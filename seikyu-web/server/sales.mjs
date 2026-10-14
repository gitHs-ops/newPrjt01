import { createHash } from 'node:crypto';
import { check, Conflict, yen, qty, lineAmount, taxOf, isoDate, isoMonth, toNum, fromNum, period, dueDate, closingDay, text, RATES, METHODS, today } from './domain.mjs';
import { rows, one, nextNo, assertOpen, audit, stamp, postJournal, reverseJournal, line } from './db.mjs';

const site = s => { const [code = '', suffix = ''] = String(s || '').split('|'); return { code, suffix }; };
const monthRange = m => { isoMonth(m); return [toNum(m + '-01'), toNum(m + '-31')]; };
const num = v => Number(v || 0);
// Tax per rate bucket, truncated toward zero so correction (negative) buckets mirror positive ones.
const bucketTax = (net, rate) => (net >= 0 ? taxOf(net, rate) : -taxOf(-net, rate));
export const SHIP_KB = { 1: '出荷売上', 2: '訂正' };

// Billing heads are per customer (field_cd=''), per NO6. Older per-site heads keep their site key.
const DETAIL_JOIN = "d.customers_cd=h.customers_cd AND d.closing_yymm=h.closing_yymm AND d.claim_processing_period=h.closing_date AND (h.field_cd='' OR (d.field_cd=h.field_cd AND d.field_suffix=h.field_suffix))";
const detailWhere = h => ({ sql: `customers_cd=? AND closing_yymm=? AND claim_processing_period=?${h.field_cd ? ' AND field_cd=? AND field_suffix=?' : ''}`, args: [h.customers_cd, h.closing_yymm, h.closing_date, ...(h.field_cd ? [h.field_cd, h.field_suffix] : [])] });

