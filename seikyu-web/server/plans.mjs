// 出荷予定（現行 NS001001 出荷予定登録・NS005001 出荷予定検索・NS002002 出荷予定照会・NS003003 出荷予定修正、テーブル shipment_plan）と
// 納品書発行（現行 NI0060 / MA057001：出荷日単位、1伝票＝1ページ、単価・金額は印字しない、ship_printing_fg4 で再発行判定）。
// 機能一覧の範囲外のため、現行 Java ソースからの推定実装（2026-10-21）。
import { check, Conflict, qty, isoDate, text, today } from './domain.mjs';
import { rows, one, assertOpen, audit } from './db.mjs';
import { priceFor, taxRateOn, roundModes, moneyOf, lineTax, siteOf, hhmm, applyPlan, workKeyArgs, businessDate } from './sales.mjs';

const num = v => Number(v || 0);
const WORK = 'shipment_dt=? AND customers_cd=? AND delivery_name=? AND field_name1=? AND field_name2=? AND item_cd=? AND delivery_kbn_cd=?';
const PLAN_SELECT = `SELECT p.*, c.customers_name, i.item_nam, unit_name(p.unit_cd) unit, op.tanto_nm, dk.code_dtl_nam delivery_kbn_name, oc.customers_name other_name,
    (SELECT s.order_no FROM shipment_slip s WHERE s.shipment_dt=p.shipment_dt AND s.customers_cd=p.customers_cd AND s.delivery_name=p.delivery_name AND s.field_name1=p.field_name1 AND s.field_name2=p.field_name2
      AND s.item_cd=p.item_cd AND s.delivery_kbn_cd=p.delivery_kbn_cd AND s.cumulative_number=p.cumulative_number AND s.ship_kb NOT IN (2,9) AND s.quantity>=0 ORDER BY s.order_no LIMIT 1) shipped_no
  FROM shipment_plan p LEFT JOIN client_m c ON c.customers_cd=p.customers_cd LEFT JOIN item_m i ON i.item_cd=p.item_cd LEFT JOIN client_m oc ON oc.customers_cd=NULLIF(p.other_company_customers_cd,'')
  LEFT JOIN operator_m op ON op.tanto_cd=CAST(NULLIF(p.person_in_charge_cd,'') AS INTEGER) LEFT JOIN code_m dk ON dk.code_key='A0000' AND dk.code_dtl=CAST(p.delivery_kbn_cd AS TEXT)`;
const decode = r => ({ orderNo: r.order_no, date: String(r.shipment_dt).slice(0, 10), shipKb: Number(r.ship_kb), customer: r.customers_cd, customerName: r.customers_name || '', otherCustomer: r.other_company_customers_cd || '', otherCustomerName: r.other_name || '',
  site: r.field_cd ? `${r.field_cd}|${r.field_suffix}` : '', siteName1: r.field_name1 || '', siteName2: r.field_name2 || '', siteName: [r.field_name1, r.field_name2].filter(Boolean).join(' '),
  item: r.item_cd, itemName: r.item_nam || '', deliveryKbn: String(r.delivery_kbn_cd), deliveryKbnName: r.delivery_kbn_name || '', quantity: num(r.quantity), unit: r.unit || '',
  cumulativeQty: num(r.cumulative_quantity), cumulativeCount: num(r.cumulative_number), price: num(r.unit_price), freight: num(r.freight), net: num(r.money), taxRate: num(r.tax_rate), tax: num(r.consumption_tax),
  method: num(r.payment_method_cd), vehicle: r.vehicle_no || '', startTime: r.start_time || '', operator: r.person_in_charge_cd || '', operatorName: r.tanto_nm || '', remarks: r.slip_remark || '', shippedNo: r.shipped_no || '' });

