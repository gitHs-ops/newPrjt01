// Fictional sample data. Runs once, only when every transaction table is empty.
import { tx, one } from './db.mjs';
import { today, addMonths } from './domain.mjs';
import { save, MASTERS } from './masters.mjs';
import { saveShipment, runBilling, issueInvoices, createReceipt, listInvoices } from './sales.mjs';
import { createPurchase, createExpense, createPayment, saveInventory } from './payables.mjs';

const ctx = { user: { login_id: 'system(サンプル生成)', user_id: 0 }, requestId: 'seed' };
async function ensure(c, kind, rec) {
  const cfg = MASTERS[kind], key = cfg.keyOf(cfg.validate(rec));
  const exists = await one(c, `${cfg.select} ${cfg.select.includes(' WHERE ') ? 'AND' : 'WHERE'} ${cfg.where}`, key);
  if (!exists) await save(c, ctx, kind, rec, 'create');
}
export async function seedIfEmpty(pool) {
  const busy = await one(pool, `SELECT (SELECT COUNT(*) FROM sales_trn)+(SELECT COUNT(*) FROM billing_head)+(SELECT COUNT(*) FROM receipt)+(SELECT COUNT(*) FROM expense_document)+(SELECT COUNT(*) FROM purchase)+(SELECT COUNT(*) FROM journal_entry) n`);
  if (Number(busy.n)) return false;
  await tx(pool, async c => {
    const now = today(), month = now.slice(0, 7), dom = Number(now.slice(8));
    const customers = [['C001', '青空建設（架空）', 10], ['C002', 'みなと道路（架空）', 10], ['C003', '若葉工業（架空）', 10], ['C004', 'さくら土木（架空）', 20]];
    const sites = { C001: ['G0101', '北地区道路改良工事'], C002: ['G0201', '河川護岸工事'], C003: ['G0301', '工業団地造成工事'], C004: ['G0401', '駅前整備工事'] };
    for (const [code, name, closing] of customers) {
      await ensure(c, 'customers', { code, name, closing, address: '架空県デモ市' + code, tel: '00-0000-' + code.slice(1), active: true });
      await ensure(c, 'sites', { customer: code, code: sites[code][0], suffix: '000', name: sites[code][1], active: true });
    }
    const items = [['P001', '再生砕石 RC-40', 3200], ['P002', '粒度調整砕石 M-30', 4800], ['P003', '山砂', 2600]];
    for (const [code, name, price] of items) await ensure(c, 'items', { code, name, unit: 't', price, active: true });
    await ensure(c, 'prices', { item: 'P002', customer: 'C002', site: '', price: 4650, active: true });
    await ensure(c, 'banks', { code: '041', name: 'サンプル銀行（架空）', active: true });
    await ensure(c, 'vendors', { code: 'V001', name: 'サンプル資材（架空）', active: true });
    await ensure(c, 'vendors', { code: 'V002', name: 'デモ運輸（架空）', active: true });
    await ensure(c, 'accounts', { code: '8310', name: '消耗品費', active: true });
    await ensure(c, 'accounts', { code: '8244', name: '機械等経費', active: true });

    const day = (m, d) => `${addMonths(month, m)}-${String(d).padStart(2, '0')}`;
    for (let m = -5; m <= 0; m++) {
      if (m === 0 && dom < 6) break;
      for (let i = 0; i < 3; i++) {
        const [code] = customers[i], [item, , price] = items[i];
        for (const d of [3, 5]) await saveShipment(c, ctx, { date: day(m, d), customer: code, site: `${sites[code][0]}|000`, item, quantity: String(40 + (m + 5) * 9 + i * 7 + d), price: code === 'C002' ? 4650 : price, taxRate: 10, method: 1, vehicle: `デモ${100 + i}` });
      }
      if (m === -2) await saveShipment(c, ctx, { date: day(m, 4), customer: 'C001', site: 'G0101|000', item: 'P003', quantity: '6.5', price: 2600, taxRate: 10, method: 2, remarks: '現金売上' });
      if (m === 0 && dom < 10) continue;
      await runBilling(c, ctx, { month: addMonths(month, m), closing: 10, customers: ['C001', 'C002', 'C003'] });
      const inv = (await listInvoices(c, { month: addMonths(month, m) })).filter(x => ['C001', 'C002', 'C003'].includes(x.customer));
      const toIssue = inv.filter(x => !(m === 0 && x.customer === 'C003')).map(x => x.id);
      if (toIssue.length) await issueInvoices(c, ctx, { ids: toIssue });
      for (const x of inv) {
        if (!toIssue.includes(x.id) || (m >= -2 && x.customer === 'C002')) continue;
        const date = day(m, 25); if (date > now) continue;
        const fee = x.customer === 'C003' ? 660 : 0, value = m === 0 ? Math.floor(x.total / 2) : x.total;
        await createReceipt(c, ctx, { idempotencyKey: `seed-${x.id}`, date, customer: x.customer, bank: value - fee, bankCode: '041', fee, allocations: [{ invoiceId: x.id, amount: value }] });
      }
    }
    for (let n = 0; n < 3; n++) if (dom >= 2) await saveShipment(c, ctx, { date: day(0, Math.min(dom, 2 + n * 3)), customer: 'C004', site: 'G0401|000', item: items[n][0], quantity: String(25 + n * 12.5), price: items[n][2], taxRate: 10, method: 1 });
    const pm = addMonths(month, -1);
    for (let n = 0; n < 2; n++) {
      await createPurchase(c, ctx, { date: `${pm}-12`, vendor: n ? 'V002' : 'V001', item: items[n][0], quantity: String(120 + n * 40), price: 1800 + n * 300, taxCode: '10%', memo: 'サンプル仕入' });
      const doc = await createExpense(c, ctx, { kind: 'PAYABLE', date: `${pm}-20`, vendor: n ? 'V002' : 'V001', account: n ? '8244' : '8231', taxCode: '10%', amount: 250000 + n * 110000, memo: n ? '運搬費（デモ）' : '材料仕入（デモ）' });
      if (!n) await createPayment(c, ctx, { idempotencyKey: 'seed-pay-1', date: `${pm}-28`, vendor: 'V001', bankCode: '041', allocations: [{ expenseId: doc.id, amount: 250000 }] });
    }
    await createExpense(c, ctx, { kind: 'PETTY_CASH', date: `${pm}-15`, account: '8310', taxCode: '10%', amount: 4400, memo: '事務用品（デモ）' });
    for (const [n, [item]] of items.entries()) {
      await saveInventory(c, ctx, { month: addMonths(month, -2), item, quantity: String(180 + n * 30), price: 1750 + n * 300 });
      await saveInventory(c, ctx, { month: pm, item, quantity: String(200 + n * 40), price: 1800 + n * 300 });
    }
  });
  return true;
}
