import { createHash } from 'node:crypto';
import { check, Conflict, yen, qty, lineAmount, taxOf, isoDate, isoMonth, toNum, fromNum, period, dueDate, closingDay, text, RATES, METHODS, today } from './domain.mjs';
import { rows, one, nextNo, assertOpen, audit, stamp, postJournal, reverseJournal, line } from './db.mjs';

const site = s => { const [code = '', suffix = ''] = String(s || '').split('|'); return { code, suffix }; };
const monthRange = m => { isoMonth(m); return [toNum(m + '-01'), toNum(m + '-31')]; };

// ---------- 出荷・売上 (shipment_slip + sales_trn, 1 order = 1 line, order_suffix 1) ----------
export async function priceFor(c, { item, customer, site: s, date }) {
  const d = date || today(), { code, suffix } = site(s);
  const rs = await rows(c, "SELECT * FROM uriage_tanka_m WHERE item_cd=? AND customers_cd=? AND delete_f<>'1' AND (field_cd=? AND field_suffix=? OR field_cd='') AND (apply_start IS NULL OR apply_start<=?) AND (apply_end IS NULL OR apply_end>=?) ORDER BY field_cd DESC LIMIT 1", [item, customer, code, suffix, d, d]);
  if (rs.length) return { price: Number(rs[0].apply_tanka), source: rs[0].field_cd ? '現場別単価' : '得意先別単価' };
  const it = await one(c, 'SELECT tanka FROM item_m WHERE item_cd=?', [item]);
  return { price: Number(it?.tanka || 0), source: '標準単価' };
}
export async function listShipments(c, q = {}) {
  const [from, to] = monthRange(q.month); const args = [from, to]; let where = '';
  if (q.customer) { where += ' AND s.customers_cd=?'; args.push(q.customer); }
  if (q.status === 'open') where += " AND s.process_status='0'";
  if (q.status === 'billed') where += " AND s.process_status='1'";
  const rs = await rows(c, `SELECT s.*, c.customers_name, sl.vehicle_no, sl.unit_cd unit, h.invoice_id
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN shipment_slip sl ON sl.order_no=s.order_no
    LEFT JOIN billing_detail d ON d.order_no=s.order_no
    LEFT JOIN billing_head h ON h.customers_cd=d.customers_cd AND h.closing_yymm=d.closing_yymm AND h.closing_date=d.claim_processing_period AND h.field_cd=d.field_cd AND h.field_suffix=d.field_suffix
    WHERE s.sales_date BETWEEN ? AND ?${where} ORDER BY s.sales_date DESC, s.order_no DESC LIMIT 1000`, args);
  return rs.map(r => ({ orderNo: r.order_no, date: fromNum(r.sales_date), customer: r.customers_cd, customerName: r.customers_name, site: `${r.field_cd}|${r.field_suffix}`, siteName: [r.field_name1, r.field_name2].filter(Boolean).join(' '),
    item: r.item_cd, itemName: r.item_name, quantity: Number(r.quantity), unit: r.unit || '', price: Number(r.unit_price), net: Number(r.money), taxRate: Number(r.tax_rate), tax: Number(r.consumption_tax),
    method: Number(r.payment_method_cd), methodName: METHODS[r.payment_method_cd] || '', billed: r.process_status === '1', invoiceId: r.invoice_id || null, vehicle: r.vehicle_no || '', remarks: r.remarks || '' }));
}
export async function saveShipment(c, ctx, p) {
  const date = isoDate(p.date, '出荷日'); await assertOpen(c, date);
  const cust = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [String(p.customer || '')]);
  check(cust && cust.delete_f !== '1', '有効な得意先を選択してください');
  const s = site(p.site), f = await one(c, 'SELECT * FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [cust.customers_cd, s.code, s.suffix]);
  check(f && f.delete_f !== '1', '得意先に登録された有効な現場を選択してください');
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(p.item || '')]);
  check(it && it.delete_f !== '1', '有効な商品を選択してください');
  const q = qty(p.quantity, '数量'), price = yen(p.price, '単価', { max: 9999999 }), rate = Number(p.taxRate ?? 10), method = Number(p.method || 1);
  check(RATES.includes(rate), '税率が不正です'); check(METHODS[method], '決済方法が不正です');
  const net = lineAmount(q, price); check(net <= 999999999, '売上金額が上限(9億9999万円)を超えています');
  const tax = taxOf(net, rate), vehicle = text(p.vehicle, '車番', 15, { required: false }), remarks = text(p.remarks, '備考', 20, { required: false });
  const paid = method === 1 ? 0 : net + tax, st = stamp();
  let orderNo = p.orderNo;
  if (orderNo) {
    const old = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [orderNo]);
    if (!old) throw new Conflict('出荷伝票が見つかりません。再読込してください');
    check(old.process_status === '0', '請求済みの出荷は変更できません（請求取消後に修正してください）');
    await assertOpen(c, fromNum(old.sales_date));
    await c.query(`UPDATE sales_trn SET sales_date=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,item_name=?,quantity=?,unit_price=?,money=?,tax_rate=?,consumption_tax=?,remarks=?,payment_method_cd=?,payment_money=?,update_day=?,update_time=?,update_pgm=?,update_ws=? WHERE order_no=? AND order_suffix=1`,
      [toNum(date), cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1, f.field_name2, it.item_cd, it.item_nam.slice(0, 20), q.text, price, net, rate, tax, remarks, method, paid, st.update_day, st.update_time, st.update_pgm, st.update_ws, orderNo]);
    await c.query('UPDATE shipment_slip SET shipment_dt=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,quantity=?,unit_cd=?,unit_price=?,money=?,tax_rate=?,consumption_tax=?,payment_method_cd=?,payment_money=?,vehicle_no=?,slip_remark=?,update_daytime=UTC_TIMESTAMP(6) WHERE order_no=?',
      [date, cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1.slice(0, 20), f.field_name2.slice(0, 20), it.item_cd, q.text, it.unit, price, net, rate, tax, method, paid, vehicle, remarks, orderNo]);
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.update', { date, customer: cust.customers_cd, item: it.item_cd, net });
  } else {
    orderNo = await nextNo(c, 'sales');
    await c.query(`INSERT INTO shipment_slip (order_no,ship_kb,shipment_dt,weather_cd,customers_cd,other_company_customers_cd,delivery_cd,delivery_name,field_cd,field_suffix,field_name1,field_name2,item_cd,delivery_kbn_cd,quantity,unit_cd,cumulative_quantity,plan_cumulative_quantity,unit_price,money,tax_rate,consumption_tax,payment_method_cd,payment_money,vehicle_no,cumulative_number,start_time,plan_start_time,start_temperature,person_in_charge_cd,slip_remark,ship_printing_fg1,ship_printing_fg2,ship_printing_fg3,ship_printing_fg4,printing_settled_fg,claim_status,claim_processing_period,freight,card_sales_sts,card_sales_dt,card_member_id,card_order_id,card_credit_dt,update_daytime,order_processing_period)
      VALUES (?,1,?,NULL,?,'','','',?,?,?,?,?,0,?,?,0,0,?,?,?,?,?,?,?,0,'','',NULL,'',?,0,0,0,0,0,0,0,0,0,NULL,'','',NULL,UTC_TIMESTAMP(6),NULL)`,
      [orderNo, date, cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1.slice(0, 20), f.field_name2.slice(0, 20), it.item_cd, q.text, it.unit, price, net, rate, tax, method, paid, vehicle, remarks]);
    await c.query(`INSERT INTO sales_trn (order_no,order_suffix,sales_date,sales_no,sales_suffix,ship_kb,customers_cd,field_cd,field_suffix,field_name1,field_name2,shipping_kb,item_cd,item_name,item_zaiko_cd,quantity,unit_cd,unit_price,money,proc_kb,tax_kb,tax_rate,consumption_tax,remarks,claim_processing_period,payment_method_cd,payment_money,process_status,update_day,update_time,update_pgm,update_ws)
      VALUES (?,1,?,?,1,'1',?,?,?,?,?,NULL,?,?,?,?,NULL,?,?,'1','1',?,?,?,NULL,?,?,'0',?,?,?,?)`,
      [orderNo, toNum(date), orderNo, cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1, f.field_name2, it.item_cd, it.item_nam.slice(0, 20), it.item_cd, q.text, price, net, rate, tax, remarks, method, paid, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.create', { date, customer: cust.customers_cd, item: it.item_cd, net });
  }
  return { orderNo };
}
export async function deleteShipment(c, ctx, { orderNo }) {
  const old = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [String(orderNo || '')]);
  if (!old) throw new Conflict('出荷伝票が見つかりません。再読込してください');
  check(old.process_status === '0', '請求済みの出荷は取消できません');
  await assertOpen(c, fromNum(old.sales_date));
  await c.query('DELETE FROM sales_trn WHERE order_no=?', [orderNo]);
  await c.query('DELETE FROM shipment_slip WHERE order_no=?', [orderNo]);
  await audit(c, ctx, 'sales_trn', orderNo, 'shipment.delete', { date: fromNum(old.sales_date), customer: old.customers_cd, net: Number(old.money) });
  return { orderNo };
}