// NS005001：出荷日 From/To・得意先・現場名・担当者で検索。並びは 得意先・現場・出荷日・伝票No
export async function listPlans(c, q = {}) {
  const from = q.from ? isoDate(q.from, '出荷日（自）') : await businessDate(c), to = q.to ? isoDate(q.to, '出荷日（至）') : from;
  check(from <= to, '出荷日の範囲が不正です');
  const w = ['p.shipment_dt BETWEEN ? AND ?'], args = [from, to];
  if (q.customer) { w.push('p.customers_cd=?'); args.push(String(q.customer)); }
  if (q.site) { w.push("(p.field_name1 LIKE ? OR p.field_name2 LIKE ?)"); args.push(`%${q.site}%`, `%${q.site}%`); }
  if (q.operator) { w.push('p.person_in_charge_cd=?'); args.push(String(q.operator).padStart(6, '0')); }
  return (await rows(c, `${PLAN_SELECT} WHERE ${w.join(' AND ')} ORDER BY p.customers_cd, p.field_cd, p.shipment_dt, p.start_time, p.order_no LIMIT 2000`, args)).map(decode);
}

// 予定伝票No：P＋出荷日の YYMM＋5桁（現行は numbering_m id=1。出荷伝票の番号と重ならないよう接頭辞 P）
async function nextPlanNo(c, date) {
  const p = 'P' + date.slice(2, 4) + date.slice(5, 7);
  await one(c, 'SELECT present_value FROM numbering_m WHERE numbering_key=101 FOR UPDATE');
  const r = await one(c, 'SELECT MAX(order_no) m FROM shipment_plan WHERE order_no ~ ?', ['^' + p + '[0-9]{5}$']);
  const next = r?.m ? Number(String(r.m).slice(5)) + 1 : 1; check(next <= 99999, '今月の予定伝票番号が上限に達しました');
  return p + String(next).padStart(5, '0');
}