// ---------- 出荷・売上 (shipment_slip + sales_trn) ----------
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
  if (q.method) { where += ' AND s.payment_method_cd=?'; args.push(Number(q.method)); }
  const rs = await rows(c, `SELECT s.*, c.customers_name, sl.vehicle_no, sl.unit_cd unit, h.invoice_id,
      (SELECT COALESCE(SUM(x.quantity),0) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrected
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN shipment_slip sl ON sl.order_no=s.order_no
    LEFT JOIN billing_detail d ON d.order_no=s.order_no LEFT JOIN billing_head h ON ${DETAIL_JOIN}
    WHERE s.sales_date BETWEEN ? AND ?${where} ORDER BY s.sales_date DESC, s.order_no DESC LIMIT 1000`, args);
  return rs.map(r => ({ orderNo: r.order_no, date: fromNum(r.sales_date), customer: r.customers_cd, customerName: r.customers_name, site: `${r.field_cd}|${r.field_suffix}`, siteName: [r.field_name1, r.field_name2].filter(Boolean).join(' '),
    item: r.item_cd, itemName: r.item_name, quantity: Number(r.quantity), unit: r.unit || '', price: Number(r.unit_price), net: Number(r.money), taxRate: Number(r.tax_rate), tax: Number(r.consumption_tax),
    method: Number(r.payment_method_cd), methodName: METHODS[r.payment_method_cd] || '', billed: r.process_status === '1', invoiceId: r.invoice_id || null, vehicle: r.vehicle_no || '', remarks: r.remarks || '',
    shipKb: Number(r.ship_kb || 1), originalNo: r.sales_no !== r.order_no ? r.sales_no : '', corrected: Number(r.corrected) }));
}
async function insertSlip(c, { orderNo, shipKb, date, cust, f, it, q, price, net, rate, tax, method, paid, vehicle, remarks, salesNo, salesSuffix }) {
  const st = stamp();
  await c.query(`INSERT INTO shipment_slip (order_no,ship_kb,shipment_dt,weather_cd,customers_cd,other_company_customers_cd,delivery_cd,delivery_name,field_cd,field_suffix,field_name1,field_name2,item_cd,delivery_kbn_cd,quantity,unit_cd,cumulative_quantity,plan_cumulative_quantity,unit_price,money,tax_rate,consumption_tax,payment_method_cd,payment_money,vehicle_no,cumulative_number,start_time,plan_start_time,start_temperature,person_in_charge_cd,slip_remark,ship_printing_fg1,ship_printing_fg2,ship_printing_fg3,ship_printing_fg4,printing_settled_fg,claim_status,claim_processing_period,freight,card_sales_sts,card_sales_dt,card_member_id,card_order_id,card_credit_dt,update_daytime,order_processing_period)
    VALUES (?,?,?,NULL,?,'','','',?,?,?,?,?,0,?,?,0,0,?,?,?,?,?,?,?,0,'','',NULL,'',?,0,0,0,0,0,0,0,0,0,NULL,'','',NULL,UTC_TIMESTAMP(6),NULL)`,
    [orderNo, shipKb, date, cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1.slice(0, 20), f.field_name2.slice(0, 20), it.item_cd, q.text, it.unit, price, net, rate, tax, method, paid, vehicle, remarks]);
  await c.query(`INSERT INTO sales_trn (order_no,order_suffix,sales_date,sales_no,sales_suffix,ship_kb,customers_cd,field_cd,field_suffix,field_name1,field_name2,shipping_kb,item_cd,item_name,item_zaiko_cd,quantity,unit_cd,unit_price,money,proc_kb,tax_kb,tax_rate,consumption_tax,remarks,claim_processing_period,payment_method_cd,payment_money,process_status,update_day,update_time,update_pgm,update_ws)
    VALUES (?,1,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL,?,?,'1','1',?,?,?,NULL,?,?,'0',?,?,?,?)`,
    [orderNo, toNum(date), salesNo || orderNo, salesSuffix || 1, String(shipKb), cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1, f.field_name2, it.item_cd, it.item_nam.slice(0, 20), it.item_cd, q.text, price, net, rate, tax, remarks, method, paid, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
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
    check(old.process_status === '0', '請求済みの出荷は変更できません（「訂正」で数量を訂正してください）');
    check(old.ship_kb !== '2', '訂正伝票は変更できません。取消して再登録してください');
    await assertOpen(c, fromNum(old.sales_date));
    await c.query(`UPDATE sales_trn SET sales_date=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,item_name=?,quantity=?,unit_price=?,money=?,tax_rate=?,consumption_tax=?,remarks=?,payment_method_cd=?,payment_money=?,update_day=?,update_time=?,update_pgm=?,update_ws=? WHERE order_no=? AND order_suffix=1`,
      [toNum(date), cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1, f.field_name2, it.item_cd, it.item_nam.slice(0, 20), q.text, price, net, rate, tax, remarks, method, paid, st.update_day, st.update_time, st.update_pgm, st.update_ws, orderNo]);
    await c.query('UPDATE shipment_slip SET shipment_dt=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,quantity=?,unit_cd=?,unit_price=?,money=?,tax_rate=?,consumption_tax=?,payment_method_cd=?,payment_money=?,vehicle_no=?,slip_remark=?,update_daytime=UTC_TIMESTAMP(6) WHERE order_no=?',
      [date, cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1.slice(0, 20), f.field_name2.slice(0, 20), it.item_cd, q.text, it.unit, price, net, rate, tax, method, paid, vehicle, remarks, orderNo]);
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.update', { date, customer: cust.customers_cd, item: it.item_cd, net });
  } else {
    orderNo = await nextNo(c, 'sales');
    await insertSlip(c, { orderNo, shipKb: 1, date, cust, f, it, q, price, net, rate, tax, method, paid, vehicle, remarks });
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.create', { date, customer: cust.customers_cd, item: it.item_cd, net });
  }
  return { orderNo };
}
// NO11 出荷伝票訂正: one correction slip (ship_kb 2) per request, quantity may be negative.
// Linked to the original through sales_no / sales_suffix. Customer, site, item, price, tax and method are inherited.
export async function correctShipment(c, ctx, p) {
  const orig = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [String(p.orderNo || '')]);
  if (!orig) throw new Conflict('訂正元の出荷伝票が見つかりません');
  check(orig.ship_kb !== '2', '訂正伝票をさらに訂正することはできません。元の伝票から訂正してください');
  const date = isoDate(p.date, '訂正日'); await assertOpen(c, date);
  check(date >= fromNum(orig.sales_date), '訂正日が元伝票の出荷日より前です');
  const q = qty(p.quantity, '訂正数量', { positive: false, allowNegative: true }); check(q.scaled !== 0n, '訂正数量を入力してください');
  const prev = await one(c, 'SELECT COALESCE(SUM(quantity),0) q, COUNT(*) n FROM sales_trn WHERE sales_no=? AND order_no<>?', [orig.order_no, orig.order_no]);
  check(Number(orig.quantity) + Number(prev.q) + Number(q.text) >= 0, `訂正後の数量がマイナスになります（元 ${Number(orig.quantity)} / 訂正済 ${Number(prev.q)}）`);
  const cust = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [orig.customers_cd]);
  const f = await one(c, 'SELECT * FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [orig.customers_cd, orig.field_cd, orig.field_suffix]) || { field_cd: orig.field_cd, field_suffix: orig.field_suffix, field_name1: orig.field_name1 || '', field_name2: orig.field_name2 || '' };
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [orig.item_cd]);
  const price = Number(orig.unit_price), rate = Math.round(Number(orig.tax_rate)), method = Number(orig.payment_method_cd);
  const net = lineAmount(q, price), tax = bucketTax(net, rate), paid = method === 1 ? 0 : net + tax;
  const remarks = text(p.remarks || `訂正 ${orig.order_no}`, '備考', 20);
  const orderNo = await nextNo(c, 'sales');
  await insertSlip(c, { orderNo, shipKb: 2, date, cust, f, it, q, price, net, rate, tax, method, paid, vehicle: '', remarks, salesNo: orig.order_no, salesSuffix: Number(prev.n) + 2 });
  await audit(c, ctx, 'sales_trn', orderNo, 'shipment.correct', { original: orig.order_no, quantity: q.text, net });
  return { orderNo, original: orig.order_no, net };
}
export async function deleteShipment(c, ctx, { orderNo }) {
  const old = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [String(orderNo || '')]);
  if (!old) throw new Conflict('出荷伝票が見つかりません。再読込してください');
  check(old.process_status === '0', '請求済みの出荷は取消できません');
  check(!(await one(c, 'SELECT 1 x FROM sales_trn WHERE sales_no=? AND order_no<>? LIMIT 1', [orderNo, orderNo])), '訂正伝票がある出荷は取消できません（先に訂正伝票を取消してください）');
  await assertOpen(c, fromNum(old.sales_date));
  await c.query('DELETE FROM sales_trn WHERE order_no=?', [orderNo]);
  await c.query('DELETE FROM shipment_slip WHERE order_no=?', [orderNo]);
  await audit(c, ctx, 'sales_trn', orderNo, 'shipment.delete', { date: fromNum(old.sales_date), customer: old.customers_cd, net: Number(old.money) });
  return { orderNo };
}

