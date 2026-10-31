import { createHash } from 'node:crypto';
import { check, Conflict, yen, qty, taxOf, isoDate, isoMonth, toNum, fromNum, period, dueDate, closingDay, text, RATES, METHODS, CREDIT, today } from './domain.mjs';
import { rows, one, nextNo, assertOpen, audit, stamp, postJournal, reverseJournal, line, AR_SLIP_MAX } from './db.mjs';
import { mustDecode, decode } from './taxcode.mjs';

const site = s => { const [code = '', suffix = ''] = String(s || '').split('|'); return { code, suffix }; };
const monthRange = m => { isoMonth(m); return [toNum(m + '-01'), toNum(m + '-31')]; };
const num = v => Number(v || 0);
// Tax per rate bucket, truncated toward zero so correction (negative) buckets mirror positive ones.
const bucketTax = (net, rate) => (net >= 0 ? taxOf(net, rate) : -taxOf(-net, rate));
export const SHIP_KB = { 1: '出荷売上', 2: '他社納入', 3: '他社顧客購入', 4: '他社納入2', 5: '訂正', 9: '値引' }; // code_m A0009（現行 Java）＋ 5＝訂正（赤黒、本システムで追加）
const CORRECTION = '5';

// Billing heads are per customer (field_cd=''), per NO6. Older per-site heads keep their site key.
const DETAIL_JOIN = "d.customers_cd=h.customers_cd AND d.closing_yymm=h.closing_yymm AND d.claim_processing_period=h.closing_date AND (h.field_cd='' OR (d.field_cd=h.field_cd AND d.field_suffix=h.field_suffix))";
const detailWhere = h => ({ sql: `customers_cd=? AND closing_yymm=? AND claim_processing_period=?${h.field_cd ? ' AND field_cd=? AND field_suffix=?' : ''}`, args: [h.customers_cd, h.closing_yymm, h.closing_date, ...(h.field_cd ? [h.field_cd, h.field_suffix] : [])] });

// ---------- 出荷・売上 (shipment_slip + sales_trn) ----------
// 単価（現行 Java NS903000Service.getUriageTanka/getApplyFlag と同じ）：得意先×商品で現場一致の行、なければ得意先共通の行を日付で絞らずに選び、
// 出荷日が適用期間内なら適用単価・適用運賃、期間外（期間なしを含む）なら通常単価・運賃。単価マスタになければ商品マスタの単価・運賃。
// 消費税率（現行 Java：code_m A0007 から出荷日以前で最新の行。20140401→8%、20191001→10%）
export async function taxRateOn(c, date) {
  const r = await one(c, "SELECT category1 FROM code_m WHERE code_key='A0007' AND code_dtl<=? AND category3<>'0' ORDER BY code_dtl DESC LIMIT 1", [String(toNum(date))]);
  return r ? Number(String(r.category1).trim()) : 10;
}
// 業務日付（現行 Java company_info_m.trading_day・MA057 出荷日変更）。未設定は当日
export async function businessDate(c) { const r = await one(c, 'SELECT trading_day FROM company_info_m WHERE company_info_id=1'); return r?.trading_day ? String(r.trading_day).slice(0, 10) : today(); }
// 伝票番号（提案書 出荷伝票画面・現行 Java NumberingMEntity）：業務日付の YYMM＋5桁、月が変わると 00001 から
async function nextShipNo(c) {
  const bd = await businessDate(c), p = bd.slice(2, 4) + bd.slice(5, 7);
  await one(c, 'SELECT present_value FROM numbering_m WHERE numbering_key=101 FOR UPDATE'); // 採番の直列化
  const r = await one(c, "SELECT MAX(order_no) m FROM shipment_slip WHERE order_no ~ ?", ['^' + p + '[0-9]{5}$']);
  const next = r?.m ? Number(String(r.m).slice(4)) + 1 : 1; check(next <= 99999, '今月の伝票番号が上限に達しました');
  return p + String(next).padStart(5, '0');
}
export async function priceFor(c, { item, customer, site: s, date }) {
  const d = date || today(), { code, suffix } = site(s), taxRate = await taxRateOn(c, d);
  const r = await one(c, "SELECT * FROM uriage_tanka_m WHERE item_cd=? AND customers_cd=? AND delete_f<>'1' AND ((field_cd=? AND field_suffix=?) OR field_cd='') ORDER BY field_cd DESC, field_suffix DESC LIMIT 1", [item, customer, code, suffix]);
  if (r) {
    const inPeriod = r.apply_start && r.apply_end && String(r.apply_start).slice(0, 10) <= d && d <= String(r.apply_end).slice(0, 10);
    return { price: num(inPeriod ? r.apply_tanka : r.tanka), freight: num(inPeriod ? r.apply_freight : r.freight), taxRate, source: `${r.field_cd ? '現場別' : '得意先別'}${inPeriod ? '適用' : ''}単価` };
  }
  const it = await one(c, 'SELECT tanka, freight FROM item_m WHERE item_cd=?', [item]);
  return { price: num(it?.tanka), freight: num(it?.freight), taxRate, source: '標準単価' };
}
// 金額・税の端数処理（自社情報 company_info_m：proceed_round＝金額、tax_round＝税。code_m A0005：1 切上 / 2 切捨 / 3 四捨五入。現行データは 3 / 2）
export async function roundModes(c) { const r = await one(c, 'SELECT proceed_round, tax_round FROM company_info_m WHERE company_info_id=1'); return { money: String(r?.proceed_round || '3'), tax: String(r?.tax_round || '2') }; }
const roundBig = (n, d, mode) => { const neg = n < 0n, a = neg ? -n : n, q = a / d, rem = a % d; let v = q; if (rem) { if (mode === '1') v = q + 1n; else if (mode === '3' && rem * 2n >= d) v = q + 1n; } return Number(neg ? -v : v); };
export const moneyOf = (q, unit, mode) => roundBig(q.scaled * BigInt(unit), 100n, mode); // 数量×(単価＋運賃)
export const lineTax = (net, rate, mode) => roundBig(BigInt(net) * BigInt(rate), 100n, mode);
// 累計数量・累計台数（現行 Java NS006000Service.updateWorkKeyGroup）：出荷日×得意先×納入先名×現場名1・2×商品×納入区分 のグループを
// 出発時間・伝票No順に累計。値引(9)・他社納入(2)は除外、台数はマイナス数量の伝票を数えない。
export const CUMULATIVE_SQL = `UPDATE shipment_slip s SET cumulative_quantity=x.cq, cumulative_number=x.cn FROM (
  SELECT order_no, SUM(quantity) OVER w cq, SUM(CASE WHEN quantity>=0 THEN 1 ELSE 0 END) OVER w cn FROM shipment_slip WHERE ship_kb NOT IN (2,9) AND %WHERE%
  WINDOW w AS (PARTITION BY shipment_dt, customers_cd, delivery_name, field_name1, field_name2, item_cd, delivery_kbn_cd ORDER BY start_time, order_no ROWS UNBOUNDED PRECEDING)) x
  WHERE x.order_no=s.order_no AND (s.cumulative_quantity<>x.cq OR s.cumulative_number<>x.cn)`;
// 予定数量・予定時間（現行 ShipmentSlipMapper.updateByWorkKeyGroup）：同じ作業キー・同じ累計台数の出荷予定の累計数量・出発時間。値引(9)・他社納入(2)・マイナス数量は 0／空
const WORK_KEY = ['shipment_dt', 'customers_cd', 'delivery_name', 'field_name1', 'field_name2', 'item_cd', 'delivery_kbn_cd'];
const planOf = col => `(SELECT p.${col} FROM shipment_plan p WHERE ${WORK_KEY.map(k => `p.${k}=t.${k}`).join(' AND ')} AND p.cumulative_number=t.cumulative_number ORDER BY p.order_no DESC LIMIT 1)`;
export const PLAN_SQL = `UPDATE shipment_slip s SET plan_cumulative_quantity=x.pq, plan_start_time=x.pt FROM (
  SELECT t.order_no, CASE WHEN t.ship_kb IN (2,9) OR t.quantity<0 THEN 0 ELSE COALESCE(${planOf('cumulative_quantity')},0) END pq,
    CASE WHEN t.ship_kb IN (2,9) OR t.quantity<0 THEN '' ELSE COALESCE(${planOf('start_time')},'') END pt FROM shipment_slip t WHERE %WHERE%) x
  WHERE x.order_no=s.order_no AND (s.plan_cumulative_quantity<>x.pq OR s.plan_start_time<>x.pt)`;