// NS001001.validate：出荷日・得意先・納入場所名1・商品・納入区分・数量・担当者は必須。他社得意先は区分2・4のみ。累計台数・累計数量は手入力可（空欄は自動）
export async function savePlan(c, ctx, p) {
  const date = isoDate(p.date, '出荷日'); await assertOpen(c, date);
  const cust = await one(c, 'SELECT * FROM client_m WHERE customers_cd=?', [String(p.customer || '')]); check(cust && cust.delete_f !== '1', '有効な得意先を選択してください');
  const f = await siteOf(c, cust, p); check(f.field_name1, '納入場所名1を入力してください');
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(p.item || '')]); check(it && it.delete_f !== '1', '有効な商品を選択してください');
  const kbn = text(p.deliveryKbn, '納入区分', 2, { pattern: /^\d{1,2}$/ });
  const dk = await one(c, "SELECT category1 FROM code_m WHERE code_key='A0000' AND code_dtl=?", [kbn]); check(dk, '納入区分を選択してください');
  const q = qty(p.quantity, '数量');
  const opCode = text(p.operator, '担当者', 6, { pattern: /^\d{1,6}$/ });
  const op = await one(c, "SELECT tanto_cd FROM operator_m WHERE tanto_cd=? AND delete_f<>'1'", [Number(opCode)]); check(op, '担当者を担当者マスタから選択してください');
  const shipKb = String(p.shipKb || '1'); check(['1', '2', '3', '4'].includes(shipKb), '伝票区分が不正です');
  const other = text(p.otherCustomer, '他社得意先', 5, { required: false });
  if (['2', '4'].includes(shipKb)) check(other && await one(c, 'SELECT 1 x FROM client_m WHERE customers_cd=?', [other]), '伝票区分が他社納入のときは他社得意先を入力してください');
  else check(!other, '他社得意先は伝票区分が他社納入（2・4）のときだけ入力できます');
  const method = Number(p.method || 2); check([1, 2, 3].includes(method), '決済方法が不正です');
  const pr = await priceFor(c, { item: it.item_cd, customer: cust.customers_cd, site: p.site, date });
  const price = p.price === undefined || p.price === '' ? pr.price : Number(p.price), freight = dk.category1 === '2' ? 0 : p.freight === undefined || p.freight === '' ? pr.freight : Number(p.freight);
  check(Number.isInteger(price) && price >= 0 && price <= 9999999 && Number.isInteger(freight) && freight >= 0 && freight <= 9999999, '単価・運賃は0〜9,999,999の整数です');
  const mode = await roundModes(c), rate = await taxRateOn(c, date), net = moneyOf(q, price + freight, mode.money), tax = lineTax(net, rate, mode.tax);
  const key = { shipment_dt: date, customers_cd: cust.customers_cd, delivery_name: '', field_name1: f.field_name1.slice(0, 20), field_name2: f.field_name2.slice(0, 20), item_cd: it.item_cd, delivery_kbn_cd: Number(kbn) };
  const self = String(p.orderNo || '');
  // 累計台数：空欄は同じ作業キーの予定件数＋1。累計数量：空欄は直前の台数の累計＋数量（現行画面の JS と同じ）
  const count = p.cumulativeCount === undefined || p.cumulativeCount === '' ? num((await one(c, `SELECT COUNT(*) n FROM shipment_plan WHERE ${WORK} AND order_no<>?`, [...workKeyArgs(key), self])).n) + 1 : Number(p.cumulativeCount);
  check(Number.isInteger(count) && count >= 1 && count <= 999, '累計台数は1〜999です');
  const prev = await one(c, `SELECT cumulative_quantity FROM shipment_plan WHERE ${WORK} AND order_no<>? AND cumulative_number<? ORDER BY cumulative_number DESC LIMIT 1`, [...workKeyArgs(key), self, count]);
  const cq = p.cumulativeQty === undefined || p.cumulativeQty === '' ? qty(String((num(prev?.cumulative_quantity) + num(q.text)).toFixed(2)), '累計数量', { max: 9999999.99 }) : qty(p.cumulativeQty, '累計数量', { max: 9999999.99 });
  const vals = [Number(shipKb), date, cust.customers_cd, other, f.field_cd, f.field_suffix, key.field_name1, key.field_name2, it.item_cd, Number(kbn), q.text, it.unit, cq.text, price, net, rate, tax, method, net + tax,
    text(p.vehicle, '車両番号', 15, { required: false }), count, hhmm(p.startTime, '出発時間'), String(op.tanto_cd).padStart(6, '0'), text(p.remarks, '伝票備考', 128, { required: false }), freight];
  let orderNo = self, old = null;
  if (orderNo) {
    old = await one(c, 'SELECT * FROM shipment_plan WHERE order_no=? FOR UPDATE', [orderNo]); if (!old) throw new Conflict('出荷予定が見つかりません。再読込してください');
    await c.query(`UPDATE shipment_plan SET ship_kb=?,shipment_dt=?,customers_cd=?,other_company_customers_cd=?,field_cd=?,field_suffix=?,field_name1=?,field_name2=?,item_cd=?,delivery_kbn_cd=?,quantity=?,unit_cd=?,cumulative_quantity=?,
      unit_price=?,money=?,tax_rate=?,consumption_tax=?,payment_method_cd=?,payment_money=?,vehicle_no=?,cumulative_number=?,start_time=?,person_in_charge_cd=?,slip_remark=?,freight=?,update_daytime=UTC_TIMESTAMP(6) WHERE order_no=?`, [...vals, orderNo]);
  } else {
    orderNo = await nextPlanNo(c, date);
    await c.query(`INSERT INTO shipment_plan (ship_kb,shipment_dt,customers_cd,other_company_customers_cd,field_cd,field_suffix,field_name1,field_name2,item_cd,delivery_kbn_cd,quantity,unit_cd,cumulative_quantity,
      unit_price,money,tax_rate,consumption_tax,payment_method_cd,payment_money,vehicle_no,cumulative_number,start_time,person_in_charge_cd,slip_remark,freight,order_no,weather_cd,delivery_cd,delivery_name,start_temperature,update_daytime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'','',NULL,UTC_TIMESTAMP(6))`, [...vals, orderNo]);
  }
  if (old) await applyPlan(c, old);
  await applyPlan(c, key);
  await audit(c, ctx, 'shipment_plan', orderNo, old ? 'plan.update' : 'plan.create', { date, customer: cust.customers_cd, item: it.item_cd, count });
  return { orderNo, cumulativeCount: count, cumulativeQty: Number(cq.text) };
}
export async function deletePlan(c, ctx, { orderNo }) {
  const old = await one(c, 'SELECT * FROM shipment_plan WHERE order_no=? FOR UPDATE', [String(orderNo || '')]); if (!old) throw new Conflict('出荷予定が見つかりません。再読込してください');
  await c.query('DELETE FROM shipment_plan WHERE order_no=?', [old.order_no]); // 現行 NS004001：物理削除
  await applyPlan(c, old);
  await audit(c, ctx, 'shipment_plan', old.order_no, 'plan.delete', { date: String(old.shipment_dt).slice(0, 10), customer: old.customers_cd });
  return { orderNo: old.order_no };
}