// ---------- 請求締め (NO6: billing_head per customer, billing_detail per order) ----------
const PAID = "COALESCE((SELECT SUM(a.amount) FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.invoice_id=h.invoice_id),0)";
const totals = list => {
  const net = list.reduce((n, s) => n + num(s.money), 0);
  const tax = RATES.reduce((n, r) => n + bucketTax(list.filter(s => Math.round(num(s.tax_rate)) === r).reduce((a, s) => a + num(s.money), 0), r), 0);
  return { net, tax };
};
export async function billingPreview(c, { month, closing }) {
  const { start, end } = period(month, closing), day = closingDay(closing);
  const custs = await rows(c, "SELECT customers_cd, customers_name FROM client_m WHERE delete_f<>'1' AND CAST(deadline AS UNSIGNED)=? ORDER BY customers_cd", [day]);
  const out = [];
  for (const cu of custs) {
    const sales = await rows(c, "SELECT payment_method_cd, money, tax_rate, field_cd, field_suffix, sales_date FROM sales_trn WHERE customers_cd=? AND process_status='0' AND sales_date<=?", [cu.customers_cd, toNum(end)]);
    const credit = sales.filter(s => Number(s.payment_method_cd) === 1), t = totals(credit);
    const made = await one(c, 'SELECT COUNT(*) n FROM billing_head WHERE customers_cd=? AND closing_date=?', [cu.customers_cd, toNum(end)]);
    out.push({ customer: cu.customers_cd, name: cu.customers_name, count: credit.length, sites: new Set(credit.map(s => s.field_cd + s.field_suffix)).size, net: t.net, tax: t.tax,
      excluded: sales.length - credit.length, late: credit.filter(x => fromNum(x.sales_date) < start).length, created: Number(made.n) });
  }
  return { start, end, due: dueDate(end), customers: out };
}
// 回収条件（得意先マスタ code_m CSITE: category1=月後, category2=日）→ 支払期日。未設定は締日の翌月末（推定）。
export async function customerSite(c, customer) {
  const r = await one(c, "SELECT category1 m, category2 d, category3 method, code_dtl_abr bank FROM code_m WHERE code_key='CSITE' AND code_dtl=?", [customer]);
  return { months: r ? Number(r.m || 1) : 1, day: r ? Number(r.d || 31) : 31, method: r?.method || '', bank: r?.bank || '', set: !!r };
}
export const siteDue = (end, site) => { const [y, m] = end.split('-').map(Number); const last = new Date(Date.UTC(y, m - 1 + site.months + 1, 0)); const d = Math.min(site.day, last.getUTCDate()); return new Date(Date.UTC(y, m - 1 + site.months, d)).toISOString().slice(0, 10); };
const signed = (side, acc, v, extra) => line(v >= 0 ? side : (side === 'D' ? 'C' : 'D'), acc, Math.abs(v), extra);
async function postBillingJournal(c, id, end, customer, net, tax) {
  if (net + tax === 0 && net === 0) return;
  await postJournal(c, { date: end, pattern: 'A01', sourceType: 'billing_head', sourceId: id,
    lines: [signed('D', '1131', net + tax, { customer, tax: '9' }), signed('C', '8130', net, { dept: '063', tax: '11' }), signed('C', '4415', tax, { tax: '9' })] });
}
// 請求締め（NO6）: 当期締日までの未請求掛売上（前回締め後に入力された過去日付の売上・訂正伝票を含む）を得意先単位で請求。
// 同じ締日の請求が未発行・未消込なら追加分を加算、発行済みなら次回締めで請求。マイナス（訂正のみ）はクレジット請求として作成。
export async function runBilling(c, ctx, { month, closing, customers }) {
  const { end } = period(month, closing), day = closingDay(closing); await assertOpen(c, end);
  check(end <= today(), `締日（${end}）が到来していないため請求締めはできません`);
  let targets = await rows(c, "SELECT * FROM client_m WHERE delete_f<>'1' AND CAST(deadline AS UNSIGNED)=? ORDER BY customers_cd", [day]);
  if (Array.isArray(customers) && customers.length) targets = targets.filter(t => customers.includes(t.customers_cd));
  check(targets.length, `締日${day}日の有効な得意先がありません`);
  const created = [], appended = [], skipped = [], st = stamp(), yymm = Number(month.replace('-', ''));
  for (const cu of targets) {
    const list = await rows(c, "SELECT * FROM sales_trn WHERE customers_cd=? AND process_status='0' AND payment_method_cd=1 AND sales_date<=? ORDER BY field_cd, field_suffix, sales_date, order_no FOR UPDATE", [cu.customers_cd, toNum(end)]);
    if (!list.length) continue;
    let h = await one(c, 'SELECT * FROM billing_head WHERE customers_cd=? AND closing_date=? FOR UPDATE', [cu.customers_cd, toNum(end)]);
    if (h) {
      const locked = h.invoice_flag !== '0' || await one(c, 'SELECT 1 x FROM receipt_allocation WHERE invoice_id=? LIMIT 1', [h.invoice_id]);
      if (locked) { skipped.push(cu.customers_name + ': ' + end + '締の請求は発行済みのため、追加分 ' + list.length + '件は次回締めで請求されます'); continue; }
    }
    const site = await customerSite(c, cu.customers_cd);
    if (!h) {
      const [r] = await c.query("INSERT INTO billing_head (closing_yymm,closingdd,closing_date,customers_cd,field_cd,field_suffix,claim_processing_period,money,consumption_tax,payment_method_cd,invoice_proc_flag,invoice_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,?,?,'','',?,0,0,1,'1','0',?,?,?,?)",
        [yymm, day, toNum(end), cu.customers_cd, toNum(siteDue(end, site)), st.update_day, st.update_time, st.update_pgm, st.update_ws]);
      h = { invoice_id: r.insertId, isNew: true };
    }
    for (const s2 of list) {
      await c.query("INSERT INTO billing_detail (closing_yymm,closingdd,claim_processing_period,customers_cd,sales_date,order_no,ship_kb,item_cd,item_name,quantity,unit_cd,unit_price,money,tax_kb,tax_rate,consumption_tax,remarks,field_cd,field_suffix,field_name,payment_method_cd,shipping_kb,invoice_issud_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,'0',?,?,?,?)",
        [yymm, day, toNum(end), cu.customers_cd, s2.sales_date, s2.order_no, s2.ship_kb, s2.item_cd, (s2.item_name || '').slice(0, 22), s2.quantity, s2.unit_price, s2.money, s2.tax_kb, Math.round(num(s2.tax_rate)), s2.consumption_tax, s2.remarks, s2.field_cd, s2.field_suffix, (s2.field_name1 || '').slice(0, 40), s2.payment_method_cd, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
      await c.query("UPDATE sales_trn SET process_status='1', claim_processing_period=? WHERE order_no=? AND order_suffix=?", [toNum(end), s2.order_no, s2.order_suffix]);
      await c.query('UPDATE shipment_slip SET claim_status=1, claim_processing_period=? WHERE order_no=?', [yymm, s2.order_no]);
    }
    // Totals are recomputed from all detail lines of the head (tax per rate bucket on the whole invoice).
    const all = await rows(c, "SELECT money, tax_rate FROM billing_detail WHERE customers_cd=? AND closing_yymm=? AND claim_processing_period=?", [cu.customers_cd, yymm, toNum(end)]);
    const { net, tax } = totals(all);
    await c.query('UPDATE billing_head SET money=?, consumption_tax=?, row_version=row_version+1 WHERE invoice_id=?', [net, tax, h.invoice_id]);
    if (!h.isNew) await reverseJournal(c, { sourceType: 'billing_head', sourceId: h.invoice_id, date: end });
    await postBillingJournal(c, h.invoice_id, end, cu.customers_cd, net, tax);
    (h.isNew ? created : appended).push(h.invoice_id);
    await audit(c, ctx, 'billing_head', h.invoice_id, h.isNew ? 'billing.create' : 'billing.append', { customer: cu.customers_cd, closing: end, net, tax, lines: list.length, lateEntries: list.filter(x => fromNum(x.sales_date) < period(month, closing).start).length, credit: net + tax < 0 });
  }
  check(created.length + appended.length, skipped.length ? '請求を作成できません: ' + skipped.join(' / ') : '対象の未請求掛売上がありません');
  await c.query("INSERT INTO billing_closing_inf (closing_yymm,closingdd,invoice_proc_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,'1',?,?,?,?) ON DUPLICATE KEY UPDATE invoice_proc_flag='1',update_day=VALUES(update_day),update_time=VALUES(update_time)",
    [yymm, day, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
  return { created: created.length, appended: appended.length, ids: [...created, ...appended], skipped };
}
const invoiceSql = `SELECT h.*, c.customers_name, f.field_name1, f.field_name2, ${PAID} paid, (SELECT MAX(issue_no) FROM invoice_issue i WHERE i.invoice_id=h.invoice_id) issues
  FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd LEFT JOIN field_name_m f ON f.customers_cd=h.customers_cd AND f.field_cd=h.field_cd AND f.field_suffix=h.field_suffix`;
const decodeInvoice = r => {
  const total = num(r.money) + num(r.consumption_tax), paid = num(r.paid), issues = num(r.issues), due = fromNum(r.claim_processing_period);
  const status = total < 0 ? 'credit' : paid >= total ? 'paid' : paid > 0 ? 'partial' : issues ? 'issued' : 'draft';
  return { id: r.invoice_id, month: String(r.closing_yymm).replace(/^(\d{4})(\d{2})$/, '$1-$2'), closing: fromNum(r.closing_date), closingDay: num(r.closingdd), due, customer: r.customers_cd, customerName: r.customers_name,
    site: r.field_cd ? `${r.field_cd}|${r.field_suffix}` : '', siteName: r.field_cd ? [r.field_name1, r.field_name2].filter(Boolean).join(' ') : '（得意先単位）', net: num(r.money), tax: num(r.consumption_tax), total, paid, balance: total - paid, issues, status,
    overdue: total > paid && due && due < today(), version: num(r.row_version) };
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
const decodeLine = l => ({ unit: l.unit || '', orderNo: l.order_no, date: fromNum(l.sales_date), site: `${l.field_cd}|${l.field_suffix}`, siteName: l.field_name || '', item: l.item_cd, itemName: l.item_name, quantity: num(l.quantity), price: num(l.unit_price),
  net: num(l.money), taxRate: num(l.tax_rate), remarks: l.remarks || '', shipKb: Number(l.ship_kb || 1) });
async function headLines(c, h) { const w = detailWhere(h); return (await rows(c, `SELECT d.*, i.unit FROM billing_detail d LEFT JOIN item_m i ON i.item_cd=d.item_cd WHERE ${w.sql.replace(/(^|AND )(\w+)=/g, '$1d.$2=')} ORDER BY d.field_cd, d.field_suffix, d.sales_date, d.order_no`, w.args)).map(decodeLine); }
export async function invoiceDetail(c, id) {
  const h = await one(c, `${invoiceSql} WHERE h.invoice_id=?`, [Number(id)]); check(h, '請求が見つかりません');
  const issues = await rows(c, 'SELECT issue_no, issued_at, issued_by, document_sha256 FROM invoice_issue WHERE invoice_id=? ORDER BY issue_no', [h.invoice_id]);
  const allocations = await rows(c, 'SELECT r.receipt_no, r.receipt_date, r.status, a.amount FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id WHERE a.invoice_id=? ORDER BY r.receipt_date', [h.invoice_id]);
  return { ...decodeInvoice(h), lines: await headLines(c, h),
    issueLog: issues.map(i => ({ no: i.issue_no, at: i.issued_at, by: i.issued_by, sha256: i.document_sha256 })), allocations: allocations.map(a => ({ receiptNo: a.receipt_no, date: a.receipt_date, status: a.status, amount: num(a.amount) })) };
}

// ---------- 得意先別請求計算（NO12/NO13/請求書で共通のロジック） ----------
// 前回請求額 = 開始残高 + 前回締日までの請求 − 今回期間開始前の入金
// 差引繰越額 = 前回請求額 − 今回期間の入金 / 今回請求額 = 差引繰越額 + 今回お買上額 + 消費税
export async function statement(c, customer, month, closing) {
  const { start, end } = period(month, closing);
  const v = async (sql, args) => num(Object.values(await one(c, sql, args))[0]);
  const opening = await v("SELECT COALESCE(SUM(amount),0) FROM opening_balance WHERE customers_cd=? AND balance_kind='AR'", [customer]);
  const billedBefore = await v('SELECT COALESCE(SUM(money+consumption_tax),0) FROM billing_head WHERE customers_cd=? AND closing_date<?', [customer, toNum(end)]);
  const recBefore = await v("SELECT COALESCE(SUM(settlement_amount),0) FROM receipt WHERE customers_cd=? AND status='POSTED' AND receipt_date<?", [customer, start]);
  const received = await v("SELECT COALESCE(SUM(settlement_amount),0) FROM receipt WHERE customers_cd=? AND status='POSTED' AND receipt_date BETWEEN ? AND ?", [customer, start, end]);
  const heads = await rows(c, `${invoiceSql} WHERE h.customers_cd=? AND h.closing_date=? ORDER BY h.invoice_id`, [customer, toNum(end)]);
  let net, tax, lines;
  if (heads.length) {
    net = heads.reduce((n, h) => n + num(h.money), 0); tax = heads.reduce((n, h) => n + num(h.consumption_tax), 0);
    lines = []; for (const h of heads) lines.push(...await headLines(c, h));
  } else {
    const sales = await rows(c, "SELECT s.*, i.unit FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd WHERE s.customers_cd=? AND s.process_status='0' AND s.payment_method_cd=1 AND s.sales_date<=? ORDER BY s.field_cd, s.field_suffix, s.sales_date, s.order_no", [customer, toNum(end)]);
    ({ net, tax } = totals(sales));
    lines = sales.map(s => decodeLine({ ...s, field_name: s.field_name1 }));
  }
  const prevBalance = opening + billedBefore - recBefore, carried = prevBalance - received;
  const inv = heads.map(decodeInvoice);
  return { customer, start, end, due: heads.length ? fromNum(heads[0].claim_processing_period) : siteDue(end, await customerSite(c, customer)), prevBalance, received, carried, net, tax, current: net + tax, total: carried + net + tax, lines,
    invoiceIds: inv.map(i => i.id), issues: inv.reduce((n, i) => Math.max(n, i.issues), 0), state: !heads.length ? 'none' : inv.every(i => i.issues) ? 'issued' : 'draft' };
}
const STATE = { none: '未作成', draft: '未発行', issued: '発行済' };
// NO12 請求一覧表（確認用）: one row per customer for the closing.
export async function billingList(c, { month, closing }) {
  const { end } = period(month, closing), day = closingDay(closing);
  const custs = await rows(c, "SELECT customers_cd, customers_name FROM client_m WHERE (delete_f<>'1' AND CAST(deadline AS UNSIGNED)=?) OR customers_cd IN (SELECT customers_cd FROM billing_head WHERE closing_date=?) ORDER BY customers_cd", [day, toNum(end)]);
  const out = [];
  for (const cu of custs) {
    const s = await statement(c, cu.customers_cd, month, closing);
    if (!s.lines.length && !s.prevBalance && !s.received) continue;
    const sites = [...new Set(s.lines.map(l => l.site))].map(k => { const ls = s.lines.filter(l => l.site === k), net = ls.reduce((n, l) => n + l.net, 0);
      const tax = RATES.reduce((n, r) => n + bucketTax(ls.filter(l => l.taxRate === r).reduce((a, l) => a + l.net, 0), r), 0); return { site: k, siteName: ls[0]?.siteName || '', net, tax, discount: 0, total: net + tax }; });
    out.push({ ...s, name: cu.customers_name, stateName: STATE[s.state], lineCount: s.lines.length, discount: 0, sites, lines: undefined });
  }
  return { month, closing: day, end, rows: out };
}
// NO13 請求書発行確認表: issued customers with lines, same calculation as NO12.
export async function billingConfirm(c, { month, closing }) {
  const { end } = period(month, closing);
  const heads = await rows(c, "SELECT DISTINCT h.customers_cd, c.customers_name FROM billing_head h JOIN client_m c ON c.customers_cd=h.customers_cd WHERE h.closing_date=? AND EXISTS (SELECT 1 FROM invoice_issue i WHERE i.invoice_id=h.invoice_id) ORDER BY h.customers_cd", [toNum(end)]);
  const out = [];
  for (const h of heads) {
    const s = await statement(c, h.customers_cd, month, closing);
    const last = await one(c, `SELECT i.issue_no, i.issued_at, i.issued_by FROM invoice_issue i WHERE i.invoice_id IN (${s.invoiceIds.map(() => '?').join(',')}) ORDER BY i.issued_at DESC LIMIT 1`, s.invoiceIds);
    out.push({ ...s, name: h.customers_name, lastIssue: last ? { no: last.issue_no, at: last.issued_at, by: last.issued_by } : null });
  }
  return { month, end, rows: out };
}
export async function companyProfile(c) {
  const co = await one(c, 'SELECT * FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const set = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_abr FROM code_m WHERE code_key='SET'")).map(r => [r.code_dtl, r.code_dtl_abr]));
  let bankText = '';
  if (set.INVBANK) {
    const z = await one(c, "SELECT b.code_dtl_nam name, z.category1 bk, z.category2 bt, z.category3 acc FROM code_m b LEFT JOIN code_m z ON z.code_key='ZGN' AND z.code_dtl=b.code_dtl WHERE b.code_key='BANK' AND b.code_dtl=?", [set.INVBANK]);
    if (z) {
      const dir = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BKDIR' AND code_dtl IN (?, ?)", [z.bk || '', (z.bk || '') + '-' + String(z.bt || '').slice(0, 3)])).map(r => [r.code_dtl, r.code_dtl_nam]));
      const type = { 1: '普', 2: '当', 4: '貯' }[String(z.bt || '').slice(3, 4)] || '';
      bankText = [dir[z.bk] || z.name, dir[(z.bk || '') + '-' + String(z.bt || '').slice(0, 3)] || '', type ? '(' + type + ')' : '', z.acc || ''].filter(Boolean).join(' ');
    }
  }
  return { name: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), address: [co?.postcode && '〒' + co.postcode, co?.pref, co?.addr1, co?.addr2].filter(Boolean).join(' '), tel: co?.tel_no || '', fax: co?.fax_no || '', plant: co?.plant_name || '', invoiceNo: set.INVNO || '', bankText };
}
async function snapshot(c, inv) {
  const cu = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [inv.customer]);
  const s = await statement(c, inv.customer, inv.month, inv.closingDay);
  const buckets = RATES.map(rate => { const net = inv.lines.filter(l => l.taxRate === rate).reduce((n, l) => n + l.net, 0); return { rate, net, tax: bucketTax(net, rate) }; }).filter(b => b.net);
  return {
    company: await companyProfile(c), discount: 0,
    customer: { code: inv.customer, name: cu?.customers_name || inv.customerName, address: cu?.addr1 || '', tel: cu?.tel_no || '' },
    site: { key: inv.site, name: inv.siteName }, invoiceId: inv.id, periodStart: s.start, closing: inv.closing, due: inv.due,
    demo: process.env.SHOW_DEMO_NOTICE !== '0', prevBalance: s.prevBalance, received: s.received, carried: s.carried, net: inv.net, tax: inv.tax, total: inv.total, grandTotal: s.carried + inv.total, buckets, lines: inv.lines,
  };
}
export async function issueInvoices(c, ctx, { ids }) {
  check(Array.isArray(ids) && ids.length > 0 && ids.length <= 200, '発行する請求を選択してください（最大200件）');
  const out = [];
  for (const id of [...new Set(ids.map(Number))].sort((a, b) => a - b)) {
    const h = await one(c, 'SELECT * FROM billing_head WHERE invoice_id=? FOR UPDATE', [id]); check(h, '請求が見つかりません');
    const inv = await invoiceDetail(c, id), snap = await snapshot(c, inv), no = (inv.issues || 0) + 1;
    const body = JSON.stringify({ ...snap, issueNo: no, issuedOn: today(), issuedBy: ctx.user.login_id }), sha = createHash('sha256').update(body).digest('hex');
    await c.query('INSERT INTO invoice_issue (invoice_id,issue_no,issued_at,issued_by,snapshot_json,document_sha256) VALUES (?,?,UTC_TIMESTAMP(6),?,?,?)', [id, no, ctx.user.login_id, body, sha]);
    await c.query('UPDATE billing_head SET invoice_flag=?, row_version=row_version+1 WHERE invoice_id=?', [no === 1 ? '1' : '2', id]);
    const w = detailWhere(h); await c.query(`UPDATE billing_detail SET invoice_issud_flag='1' WHERE ${w.sql}`, w.args);
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
  const w = detailWhere(h);
  const orders = await rows(c, `SELECT order_no FROM billing_detail WHERE ${w.sql} FOR UPDATE`, w.args);
  for (const o of orders) {
    await c.query("UPDATE sales_trn SET process_status='0', claim_processing_period=NULL WHERE order_no=?", [o.order_no]);
    await c.query('UPDATE shipment_slip SET claim_status=0, claim_processing_period=0 WHERE order_no=?', [o.order_no]);
  }
  await c.query(`DELETE FROM billing_detail WHERE ${w.sql}`, w.args);
  await reverseJournal(c, { sourceType: 'billing_head', sourceId: h.invoice_id, date: fromNum(h.closing_date) });
  await c.query('DELETE FROM billing_head WHERE invoice_id=?', [h.invoice_id]);
  await audit(c, ctx, 'billing_head', h.invoice_id, 'billing.cancel', { customer: h.customers_cd, closing: fromNum(h.closing_date), orders: orders.length });
  return { cancelled: h.invoice_id };
}

// ---------- 入金・消込 (NO17: 当座預金・現金・手形・振込手数料・協力会費・預り金充当・値引) ----------
export const RECEIPT_PARTS = { BANK: '振込', CASH: '現金', NOTE: '手形', FEE: '振込手数料', COOP: '協力会費等', DEPOSIT: '預り金充当', DISCOUNT: '値引・端数' };
const DEPOSIT_USED = "SELECT COALESCE(SUM(k.amount),0) v FROM receipt_component k JOIN receipt r ON r.receipt_id=k.receipt_id AND r.status='POSTED' WHERE r.customers_cd=? AND k.component_kind='DEPOSIT'";
export async function depositBalance(c, customer) {
  const base = num((await one(c, "SELECT COALESCE(SUM(amount),0) v FROM opening_balance WHERE customers_cd=? AND balance_kind='ADVANCE'", [customer])).v);
  const over = num((await one(c, "SELECT COALESCE(SUM(k.amount),0) v FROM receipt_component k JOIN receipt r ON r.receipt_id=k.receipt_id AND r.status='POSTED' WHERE r.customers_cd=? AND k.component_kind='OVERPAY'", [customer])).v);
  return base + over - num((await one(c, DEPOSIT_USED, [customer])).v);
}
export async function receiptContext(c, customer) {
  const cu = String(customer || '');
  const invoices = (await listInvoices(c, { customer: cu, status: 'open' })).filter(i => i.issues > 0).sort((a, b) => a.closing.localeCompare(b.closing));
  return { invoices, deposit: cu ? await depositBalance(c, cu) : 0 };
}
export const openInvoices = async (c, customer) => (await receiptContext(c, customer)).invoices;
const BANK_SUB = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='receipt' AND je.source_id=CAST(r.receipt_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
export async function listReceipts(c, q = {}) {
  const args = [], w = [];
  if (q.month) { isoMonth(q.month); w.push("DATE_FORMAT(r.receipt_date,'%Y-%m')=?"); args.push(q.month); }
  if (q.customer) { w.push('r.customers_cd=?'); args.push(q.customer); }
  const rs = await rows(c, `SELECT r.*, c.customers_name, ${BANK_SUB} bank_code FROM receipt r LEFT JOIN client_m c ON c.customers_cd=r.customers_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.receipt_date DESC, r.receipt_id DESC LIMIT 1000`, args);
  const ids = rs.map(r => r.receipt_id), ph = ids.map(() => '?').join(',');
  const comps = ids.length ? await rows(c, `SELECT * FROM receipt_component WHERE receipt_id IN (${ph})`, ids) : [];
  const allocs = ids.length ? await rows(c, `SELECT a.*, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${ph})`, ids) : [];
  return rs.map(r => {
    const part = k => num(comps.find(x => x.receipt_id === r.receipt_id && x.component_kind === k)?.amount);
    return { id: r.receipt_id, no: r.receipt_no, date: r.receipt_date, customer: r.customers_cd, customerName: r.customers_name, received: num(r.received_amount), settlement: num(r.settlement_amount),
      bank: part('BANK'), cash: part('CASH'), notes: part('NOTE'), fee: part('FEE'), coop: part('COOP'), deposit: part('DEPOSIT'), overpay: part('OVERPAY'), discount: part('DISCOUNT'), bankCode: r.bank_code || '', status: r.status,
      allocations: allocs.filter(a => a.receipt_id === r.receipt_id).map(a => ({ invoiceId: a.invoice_id, closing: fromNum(a.closing_date), amount: num(a.amount) })) };
  });
}
export async function createReceipt(c, ctx, p) {
  const idem = text(p.idempotencyKey, '処理キー', 100);
  const dup = await one(c, 'SELECT receipt_id, receipt_no FROM receipt WHERE idempotency_key=?', [idem]);
  if (dup) return { id: dup.receipt_id, no: dup.receipt_no, duplicate: true };
  const date = isoDate(p.date, '入金日'); await assertOpen(c, date);
  // Customer row lock serialises receipts of the same customer (deposit balance, allocations).
  const cust = await one(c, 'SELECT customers_cd FROM client_m WHERE customers_cd=? FOR UPDATE', [String(p.customer || '')]); check(cust, '得意先を選択してください');
  const parts = { BANK: yen(p.bank || 0, '振込'), CASH: yen(p.cash || 0, '現金'), NOTE: yen(p.notes || 0, '手形'), FEE: yen(p.fee || 0, '振込手数料'), COOP: yen(p.coop || 0, '協力会費等'), DEPOSIT: yen(p.deposit || 0, '預り金充当'), DISCOUNT: yen(p.discount || 0, '値引・端数') };
  const received = parts.BANK + parts.CASH + parts.NOTE, settlement = Object.values(parts).reduce((a, b) => a + b, 0);
  check(settlement > 0, '入金額を入力してください');
  let bankCode = null;
  if (parts.BANK) { bankCode = String(p.bankCode || ''); const b = await one(c, "SELECT category1 FROM code_m WHERE code_key='BANK' AND code_dtl=?", [bankCode]); check(b && b.category1 !== '0', '入金口座（銀行）を選択してください'); }
  const noteDue = parts.NOTE ? isoDate(p.noteDue, '手形期日') : null;
  if (parts.DEPOSIT) { const bal = await depositBalance(c, cust.customers_cd); check(parts.DEPOSIT <= bal, `預り金残高（${bal.toLocaleString('ja-JP')}円）を超えて充当できません`); }
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
    check(a.amount <= num(h.money) + num(h.consumption_tax) - num(h.paid), `請求(${fromNum(h.closing_date)}締)の残高を超えています`);
  }
  const allocated = allocs.reduce((n, a) => n + a.amount, 0), overpay = settlement - allocated;
  check(overpay >= 0, '消込合計が入金合計（手数料・協力会費・預り金充当・値引を含む）を超えています');
  check(overpay === 0 || p.overpayToDeposit === true, '入金合計と消込合計が一致しません（差額を預り金として受け入れる場合は「差額を預り金で受入」を選択）');
  check(overpay === 0 || parts.DEPOSIT === 0, '預り金充当と過入金の預り金受入は同時に処理できません');
  const no = await nextNo(c, 'receipt');
  const [r] = await c.query("INSERT INTO receipt (receipt_no,customers_cd,receipt_date,received_amount,settlement_amount,status,idempotency_key,created_at) VALUES (?,?,?,?,?,'POSTED',?,UTC_TIMESTAMP(6))", [no, cust.customers_cd, date, received, settlement, idem]);
  let n = 0;
  for (const [k, v] of Object.entries(parts)) if (v) await c.query('INSERT INTO receipt_component (receipt_id,component_no,component_kind,amount,maturity_date) VALUES (?,?,?,?,?)', [r.insertId, ++n, k, v, k === 'NOTE' ? noteDue : null]);
  if (overpay) await c.query('INSERT INTO receipt_component (receipt_id,component_no,component_kind,amount) VALUES (?,?,?,?)', [r.insertId, ++n, 'OVERPAY', overpay]);
  for (const a of allocs) await c.query('INSERT INTO receipt_allocation (receipt_id,invoice_id,customers_cd,amount) VALUES (?,?,?,?)', [r.insertId, a.id, cust.customers_cd, a.amount]);
  // 仕訳パターン分析 B-01〜B-06（処税率: 協力会費は141/41混在のため141で仮置き Q04）
  await postJournal(c, { date, pattern: 'B01', sourceType: 'receipt', sourceId: r.insertId, lines: [
    line('D', '1112', parts.BANK, { sub: bankCode, tax: '9' }), line('D', '1111', parts.CASH, { tax: '9' }), line('D', '1120', parts.NOTE, { customer: cust.customers_cd, tax: '9' }),
    line('D', '8330', parts.FEE, { sub: '101', dept: '063', tax: '141' }), line('D', '8330', parts.COOP, { sub: '107', dept: '063', tax: '141' }),
    line('D', '4170', parts.DEPOSIT, { customer: cust.customers_cd, tax: '9' }), line('D', '8850', parts.DISCOUNT, { dept: '063', tax: '141' }),
    ...allocs.map(a => line('C', '1131', a.amount, { customer: cust.customers_cd, tax: '9' })), line('C', '4170', overpay, { customer: cust.customers_cd, tax: '9' }) ] });
  await audit(c, ctx, 'receipt', r.insertId, 'receipt.create', { no, customer: cust.customers_cd, received, settlement, parts: Object.fromEntries(Object.entries(parts).filter(([, v]) => v)), invoices: allocs.map(a => a.id) });
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