export const workKeyArgs = r => [String(r.shipment_dt).slice(0, 10), r.customers_cd, r.delivery_name, r.field_name1, r.field_name2, r.item_cd, r.delivery_kbn_cd];
const WORK_WHERE = WORK_KEY.map(k => `${k}=?`).join(' AND ');
export async function applyPlan(c, key) { await c.query(PLAN_SQL.replace('%WHERE%', WORK_WHERE.replace(/(\w+)=\?/g, 't.$1=?')), workKeyArgs(key)); }
async function recalcCumulative(c, sl) {
  if (!sl) return;
  await c.query(CUMULATIVE_SQL.replace('%WHERE%', WORK_WHERE), workKeyArgs(sl));
  await applyPlan(c, sl);
}
export async function listShipments(c, q = {}) {
  // 10/23 打合せ：売上日 From〜To・現場（コード・名称の部分一致）で絞込。日付が無ければ月
  const byNo = q.orderNo ? String(q.orderNo) : '', [from, to] = byNo ? [0, 99999999] : q.from || q.to ? [q.from ? toNum(isoDate(q.from, '売上日（から）')) : 0, q.to ? toNum(isoDate(q.to, '売上日（まで）')) : 99999999] : monthRange(q.month); const args = [from, to]; let where = '';
  if (byNo) { where += ' AND s.order_no=?'; args.push(byNo); } // 1件照会（登録画面の元伝票No）
  if (q.site) { const like = `%${String(q.site).trim()}%`; where += ' AND (s.field_cd LIKE ? OR s.field_name1 LIKE ? OR s.field_name2 LIKE ?)'; args.push(like, like, like); }
  if (q.customer) { where += ' AND s.customers_cd=?'; args.push(q.customer); }
  if (q.status === 'open') where += " AND s.process_status='0'";
  if (q.status === 'billed') where += " AND s.process_status='1'";
  if (q.method) { where += ' AND s.payment_method_cd=?'; args.push(Number(q.method)); }
  const rs = await rows(c, `SELECT s.*, c.customers_name, sl.vehicle_no, unit_name(sl.unit_cd) unit, sl.unit_price slip_price, sl.freight slip_freight, sl.person_in_charge_cd, sl.delivery_kbn_cd, sl.cumulative_quantity, sl.cumulative_number, sl.other_company_customers_cd, sl.weather_cd, sl.start_temperature, (SELECT w.code_dtl_nam FROM code_m w WHERE w.code_key='A0010' AND w.code_dtl=CAST(sl.weather_cd AS TEXT)) weather_name, sl.start_time, sl.plan_start_time, sl.plan_cumulative_quantity, sl.ship_printing_fg4, oc.customers_name other_name, op.tanto_nm, dk.code_dtl_nam delivery_kbn_name, h.invoice_id,
      (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrections
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN shipment_slip sl ON sl.order_no=s.order_no
    LEFT JOIN client_m oc ON oc.customers_cd=NULLIF(sl.other_company_customers_cd,'') LEFT JOIN operator_m op ON op.tanto_cd=CAST(NULLIF(sl.person_in_charge_cd,'') AS INTEGER) LEFT JOIN code_m dk ON dk.code_key='A0000' AND dk.code_dtl=CAST(sl.delivery_kbn_cd AS TEXT)
    LEFT JOIN billing_detail d ON d.order_no=s.order_no LEFT JOIN billing_head h ON ${DETAIL_JOIN}
    WHERE s.sales_date BETWEEN ? AND ?${where} ORDER BY s.sales_date DESC, s.order_no DESC LIMIT 1000`, args);
  return rs.map(r => ({ orderNo: r.order_no, slipNo: slipNoOf(r), date: fromNum(r.sales_date), correctionDate: r.correction_date ? fromNum(r.correction_date) : '', customer: r.customers_cd, customerName: r.customers_name, site: r.field_cd ? `${r.field_cd}|${r.field_suffix}` : '', siteName: [r.field_name1, r.field_name2].filter(Boolean).join(' '),
    siteName1: r.field_name1 || '', siteName2: r.field_name2 || '', item: r.item_cd, itemName: r.item_name, quantity: Number(r.quantity), unit: r.unit || '', ...priceOf(r.unit_price, r.slip_price, r.slip_freight), unitPrice: num(r.unit_price),
    net: Number(r.money), taxRate: Number(r.tax_rate), tax: Number(r.consumption_tax), method: Number(r.payment_method_cd), methodName: METHODS[r.payment_method_cd] || '', billed: r.process_status === '1', invoiceId: r.invoice_id || null,
    vehicle: r.vehicle_no || '', remarks: r.remarks || '', operator: r.person_in_charge_cd || '', operatorName: r.tanto_nm || '', deliveryKbn: r.delivery_kbn_cd ? String(r.delivery_kbn_cd) : '', deliveryKbnName: r.delivery_kbn_name || '',
    cumulativeQty: num(r.cumulative_quantity), cumulativeCount: num(r.cumulative_number), otherCustomer: r.other_company_customers_cd || '', otherCustomerName: r.other_name || '', paymentMoney: num(r.payment_money), weather: r.weather_cd === null || r.weather_cd === undefined ? '' : String(r.weather_cd), weatherName: r.weather_name || '', startTemp: r.start_temperature === null || r.start_temperature === undefined ? '' : String(Number(r.start_temperature)), startTime: r.start_time || '', planQty: num(r.plan_cumulative_quantity), planTime: r.plan_start_time || '', printed: Number(r.ship_printing_fg4 || 0), shipKb: Number(r.ship_kb || 1), shipKbName: SHIP_KB[Number(r.ship_kb || 1)] || '', originalNo: r.sales_no !== r.order_no ? r.sales_no : '', corrected: Number(r.corrections) > 0 }));
}
// sales_trn の列は現行 Java（NI0010）に合わせる：unit_price＝単価＋運賃、proc_kb・tax_kb＝''、remarks＝伝票備考の先頭20文字
// 単価・運賃：出荷伝票の単価＋運賃が売上（請求の元）の単価と合わない移行データ（現行の伝票 157件）は、売上の単価を単価・運賃0とする。
// 合わないまま赤黒訂正すると、何も変えなくても差額が出ていた（2026-10-27、例 221001265：売上 2,000 円・伝票 1,200 円）
export const priceOf = (salesUnit, slipPrice, slipFreight) => (slipPrice == null || num(slipPrice) + num(slipFreight) !== num(salesUnit) ? { price: num(salesUnit), freight: 0 } : { price: num(slipPrice), freight: num(slipFreight) });
async function insertSlip(c, { orderNo, shipKb, date, cust, f, it, q, price, freight = 0, net, rate, tax, method, vehicle, remarks, operator, kbn, other = '', salesNo, salesSuffix, startTime = '', weather = null, startTemp = null }) {
  const st = stamp(), paid = net + tax; // payment_money は決済方法に関係なく 金額＋税（現行 Java）
  await c.query(`INSERT INTO shipment_slip (order_no,ship_kb,shipment_dt,weather_cd,customers_cd,other_company_customers_cd,delivery_cd,delivery_name,field_cd,field_suffix,field_name1,field_name2,item_cd,delivery_kbn_cd,quantity,unit_cd,cumulative_quantity,plan_cumulative_quantity,unit_price,money,tax_rate,consumption_tax,payment_method_cd,payment_money,vehicle_no,cumulative_number,start_time,plan_start_time,start_temperature,person_in_charge_cd,slip_remark,ship_printing_fg1,ship_printing_fg2,ship_printing_fg3,ship_printing_fg4,printing_settled_fg,claim_status,claim_processing_period,freight,card_sales_sts,card_sales_dt,card_member_id,card_order_id,card_credit_dt,update_daytime,order_processing_period)
    VALUES (?,?,?,NULL,?,?,'','',?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,0,'','',NULL,?,?,0,0,0,0,0,0,0,?,0,NULL,'','',NULL,UTC_TIMESTAMP(6),NULL)`,
    [orderNo, Number(shipKb), date, cust.customers_cd, other, f.field_cd, f.field_suffix, f.field_name1.slice(0, 20), f.field_name2.slice(0, 20), it.item_cd, Number(kbn), q.text, it.unit, price, net, rate, tax, method, paid, vehicle, operator, remarks, freight]);
  if (startTime || weather !== null || startTemp !== null) await c.query('UPDATE shipment_slip SET start_time=?, weather_cd=?, start_temperature=? WHERE order_no=?', [startTime, weather, startTemp, orderNo]);
  await c.query(`INSERT INTO sales_trn (order_no,order_suffix,sales_date,sales_no,sales_suffix,ship_kb,customers_cd,field_cd,field_suffix,field_name1,field_name2,shipping_kb,item_cd,item_name,item_zaiko_cd,quantity,unit_cd,unit_price,money,proc_kb,tax_kb,tax_rate,consumption_tax,remarks,claim_processing_period,payment_method_cd,payment_money,process_status,update_day,update_time,update_pgm,update_ws)
    VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'','',?,?,?,NULL,?,?,'0',?,?,?,?)`,
    [orderNo, toNum(date), salesNo || orderNo, salesSuffix || 1, String(shipKb), cust.customers_cd, f.field_cd, f.field_suffix, f.field_name1, f.field_name2, Number(kbn), it.item_cd, it.item_nam.slice(0, 20), it.item_cd, q.text, /^\d+$/.test(it.unit) ? Number(it.unit) : null, price + freight, net, rate, tax, remarks.slice(0, 20), method, paid, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
}
// 現場は任意（現行 Java と同じ）：コード指定ならマスタの現場、未指定なら現場名1・2 を自由入力
// 天候（code_m A0010）：任意
export async function weatherOf(c, v) {
  if (v === undefined || v === null || v === '') return null;
  check(/^\d{1,2}$/.test(String(v)) && await one(c, "SELECT 1 x FROM code_m WHERE code_key='A0010' AND code_dtl=?", [String(Number(v))]), '天候を天候マスタから選択してください');
  return Number(v);
}
// 出発温度（現行 NS006001：3桁、納品書に印字）：任意
export const tempOf = (v, label) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(v); check(Number.isInteger(n) && n >= -99 && n <= 999, `${label}は-99〜999の整数です`); return n; };
export const hhmm = (v, label) => text(v, label, 5, { required: false, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ });
export async function siteOf(c, cust, p) {
  const s = site(p.site);
  if (s.code) { const f = await one(c, 'SELECT * FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [cust.customers_cd, s.code, s.suffix]); check(f && f.delete_f !== '1', '得意先に登録された有効な現場を選択してください'); return f; }
  return { field_cd: '', field_suffix: '', field_name1: text(p.siteName1, '現場名1', 20, { required: false }), field_name2: text(p.siteName2, '現場名2', 20, { required: false }) };
}
async function slipValues(c, p, label = '') {
  const date = isoDate(p.date, label + '出荷日'); await assertOpen(c, date);
  const cust = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [String(p.customer || '')]); check(cust && cust.delete_f !== '1', '有効な得意先を選択してください');
  const f = await siteOf(c, cust, p);
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(p.item || '')]); check(it && it.delete_f !== '1', '有効な商品を選択してください');
  const q = qty(p.quantity, label + '数量', { positive: false, allowNegative: true }); check(q.scaled !== 0n, label + '数量を入力してください');
  const price = yen(p.price, label + '単価', { max: 9999999 }), freight = yen(p.freight || 0, label + '運賃', { max: 9999999 }), rate = await taxRateOn(c, date), method = Number(p.method || CREDIT);
  check(METHODS[method], '決済方法が不正です');
  // 担当者・納入区分は必須（現行 Java NS006000Service.isCheck）。納入区分が引取（category1=2）なら運賃は0のみ
  const opCode = text(p.operator, label + '担当者', 6, { pattern: /^\d{1,6}$/ });
  const op = await one(c, "SELECT tanto_cd FROM operator_m WHERE tanto_cd=? AND delete_f<>'1'", [Number(opCode)]); check(op, label + '担当者を担当者マスタから選択してください');
  const kbn = text(p.deliveryKbn, label + '納入区分', 2, { pattern: /^\d{1,2}$/ });
  const dk = await one(c, "SELECT category1 FROM code_m WHERE code_key='A0000' AND code_dtl=?", [kbn]); check(dk, label + '納入区分を選択してください');
  if (dk.category1 === '2') check(freight === 0, '納入区分が引取のため運賃は0です');
  // 伝票区分（提案書・現行 A0009）：1 出荷売上 / 2 他社納入 / 3 他社顧客購入 / 4 他社納入２ / 5 訂正（赤：元伝票No 必須、saveShipment で検査）。値引（9）は入金時に処理するため対象外（Q18）。区分 2・4 は他社得意先が必須、それ以外は入力不可
  const shipKb = String(p.shipKb || '1'); check(['1', '2', '3', '4', '5'].includes(shipKb), '伝票区分が不正です');
  const other = text(p.otherCustomer, '他社得意先', 5, { required: false });
  if (['2', '4'].includes(shipKb)) { check(other, '伝票区分が他社納入のときは他社得意先を入力してください'); check(await one(c, 'SELECT 1 x FROM client_m WHERE customers_cd=?', [other]), '他社得意先が得意先マスタにありません'); }
  else check(!other, '他社得意先は伝票区分が他社納入（2・4）のときだけ入力できます');
  const mode = await roundModes(c), net = moneyOf(q, price + freight, mode.money); check(Math.abs(net) <= 999999999, '売上金額が上限(9億9999万円)を超えています');
  return { date, cust, f, it, q, price, freight, rate, method, net, tax: lineTax(net, rate, mode.tax), operator: String(op.tanto_cd).padStart(6, '0'), kbn, shipKb, other, vehicle: text(p.vehicle, '車番', 15, { required: false }), remarks: text(p.remarks, '備考', 20, { required: false }), startTime: hhmm(p.startTime, label + '出発時間'), weather: await weatherOf(c, p.weather), startTemp: tempOf(p.startTemp, label + '出発温度') };
}
export async function saveShipment(c, ctx, p) {
  const v = await slipValues(c, p), st = stamp();
  let orderNo = p.orderNo;
  if (orderNo) {
    const old = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [orderNo]);
    if (!old) throw new Conflict('出荷伝票が見つかりません。再読込してください');
    check(old.process_status === '0', '請求済みの出荷は変更できません（「訂正」で赤黒訂正してください）');
    check(old.ship_kb !== CORRECTION, '訂正伝票は変更できません。取消して再登録してください');
    check(v.shipKb !== CORRECTION, '登録済みの伝票を訂正（区分 5）に変えることはできません。元伝票No を指定して赤伝票を新規登録してください');
    check(!(await one(c, 'SELECT 1 x FROM sales_trn WHERE sales_no=? AND order_no<>? LIMIT 1', [orderNo, orderNo])), '訂正済みの伝票は変更できません');
    await assertOpen(c, fromNum(old.sales_date));
    await c.query(`UPDATE sales_trn SET sales_date=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,item_name=?,quantity=?,unit_price=?,money=?,tax_rate=?,consumption_tax=?,remarks=?,payment_method_cd=?,payment_money=?,update_day=?,update_time=?,update_pgm=?,update_ws=? WHERE order_no=? AND order_suffix=1`,
      [toNum(v.date), v.cust.customers_cd, v.f.field_cd, v.f.field_suffix, v.f.field_name1, v.f.field_name2, v.it.item_cd, v.it.item_nam.slice(0, 20), v.q.text, v.price + v.freight, v.net, v.rate, v.tax, v.remarks, v.method, v.net + v.tax, st.update_day, st.update_time, st.update_pgm, st.update_ws, orderNo]);
    await c.query('UPDATE sales_trn SET shipping_kb=?,unit_cd=?,ship_kb=? WHERE order_no=?', [Number(v.kbn), /^\d+$/.test(v.it.unit) ? Number(v.it.unit) : null, v.shipKb, orderNo]);
    const before = await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [orderNo]);
    await c.query('UPDATE shipment_slip SET shipment_dt=?,customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,delivery_kbn_cd=?,quantity=?,unit_cd=?,unit_price=?,freight=?,money=?,tax_rate=?,consumption_tax=?,payment_method_cd=?,payment_money=?,vehicle_no=?,person_in_charge_cd=?,slip_remark=?,update_daytime=UTC_TIMESTAMP(6) WHERE order_no=?',
      [v.date, v.cust.customers_cd, v.f.field_cd, v.f.field_suffix, v.f.field_name1.slice(0, 20), v.f.field_name2.slice(0, 20), v.it.item_cd, Number(v.kbn), v.q.text, v.it.unit, v.price, v.freight, v.net, v.rate, v.tax, v.method, v.net + v.tax, v.vehicle, v.operator, v.remarks, orderNo]);
    await c.query('UPDATE shipment_slip SET ship_kb=?,other_company_customers_cd=?,start_time=?,weather_cd=?,start_temperature=? WHERE order_no=?', [Number(v.shipKb), v.other, v.startTime, v.weather, v.startTemp, orderNo]);
    if (before) await recalcCumulative(c, before);
    await recalcCumulative(c, await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [orderNo]));
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.update', { date: v.date, customer: v.cust.customers_cd, item: v.it.item_cd, net: v.net });
  } else {
    // 伝票区分 5 訂正（2026-10-23）：登録画面から元伝票No を指定して赤伝票を起票。赤黒訂正と同じく sales_no＝元伝票No で結び付ける
    const link = v.shipKb === CORRECTION ? await redLink(c, p, v) : {};
    orderNo = await nextShipNo(c);
    await insertSlip(c, { ...v, orderNo, shipKb: v.shipKb, ...link });
    if (link.salesNo) await dropSummaryOf(c, link.salesNo);
    await recalcCumulative(c, await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [orderNo]));
    await audit(c, ctx, 'sales_trn', orderNo, 'shipment.create', { date: v.date, customer: v.cust.customers_cd, item: v.it.item_cd, net: v.net });
  }
  return { orderNo };
}
// 赤伝票の備考：「M/D 分削除」（元伝票の売上日、10/23 打合せ）
const redMemo = orig => { const d = fromNum(orig.sales_date); return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} 分削除`; };
// 登録画面の赤伝票（区分 5）：元伝票と得意先・商品が同じで、数量は元伝票と逆符号・元伝票の数量以内。訂正済み・赤伝票は元にできない
async function redLink(c, p, v) {
  const no = String(p.originalNo || '').trim(); check(no, '伝票区分が訂正のときは元伝票No を入力してください');
  const orig = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [no]); check(orig, `元伝票No ${no} の出荷伝票がありません`);
  check(!(orig.ship_kb === CORRECTION && Number(orig.quantity) < 0), '赤伝票を元伝票にはできません');
  check(!(await one(c, 'SELECT 1 x FROM sales_trn WHERE sales_no=? AND order_no<>? LIMIT 1', [no, no])), `元伝票No ${no} は訂正済みです`);
  check(v.cust.customers_cd === orig.customers_cd, `得意先が元伝票（${orig.customers_cd}）と違います`);
  check(v.it.item_cd === orig.item_cd, `商品が元伝票（${orig.item_cd}）と違います`);
  check(v.date >= fromNum(orig.sales_date), '出荷日が元伝票の出荷日より前です');
  const oq = Number(orig.quantity), nq = Number(v.q.text);
  check(Math.sign(nq) === -Math.sign(oq) && Math.abs(nq) <= Math.abs(oq), `赤伝票の数量は元伝票（${oq}）と逆符号で、元の数量以内です`);
  if (!v.remarks) v.remarks = redMemo(orig);
  return { salesNo: no, salesSuffix: 2 };
}
// NO11 出荷伝票訂正（10/14 打合せ：赤黒）。元伝票は変更せず、赤＝元伝票の全量マイナス、黒＝訂正後の内容（日付・得意先・現場・商品・数量・単価・運賃すべて変更可）を起票。
// 請求書・明細には 元 / 赤 / 黒 の3行で表示される。黒の数量 0（または未入力）は赤のみ＝取消。訂正伝票は sales_no＝元伝票No で結び付ける（区分 5）。
export async function correctShipment(c, ctx, p) {
  const orig = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [String(p.orderNo || '')]);
  if (!orig) throw new Conflict('訂正元の出荷伝票が見つかりません');
  check(!(await one(c, 'SELECT 1 x FROM sales_trn WHERE sales_no=? AND order_no<>? LIMIT 1', [orig.order_no, orig.order_no])), 'この伝票は訂正済みです。訂正後（黒）の伝票を訂正してください');
  check(!(orig.ship_kb === CORRECTION && Number(orig.quantity) < 0), '赤伝票は訂正できません');
  const slip = await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [orig.order_no]);
  // 赤・黒の売上日は元伝票の売上日（現行と同じ、2026-10-27 大西さん回答 H）。訂正日は correction_date に持つ
  const corrDate = isoDate(p.date, '訂正日'), date = fromNum(orig.sales_date); await assertOpen(c, corrDate);
  check(corrDate >= date, '訂正日が元伝票の出荷日より前です');
  const cust = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [orig.customers_cd]);
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [orig.item_cd]);
  const f = { field_cd: orig.field_cd || '', field_suffix: orig.field_suffix || '', field_name1: orig.field_name1 || '', field_name2: orig.field_name2 || '' };
  const red = { date, cust, f, it, q: qty('-' + String(orig.quantity).replace(/^-/, ''), '数量', { positive: false, allowNegative: true }), ...priceOf(orig.unit_price, slip?.unit_price, slip?.freight),
    net: -num(orig.money), rate: Math.round(num(orig.tax_rate)), tax: -num(orig.consumption_tax), method: Number(orig.payment_method_cd), vehicle: '', remarks: redMemo(orig),
    operator: slip?.person_in_charge_cd || '', kbn: String(slip?.delivery_kbn_cd ?? orig.shipping_kb ?? 1) };
  if (Number(orig.quantity) < 0) red.q = qty(String(-Number(orig.quantity)), '数量'); // 元がマイナス伝票なら赤はプラス
  const redNo = await nextShipNo(c);
  await insertSlip(c, { orderNo: redNo, shipKb: CORRECTION, ...red, salesNo: orig.order_no, salesSuffix: 2 });
  await c.query('UPDATE sales_trn SET correction_date=? WHERE order_no=?', [toNum(corrDate), redNo]);
  await recalcCumulative(c, await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [redNo]));
  let blackNo = null, black = null;
  if (p.quantity !== undefined && p.quantity !== '' && Number(p.quantity) !== 0) {
    // 訂正できるのは 単価・数量 だけ（2026-10-27：お客様の運用は決められた範囲で行う。10/23「まずは単価・数量の2種類」）。
    // 得意先・現場・商品・運賃・決済・担当・納入区分は元伝票のまま。得意先・現場などの誤りは 数量0（取消）→ 正しい内容で出荷登録
    black = await slipValues(c, { date, customer: orig.customers_cd, site: orig.field_cd ? `${orig.field_cd}|${orig.field_suffix}` : '', siteName1: orig.field_name1, siteName2: orig.field_name2,
      item: orig.item_cd, quantity: p.quantity, price: p.price ?? red.price, freight: red.freight, method: red.method, operator: red.operator, deliveryKbn: red.kbn,
      shipKb: '1', otherCustomer: '', vehicle: slip?.vehicle_no || '', remarks: orig.remarks ?? '' }, '黒伝票の'); // 黒の備考は元伝票の備考を引き継ぐ（指摘 No.26）
    blackNo = await nextShipNo(c);
    await insertSlip(c, { orderNo: blackNo, ...black, shipKb: CORRECTION, salesNo: orig.order_no, salesSuffix: 3 }); // black（slipValues）の shipKb '1' で上書きしない
    await c.query('UPDATE sales_trn SET correction_date=? WHERE order_no=?', [toNum(corrDate), blackNo]);
    await recalcCumulative(c, await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [blackNo]));
  }
  await dropSummaryOf(c, orig.order_no);
  await audit(c, ctx, 'sales_trn', orig.order_no, 'shipment.correct', { original: orig.order_no, red: redNo, black: blackNo, net: red.net + (black?.net || 0) });
  return { orderNo: blackNo || redNo, red: redNo, black: blackNo, original: orig.order_no, redSlip: `${orig.order_no}-02`, blackSlip: blackNo ? `${orig.order_no}-03` : null, net: red.net + (black?.net || 0) };
}
// 入力中の累計数量・累計台数・予定数量・予定時間（現行 NS006001 の lastCumulative／planInformation と同じ考え方）。登録後はサーバーで振り直す。
// 登録済みの出荷日の範囲（帳票の期間指定の目安）
export async function shipmentRange(c) {
  const r = await one(c, 'SELECT MIN(sales_date) a, MAX(sales_date) b FROM sales_trn');
  return { from: r?.a ? fromNum(r.a) : '', to: r?.b ? fromNum(r.b) : '' };
}
export async function cumulativePreview(c, q) {
  const z = { cumulativeQty: 0, cumulativeCount: 0, planQty: 0, planTime: '' };
  const cust = q.customer && await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [String(q.customer)]);
  if (!cust || !q.item || !q.deliveryKbn || !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ''))) return z;
  const f = await siteOf(c, cust, q).catch(() => null); if (!f) return z;
  const qn = Number(q.quantity || 0), kb = String(q.shipKb || '1');
  const key = { shipment_dt: q.date, customers_cd: cust.customers_cd, delivery_name: '', field_name1: f.field_name1.slice(0, 20), field_name2: f.field_name2.slice(0, 20), item_cd: String(q.item), delivery_kbn_cd: Number(q.deliveryKbn) };
  const ex = await one(c, `SELECT COALESCE(SUM(quantity),0) qs, COUNT(*) FILTER (WHERE quantity>=0) n FROM shipment_slip WHERE ${WORK_WHERE} AND ship_kb NOT IN (2,9) AND order_no<>?`, [...workKeyArgs(key), String(q.orderNo || '')]);
  if (['2', '9'].includes(kb)) return z;
  const count = Number(ex.n) + (qn >= 0 ? 1 : 0), cq = Math.round((Number(ex.qs) + qn) * 100) / 100;
  const plan = qn >= 0 ? await one(c, `SELECT cumulative_quantity, start_time FROM shipment_plan WHERE ${WORK_WHERE} AND cumulative_number=? ORDER BY order_no DESC LIMIT 1`, [...workKeyArgs(key), count]) : null;
  return { cumulativeQty: cq, cumulativeCount: count, planQty: num(plan?.cumulative_quantity), planTime: plan?.start_time || '' };
}
export async function deleteShipment(c, ctx, { orderNo }) {
  const old = await one(c, 'SELECT * FROM sales_trn WHERE order_no=? AND order_suffix=1 FOR UPDATE', [String(orderNo || '')]);
  if (!old) throw new Conflict('出荷伝票が見つかりません。再読込してください');
  check(old.process_status === '0', '請求済みの出荷は取消できません');
  check(!(await one(c, 'SELECT 1 x FROM sales_trn WHERE sales_no=? AND order_no<>? LIMIT 1', [orderNo, orderNo])), '訂正伝票がある出荷は取消できません（先に訂正伝票を取消してください）');
  await assertOpen(c, fromNum(old.sales_date));
  // 赤黒は組で取消（赤だけ・黒だけを残さない）
  const pair = old.ship_kb === CORRECTION ? (await rows(c, "SELECT order_no FROM sales_trn WHERE sales_no=? AND order_no<>sales_no AND ship_kb=? AND process_status='0'", [old.sales_no, CORRECTION])).map(r => r.order_no) : [orderNo];
  for (const no of pair) { const sl = await one(c, 'SELECT * FROM shipment_slip WHERE order_no=?', [no]); await c.query('DELETE FROM sales_trn WHERE order_no=?', [no]); await c.query('DELETE FROM shipment_slip WHERE order_no=?', [no]); if (sl) await recalcCumulative(c, sl); }
  if (old.ship_kb === CORRECTION && old.sales_no && old.sales_no !== old.order_no) await dropSummaryOf(c, old.sales_no);
  await audit(c, ctx, 'sales_trn', orderNo, 'shipment.delete', { date: fromNum(old.sales_date), customer: old.customers_cd, net: Number(old.money), slips: pair });
  return { orderNo, slips: pair };
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
  const custs = await rows(c, "SELECT customers_cd, customers_name FROM client_m WHERE delete_f<>'1' AND CAST(substring(deadline from '^ *([0-9]+)') AS INTEGER)=? ORDER BY customers_cd", [day]);
  const out = [];
  for (const cu of custs) {
    const sales = await rows(c, "SELECT payment_method_cd, money, tax_rate, field_cd, field_suffix, sales_date FROM sales_trn WHERE customers_cd=? AND process_status='0' AND sales_date<=?", [cu.customers_cd, toNum(end)]);
    const credit = sales.filter(s => Number(s.payment_method_cd) === CREDIT), t = totals(credit);
    const made = await one(c, 'SELECT invoice_id, invoice_flag FROM billing_head WHERE customers_cd=? AND closing_date=?', [cu.customers_cd, toNum(end)]);
    // 作成済みの請求：未発行・消込なしなら後から入力した未請求分を追加できる。発行済み・消込ありは追加せず次回締めで請求（runBilling と同じ判定）
    const locked = !!made && (made.invoice_flag !== '0' || !!(await one(c, 'SELECT 1 x FROM receipt_allocation WHERE invoice_id=? LIMIT 1', [made.invoice_id])));
    out.push({ customer: cu.customers_cd, name: cu.customers_name, count: credit.length, sites: new Set(credit.map(s => s.field_cd + s.field_suffix)).size, net: t.net, tax: t.tax,
      excluded: sales.length - credit.length, late: credit.filter(x => fromNum(x.sales_date) < start).length, created: made ? 1 : 0, locked });
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
async function postBillingJournal(c, id, end, customer, net, tax, slip) {
  if (net + tax === 0 && net === 0) return;
  await postJournal(c, { date: end, pattern: 'A01', sourceType: 'billing_head', sourceId: id, slip,
    lines: [signed('D', '1131', net + tax, { customer, tax: '9' }), signed('C', '8130', net, { customer, dept: '063', tax: '11' }), signed('C', '4415', tax, { customer, tax: '9' })] });
}
// 請求締め（NO6）: 当期締日までの未請求掛売上（前回締め後に入力された過去日付の売上・訂正伝票を含む）を得意先単位で請求。
// 同じ締日の請求が未発行・未消込なら追加分を加算、発行済みなら次回締めで請求。マイナス（訂正のみ）はクレジット請求として作成。
export async function runBilling(c, ctx, { month, closing, customers, slip: cont }) {
  const { end } = period(month, closing), day = closingDay(closing); await assertOpen(c, end);
  check(end <= today(), `締日（${end}）が到来していないため請求締めはできません`);
  let targets = await rows(c, "SELECT * FROM client_m WHERE delete_f<>'1' AND CAST(substring(deadline from '^ *([0-9]+)') AS INTEGER)=? ORDER BY customers_cd", [day]);
  if (Array.isArray(customers) && customers.length) targets = targets.filter(t => customers.includes(t.customers_cd));
  check(targets.length, `締日${day}日の有効な得意先がありません`);
  const created = [], appended = [], skipped = [], st = stamp(), yymm = Number(month.replace('-', '')), slip = { max: AR_SLIP_MAX }; // 売掛金計上の伝票（得意先コード順に45得意先で分割）
  // 画面は得意先ごとに呼び出すため、同じ締日の A01 伝票番号を受け取り、45得意先未満なら続けて使う
  if (typeof cont === 'string' && /^R(\d{4})?\d{5}$/.test(cont)) {
    const n = Number((await one(c, "SELECT COUNT(*) n FROM app_slip_no s JOIN journal_entry e ON e.journal_id=s.journal_id WHERE s.slip_no=? AND e.pattern_code='A01' AND e.reversal_of IS NULL AND e.journal_date=?", [cont, end])).n);
    if (n && n < AR_SLIP_MAX) Object.assign(slip, { no: cont, count: n });
  }
  for (const cu of targets) {
    const list = await rows(c, "SELECT * FROM sales_trn WHERE customers_cd=? AND process_status='0' AND payment_method_cd=2 AND sales_date<=? ORDER BY field_cd, field_suffix, sales_date, order_no FOR UPDATE", [cu.customers_cd, toNum(end)]);
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
        [yymm, day, toNum(end), cu.customers_cd, s2.sales_date, s2.order_no, s2.ship_kb, s2.item_cd, (s2.item_name || '').slice(0, 22), s2.quantity, s2.unit_price, s2.money, s2.tax_kb, Math.round(num(s2.tax_rate)), s2.consumption_tax, s2.remarks, s2.field_cd, s2.field_suffix, [s2.field_name1, s2.field_name2].filter(Boolean).join(' ').slice(0, 40), s2.payment_method_cd, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
      await c.query("UPDATE sales_trn SET process_status='1', claim_processing_period=? WHERE order_no=? AND order_suffix=?", [toNum(end), s2.order_no, s2.order_suffix]);
      await c.query('UPDATE shipment_slip SET claim_status=1, claim_processing_period=? WHERE order_no=?', [yymm, s2.order_no]);
    }
    // Totals are recomputed from all detail lines of the head (tax per rate bucket on the whole invoice).
    const all = await rows(c, "SELECT money, tax_rate FROM billing_detail WHERE customers_cd=? AND closing_yymm=? AND claim_processing_period=?", [cu.customers_cd, yymm, toNum(end)]);
    const { net, tax } = totals(all);
    await c.query('UPDATE billing_head SET money=?, consumption_tax=?, row_version=row_version+1 WHERE invoice_id=?', [net, tax, h.invoice_id]);
    if (!h.isNew) await reverseJournal(c, { sourceType: 'billing_head', sourceId: h.invoice_id, date: end });
    await postBillingJournal(c, h.invoice_id, end, cu.customers_cd, net, tax, slip);
    (h.isNew ? created : appended).push(h.invoice_id);
    await audit(c, ctx, 'billing_head', h.invoice_id, h.isNew ? 'billing.create' : 'billing.append', { customer: cu.customers_cd, closing: end, net, tax, lines: list.length, lateEntries: list.filter(x => fromNum(x.sales_date) < period(month, closing).start).length, credit: net + tax < 0 });
  }
  check(created.length + appended.length, skipped.length ? '請求を作成できません: ' + skipped.join(' / ') : '対象の未請求掛売上がありません');
  await c.query("INSERT INTO billing_closing_inf (closing_yymm,closingdd,invoice_proc_flag,update_day,update_time,update_pgm,update_ws) VALUES (?,?,'1',?,?,?,?) ON DUPLICATE KEY UPDATE invoice_proc_flag='1',update_day=VALUES(update_day),update_time=VALUES(update_time)",
    [yymm, day, st.update_day, st.update_time, st.update_pgm, st.update_ws]);
  return { created: created.length, appended: appended.length, ids: [...created, ...appended], skipped, slip: slip.no || '' };
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
  if (q.closing) { w.push('h.closingdd=?'); args.push(Number(q.closing)); }
  if (q.customerFrom) { w.push('h.customers_cd>=?'); args.push(q.customerFrom); }
  if (q.customerTo) { w.push('h.customers_cd<=?'); args.push(q.customerTo); }
  let list = (await rows(c, `${invoiceSql}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY h.closing_date DESC, h.customers_cd, h.invoice_id DESC LIMIT 1000`, args)).map(decodeInvoice);
  // 10/14 打合せ：請求一覧照会に現場名を表示（請求一覧表（確認用）の代わり）。請求は得意先単位のため明細の現場名を列挙する。
  if (list.length) {
    // 現場名は請求明細の現場名、空なら売上の現場名1・2（移行データは現場名2だけのことがある）
    const sites = await rows(c, `SELECT DISTINCT d.customers_cd, d.closing_yymm, d.claim_processing_period, COALESCE(NULLIF(d.field_name,''), NULLIF(TRIM(CONCAT_WS(' ', st.field_name1, st.field_name2)),''), '') field_name FROM billing_detail d JOIN billing_head h ON h.customers_cd=d.customers_cd AND h.closing_yymm=d.closing_yymm AND h.closing_date=d.claim_processing_period LEFT JOIN sales_trn st ON st.order_no=d.order_no AND st.order_suffix=1
      WHERE h.invoice_id IN (${list.map(() => '?').join(',')}) AND COALESCE(NULLIF(d.field_name,''), NULLIF(TRIM(CONCAT_WS(' ', st.field_name1, st.field_name2)),''), '')<>''`, list.map(i => i.id));
    for (const i of list) { const n = sites.filter(s => s.customers_cd === i.customer && toNum(i.closing) === Number(s.claim_processing_period) && String(s.closing_yymm) === i.month.replace('-', '')).map(s => s.field_name); if (n.length) i.siteNames = n; }
    // 10/23 打合せ（大西さん）：請求一覧照会は 得意先×現場 の行。現場ごとの売上額・消費税（税率別に端数処理）・決済区分
    const parts = await rows(c, `SELECT h.invoice_id, d.field_cd, d.field_suffix, COALESCE(NULLIF(d.field_name,''), NULLIF(TRIM(CONCAT_WS(' ', st.field_name1, st.field_name2)),''), '') field_name, d.payment_method_cd, d.tax_rate, SUM(d.money) money FROM billing_detail d JOIN billing_head h ON h.customers_cd=d.customers_cd AND h.closing_yymm=d.closing_yymm AND h.closing_date=d.claim_processing_period LEFT JOIN sales_trn st ON st.order_no=d.order_no AND st.order_suffix=1
      WHERE h.invoice_id IN (${list.map(() => '?').join(',')}) GROUP BY h.invoice_id, d.field_cd, d.field_suffix, COALESCE(NULLIF(d.field_name,''), NULLIF(TRIM(CONCAT_WS(' ', st.field_name1, st.field_name2)),''), ''), d.payment_method_cd, d.tax_rate ORDER BY h.invoice_id, d.field_cd, d.field_suffix, 4`, list.map(i => i.id));
    const iss = await siteIssues(c, list.map(i => i.id));
    for (const i of list) {
      const mine = parts.filter(x => Number(x.invoice_id) === i.id), keyOf = x => `${x.field_cd || ''}|${x.field_suffix || ''}|${x.field_name || ''}`, keys = [...new Set(mine.map(keyOf))]; // 現場コードの無い自由入力の現場は名称で分ける
      i.sites = keys.map(k => { const ls = mine.filter(x => keyOf(x) === k), net = ls.reduce((n, x) => n + num(x.money), 0);
        const tax = RATES.reduce((n, r) => n + bucketTax(ls.filter(x => Math.round(num(x.tax_rate)) === r).reduce((a, x) => a + num(x.money), 0), r), 0);
        return { site: ls[0].field_cd ? `${ls[0].field_cd}|${ls[0].field_suffix}` : '', siteName: ls[0].field_name || '', method: [...new Set(ls.map(x => METHODS[x.payment_method_cd] || ''))].filter(Boolean).join('・'), net, tax, total: net + tax,
          issues: iss.get(i.id)?.of(siteLabel(ls[0].field_name)).length || 0 }; });
    }
  }
  if (q.status === 'open') list = list.filter(i => i.balance > 0);
  else if (q.status) list = list.filter(i => i.status === q.status);
  return list;
}
// 運送（現行 HAR430「1 当方／2 先方」）：納入区分が引取（category1=2）なら先方、それ以外は当方（推定）
const CARRY = cat => (cat === '2' ? '2 先方' : '1 当方');
// 赤黒（区分 5）の伝票No は 元伝票No－枝番（2 赤・3 黒）で表示（10/23 打合せ：帳票②´ と同じ番号で元伝票の下に並べる）
// 伝票No の表示（10/24 採番方式の回答、2026-10-27）：赤黒は「元伝票No-02（赤）／-03（黒）」、赤黒のある元伝票は「元伝票No-01」、それ以外は枝番なし。
// l.corrections＝その伝票を元にした赤黒の件数（一覧・明細の SQL で取る）
const BRANCH = n => String(Number(n)).padStart(2, '0');
export const slipNoOf = l => (String(l.ship_kb) === '5' && l.sales_no && l.sales_no !== l.order_no ? `${l.sales_no}-${BRANCH(l.sales_suffix)}` : Number(l.corrections) > 0 ? `${l.order_no}-${BRANCH(1)}` : l.order_no);
// 赤黒の起票・取消で元伝票の番号（-01 の有無）が変わるので、元伝票を含む請求の保存済みのまとめを消す（読むときは明細から作り、次の起動で作り直す）
async function dropSummaryOf(c, orderNo) { await c.query(`DELETE FROM app_billing_line WHERE invoice_id IN (SELECT h.invoice_id FROM billing_detail d JOIN billing_head h ON ${DETAIL_JOIN} WHERE d.order_no=?)`, [String(orderNo)]); }
const decodeLine = l => ({ carry: CARRY(l.kbn_cat), unit: l.unit || '', orderNo: slipNoOf(l), ownNo: l.order_no, date: fromNum(l.sales_date), site: `${l.field_cd}|${l.field_suffix}`, siteName: l.field_name || l.st_site || '', item: l.item_cd, itemName: l.item_name, quantity: num(l.quantity), price: num(l.unit_price),
  net: num(l.money), taxRate: num(l.tax_rate), remarks: l.remarks || '', shipKb: Number(l.ship_kb || 1) });
// 請求書・請求書発行確認表・請求詳細の明細はまとめずに全行を現場別に出す（2026-10-27 内部会議 No.3：「明細は現場別に全行を出力」）。
// 以前の「得意先×現場×出荷日×商品でまとめる」（指摘 No.9、app_billing_line に保存）は廃止。テーブルは残すが読み書きしない
export const summaryLines = async (c, ids, lines) => lines;
// 赤・黒は元伝票の直後に並べる（元伝票の売上日・番号で並べ、枝番 2 赤・3 黒の順）
async function headLines(c, h) { const w = detailWhere(h); return (await rows(c, `SELECT d.*, st.sales_no, st.sales_suffix, (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=d.order_no AND x.order_no<>d.order_no) corrections, NULLIF(TRIM(CONCAT_WS(' ', st.field_name1, st.field_name2)), '') st_site, unit_name(i.unit) unit, (SELECT k.category1 FROM code_m k WHERE k.code_key='A0000' AND k.code_dtl=CAST(d.shipping_kb AS TEXT)) kbn_cat FROM billing_detail d LEFT JOIN item_m i ON i.item_cd=d.item_cd
    LEFT JOIN sales_trn st ON st.order_no=d.order_no AND st.order_suffix=1 LEFT JOIN sales_trn o ON st.ship_kb='5' AND o.order_no=st.sales_no AND o.order_suffix=1
    WHERE ${w.sql.replace(/(^|AND )(\w+)=/g, '$1d.$2=')} ORDER BY d.field_cd, d.field_suffix, COALESCE(o.sales_date, d.sales_date), COALESCE(o.order_no, d.order_no), COALESCE(st.sales_suffix, 1)`, w.args)).map(decodeLine); }
export async function invoiceDetail(c, id) {
  const h = await one(c, `${invoiceSql} WHERE h.invoice_id=?`, [Number(id)]); check(h, '請求が見つかりません');
  const issues = await rows(c, 'SELECT issue_no, issued_at, issued_by, document_sha256 FROM invoice_issue WHERE invoice_id=? ORDER BY issue_no', [h.invoice_id]);
  const allocations = await rows(c, 'SELECT r.receipt_no, r.receipt_date, r.status, a.amount FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id WHERE a.invoice_id=? ORDER BY r.receipt_date', [h.invoice_id]);
  const lines = await headLines(c, h);
  return { ...decodeInvoice(h), lines,
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
    const sales = await rows(c, "SELECT s.*, unit_name(i.unit) unit, (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrections FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd WHERE s.customers_cd=? AND s.process_status='0' AND s.payment_method_cd=2 AND s.sales_date<=? ORDER BY s.field_cd, s.field_suffix, s.sales_date, s.order_no", [customer, toNum(end)]);
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
  const custs = await rows(c, "SELECT customers_cd, customers_name FROM client_m WHERE (delete_f<>'1' AND CAST(substring(deadline from '^ *([0-9]+)') AS INTEGER)=?) OR customers_cd IN (SELECT customers_cd FROM billing_head WHERE closing_date=?) ORDER BY customers_cd", [day, toNum(end)]);
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
// 発行前確認一覧（2026-10-25）：請求データ作成の前に、その締日で請求される未請求の掛売上（出荷伝票）を得意先ごとに明細で確認する。
// 現行 HAR430（メニュー 11）は請求書印刷及び更新（12）の前に出力していたため、請求データを作らずに出荷伝票から直接作る。
// 対象・条件は請求データ作成（runBilling）と同じ：締日の得意先、process_status=0・掛売・売上日≦締日。
// closing='all'（2026-10-27）：規定の締日 5・10・15・20・月末 をまとめて表示（請求漏れの確認用）。各行に締日・請求期間を持つ
const PRECHECK_CLOSINGS = [5, 10, 15, 20, 31];
export async function billingPrecheck(c, { month, closing, customer }) {
  if (String(closing) === 'all') {
    const parts = []; for (const cl of PRECHECK_CLOSINGS) parts.push(await billingPrecheckOne(c, { month, closing: cl, customer }));
    return { month, closing: 'all', start: parts[0].start, end: parts[parts.length - 1].end, company: parts[0].company, rows: parts.flatMap(p => p.rows) };
  }
  return billingPrecheckOne(c, { month, closing, customer });
}
async function billingPrecheckOne(c, { month, closing, customer }) {
  const { start, end } = period(month, closing), day = closingDay(closing);
  const args = [day]; let cw = '';
  if (customer) { cw = ' AND (customers_cd=? OR customers_name LIKE ?)'; args.push(String(customer), '%' + String(customer) + '%'); }
  const custs = await rows(c, `SELECT customers_cd, customers_name FROM client_m WHERE delete_f<>'1' AND CAST(substring(deadline from '^ *([0-9]+)') AS INTEGER)=?${cw} ORDER BY customers_cd`, args);
  const out = [];
  for (const cu of custs) {
    const sales = await rows(c, "SELECT s.*, unit_name(i.unit) unit, (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrections, (SELECT k.category1 FROM code_m k WHERE k.code_key='A0000' AND k.code_dtl=CAST(s.shipping_kb AS TEXT)) kbn_cat FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd WHERE s.customers_cd=? AND s.process_status='0' AND s.payment_method_cd=2 AND s.sales_date<=? ORDER BY s.field_cd, s.field_suffix, s.sales_date, s.order_no", [cu.customers_cd, toNum(end)]);
    if (!sales.length) continue;
    const { net, tax } = totals(sales), lines = sales.map(s => decodeLine({ ...s, field_name: s.field_name1 }));
    const h = await one(c, 'SELECT invoice_id, invoice_flag FROM billing_head WHERE customers_cd=? AND closing_date=?', [cu.customers_cd, toNum(end)]);
    const locked = h && (h.invoice_flag !== '0' || await one(c, 'SELECT 1 x FROM receipt_allocation WHERE invoice_id=? LIMIT 1', [h.invoice_id]));
    const byRate = RATES.map(rate => { const n = lines.filter(l => Math.round(l.taxRate) === rate).reduce((a, l) => a + l.net, 0); return { rate, net: n, tax: bucketTax(n, rate) }; }).filter(x => x.net);
    out.push({ closing: day, start, end, customer: cu.customers_cd, name: cu.customers_name, plan: !h ? 'new' : locked ? 'next' : 'append', invoiceId: h?.invoice_id || null,
      count: lines.length, corrections: lines.filter(l => String(l.shipKb) === CORRECTION).length, late: sales.filter(s => fromNum(s.sales_date) < start).length,
      sites: new Set(lines.map(l => l.site)).size, net, tax, current: net + tax, byRate, lines });
  }
  const co = await one(c, 'SELECT company_name1 FROM company_info_m WHERE company_info_id=1');
  return { month, start, end, closing: day, company: co?.company_name1 || '', rows: out };
}
export const PRECHECK_PLAN = { new: '新規作成', append: '作成済みの請求に追加', next: '発行済みのため次回締めで請求' };
// NO13 請求書発行確認表: issued customers with lines, same calculation as NO12.
// 該当なしのとき案内する「請求がある年月・締日」（新しい順）。issued=true は発行済みのみ
async function billingPeriods(c, issued) {
  return (await rows(c, `SELECT DISTINCT h.closing_yymm, h.closingdd FROM billing_head h${issued ? ' WHERE EXISTS (SELECT 1 FROM invoice_issue i WHERE i.invoice_id=h.invoice_id)' : ''} ORDER BY h.closing_yymm DESC, h.closingdd LIMIT 12`))
    .map(r => ({ month: String(r.closing_yymm).replace(/^(\d{4})(\d{2})$/, '$1-$2'), closing: Number(r.closingdd) }));
}
// unissued='1'：未発行の請求も含める（発行前に全得意先の明細を確認する用途。現行 HAR430 はメニュー 11＝請求書印刷及び更新の前に出力）
export async function billingConfirm(c, { month, closing, unissued, customer }) {
  const { end } = period(month, closing), withDraft = String(unissued || '') === '1';
  const heads = await rows(c, `SELECT DISTINCT h.customers_cd, c.customers_name FROM billing_head h JOIN client_m c ON c.customers_cd=h.customers_cd WHERE h.closing_date=?${customer ? ' AND h.customers_cd=?' : ''}${withDraft ? '' : ' AND EXISTS (SELECT 1 FROM invoice_issue i WHERE i.invoice_id=h.invoice_id)'} ORDER BY h.customers_cd`, [toNum(end), ...(customer ? [String(customer)] : [])]);
  const out = [];
  for (const h of heads) {
    const s = await statement(c, h.customers_cd, month, closing);
    const last = s.invoiceIds.length ? await one(c, `SELECT i.issue_no, i.issued_at, i.issued_by FROM invoice_issue i WHERE i.invoice_id IN (${s.invoiceIds.map(() => '?').join(',')}) ORDER BY i.issued_at DESC LIMIT 1`, s.invoiceIds) : null;
    out.push({ ...s, lines: await summaryLines(c, s.invoiceIds, s.lines), name: h.customers_name, lastIssue: last ? { no: last.issue_no, at: last.issued_at, by: last.issued_by } : null });
  }
  // 税率別（現行 HAR430 の合計下段「10 %  売上額  消費税額」）
  for (const r of out) r.byRate = RATES.map(rate => { const n = r.lines.filter(l => Math.round(l.taxRate) === rate).reduce((a, l) => a + l.net, 0); return { rate, net: n, tax: bucketTax(n, rate) }; }).filter(x => x.net);
  const co = await one(c, 'SELECT company_name1 FROM company_info_m WHERE company_info_id=1');
  return { month, end, closing: closingDay(closing), company: co?.company_name1 || '', unissued: withDraft, rows: out, available: out.length ? [] : await billingPeriods(c, !withDraft) };
}
export async function companyProfile(c) {
  const co = await one(c, 'SELECT * FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const set = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_abr FROM code_m WHERE code_key='SET'")).map(r => [r.code_dtl, r.code_dtl_abr]));
  const bankOf = async code => {
  let bankText = '';
  if (code) {
    const z = await one(c, "SELECT b.code_dtl_nam name, z.category1 bk, z.category2 bt, z.category3 acc FROM code_m b LEFT JOIN code_m z ON z.code_key='ZGN' AND z.code_dtl=b.code_dtl WHERE b.code_key='BANK' AND b.code_dtl=?", [code]);
    if (z) {
      const dir = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BKDIR' AND code_dtl IN (?, ?)", [z.bk || '', (z.bk || '') + '-' + String(z.bt || '').slice(0, 3)])).map(r => [r.code_dtl, r.code_dtl_nam]));
      const type = { 1: '普', 2: '当', 4: '貯' }[String(z.bt || '').slice(3, 4)] || '';
      bankText = [dir[z.bk] || z.name, dir[(z.bk || '') + '-' + String(z.bt || '').slice(0, 3)] || '', type ? '(' + type + ')' : '', z.acc || ''].filter(Boolean).join(' ');
    }
  }
  return bankText; };
  const bankText = await bankOf(set.INVBANK), bankText2 = await bankOf(set.INVBANK2);
  return { name: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), address: [co?.postcode && '〒' + co.postcode, co?.pref, co?.addr1, co?.addr2].filter(Boolean).join(' '), tel: co?.tel_no || '', fax: co?.fax_no || '', plant: co?.plant_name || '', invoiceNo: set.INVNO || '', bankText, banks: [bankText, bankText2].filter(Boolean), layout: set.INVLAYOUT || 'proposal' };
}
async function snapshot(c, inv) {
  const cu = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [inv.customer]);
  const s = await statement(c, inv.customer, inv.month, inv.closingDay);
  const buckets = RATES.map(rate => { const net = inv.lines.filter(l => l.taxRate === rate).reduce((n, l) => n + l.net, 0); return { rate, net, tax: bucketTax(net, rate) }; }).filter(b => b.net);
  return {
    company: await companyProfile(c), discount: 0, invoiceNo: 'K' + String(inv.closing).slice(0, 7).replace('-', '') + String(inv.id).padStart(5, '0'),
    customer: { code: inv.customer, name: cu?.customers_name || inv.customerName, address: cu?.addr1 || '', tel: cu?.tel_no || '' },
    site: { key: inv.site, name: inv.siteName }, invoiceId: inv.id, periodStart: s.start, closing: inv.closing, due: inv.due,
    demo: process.env.SHOW_DEMO_NOTICE !== '0', prevBalance: s.prevBalance, received: s.received, carried: s.carried, net: inv.net, tax: inv.tax, total: inv.total, grandTotal: s.carried + inv.total, buckets, lines: await summaryLines(c, [inv.id], inv.lines),
  };
}
// sites：{請求ID: [現場名]}（2026-10-27 現場別発行）。無い請求は全現場。スナップショットは請求全体を保存し、発行した現場（sites）と現場ごとの発行回数（siteIssueNo）を持つ
export async function issueInvoices(c, ctx, { ids, sites = {} }) {
  check(Array.isArray(ids) && ids.length > 0 && ids.length <= 200, '発行する請求を選択してください（最大200件）');
  const out = [];
  for (const id of [...new Set(ids.map(Number))].sort((a, b) => a - b)) {
    const h = await one(c, 'SELECT * FROM billing_head WHERE invoice_id=? FOR UPDATE', [id]); check(h, '請求が見つかりません');
    const inv = await invoiceDetail(c, id), snap = await snapshot(c, inv), no = (inv.issues || 0) + 1;
    const all = [...new Set(snap.lines.map(l => siteLabel(l.siteName)))], want = Array.isArray(sites[id]) ? [...new Set(sites[id].map(siteLabel))] : all;
    const bad = want.filter(n => !all.includes(n)); check(!bad.length && want.length, `請求No.${id} に現場「${bad.join('・')}」がありません`);
    const prev = (await siteIssues(c, [id])).get(id), siteIssueNo = Object.fromEntries(want.map(n => [n, (prev?.of(n).length || 0) + 1]));
    const body = JSON.stringify({ ...snap, issueNo: no, issuedOn: today(), issuedBy: ctx.user.login_id, sites: want, siteIssueNo }), sha = createHash('sha256').update(body).digest('hex');
    await c.query('INSERT INTO invoice_issue (invoice_id,issue_no,issued_at,issued_by,snapshot_json,document_sha256) VALUES (?,?,UTC_TIMESTAMP(6),?,?,?)', [id, no, ctx.user.login_id, body, sha]);
    for (const n of want) await c.query('INSERT INTO app_invoice_issue_site (invoice_id,issue_no,site_name) VALUES (?,?,?)', [id, no, n.slice(0, 80)]);
    await c.query('UPDATE billing_head SET invoice_flag=?, row_version=row_version+1 WHERE invoice_id=?', [no === 1 ? '1' : '2', id]);
    const w = detailWhere(h); await c.query(`UPDATE billing_detail SET invoice_issud_flag='1' WHERE ${w.sql}`, w.args);
    await audit(c, ctx, 'billing_head', id, no === 1 ? 'invoice.issue' : 'invoice.reissue', { issueNo: no, sha256: sha, sites: want });
    out.push({ ...JSON.parse(body), reissue: no > 1 });
  }
  return { documents: out };
}
// 現場名の表記（請求書の「現場：」・現場別発行の単位）。名称の無い現場は（現場なし）
export const siteLabel = n => (n && String(n).trim() ? String(n) : '（現場なし）');
// 請求ごとの発行（invoice_issue）と現場の対応：of(現場名)＝その現場を発行した回の issue_no（古い順）。現場の行が無い発行は全現場
async function siteIssues(c, ids) {
  const out = new Map(); if (!ids.length) return out;
  const q = ids.map(() => '?').join(',');
  const iss = await rows(c, `SELECT invoice_id, issue_no FROM invoice_issue WHERE invoice_id IN (${q}) ORDER BY issue_no`, ids);
  const st = await rows(c, `SELECT invoice_id, issue_no, site_name FROM app_invoice_issue_site WHERE invoice_id IN (${q})`, ids);
  for (const id of ids) {
    const mine = st.filter(x => Number(x.invoice_id) === Number(id)), withSite = new Set(mine.map(x => Number(x.issue_no)));
    const all = iss.filter(x => Number(x.invoice_id) === Number(id) && !withSite.has(Number(x.issue_no))).map(x => Number(x.issue_no));
    out.set(Number(id), { of: n => [...all, ...mine.filter(x => x.site_name === siteLabel(n)).map(x => Number(x.issue_no))].sort((a, b) => a - b) });
  }
  return out;
}
export async function issuedDocument(c, id, site = null) {
  const nos = site ? (await siteIssues(c, [Number(id)])).get(Number(id)).of(site) : null; check(!site || nos.length, `現場「${siteLabel(site)}」は未発行です`);
  const r = await one(c, `SELECT snapshot_json, issue_no FROM invoice_issue WHERE invoice_id=?${site ? ' AND issue_no=?' : ''} ORDER BY issue_no DESC LIMIT 1`, site ? [Number(id), nos.at(-1)] : [Number(id)]); check(r, '発行履歴がありません');
  const s = typeof r.snapshot_json === 'string' ? JSON.parse(r.snapshot_json) : r.snapshot_json;
  // 2026-10-26 より前の発行分は明細に現場名が無い：金額はそのまま、現場名を今の請求明細から補う（まとめない）
  if (s.lines?.length && s.lines.every(l => !l.siteName)) {
    const h = await one(c, 'SELECT * FROM billing_head WHERE invoice_id=?', [Number(id)]), at = new Map();
    for (const l of h ? await headLines(c, h) : []) { at.set(String(l.orderNo), l); at.set(String(l.ownNo), l); }
    s.lines = (s.lines.map(l => { const x = at.get(String(l.ownNo || l.orderNo)) || at.get(String(l.orderNo)); return x ? { ...l, site: x.site, siteName: x.siteName } : l; }));
  }
  if (site) s.sites = [siteLabel(site)];
  return { ...s, issueNo: r.issue_no, reissue: r.issue_no > 1, copy: true };
}
// site・siteName（請求一覧照会の現場の行）があればその現場の明細だけを取消す（2026-10-28）。残りの現場で金額・消費税を計算し直し、売掛金の仕訳は逆仕訳して同じ伝票番号で計上し直す。
// 現場の明細が請求の全明細なら請求ごと取消す
export async function cancelInvoice(c, ctx, { id, site, siteName }) {
  const h = await one(c, 'SELECT * FROM billing_head WHERE invoice_id=? FOR UPDATE', [Number(id)]); check(h, '請求が見つかりません');
  await assertOpen(c, fromNum(h.closing_date));
  check(!(await one(c, 'SELECT 1 x FROM invoice_issue WHERE invoice_id=? LIMIT 1', [h.invoice_id])), '発行済みの請求は取消できません（発行履歴を保全するため）');
  check(!(await one(c, 'SELECT 1 x FROM receipt_allocation WHERE invoice_id=? LIMIT 1', [h.invoice_id])), '入金消込のある請求は取消できません');
  const w = detailWhere(h);
  if (site !== undefined || siteName !== undefined) {
    const all = await headLines(c, h), mine = all.filter(l => (!site || l.site === site) && l.siteName === (siteName || ''));
    check(mine.length, 'この現場の明細がありません（画面を更新してください）');
    if (mine.length < all.length) return cancelSite(c, ctx, h, w, [...new Set(mine.map(l => l.ownNo))], siteLabel(siteName));
  }
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

async function cancelSite(c, ctx, h, w, orders, label) {
  const end = fromNum(h.closing_date);
  for (const o of orders) {
    await c.query("UPDATE sales_trn SET process_status='0', claim_processing_period=NULL WHERE order_no=?", [o]);
    await c.query('UPDATE shipment_slip SET claim_status=0, claim_processing_period=0 WHERE order_no=?', [o]);
    await c.query(`DELETE FROM billing_detail WHERE ${w.sql} AND order_no=?`, [...w.args, o]);
  }
  const { net, tax } = totals(await rows(c, `SELECT money, tax_rate FROM billing_detail WHERE ${w.sql}`, w.args));
  await c.query('UPDATE billing_head SET money=?, consumption_tax=?, row_version=row_version+1 WHERE invoice_id=?', [net, tax, h.invoice_id]);
  const prev = await one(c, "SELECT s.slip_no FROM journal_entry e JOIN app_slip_no s ON s.journal_id=e.journal_id WHERE e.source_type='billing_head' AND e.source_id=? AND e.status='POSTED' AND e.reversal_of IS NULL", [String(h.invoice_id)]);
  await reverseJournal(c, { sourceType: 'billing_head', sourceId: h.invoice_id, date: end });
  await postBillingJournal(c, h.invoice_id, end, h.customers_cd, net, tax, prev ? { max: AR_SLIP_MAX, no: prev.slip_no, count: 0 } : { max: AR_SLIP_MAX });
  await audit(c, ctx, 'billing_head', h.invoice_id, 'billing.cancel', { customer: h.customers_cd, closing: end, site: label, orders: orders.length, net, tax });
  return { cancelled: h.invoice_id, site: label, orders: orders.length, net, tax };
}

// ---------- 入金・消込 (NO17: 当座預金・現金・手形・振込手数料・協力会費・預り金充当・値引) ----------
export const RECEIPT_PARTS = { BANK: '振込', CASH: '現金', NOTE: '手形', FEE: '振込手数料', COOP: '協力会費等', DEPOSIT: '預り金充当', DISCOUNT: '値引', LOSS: '雑損失' };
const DEPOSIT_USED = "SELECT COALESCE(SUM(k.amount),0) v FROM receipt_component k JOIN receipt r ON r.receipt_id=k.receipt_id AND r.status='POSTED' WHERE r.customers_cd=? AND k.component_kind='DEPOSIT'";
export async function depositBalance(c, customer) {
  const base = num((await one(c, "SELECT COALESCE(SUM(amount),0) v FROM opening_balance WHERE customers_cd=? AND balance_kind='ADVANCE'", [customer])).v);
  const over = num((await one(c, "SELECT COALESCE(SUM(k.amount),0) v FROM receipt_component k JOIN receipt r ON r.receipt_id=k.receipt_id AND r.status='POSTED' WHERE r.customers_cd=? AND k.component_kind='OVERPAY'", [customer])).v);
  return base + over - num((await one(c, DEPOSIT_USED, [customer])).v);
}
export async function receiptContext(c, customer, exclude = 0) {
  // 得意先が空のときは全得意先の請求を返さない（未選択のまま消込対象が表示されて登録エラーになっていた）
  const cu = String(customer || ''); if (!cu) return { invoices: [], deposit: 0 };
  // 2026-10-23：未発行の請求も残高があれば消込対象（移行データは発行履歴が無いため）。発行の有無は status（draft＝未発行）で表示
  // exclude＝修正する入金（2026-10-27）：その入金を取り消した後の残高・預り金残高で返す
  const ex = Number(exclude) || 0, back = ex ? await rows(c, "SELECT a.invoice_id, a.amount FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.receipt_id=? AND r.customers_cd=?", [ex, cu]) : [];
  const undo = id => back.filter(x => x.invoice_id === id).reduce((n, x) => n + num(x.amount), 0);
  const invoices = (await listInvoices(c, { customer: cu, status: ex ? '' : 'open' })).map(i => (undo(i.id) ? { ...i, paid: i.paid - undo(i.id), balance: i.balance + undo(i.id) } : i))
    .filter(i => i.balance > 0).sort((a, b) => a.closing.localeCompare(b.closing) || a.id - b.id);
  const dep = ex ? await one(c, "SELECT COALESCE(SUM(CASE WHEN k.component_kind='DEPOSIT' THEN k.amount WHEN k.component_kind='OVERPAY' THEN -k.amount ELSE 0 END),0) v FROM receipt_component k JOIN receipt r ON r.receipt_id=k.receipt_id AND r.status='POSTED' WHERE k.receipt_id=?", [ex]) : null;
  return { invoices, deposit: (await depositBalance(c, cu)) + num(dep?.v) };
}
export const openInvoices = async (c, customer) => (await receiptContext(c, customer)).invoices;
const BANK_SUB = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='receipt' AND je.source_id=CAST(r.receipt_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
export async function listReceipts(c, q = {}) {
  const args = [], w = [];
  if (q.month) { isoMonth(q.month); w.push("to_char(r.receipt_date,'YYYY-MM')=?"); args.push(q.month); }
  if (q.customer) { w.push('r.customers_cd=?'); args.push(q.customer); }
  const rs = await rows(c, `SELECT r.*, c.customers_name, ${BANK_SUB} bank_code FROM receipt r LEFT JOIN client_m c ON c.customers_cd=r.customers_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.receipt_date DESC, r.receipt_id DESC LIMIT 1000`, args);
  const ids = rs.map(r => r.receipt_id), ph = ids.map(() => '?').join(',');
  const comps = ids.length ? await rows(c, `SELECT * FROM receipt_component WHERE receipt_id IN (${ph})`, ids) : [];
  const allocs = ids.length ? await rows(c, `SELECT a.*, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${ph})`, ids) : [];
  return rs.map(r => {
    const part = k => num(comps.find(x => x.receipt_id === r.receipt_id && x.component_kind === k)?.amount);
    return { id: r.receipt_id, no: r.receipt_no, date: r.receipt_date, customer: r.customers_cd, customerName: r.customers_name, received: num(r.received_amount), settlement: num(r.settlement_amount),
      bank: part('BANK'), cash: part('CASH'), notes: part('NOTE'), fee: part('FEE'), coop: part('COOP'), deposit: part('DEPOSIT'), overpay: part('OVERPAY'), discount: part('DISCOUNT'), loss: part('LOSS'), bankCode: r.bank_code || '', noteDue: comps.find(x => x.receipt_id === r.receipt_id && x.component_kind === 'NOTE')?.maturity_date || '', status: r.status,
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
  const parts = { BANK: yen(p.bank || 0, '振込'), CASH: yen(p.cash || 0, '現金'), NOTE: yen(p.notes || 0, '手形'), FEE: yen(p.fee || 0, '振込手数料'), COOP: yen(p.coop || 0, '協力会費等'), DEPOSIT: yen(p.deposit || 0, '預り金充当'), DISCOUNT: yen(p.discount || 0, '値引・端数') , LOSS: yen(p.loss || 0, '雑損失') };
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
    check(date >= fromNum(h.closing_date), '入金日が請求締日より前です');
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
  // 現行入金処理では借方の処税率を入力できる（p.tax：{ FEE: '041', … }。2026-10-31）。指定が無ければ既定値
  // 外税の処税率を選んだときは、入金額（税込）を科目の税抜金額と仮払消費税 1465 に分ける（定時請求・小口現金の外税と同じ）
  const tx = (k, d) => (p.tax?.[k] ? mustDecode(p.tax[k], `${RECEIPT_PARTS[k]}の処税率`).code : d);
  const dr = (acc, k, def, opt = {}) => { const amt = parts[k], code = tx(k, def), d = decode(code), r = d?.excl ? Math.round(d.rate * 10) : 0, t = amt && r ? Math.floor(amt * r / (1000 + r)) : 0;
    return [line('D', acc, amt - t, { ...opt, tax: code }), line('D', '1465', t, { tax: '9' })]; };
  await postJournal(c, { date, pattern: 'B01', sourceType: 'receipt', sourceId: r.insertId, lines: [
    ...dr('1112', 'BANK', '9', { sub: bankCode }), ...dr('1111', 'CASH', '9'), ...dr('1120', 'NOTE', '9', { customer: cust.customers_cd }),
    ...dr('8330', 'FEE', '141', { sub: '101', dept: '063' }), ...dr('8330', 'COOP', '141', { sub: '107', dept: '063' }),
    ...dr('4170', 'DEPOSIT', '9', { customer: cust.customers_cd }), ...dr('8850', 'DISCOUNT', '141', { dept: '063' }), ...dr('8850', 'LOSS', '9', { dept: '063' }),
    ...allocs.map(a => line('C', '1131', a.amount, { customer: cust.customers_cd, tax: '9' })), line('C', '4170', overpay, { customer: cust.customers_cd, tax: '9' }) ] });
  await audit(c, ctx, 'receipt', r.insertId, 'receipt.create', { no, customer: cust.customers_cd, received, settlement, parts: Object.fromEntries(Object.entries(parts).filter(([, v]) => v)), invoices: allocs.map(a => a.id) });
  return { id: r.insertId, no };
}
// 入金の修正（2026-10-27）：月次確定前なら、元の入金を取り消して（逆仕訳）同じ得意先で新しい入金として登録し直す（1トランザクション）
export async function updateReceipt(c, ctx, p) {
  const r = await one(c, 'SELECT customers_cd FROM receipt WHERE receipt_id=?', [Number(p.id)]); check(r, '入金が見つかりません');
  check(r.customers_cd === String(p.customer || ''), '異なる得意先の入金は修正できません');
  await reverseReceipt(c, ctx, { id: p.id });
  const res = await createReceipt(c, ctx, p);
  return { ...res, replaced: Number(p.id) };
}
export async function reverseReceipt(c, ctx, { id }) {
  const r = await one(c, 'SELECT * FROM receipt WHERE receipt_id=? FOR UPDATE', [Number(id)]); check(r, '入金が見つかりません');
  check(r.status === 'POSTED', '取消済みです'); await assertOpen(c, r.receipt_date);
  await c.query("UPDATE receipt SET status='REVERSED', row_version=row_version+1 WHERE receipt_id=?", [r.receipt_id]);
  await reverseJournal(c, { sourceType: 'receipt', sourceId: r.receipt_id, date: r.receipt_date });
  await audit(c, ctx, 'receipt', r.receipt_id, 'receipt.reverse', { no: r.receipt_no });
  return { id: r.receipt_id };
}

// ---------- 請求残高照会・入金消込の対象選択・入金予定一覧（提案書 スライド18〜21） ----------
// 得意先×請求年月ごとに 前回残高（前回の今回残高）→ 当月請求金額 → 今回請求金額 → 消込金額（その締日の翌日から次の締日までの入金消込）→ 消込残高（10/27 内部会議 No.19 で「今回残高」から改称）
export async function arLedger(c, q = {}) {
  const t = String(q.customer || '').trim(), like = `%${t}%`;
  const custs = await rows(c, `SELECT customers_cd, customers_name FROM client_m WHERE (customers_cd LIKE ? OR customers_name LIKE ?) ORDER BY customers_cd`, [like, like]);
  const out = [], closed = new Set((await rows(c, 'SELECT period FROM app_period_close')).map(r => r.period));
  for (const cu of custs) {
    const invs = (await listInvoices(c, { customer: cu.customers_cd })).filter(i => i.customer === cu.customers_cd).sort((a, b) => a.closing.localeCompare(b.closing) || a.id - b.id);
    const opening = num((await one(c, "SELECT COALESCE(SUM(amount),0) v FROM opening_balance WHERE customers_cd=? AND balance_kind='AR'", [cu.customers_cd])).v);
    if (!invs.length && !opening) continue;
    const pays = await rows(c, "SELECT r.receipt_id id, r.receipt_date d, SUM(a.amount) v FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.customers_cd=? GROUP BY r.receipt_id, r.receipt_date ORDER BY r.receipt_date, r.receipt_id", [cu.customers_cd]);
    let prev = opening;
    invs.forEach((inv, i) => {
      const next = invs[i + 1]?.closing || '9999-12-31', mine = pays.filter(p => String(p.d).slice(0, 10) > inv.closing && String(p.d).slice(0, 10) <= next), cleared = mine.reduce((n, p) => n + num(p.v), 0);
      const claim = prev + inv.total, remain = claim - cleared;
      // receipt＝この行の最新の入金（月次確定前なら入金消込の一覧から選び直して修正できる。2026-10-27）
      const last = mine[mine.length - 1], receipt = last && !closed.has(String(last.d).slice(0, 7)) ? last.id : 0;
      out.push({ customer: cu.customers_cd, name: cu.customers_name, month: inv.month, closing: inv.closing, invoiceId: inv.id, prev, current: inv.total, claim, cleared, remain, receipt, latest: i === invs.length - 1, issued: inv.issues > 0, status: inv.status });
      prev = remain;
    });
  }
  const rowsOut = q.month ? out.filter(r => r.month === q.month) : out;
  return { rows: rowsOut, totals: { current: rowsOut.reduce((n, r) => n + r.current, 0), claim: rowsOut.reduce((n, r) => n + r.claim, 0), cleared: rowsOut.reduce((n, r) => n + r.cleared, 0), remain: rowsOut.filter(r => r.latest).reduce((n, r) => n + r.remain, 0) } };
}