// ---------- 請求締め (billing_head per customer + site, billing_detail per order) ----------
const PAID = "COALESCE((SELECT SUM(a.amount) FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.invoice_id=h.invoice_id),0)";
export async function billingPreview(c, { month, closing }) {
  const { start, end } = period(month, closing), day = closingDay(closing);
  const custs = await rows(c, "SELECT customers_cd, customers_name FROM client_m WHERE delete_f<>'1' AND CAST(deadline AS UNSIGNED)=? ORDER BY customers_cd", [day]);
  const out = [];
  for (const cu of custs) {
    const s = await rows(c, "SELECT payment_method_cd m, COUNT(*) n, SUM(money) net FROM sales_trn WHERE customers_cd=? AND process_status='0' AND sales_date BETWEEN ? AND ? GROUP BY payment_method_cd", [cu.customers_cd, toNum(start), toNum(end)]);
    const made = await one(c, 'SELECT COUNT(*) n FROM billing_head WHERE customers_cd=? AND closing_date=?', [cu.customers_cd, toNum(end)]);
    const credit = s.find(x => Number(x.m) === 1);
    out.push({ customer: cu.customers_cd, name: cu.customers_name, count: Number(credit?.n || 0), net: Number(credit?.net || 0), excluded: s.filter(x => Number(x.m) !== 1).reduce((n, x) => n + Number(x.n), 0), created: Number(made.n) });
  }
  return { start, end, due: dueDate(end), customers: out };
}
export async function runBilling(c, ctx, { month, closing, customers }) {
  const { start, end } = period(month, closing), day = closingDay(closing); await assertOpen(c, end);
  check(end <= today(), `締日（${end}）が到来していないため請求締めはできません`);
  let targets = await rows(c, "SELECT * FROM client_m WHERE delete_f<>'1' AND CAST(deadline AS UNSIGNED)=? ORDER BY customers_cd", [day]);
  if (Array.isArray(customers) && customers.length) targets = targets.filter(t => customers.includes(t.customers_cd));
  check(targets.length, `締日${day}日の有効な得意先がありません`);
  const created = [], st = stamp(), yymm = Number(month.replace('-', ''));
  for (const cu of targets) {
    const sales = await rows(c, "SELECT * FROM sales_trn WHERE customers_cd=? AND process_status='0' AND payment_method_cd=1 AND sales_date BETWEEN ? AND ? ORDER BY sales_date, order_no FOR UPDATE", [cu.customers_cd, toNum(start), toNum(end)]);
    const groups = new Map();
    for (const s of sales) { const k = `${s.field_cd}|${s.field_suffix}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    for (const [k, list] of groups) {
      const [fc, fs] = k.split('|');
      const dup = await one(c, 'SELECT invoice_id FROM billing_head WHERE closing_yymm=? AND closing_date=? AND customers_cd=? AND field_cd=? AND field_suffix=?', [yymm, toNum(end), cu.customers_cd, fc, fs]);
      check(!dup, `${cu.customers_name} 現場${fc}-${fs} の ${end} 締請求は作成済みです。追加の出荷を含める場合は請求取消後に再作成してください`);
      check(list.every(s => Number(s.money) >= 0), 'マイナス売上（値引）の請求ルールは確認待ちです (Q18)');
      const net = list.reduce((n, s) => n + Number(s.money), 0);
      const tax = RATES.reduce((n, r) => n + taxOf(list.filter(s => Number(s.tax_rate) === r).reduce((a, s) => a + Number(s.money), 0), r), 0);
      check(net + tax > 0, '請求額が0円です');
      const [h] = await c.query("INSERT INTO billing_head (closing_yymm,closingdd,closing_date,customers_cd,field_cd,field_suffix,claim_processing_period,money,consumption_tax,payment_method_cd,invoice_proc_flag,invoice_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,?,?,?,?,?,?,?,1,'1','0',?,?,?,?)",
        [yymm, day, toNum(end), cu.customers_cd, fc, fs, toNum(dueDate(end)), net, tax, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
      for (const s of list) {
        await c.query("INSERT INTO billing_detail (closing_yymm,closingdd,claim_processing_period,customers_cd,sales_date,order_no,ship_kb,item_cd,item_name,quantity,unit_cd,unit_price,money,tax_kb,tax_rate,consumption_tax,remarks,field_cd,field_suffix,field_name,payment_method_cd,shipping_kb,invoice_issud_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,'0',?,?,?,?)",
          [yymm, day, toNum(end), cu.customers_cd, s.sales_date, s.order_no, s.ship_kb, s.item_cd, (s.item_name || '').slice(0, 22), s.quantity, s.unit_price, s.money, s.tax_kb, Math.round(Number(s.tax_rate)), s.consumption_tax, s.remarks, fc, fs, (s.field_name1 || '').slice(0, 40), s.payment_method_cd, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
        await c.query("UPDATE sales_trn SET process_status='1', claim_processing_period=? WHERE order_no=? AND order_suffix=?", [toNum(end), s.order_no, s.order_suffix]);
        await c.query('UPDATE shipment_slip SET claim_status=1, claim_processing_period=? WHERE order_no=?', [yymm, s.order_no]);
      }
      await postJournal(c, { date: end, pattern: 'A01', sourceType: 'billing_head', sourceId: h.insertId,
        lines: [line('D', '1131', net + tax, { customer: cu.customers_cd }), line('C', '8130', net, { dept: '063' }), line('C', '4415', tax)] });
      created.push(h.insertId);
      await audit(c, ctx, 'billing_head', h.insertId, 'billing.create', { customer: cu.customers_cd, site: k, closing: end, net, tax, lines: list.length });
    }
  }
  check(created.length, '対象期間に未請求の掛売上がありません');
  await c.query("INSERT INTO billing_closing_inf (closing_yymm,closingdd,invoice_proc_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,'1',?,?,?,?) ON DUPLICATE KEY UPDATE invoice_proc_flag='1',update_day=VALUES(update_day),update_time=VALUES(update_time)",
    [yymm, day, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
  return { created: created.length, ids: created };
}
const invoiceSql = `SELECT h.*, c.customers_name, f.field_name1, f.field_name2, ${PAID} paid, (SELECT MAX(issue_no) FROM invoice_issue i WHERE i.invoice_id=h.invoice_id) issues
  FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd LEFT JOIN field_name_m f ON f.customers_cd=h.customers_cd AND f.field_cd=h.field_cd AND f.field_suffix=h.field_suffix`;
const decodeInvoice = r => {
  const total = Number(r.money) + Number(r.consumption_tax), paid = Number(r.paid), issues = Number(r.issues || 0), due = fromNum(r.claim_processing_period);
  const status = paid >= total ? 'paid' : paid > 0 ? 'partial' : issues ? 'issued' : 'draft';
  return { id: r.invoice_id, month: String(r.closing_yymm).replace(/^(\d{4})(\d{2})$/, '$1-$2'), closing: fromNum(r.closing_date), closingDay: Number(r.closingdd), due, customer: r.customers_cd, customerName: r.customers_name,
    site: `${r.field_cd}|${r.field_suffix}`, siteName: [r.field_name1, r.field_name2].filter(Boolean).join(' '), net: Number(r.money), tax: Number(r.consumption_tax), total, paid, balance: total - paid, issues, status,
    overdue: total > paid && due && due < today(), version: Number(r.row_version) };
};
export async function listInvoices(c, q = {}) {
  const args = [], w = [];
  if (q.month) { isoMonth(q.month); w.push('h.closing_yymm=?'); args.push(Number(q.month.replace('-', ''))); }
  if (q.customer) { w.push('h.customers_cd=?'); args.push(q.customer); }
  let list = (await rows(c, `${invoiceSql}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY h.closing_date DESC, h.customers_cd, h.invoice_id DESC LIMIT 1000`, args)).map(decodeInvoice);
  if (q.status === 'open') list = list.filter(i => i.balance > 0);
  else if (q.status) list = list.filter(i => i.status === q.status);
  return list;
}
export async function invoiceDetail(c, id) {
  const h = await one(c, `${invoiceSql} WHERE h.invoice_id=?`, [Number(id)]); check(h, '請求が見つかりません');
  const lines = await rows(c, 'SELECT * FROM billing_detail WHERE customers_cd=? AND closing_yymm=? AND claim_processing_period=? AND field_cd=? AND field_suffix=? ORDER BY sales_date, order_no', [h.customers_cd, h.closing_yymm, h.closing_date, h.field_cd, h.field_suffix]);
  const issues = await rows(c, 'SELECT issue_no, issued_at, issued_by, document_sha256 FROM invoice_issue WHERE invoice_id=? ORDER BY issue_no', [h.invoice_id]);
  const allocations = await rows(c, 'SELECT r.receipt_no, r.receipt_date, r.status, a.amount FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id WHERE a.invoice_id=? ORDER BY r.receipt_date', [h.invoice_id]);
  return { ...decodeInvoice(h), lines: lines.map(l => ({ orderNo: l.order_no, date: fromNum(l.sales_date), item: l.item_cd, itemName: l.item_name, quantity: Number(l.quantity), price: Number(l.unit_price), net: Number(l.money), taxRate: Number(l.tax_rate), remarks: l.remarks })),
    issueLog: issues.map(i => ({ no: i.issue_no, at: i.issued_at, by: i.issued_by, sha256: i.document_sha256 })), allocations: allocations.map(a => ({ receiptNo: a.receipt_no, date: a.receipt_date, status: a.status, amount: Number(a.amount) })) };
}
async function snapshot(c, inv) {
  const co = await one(c, 'SELECT * FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const cu = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [inv.customer]);
  const prior = await rows(c, `${invoiceSql} WHERE h.customers_cd=? AND h.field_cd=? AND h.field_suffix=? AND h.closing_date<?`, [inv.customer, ...inv.site.split('|'), toNum(inv.closing)]);
  const carried = prior.map(decodeInvoice).reduce((n, i) => n + i.balance, 0);
  const buckets = RATES.map(rate => { const net = inv.lines.filter(l => l.taxRate === rate).reduce((n, l) => n + l.net, 0); return { rate, net, tax: taxOf(net, rate) }; }).filter(b => b.net);
  const { start } = period(inv.month, inv.closingDay);
  return {
    company: { name: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), address: [co?.postcode && '〒' + co.postcode, co?.pref, co?.addr1, co?.addr2].filter(Boolean).join(' '), tel: co?.tel_no || '', plant: co?.plant_name || '' },
    customer: { code: inv.customer, name: cu?.customers_name || inv.customerName, address: cu?.addr1 || '', tel: cu?.tel_no || '' },
    site: { key: inv.site, name: inv.siteName }, invoiceId: inv.id, periodStart: start, closing: inv.closing, due: inv.due,
    carried, net: inv.net, tax: inv.tax, total: inv.total, grandTotal: carried + inv.total, buckets, lines: inv.lines,
  };
}
export async function issueInvoices(c, ctx, { ids }) {
  check(Array.isArray(ids) && ids.length > 0 && ids.length <= 200, '発行する請求を選択してください（最大200件）');
  const out = [];
  for (const id of [...new Set(ids.map(Number))].sort((a, b) => a - b)) {
    const h = await one(c, 'SELECT invoice_id FROM billing_head WHERE invoice_id=? FOR UPDATE', [id]); check(h, '請求が見つかりません');
    const inv = await invoiceDetail(c, id), snap = await snapshot(c, inv), no = (inv.issues || 0) + 1;
    const body = JSON.stringify({ ...snap, issueNo: no, issuedOn: today(), issuedBy: ctx.user.login_id }), sha = createHash('sha256').update(body).digest('hex');
    await c.query('INSERT INTO invoice_issue (invoice_id,issue_no,issued_at,issued_by,snapshot_json,document_sha256) VALUES (?,?,UTC_TIMESTAMP(6),?,?,?)', [id, no, ctx.user.login_id, body, sha]);
    await c.query("UPDATE billing_head SET invoice_flag=?, row_version=row_version+1 WHERE invoice_id=?", [no === 1 ? '1' : '2', id]);
    await c.query("UPDATE billing_detail SET invoice_issud_flag='1' WHERE customers_cd=? AND claim_processing_period=? AND field_cd=? AND field_suffix=?", [inv.customer, toNum(inv.closing), ...inv.site.split('|')]);
    await audit(c, ctx, 'billing_head', id, no === 1 ? 'invoice.issue' : 'invoice.reissue', { issueNo: no, sha256: sha });
    out.push({ ...JSON.parse(body), reissue: no > 1 });
  }
  return { documents: out };
}
export async function issuedDocument(c, id) {
  const r = await one(c, 'SELECT snapshot_json, issue_no FROM invoice_issue WHERE invoice_id=? ORDER BY issue_no DESC LIMIT 1', [Number(id)]); check(r, '発行履歴がありません');
  const s = typeof r.snapshot_json === 'string' ? JSON.parse(r.snapshot_json) : r.snapshot_json; return { ...s, issueNo: r.issue_no, reissue: r.issue_no > 1, copy: true };
}
export async function cancelInvoice(c, ctx, { id }) {
  const h = await one(c, 'SELECT * FROM billing_head WHERE invoice_id=? FOR UPDATE', [Number(id)]); check(h, '請求が見つかりません');
  await assertOpen(c, fromNum(h.closing_date));
  check(!(await one(c, 'SELECT 1 x FROM invoice_issue WHERE invoice_id=? LIMIT 1', [h.invoice_id])), '発行済みの請求は取消できません（発行履歴を保全するため）');
  check(!(await one(c, 'SELECT 1 x FROM receipt_allocation WHERE invoice_id=? LIMIT 1', [h.invoice_id])), '入金消込のある請求は取消できません');
  const keys = [h.customers_cd, h.closing_yymm, h.closing_date, h.field_cd, h.field_suffix];
  const orders = await rows(c, 'SELECT order_no FROM billing_detail WHERE customers_cd=? AND closing_yymm=? AND claim_processing_period=? AND field_cd=? AND field_suffix=? FOR UPDATE', keys);
  for (const o of orders) {
    await c.query("UPDATE sales_trn SET process_status='0', claim_processing_period=NULL WHERE order_no=?", [o.order_no]);
    await c.query('UPDATE shipment_slip SET claim_status=0, claim_processing_period=0 WHERE order_no=?', [o.order_no]);
  }
  await c.query('DELETE FROM billing_detail WHERE customers_cd=? AND closing_yymm=? AND claim_processing_period=? AND field_cd=? AND field_suffix=?', keys);
  await reverseJournal(c, { sourceType: 'billing_head', sourceId: h.invoice_id, date: fromNum(h.closing_date) });
  await c.query('DELETE FROM billing_head WHERE invoice_id=?', [h.invoice_id]);
  await audit(c, ctx, 'billing_head', h.invoice_id, 'billing.cancel', { customer: h.customers_cd, closing: fromNum(h.closing_date), orders: orders.length });
  return { cancelled: h.invoice_id };
}

// ---------- 入金・消込 (receipt / receipt_component / receipt_allocation) ----------
export async function openInvoices(c, customer) {
  return (await listInvoices(c, { customer: String(customer || ''), status: 'open' })).filter(i => i.issues > 0).sort((a, b) => a.closing.localeCompare(b.closing));
}
const BANK_SUB = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='receipt' AND je.source_id=CAST(r.receipt_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
export async function listReceipts(c, q = {}) {
  const args = [], w = [];
  if (q.month) { isoMonth(q.month); w.push("DATE_FORMAT(r.receipt_date,'%Y-%m')=?"); args.push(q.month); }
  if (q.customer) { w.push('r.customers_cd=?'); args.push(q.customer); }
  const rs = await rows(c, `SELECT r.*, c.customers_name, ${BANK_SUB} bank_code FROM receipt r LEFT JOIN client_m c ON c.customers_cd=r.customers_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.receipt_date DESC, r.receipt_id DESC LIMIT 1000`, args);
  const comps = rs.length ? await rows(c, `SELECT * FROM receipt_component WHERE receipt_id IN (${rs.map(() => '?').join(',')})`, rs.map(r => r.receipt_id)) : [];
  const allocs = rs.length ? await rows(c, `SELECT a.*, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${rs.map(() => '?').join(',')})`, rs.map(r => r.receipt_id)) : [];
  return rs.map(r => {
    const part = k => Number(comps.find(x => x.receipt_id === r.receipt_id && x.component_kind === k)?.amount || 0);
    return { id: r.receipt_id, no: r.receipt_no, date: r.receipt_date, customer: r.customers_cd, customerName: r.customers_name, received: Number(r.received_amount), settlement: Number(r.settlement_amount),
      bank: part('BANK'), cash: part('CASH'), notes: part('NOTE'), fee: part('FEE'), discount: part('DISCOUNT'), bankCode: r.bank_code || '', status: r.status,
      allocations: allocs.filter(a => a.receipt_id === r.receipt_id).map(a => ({ invoiceId: a.invoice_id, closing: fromNum(a.closing_date), amount: Number(a.amount) })) };
  });
}
export async function createReceipt(c, ctx, p) {
  const idem = text(p.idempotencyKey, '処理キー', 100);
  const dup = await one(c, 'SELECT receipt_id, receipt_no FROM receipt WHERE idempotency_key=?', [idem]);
  if (dup) return { id: dup.receipt_id, no: dup.receipt_no, duplicate: true };
  const date = isoDate(p.date, '入金日'); await assertOpen(c, date);
  const cust = await one(c, 'SELECT customers_cd FROM client_m WHERE customers_cd=?', [String(p.customer || '')]); check(cust, '得意先を選択してください');
  const parts = { BANK: yen(p.bank || 0, '振込'), CASH: yen(p.cash || 0, '現金'), NOTE: yen(p.notes || 0, '手形'), FEE: yen(p.fee || 0, '振込手数料'), DISCOUNT: yen(p.discount || 0, '値引・端数') };
  const received = parts.BANK + parts.CASH + parts.NOTE, settlement = received + parts.FEE + parts.DISCOUNT;
  check(settlement > 0, '入金額を入力してください');
  let bankCode = null;
  if (parts.BANK) { bankCode = String(p.bankCode || ''); const b = await one(c, "SELECT category1 FROM code_m WHERE code_key='BANK' AND code_dtl=?", [bankCode]); check(b && b.category1 !== '0', '入金口座（銀行）を選択してください'); }
  const noteDue = parts.NOTE ? isoDate(p.noteDue, '手形期日') : null;
  check(Array.isArray(p.allocations) && p.allocations.length > 0, '消込対象の請求を選択してください');
  const allocs = p.allocations.map(a => ({ id: Number(a.invoiceId), amount: yen(a.amount, '消込額') })).filter(a => a.amount > 0);
  check(allocs.length && new Set(allocs.map(a => a.id)).size === allocs.length, '消込対象が不正です');
  allocs.sort((a, b) => a.id - b.id);
  for (const a of allocs) {
    // Lock first, then read the balance in a separate statement so the read sees concurrent commits.
    const h = await one(c, 'SELECT h.* FROM billing_head h WHERE h.invoice_id=? FOR UPDATE', [a.id]);
    if (h) h.paid = (await one(c, `SELECT ${PAID} paid FROM billing_head h WHERE h.invoice_id=?`, [a.id])).paid;
    check(h, '請求が見つかりません'); check(h.customers_cd === cust.customers_cd, '異なる得意先の請求には消込できません');
    check(h.invoice_flag !== '0', '請求書発行後に消込できます'); check(date >= fromNum(h.closing_date), '入金日が請求締日より前です');
    check(a.amount <= Number(h.money) + Number(h.consumption_tax) - Number(h.paid), `請求(${fromNum(h.closing_date)}締)の残高を超えています`);
    a.closing = fromNum(h.closing_date);
  }
  check(allocs.reduce((n, a) => n + a.amount, 0) === settlement, '入金合計（手数料・値引を含む）と消込合計が一致しません');
  const no = await nextNo(c, 'receipt');
  const [r] = await c.query("INSERT INTO receipt (receipt_no,customers_cd,receipt_date,received_amount,settlement_amount,status,idempotency_key,created_at) VALUES (?,?,?,?,?,'POSTED',?,UTC_TIMESTAMP(6))", [no, cust.customers_cd, date, received, settlement, idem]);
  let n = 0;
  for (const [k, v] of Object.entries(parts)) if (v) await c.query('INSERT INTO receipt_component (receipt_id,component_no,component_kind,amount,maturity_date) VALUES (?,?,?,?,?)', [r.insertId, ++n, k, v, k === 'NOTE' ? noteDue : null]);
  for (const a of allocs) await c.query('INSERT INTO receipt_allocation (receipt_id,invoice_id,customers_cd,amount) VALUES (?,?,?,?)', [r.insertId, a.id, cust.customers_cd, a.amount]);
  await postJournal(c, { date, pattern: 'B01', sourceType: 'receipt', sourceId: r.insertId, lines: [
    line('D', '1112', parts.BANK, { sub: bankCode }), line('D', '1111', parts.CASH), line('D', '1120', parts.NOTE), line('D', '8330', parts.FEE, { sub: '101', dept: '063' }), line('D', '8850', parts.DISCOUNT, { dept: '063' }),
    ...allocs.map(a => line('C', '1131', a.amount, { customer: cust.customers_cd })) ] });
  await audit(c, ctx, 'receipt', r.insertId, 'receipt.create', { no, customer: cust.customers_cd, received, settlement, invoices: allocs.map(a => a.id) });
  return { id: r.insertId, no };
}
export async function reverseReceipt(c, ctx, { id }) {
  const r = await one(c, 'SELECT * FROM receipt WHERE receipt_id=? FOR UPDATE', [Number(id)]); check(r, '入金が見つかりません');
  check(r.status === 'POSTED', '取消済みです'); await assertOpen(c, r.receipt_date);
  await c.query("UPDATE receipt SET status='REVERSED', row_version=row_version+1 WHERE receipt_id=?", [r.receipt_id]);
  await reverseJournal(c, { sourceType: 'receipt', sourceId: r.receipt_id, date: r.receipt_date });
  await audit(c, ctx, 'receipt', r.receipt_id, 'receipt.reverse', { no: r.receipt_no });
  return { id: r.receipt_id };
}
