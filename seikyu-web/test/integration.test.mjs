// End-to-end API test against a disposable PostgreSQL database. Never point PG_TEST_URL at production (seikyu_web).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../server/pg.mjs';
import { prepare } from '../server/schema.mjs';
import { createApp } from '../server/http.mjs';

const url = process.env.PG_TEST_URL;
const skip = !url ? 'PG_TEST_URL not set' : /\/seikyu_web(\?|$)/.test(url) ? 'refusing to run against the production database' : false;
test('workflow against PostgreSQL business tables', { skip, timeout: 900000 }, async t => {
  const pool = createPool(url, { max: 6, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const env = { DEMO_USER: 'itest-admin', DEMO_PASSWORD: 'itest-password-0001', SCHEMA_SQL_DIR: process.env.SCHEMA_SQL_DIR };
  const saved = { DEMO_USER: process.env.DEMO_USER }; process.env.DEMO_USER = env.DEMO_USER;
  await prepare(pool, env);
  const server = await createApp({ pool, publicDir: new URL('../public/', import.meta.url), secureCookies: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '', csrf = '';
    const call = async (path, body) => {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}) }, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || ''; return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
    };
    return { call, get cookie() { return cookie; }, async login(id, pw) { const r = await call('/api/login', { loginId: id, password: pw }); if (r.status === 200) csrf = (await call('/api/session')).data.csrf; return r; } };
  };
  const tag = Date.now().toString(36).slice(-4).toUpperCase(), C = 'Q' + tag, d = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const pm = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 2, 1)).toISOString().slice(0, 7), sd = pm + '-15', month = pm;
  try {
    const anon = client();
    assert.equal((await anon.call('/api/dashboard')).status, 401);
    assert.equal((await anon.login(env.DEMO_USER, 'wrong-password-xx')).status, 401);
    const a = client(); assert.equal((await a.login(env.DEMO_USER, env.DEMO_PASSWORD)).status, 200);
    const noCsrf = await fetch(base + '/api/shipments', { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie }, body: '{}' });
    assert.equal(noCsrf.status, 403, 'CSRF token required');

    await t.test('masters with optimistic concurrency', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: C, name: '結合試験(架空)', closing: 31, active: true } }));
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: C, code: 'S' + tag, suffix: '000', name: '試験現場', active: true } }));
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: C, code: 'T' + tag, suffix: '000', name: '試験現場2', active: true } }));
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'I' + tag, name: '試験商品', unit: '01', price: 1000, active: true } }));
      ok(await a.call('/api/masters/vendors', { mode: 'create', record: { code: 'V' + tag, name: '試験業者', bank: '0001', branch: '001', accountType: '1', account: '1234567', holder: 'ｼｹﾝ', active: true } }));
      ok(await a.call('/api/masters/banks', { mode: 'create', record: { code: 'B' + tag, name: '試験銀行', active: true } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'create', record: { code: C, name: 'dup', closing: 31 } })).status, 400);
      const cust = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      ok(await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: '結合試験(更新)' } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: 'stale' } })).status, 409);
      const bad = await a.call(`/api/masters/items/import`, { csv: `code,name,unit,price\nJ${tag},ok,01,10\nK${tag},${'x'.repeat(30)},01,10\n` });
      assert.equal(bad.status, 400); assert.match(bad.data.error, /3行目/);
      assert.ok(!(await a.call('/api/masters/items')).data.some(x => x.code === 'J' + tag), 'CSV import rolled back');
    });

    let invoiceId;
    await t.test('shipment → billing → issue → receipt with journals', async () => {
      const s1 = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '10.5', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 });
      assert.equal(s1.status, 200, JSON.stringify(s1.data));
      await a.call('/api/shipments', { date: sd, customer: C, site: `T${tag}|000`, item: 'I' + tag, quantity: '3', price: 999, taxRate: 8, operator: '1', deliveryKbn: '1', method: 2 });
      // NO11 赤黒（10/14）：赤＝元の全量マイナス、黒＝訂正後。同じ伝票の二重訂正は不可
      const corr = await a.call('/api/shipments/correct', { orderNo: s1.data.orderNo, date: sd, quantity: '10' });
      assert.equal(corr.status, 200, JSON.stringify(corr.data)); assert.equal(corr.data.net, -500); assert.ok(corr.data.red && corr.data.black);
      assert.equal((await a.call('/api/shipments/correct', { orderNo: s1.data.orderNo, date: sd, quantity: '9' })).status, 400, 'already corrected');
      const cash = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '1', price: 500, taxRate: 10, operator: '1', deliveryKbn: '1', method: 1 });
      const run = await a.call('/api/billing/run', { month, closing: 31, customers: [C] });
      assert.equal(run.status, 200, JSON.stringify(run.data)); assert.equal(run.data.created, 1); invoiceId = run.data.ids[0];
      const inv = (await a.call('/api/invoices/' + invoiceId)).data;
      // NO6: one head per customer covering both sites and the correction
      assert.equal(inv.net, 10500 - 500 + 2997); assert.equal(inv.tax, 1299); // 税率は出荷日で消費税率マスタ（A0007）から自動＝10% assert.equal(inv.lines.length, 4); assert.equal(new Set(inv.lines.map(l => l.site)).size, 2);
      const list = await a.call(`/api/reports/billing-list?month=${month}&closing=31`); assert.equal(list.status, 200);
      const row = list.data.rows.find(r => r.customer === C); assert.equal(row.current, inv.total); assert.equal(row.total, row.carried + inv.total); assert.equal(row.state, 'draft');
      const book = await fetch(base + `/api/reports/billing-list?month=${month}&closing=31&format=xlsx`, { headers: { cookie: a.cookie } });
      assert.equal(book.status, 200); assert.equal(Buffer.from(await book.arrayBuffer()).subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
      assert.equal((await a.call('/api/billing/run', { month, closing: 31, customers: [C] })).status, 400, 'no double billing');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: s1.data.orderNo })).status, 400, 'billed shipment locked');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: cash.data.orderNo })).status, 200);
      // 2026-10-23：未発行でも残高があれば消込対象（状態は draft＝未発行）
      const ctx0 = (await a.call('/api/receipt-context?customer=' + C)).data.invoices.find(i => i.id === invoiceId); assert.equal(ctx0?.status, 'draft', 'unissued invoice is a receipt target');
      const issued = await a.call('/api/invoices/issue', { ids: [invoiceId] }); assert.equal(issued.status, 200);
      const conf = await a.call(`/api/reports/billing-confirm?month=${month}&closing=31`); assert.equal(conf.data.rows.find(r => r.customer === C).lines.length, 4);
      assert.equal(issued.data.documents[0].total, inv.total);
      // Two concurrent receipts that together exceed the balance: exactly one succeeds.
      const half = inv.total - 1000;
      const [r1, r2] = await Promise.all([1, 2].map(n => a.call('/api/receipts', { idempotencyKey: `c${n}-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] })));
      assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
      const again = await a.call('/api/receipts', { idempotencyKey: r1.status === 200 ? `c1-${tag}` : `c2-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] });
      assert.equal(again.data.duplicate, true);
      // NO17: deposit applied up to its balance, cooperation fee deducted
      const cu = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      assert.equal((await a.call('/api/masters/customers', { mode: 'update', record: { ...cu, deposit: 300 } })).status, 200);
      assert.equal((await a.call('/api/receipts', { idempotencyKey: 'd' + tag, date: d, customer: C, deposit: 400, bank: 600, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] })).status, 400, 'deposit over balance');
      const fin = await a.call('/api/receipts', { idempotencyKey: 'f' + tag, date: d, customer: C, bank: 540, fee: 60, coop: 100, deposit: 300, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] });
      assert.equal((await a.call('/api/receipt-context?customer=' + C)).data.deposit, 0);
      assert.equal(fin.status, 200, JSON.stringify(fin.data));
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.status, 'paid');
      const rev = await a.call('/api/receipts/reverse', { id: fin.data.id }); assert.equal(rev.status, 200);
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.balance, 1000);
      const js = [...(await a.call('/api/journals?month=' + month)).data, ...(await a.call('/api/journals?month=' + d.slice(0, 7))).data].filter(j => ['billing_head', 'receipt'].includes(j.source));
      for (const j of js) assert.equal(j.lines.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), j.lines.filter(l => l.side === 'C').reduce((n, l) => n + l.amount, 0));
      assert.ok(js.some(j => j.reversalOf), 'reversal journal recorded');
    });

    await t.test('payables, payment and roles', async () => {
      const doc = await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '10%', amount: 50000, memo: '試験' });
      assert.equal(doc.status, 200, JSON.stringify(doc.data));
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 60000 }] })).status, 400);
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 50000 }] })).status, 200);
      assert.equal((await a.call('/api/expenses/reverse', { id: doc.data.id })).status, 400, 'paid document locked');
      const u = await a.call('/api/users', { loginId: 'viewer' + tag, name: '参照者', role: 5, password: 'viewer-password-01', enabled: true }); assert.equal(u.status, 200);
      const v = client(); assert.equal((await v.login('viewer' + tag, 'viewer-password-01')).status, 200);
      assert.equal((await v.call('/api/dashboard')).status, 200);
      assert.equal((await v.call('/api/shipments', { date: d })).status, 403);
      assert.equal((await v.call('/api/users')).status, 403);
      await a.call('/api/users', { id: u.data.id, name: '参照者', role: 5, enabled: false });
      assert.equal((await v.call('/api/dashboard')).status, 401, 'disabled user session revoked');
    });
    await t.test('② journal lists and bank payment list', async () => {
      const span = { from: pm + '-01', to: d };
      for (const pattern of ['A01', 'B01', 'C01', 'D01', 'E01', 'F01']) {
        const r = await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern, ...span }));
        assert.equal(r.status, 200, pattern + JSON.stringify(r.data));
        for (const sl of r.data.slips) {
          const dr = sl.pairs.reduce((n, p) => n + (p.dr?.amount || 0), 0), cr = sl.pairs.reduce((n, p) => n + (p.cr?.amount || 0), 0);
          assert.equal(dr, cr, pattern + ' slip balanced'); assert.equal(dr, sl.total);
        }
        assert.equal(r.data.total, r.data.dates.reduce((n, x) => n + x.total, 0));
      }
      const b = (await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'B01', ...span }))).data;
      const memos = b.slips.flatMap(sl => sl.pairs.flatMap(p => [p.dr?.memo2, p.cr?.memo2]));
      assert.ok(memos.includes('手数料') && memos.includes('協力費') && memos.includes('預り金充当'), 'B01 deduction memos');
      const bank = await a.call('/api/reports/bank-payments?' + new URLSearchParams(span));
      assert.ok(bank.data.days.some(x => x.rows.some(r => r.vendor === 'V' + tag && r.vendorTotal === 50000)));
      const x = await fetch(base + '/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', ...span, format: 'xlsx' }), { headers: { cookie: a.cookie } });
      assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK');
      assert.equal((await a.call('/api/reports/journal-list?pattern=ZZ&from=2026-01-01&to=2026-01-31')).status, 400);
    });
    await t.test('③ zengin transfer data and payment reports', async () => {
      const bk = (await a.call('/api/masters/banks')).data.find(x => x.code === 'B' + tag);
      assert.equal((await a.call('/api/masters/banks', { mode: 'update', record: { ...bk, zgBank: '0001', zgBranch: '100', zgType: '2', zgAccount: '7777777', zgCode: '1234567890', zgName: '山田' } })).status, 400, 'kanji requester name rejected');
      assert.equal((await a.call('/api/masters/banks', { mode: 'update', record: { ...bk, zgBank: '0001', zgBranch: '100', zgType: '2', zgAccount: '7777777', zgCode: '1234567890', zgName: 'さんぷるけんざい' } })).status, 200);
      const z = await a.call('/api/reports/zengin?' + new URLSearchParams({ date: d, bank: 'B' + tag }));
      assert.equal(z.status, 200); assert.deepEqual(z.data.errors, []); assert.equal(z.data.count, 1); assert.equal(z.data.total, 50000);
      assert.ok(z.data.records.every(r => r.length === 120)); assert.ok(z.data.records[0].includes('ｻﾝﾌﾟﾙｹﾝｻﾞｲ'));
      const file = await fetch(base + '/api/reports/zengin?' + new URLSearchParams({ date: d, bank: 'B' + tag, format: 'file' }), { headers: { cookie: a.cookie } });
      const bytes = Buffer.from(await file.arrayBuffer()); assert.equal(file.status, 200); assert.equal(bytes.length, 4 * 122); assert.equal(bytes[0], 0x31);
      const vp = await a.call('/api/reports/payments/vendor-payments?' + new URLSearchParams({ from: pm + '-01', to: d }));
      assert.ok(vp.data.vendors.some(v => v.vendor === 'V' + tag && v.total === 50000));
      const tr = await a.call('/api/reports/payments/transfer-request?date=' + d); assert.ok(tr.data.groups.some(g => g.rows.some(r => r.vendor === 'V' + tag)));
      assert.equal((await a.call('/api/reports/payments/carryover?date=' + d)).status, 200);
      const nt = await a.call('/api/reports/payments/notices?date=' + d); const n = nt.data.notices.find(x => x.vendor === 'V' + tag);
      assert.equal(n.total, 50000); assert.equal(n.docs[0].paid, 50000); assert.equal(n.carry.total, 0);
      for (const k of ['vendor-payments', 'transfer-request', 'carryover', 'notices']) {
        const x = await fetch(base + '/api/reports/payments/' + k + '?' + new URLSearchParams({ date: d, from: pm + '-01', to: d, format: 'xlsx' }), { headers: { cookie: a.cookie } });
        assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK', k);
      }
    });
    await t.test('④ shipment totals, material ledger, mix and JV allocation', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      const span = new URLSearchParams({ from: pm + '-01', to: d });
      const ss = (await a.call('/api/reports/misc/shipment-summary?' + span)).data.items.find(x => x.item === 'I' + tag);
      assert.equal(ss.qty, 13); assert.equal(ss.net, 12997);
      const ci = (await a.call('/api/reports/misc/customer-items?' + span)).data.customers.find(x => x.customer === C); assert.equal(ci.net, 12997);
      ok(await a.call('/api/reports/misc/cash-sales?' + span));
      // material: mark item as 材料, buy 10 @1000 this month, define a product recipe at 60%
      const it = (await a.call('/api/masters/items')).data.find(x => x.code === 'I' + tag);
      ok(await a.call('/api/masters/items', { mode: 'update', record: { ...it, kind: '1' } })); // 1=材料（現行 Java）
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'G' + tag, name: '試験合材', unit: '01', price: 9000, kind: '2', active: true } })); // 2=製品
      ok(await a.call('/api/purchases', { date: d, vendor: 'V' + tag, item: 'I' + tag, quantity: '10', price: 1000, taxCode: '10%' }));
      const ml = (await a.call('/api/reports/misc/material-ledger?closing=31&month=' + d.slice(0, 7))).data.items.find(x => x.item === 'I' + tag);
      assert.equal(ml.purchase.qty, 10); assert.equal(ml.purchase.value, 10000);
      ok(await a.call('/api/masters/mixes', { mode: 'create', record: { product: 'G' + tag, material: 'I' + tag, ratio: '60', active: true } }));
      const mx = (await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data.products.find(x => x.item === 'G' + tag);
      assert.equal(mx.haigo, 600);
      ok(await a.call('/api/mix/save', { closing: '31', month: d.slice(0, 7), denki: '10', touyu: '20', seizou: '5.5', ippann: '4.5' }));
      assert.equal((await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data.products.find(x => x.item === 'G' + tag).saved.total, 640);
      // JV members (deactivate leftovers first; this is a disposable test DB)
      for (const m of (await a.call('/api/masters/jv')).data.filter(x => x.active)) ok(await a.call('/api/masters/jv', { mode: 'update', record: { ...m, active: false } }));
      assert.equal((await a.call('/api/reports/misc/jv-expenses?' + span)).status, 400, 'no members');
      // 構成員＝業者マスタ（HMW110）
      for (const [k, r] of [['A', '47.5'], ['B', '47.5'], ['C', '5']]) { ok(await a.call('/api/masters/vendors', { mode: 'create', record: { code: 'J' + k + tag, name: 'JV' + k, active: true } })); ok(await a.call('/api/masters/jv', { mode: 'create', record: { code: 'J' + k + tag, name: 'JV' + k, ratio: r, seq: k.charCodeAt(0), active: true } })); }
      const je = (await a.call('/api/reports/misc/jv-expenses?' + span)).data;
      const row = je.accounts.flatMap(x => x.rows).find(r => r.gross === 50000 && r.vendor === '試験業者');
      assert.deepEqual(row.parts, [23750, 23750, 2500]); assert.equal(row.tax, 4545);
      const jr = (await a.call('/api/reports/misc/jv-receipts?' + span)).data;
      for (const l of jr.lines) assert.equal(l.parts.reduce((x, y) => x + y, 0), l.amount);
      for (const k of ['shipment-summary', 'customer-items', 'cash-sales', 'material-ledger', 'mix', 'jv-expenses', 'jv-receipts']) {
        const x = await fetch(base + '/api/reports/misc/' + k + '?' + new URLSearchParams({ from: pm + '-01', to: d, month: d.slice(0, 7), format: 'xlsx' }), { headers: { cookie: a.cookie } });
        assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK', k);
      }
      for (const m of (await a.call('/api/masters/jv')).data.filter(x => x.active && x.code.endsWith(tag))) await a.call('/api/masters/jv', { mode: 'update', record: { ...m, active: false } });
    });
    await t.test('△ items completed by estimation (NO3/9/10/20/25/30/33/40/44)', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      const raw2 = async p => { const r = await fetch(base + p, { headers: { cookie: a.cookie } }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
      // NO3 full customer fields
      const cu = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      ok(await a.call('/api/masters/customers', { mode: 'update', record: { ...cu, abbr: '結合', section: '工務部', postcode: '460-0001', pref: '愛知県', address2: '2F', fax: '052-000-0000', customerPic: '先方', pic: '自社', creditStart: '2026-04-01', remarks: 'テスト' } }));
      const cu2 = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      assert.equal(cu2.postcode, '4600001'); assert.equal(cu2.creditStart, '2026-04-01'); assert.equal(cu2.section, '工務部');
      // NO9 statement view data is the billing list (already covered); NO10 bulk workbook
      assert.equal((await raw2('/api/invoices/book?ids=' + invoiceId)).bytes.subarray(0, 2).toString(), 'PK');
      const draft = (await a.call('/api/invoices?status=draft')).data[0];
      if (draft) assert.equal((await raw2('/api/invoices/book?ids=' + draft.id)).status, 400, 'unissued invoices are rejected');
      // NO20 accounting export
      const span = new URLSearchParams({ from: pm + '-01', to: d });
      const g = await raw2('/api/accounting/export?' + span + '&format=generic'); assert.equal(g.status, 200); assert.deepEqual([...g.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const y = await raw2('/api/accounting/export?' + span + '&format=yayoi'); assert.equal(y.status, 200);
      const { default: iconv } = await import('iconv-lite');
      const ylines = iconv.decode(y.bytes, 'Shift_JIS').trim().split('\r\n');
      assert.ok(ylines.length > 3); for (const l of ylines) assert.ok(/^(2000|2110|2100|2101),/.test(l), l);
      assert.ok(ylines.some(l => l.includes('売掛金')), 'account names in yayoi format');
      // NO25 estimate fields
      const mx = (await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data;
      assert.ok(mx.suggest && typeof mx.suggest.tons === 'number' && Array.isArray(mx.usage));
      // NO30 / NO33 / NO40 / NO44
      // 10/21：業者コードはブランクなら出力しない、To に 9999999 で全業者
      const pi = (await a.call('/api/reports/misc/payable-input?closing=31&vendorTo=9999999&month=' + d.slice(0, 7))).data;
      assert.ok(pi.depts.some(dp => dp.vendors.some(v => v.vendor === 'V' + tag)));
      assert.equal((await a.call('/api/reports/misc/payable-input?closing=31&month=' + d.slice(0, 7))).data.depts.length, 0, 'blank vendor code outputs nothing');
      const pc = (await a.call('/api/reports/misc/petty-book?' + span)).data; assert.equal(pc.closing, pc.opening + pc.received - pc.spent);
      const sr = (await a.call('/api/reports/misc/sales-register?' + span)).data.customers.find(x => x.customer === C); assert.equal(sr.rows.length, 4); // 元・赤・黒＋別現場 assert.equal(sr.net, 12997);
      const rs = (await a.call('/api/reports/misc/receipt-schedule')).data.customers.find(x => x.customer === C);
      assert.equal(rs.due, 1000); assert.equal(rs.rows.length, 2, 'split by site (工事)');
      for (const k of ['payable-input', 'petty-book', 'sales-register', 'receipt-schedule'])
        assert.equal((await raw2('/api/reports/misc/' + k + '?' + new URLSearchParams({ from: pm + '-01', to: d, month: d.slice(0, 7), format: 'xlsx' }))).bytes.subarray(0, 2).toString(), 'PK', k);
    });
    await t.test('re-audit fixes: late entries, credit invoices, append, site due date, fee/offset, overpay, petty refill, bank directory', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const cl = Math.max(1, Math.min(28, Number(d.slice(8)))), K = 'K' + tag, curMonth = d.slice(0, 7);
      ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: K, name: '締日試験', closing: cl, siteMonths: '2', siteDay: '10', payMethod: '2', payBank: 'B' + tag, active: true } }));
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: K, code: 'K' + tag, suffix: '000', name: 'K現場', active: true } }));
      const s1 = ok(await a.call('/api/shipments', { date: pm + '-01', customer: K, site: 'K' + tag + '|000', item: 'I' + tag, quantity: '2', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      const h1 = ok(await a.call('/api/billing/run', { month: pm, closing: cl, customers: [K] })); assert.equal(h1.created, 1);
      const inv1 = ok(await a.call('/api/invoices/' + h1.ids[0]));
      const [yy, mm] = pm.split('-').map(Number); const exp = new Date(Date.UTC(yy, mm - 1 + 2, Math.min(10, new Date(Date.UTC(yy, mm + 2, 0)).getUTCDate()))).toISOString().slice(0, 10);
      assert.equal(inv1.due, exp, 'due date from customer site (2 months later, day 10)');
      ok(await a.call('/api/invoices/issue', { ids: [h1.ids[0]] }));
      // late correction dated in the already-billed period
      ok(await a.call('/api/shipments/correct', { orderNo: s1.orderNo, date: pm + '-01', quantity: '0' })); // 赤のみ＝取消
      const again = await a.call('/api/billing/run', { month: pm, closing: cl, customers: [K] });
      assert.equal(again.status, 400); assert.match(again.data.error, /次回締め/);
      // next closing picks it up as a credit invoice
      const h2 = ok(await a.call('/api/billing/run', { month: curMonth, closing: cl, customers: [K] }));
      const inv2 = ok(await a.call('/api/invoices/' + h2.ids[0])); assert.equal(inv2.total, -2200); assert.equal(inv2.status, 'credit');
      // unissued invoice: additional sale is appended to the same invoice
      ok(await a.call('/api/shipments', { date: pm + '-02', customer: K, site: 'K' + tag + '|000', item: 'I' + tag, quantity: '5', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      const h3 = ok(await a.call('/api/billing/run', { month: curMonth, closing: cl, customers: [K] })); assert.equal(h3.appended, 1);
      const inv3 = ok(await a.call('/api/invoices/' + h2.ids[0])); assert.equal(inv3.total, 3300); assert.equal(inv3.lines.length, 2);
      const jl = ok(await a.call('/api/journals?month=' + curMonth)).filter(j => j.source === 'billing_head' && j.sourceId === String(h2.ids[0]));
      assert.equal(jl.filter(j => j.status === 'POSTED' && !j.reversalOf).length, 1, 'one live journal after append');
      // payment with 先方負担手数料 and 相殺
      const ven = ok(await a.call('/api/masters/vendors')).find(x => x.code === 'V' + tag);
      ok(await a.call('/api/masters/vendors', { mode: 'update', record: { ...ven, advance: 3000 } }));
      const doc = ok(await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '10%', amount: 10000, memo: '手数料相殺試験' }));
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'po' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, fee: 0, offset: 5000, allocations: [{ expenseId: doc.id, amount: 10000 }] })).status, 400, 'offset above advance');
      const pay = ok(await a.call('/api/payments', { idempotencyKey: 'pf' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, fee: 770, offset: 2000, safety: 500, allocations: [{ expenseId: doc.id, amount: 10000 }] }));
      const pj = ok(await a.call('/api/journals?month=' + curMonth)).find(j => j.source === 'payment' && j.sourceId === String(pay.id));
      const amt = (side, acc) => pj.lines.filter(l => l.side === side && l.account === acc).reduce((n, l) => n + l.amount, 0);
      assert.equal(amt('D', '4121'), 10000); assert.equal(amt('C', '1112'), 6730); assert.equal(amt('C', '4171'), 500); assert.equal(amt('C', '8790'), 770); assert.equal(amt('C', '4415'), 0); assert.equal(amt('C', '1431'), 2000); // 現行：手数料差引は 8790-001 処税率9 の全額
      const co = ok(await a.call('/api/reports/payments/carryover?date=' + d)).vendors.find(v => v.vendor === 'V' + tag);
      if (co) assert.equal(co.offset, 1000, 'remaining 業者立替金 = 3000 - 2000');
      const vp = ok(await a.call('/api/reports/payments/vendor-payments?' + new URLSearchParams({ from: d, to: d }))).vendors.find(v => v.vendor === 'V' + tag);
      assert.ok(vp.rows.some(r => r.fee === 770 && r.offset === 2000 && r.safety === 500 && r.bank === 6730 && r.paid === 10000));
      // overpayment is taken as 預り金
      const before = ok(await a.call('/api/receipt-context?customer=' + C)).deposit;
      assert.equal((await a.call('/api/receipts', { idempotencyKey: 'ov1' + tag, date: d, customer: C, bank: 1500, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] })).status, 400);
      ok(await a.call('/api/receipts', { idempotencyKey: 'ov2' + tag, date: d, customer: C, bank: 1500, bankCode: 'B' + tag, overpayToDeposit: true, allocations: [{ invoiceId, amount: 1000 }] }));
      assert.equal(ok(await a.call('/api/receipt-context?customer=' + C)).deposit, before + 500);
      // petty cash fund and refill
      ok(await a.call('/api/petty/fund', { fund: '30000' }));
      ok(await a.call('/api/petty/refill', { date: d, amount: '5000', bankCode: 'B' + tag }));
      const pb = ok(await a.call('/api/reports/misc/petty-book?' + new URLSearchParams({ from: d, to: d })));
      assert.ok(pb.rows.some(r => r.received === 5000)); assert.equal(pb.closing, pb.opening + pb.received - pb.spent);
      // 金融機関 master names in transfer request / payment notice
      await a.call('/api/masters/bankdir', { mode: 'create', record: { bank: '0001', name: '試験銀行本体', kana: 'ｼｹﾝ', active: true } });
      await a.call('/api/masters/bankdir', { mode: 'create', record: { bank: '0001', branch: '001', name: '試験支店', kana: 'ｼﾃﾝ', active: true } });
      const tr = ok(await a.call('/api/reports/payments/transfer-request?date=' + d)).groups.flatMap(g => g.rows).find(r => r.vendor === 'V' + tag);
      assert.equal(tr.payee.bankName, '試験銀行本体'); assert.equal(tr.payee.branchName, '試験支店');
      ok(await a.call('/api/masters/depts', { mode: 'create', record: { code: 'D' + tag, name: '試験部門', active: true } }));
      // 自社情報：登録番号・振込先口座が請求書スナップショットに入る（現行請求書③の項目）
      const comp = ok(await a.call('/api/masters/company')).find(x => x.id === '1');
      assert.equal((await a.call('/api/masters/company', { mode: 'update', record: { ...comp, invoiceNo: 'X123' } })).status, 400, 'invalid registration number');
      ok(await a.call('/api/masters/company', { mode: 'update', record: { ...comp, invoiceNo: 'T4180001002429', invoiceBank: 'B' + tag } }));
      const docs = ok(await a.call('/api/invoices/issue', { ids: [h2.ids[0]] })).documents;
      assert.equal(docs[0].company.invoiceNo, 'T4180001002429'); assert.ok(docs[0].company.bankText.includes('7777777'), docs[0].company.bankText); assert.equal(docs[0].lines[0].unit, 't');
      const lst = ok(await a.call('/api/reports/billing-list?' + new URLSearchParams({ month: curMonth, closing: cl }))).rows.find(r => r.customer === K);
      assert.equal(lst.sites.length, 1); assert.equal(lst.sites[0].total, 3300);
      // NO8 grouping: A01 list slips are per closing date
      const a01 = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: pm + '-01', to: d })));
      for (const sl of a01.slips) { const dr = sl.pairs.reduce((n, p) => n + (p.dr?.amount || 0), 0), cr = sl.pairs.reduce((n, p) => n + (p.cr?.amount || 0), 0); assert.equal(dr, cr); }
    });
    await t.test('shipment entry: 伝票区分 5 訂正 with 元伝票No creates a linked red slip', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const base = { date: pm + '-03', customer: C, site: `S${tag}|000`, item: 'I' + tag, price: 1000, operator: '1', deliveryKbn: '1', method: 2 };
      const o = ok(await a.call('/api/shipments', { ...base, quantity: '3' }));
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', quantity: '-3' })).status, 400, 'originalNo required');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '3' })).status, 400, 'red must be negative');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-4' })).status, 400, 'within original quantity');
      const red = ok(await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-3' }));
      const [r0] = ok(await a.call('/api/shipments?orderNo=' + red.orderNo)), [o0] = ok(await a.call('/api/shipments?orderNo=' + o.orderNo));
      assert.equal(r0.shipKb, 5); assert.equal(r0.originalNo, o.orderNo); assert.equal(r0.remarks, '赤 ' + o.orderNo); assert.ok(o0.corrected, 'original marked corrected');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-3' })).status, 400, 'no double correction');
      ok(await a.call('/api/shipments/delete', { orderNo: red.orderNo })); ok(await a.call('/api/shipments/delete', { orderNo: o.orderNo }));
    });
    await t.test('Q08: one closing run puts its customers on one A01 slip number', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const cs = ['M' + tag, 'N' + tag, 'P' + tag];
      for (const k of cs) {
        ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: k, name: '分割試験', closing: 15, active: true } }));
        ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: k, code: k, suffix: '000', name: '分割現場', active: true } }));
        ok(await a.call('/api/shipments', { date: pm + '-01', customer: k, site: k + '|000', item: 'I' + tag, quantity: '1', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      }
      const run = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: cs.slice(0, 2) })); assert.equal(run.created, 2); assert.match(run.slip, /^R\d{5}$/);
      // 画面は得意先ごとに呼び出す：受け取った伝票番号を渡すと同じ伝票に続けて載る
      const run2 = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: [cs[2]], slip: run.slip })); assert.equal(run2.slip, run.slip); run.ids.push(...run2.ids);
      const end = pm + '-15', l = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: end, to: end })));
      const mine = l.slips.filter(sl => run.ids.some(id => sl.sourceNo.includes('I' + id)));
      assert.equal(mine.length, 1, 'both invoices on one slip'); assert.match(mine[0].sourceNo, /（3件）/); assert.equal(mine[0].pairs.length, 6);
      const each = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: end, to: end, group: 'none' }))).slips.filter(sl => run.ids.some(id => sl.sourceNo === 'I' + id));
      assert.equal(each.length, 3); assert.equal(new Set(each.map(x => x.slipNo)).size, 1);
      ok(await a.call('/api/kb/settings', { startFy: 2024 }));
      const kb = ok(await a.call('/api/kb/import/seikyu', { from: end, to: end, dry: true })), ks = kb.sample.filter(x => x.memo.startsWith(each[0].slipNo + ' '));
      assert.equal(ks.length, 1, '会計の仕訳受入も伝票番号単位で1伝票'); assert.match(ks[0].memo, /（3件）/); assert.equal(ks[0].ref, each[0].slipNo); assert.equal(ks[0].rows.length, 6);
    });
    const raw = await fetch(base + '/api/export/journals?month=' + month, { headers: { cookie: a.cookie } }); const bytes = new Uint8Array(await raw.arrayBuffer());
    assert.equal(raw.status, 200); assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV has UTF-8 BOM for Excel');
  } finally {
    process.env.DEMO_USER = saved.DEMO_USER;
    await new Promise(r => server.close(r)); await pool.end();
  }
});