// ---------- 納品書発行（NI0060） ----------
// 出荷日（1日）の全伝票、または照会画面からの1伝票。発行後 ship_printing_fg4：0→1、1→2（2は据え置き）。発行前が1以上なら「再」を印字。
const CARRY = kbn => ([1, 3, 7].includes(kbn) ? 1 : kbn === 9 ? 2 : 0); // 運搬方法 1 持込 / 2 Ｐ渡（現行 jrxml の判定）
export async function deliveryNotes(c, ctx, p) {
  const orderNo = String(p.orderNo || ''), date = orderNo ? '' : isoDate(p.date, '出荷日');
  const rs = await rows(c, `SELECT s.*, c.customers_name, i.item_nam, unit_name(s.unit_cd) unit, op.tanto_nm FROM shipment_slip s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd
    LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN operator_m op ON op.tanto_cd=CAST(NULLIF(s.person_in_charge_cd,'') AS INTEGER)
    WHERE ${orderNo ? 's.order_no=?' : 's.shipment_dt=?'} ORDER BY s.order_no`, [orderNo || date]);
  check(rs.length, '該当データがありません。');
  const co = await one(c, 'SELECT * FROM company_info_m WHERE company_info_id=1'), jp = iso => `${iso.slice(0, 4)}年${iso.slice(5, 7)}月${iso.slice(8, 10)}日`;
  const docs = rs.map(r => {
    const d = String(r.shipment_dt).slice(0, 10), st = r.start_time || '', pt = r.plan_start_time || '';
    return { orderNo: r.order_no, date: jp(d), reissue: num(r.ship_printing_fg4) >= 1, customerName: r.customers_name || '', siteName: r.field_name1 || '', itemName: r.item_nam || '', vehicle: r.vehicle_no || '',
      weather: '', startH: st.slice(0, 2), startM: st.slice(3, 5), arriveH: pt.slice(0, 2), arriveM: pt.slice(3, 5), temperature: r.start_temperature ?? '',
      quantity: num(r.quantity), unit: r.unit || '', cumulativeQty: num(r.cumulative_quantity), cumulativeCount: num(r.cumulative_number), operatorName: r.tanto_nm || '', remarks: r.slip_remark || '', carry: CARRY(num(r.delivery_kbn_cd)) };
  });
  if (orderNo) await c.query('UPDATE shipment_slip SET ship_printing_fg4=CASE WHEN ship_printing_fg4=0 THEN 1 ELSE 2 END, update_daytime=UTC_TIMESTAMP(6) WHERE order_no=? AND ship_printing_fg4<>2', [orderNo]);
  else await c.query('UPDATE shipment_slip SET ship_printing_fg4=CASE WHEN ship_printing_fg4=0 THEN 1 ELSE 2 END, update_daytime=UTC_TIMESTAMP(6) WHERE shipment_dt=? AND ship_printing_fg4<>2', [date]);
  await audit(c, ctx, 'shipment_slip', orderNo || date, 'delivery-note.issue', { slips: docs.length });
  return { company: { name1: co?.company_name1 || '', name2: co?.company_name2 || '', address: [co?.pref, co?.addr1, co?.addr2].filter(Boolean).join(''), tel: co?.tel_no || '', fax: co?.fax_no || '' }, docs, issuedOn: today() };
}
