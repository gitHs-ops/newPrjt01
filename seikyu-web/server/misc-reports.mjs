// ④ 在庫・出資金・出荷集計: NO25 配合計算, NO26 材料受払表, NO35 出資金請求明細表(定時), NO36 入金明細配分表, NO41〜43 出荷集計
import { check, isoDate, isoMonth, toNum, fromNum, today, addMonths, METHODS, yen } from './domain.mjs';
import { taxOf, decode as taxDecode, TAX_RATE } from './taxcode.mjs';
import { slipNoOf } from './sales.mjs';
import { rows, one, audit } from './db.mjs';
import { xlsx, band } from './xlsx.mjs';
import { companyPeriod } from './period.mjs';
import { jvAsOf } from './masters.mjs';

const num = v => Number(v || 0);
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const range = q => { const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です'); return { from, to }; };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;
// 締日（既定20日：現行の材料受払表は20日締め）による月度の期間
const closingRange = (month, closing) => { const d = Number(closing || 20); if (d >= 31) return { from: month + '-01', to: monthEnd(month), label: '暦月' }; const prev = addMonths(month, -1); return { from: `${prev}-${String(Math.min(d, 28) + 1).padStart(2, '0')}`, to: `${month}-${String(d).padStart(2, '0')}`, label: `${d}日締め` }; };

// ---------- NO41 商品・製品別出荷集計表：現行 HAR031 の並び（2026-11-04） ----------
// 商品（item_product_kb≠2）→【商品計】、製品（=2）→【製品計】→【合計】。他社納入（伝票区分 2・4）は別の表「（他社納入分）」にして【合計】、最後に【総合計】
// 列は 商品名・製品名（コード＋名称）・数量（＋単位）・金額 だけ。赤黒（区分 5）は元伝票の区分で振り分ける
export async function shipmentSummary(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.item_cd, MAX(COALESCE(NULLIF(i.item_nam, ''), s.item_name)) item_name, MAX(unit_name(i.unit)) unit, MAX(i.item_product_kb) pk,
      CASE WHEN (CASE WHEN s.ship_kb='5' THEN o.ship_kb ELSE s.ship_kb END) IN ('2','4') THEN 1 ELSE 0 END other, SUM(s.quantity) qty, SUM(s.money) net
    FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN sales_trn o ON s.ship_kb='5' AND o.order_no=s.sales_no AND o.order_suffix=1
    WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.item_cd, 5 ORDER BY 5, s.item_cd`, [toNum(from), toNum(to)]);
  const sections = [0, 1].map(other => {
    const mine = rs.filter(r => Number(r.other) === other);
    const groups = [['1', '商品'], ['2', '製品']].map(([kb, label]) => {
      const items = mine.filter(r => (r.pk === '2' ? '2' : '1') === kb).map(r => ({ item: r.item_cd, name: String(r.item_name || '').trim(), unit: r.unit || '', qty: r2(num(r.qty)), net: num(r.net) }));
      return { label, items, net: items.reduce((n, x) => n + x.net, 0) };
    }).filter(g => g.items.length);
    return { other: !!other, title: other ? '（他社納入分）' : '', groups, net: groups.reduce((n, g) => n + g.net, 0) };
  }).filter(s => s.groups.length);
  return { title: '商品・製品別出荷集計表', ref: 'NO41 / 添付帳票⑯（HAR031）', from, to, sections, total: sections.reduce((n, s) => n + s.net, 0) };
}
// ---------- NO42 得意先別商品別出荷累計表：現行 HAR536 の並び（2026-11-04） ----------
// 列は 得意先（コード＋名称、得意先の 1 行目だけ）・品名（コード＋名称）・単位・累計数量・累計金額。得意先計 → 総合計 → 値引（伝票区分 9）
// 他社納入（伝票区分 2・4）は別の表「他社納入分」。赤黒（区分 5）は元伝票の区分で振り分ける
// 得意先計・総合計の数量は製品（item_product_kb=2）だけの合計（現行サンプルの計がそうなっている：商品の台数などは足さない）。金額は全部の合計
export async function customerItems(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.customers_cd, MAX(c.customers_name) customers_name, s.item_cd, MAX(COALESCE(NULLIF(i.item_nam, ''), s.item_name)) item_name, MAX(unit_name(i.unit)) unit, MAX(i.item_product_kb) pk,
      CASE WHEN s.ship_kb='9' THEN 9 WHEN (CASE WHEN s.ship_kb='5' THEN o.ship_kb ELSE s.ship_kb END) IN ('2','4') THEN 1 ELSE 0 END sect, SUM(s.quantity) qty, SUM(s.money) net
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN sales_trn o ON s.ship_kb='5' AND o.order_no=s.sales_no AND o.order_suffix=1
    WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.customers_cd, s.item_cd, 7 ORDER BY s.customers_cd, s.item_cd`, [toNum(from), toNum(to)]);
  const disc = rs.filter(r => Number(r.sect) === 9), discount = { qty: r2(disc.reduce((n, r) => n + num(r.qty), 0)), net: disc.reduce((n, r) => n + num(r.net), 0) };
  const sections = [0, 1].map(other => {
    const customers = [];
    for (const r of rs.filter(x => Number(x.sect) === other)) {
      let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name || '', items: [], qty: 0, net: 0 });
      cu.items.push({ item: r.item_cd, name: String(r.item_name || '').trim(), unit: r.unit || '', qty: r2(num(r.qty)), net: num(r.net) });
      if (r.pk === '2') cu.qty = r2(cu.qty + num(r.qty)); cu.net += num(r.net);
    }
    return { other: !!other, title: other ? '他社納入分' : '', customers, qty: r2(customers.reduce((n, x) => n + x.qty, 0)), net: customers.reduce((n, x) => n + x.net, 0), discount: other ? { qty: 0, net: 0 } : discount };
  }).filter(s => s.customers.length || (!s.other && (s.discount.qty || s.discount.net)));
  return { title: '得意先別商品別出荷累計表', ref: 'NO42 / 添付帳票⑱（HAR536）', from, to, sections };
}
// ---------- NO43 現金売上明細表：現行 HAR551 の並び（2026-11-04） ----------
// 列は 得意先（コード＋名称、得意先の 1 行目だけ）・現場名・売上日・伝票No・商品名（コード＋名称）・数量・単位・単価・金額・処税率・運送・備考。得意先ごとに「*** 得意先計 ***」（金額）
// 単価は売上単価（単価＋運賃）。処税率は売上の 3 桁コード「2 1 税率区分」。運送は納入区分が引取（category1=2）なら 2 先方、それ以外は 1 現場
const RATE_DIGIT = Object.fromEntries(Object.entries(TAX_RATE).map(([k, v]) => [v, k]));
export async function cashSales(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.*, c.customers_name, unit_name(i.unit) unit, (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrections,
      (SELECT k.category1 FROM code_m k WHERE k.code_key='A0000' AND k.code_dtl=CAST(s.shipping_kb AS TEXT)) kbn_cat
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN item_m i ON i.item_cd=s.item_cd
    WHERE s.payment_method_cd=1 AND s.sales_date BETWEEN ? AND ? ORDER BY s.customers_cd, s.sales_date, CASE WHEN s.ship_kb='5' AND COALESCE(s.sales_no, '')<>'' THEN s.sales_no ELSE s.order_no END, s.sales_suffix, s.order_no`, [toNum(from), toNum(to)]);
  const customers = [];
  for (const r of rs) {
    let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name || '', rows: [], net: 0 });
    const rate = num(r.tax_rate);
    cu.rows.push({ site: [r.field_name1, r.field_name2].map(v => String(v || '').trim()).filter(Boolean).join(' '), date: fromNum(r.sales_date), no: slipNoOf(r), item: r.item_cd || '', itemName: String(r.item_name || '').trim(),
      qty: num(r.quantity), unit: r.unit || '', price: num(r.unit_price), net: num(r.money), tax: rate ? `21${RATE_DIGIT[rate] ?? ''}` : '090', carry: r.kbn_cat === '2' ? '2 先方' : '1 現場', remarks: r.remarks || '' });
    cu.net += num(r.money);
  }
  return { title: '現金売上明細表', ref: 'NO43 / 添付帳票⑲（HAR551）', from, to, customers };
}
// ---------- NO26 材料受払表（月次：前月末在庫＋当月仕入−当月末在庫＝当月使用） ----------
async function inv(c, month) {
  return Object.fromEntries((await rows(c, "SELECT item_cd, quantity, valuation_price, valuation_amount, status FROM inventory_count WHERE period_start=? AND location_code='MAIN' AND status IN ('POSTED','DRAFT')", [month + '-01'])).map(r => [r.item_cd, { posted: r.status === 'POSTED', qty: num(r.quantity), price: num(r.valuation_price), value: num(r.valuation_amount) }]));
}
export async function materialLedger(c, q) {
  const month = isoMonth(q.month, '対象月');
  const co = await one(c, 'SELECT closing_m FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const fyStartM = (num(co?.closing_m) % 12) + 1; // month after the fiscal closing month
  let fs = month; while (Number(fs.slice(5, 7)) !== fyStartM) fs = addMonths(fs, -1);
  const [prev, end, open] = [await inv(c, addMonths(month, -1)), await inv(c, month), await inv(c, addMonths(fs, -1))];
  const cr = closingRange(month, q.closing);
  const pur = Object.fromEntries((await rows(c, 'SELECT item_cd, SUM(quantity) q, SUM(net_amount) v FROM purchase WHERE purchase_date BETWEEN ? AND ? GROUP BY item_cd', [cr.from, cr.to])).map(r => [r.item_cd, { qty: num(r.q), value: num(r.v) }]));
  const codes = new Set([...Object.keys(prev), ...Object.keys(end), ...Object.keys(open), ...Object.keys(pur)]);
  const kinds = await rows(c, "SELECT item_cd, item_nam, unit_name(unit) unit, item_product_kb FROM item_m WHERE item_product_kb='1'"); // 1=材料（現行 Java）
  kinds.forEach(k => codes.add(k.item_cd));
  const names = Object.fromEntries((await rows(c, 'SELECT item_cd, item_nam, unit_name(unit) unit, tanka FROM item_m')).map(r => [r.item_cd, r]));
  const z = { qty: 0, value: 0 };
  // 金額のない在庫（実在庫登録のみ・評価額 0）は商品マスタの単価で評価する（2026-11-02 ユーザー指摘：マスタ単価を入れても金額が出ない）
  const tk = code => num(names[code]?.tanka) || null, valued = (o, code) => (o && !o.value && o.qty ? { ...o, value: Math.round(o.qty * (tk(code) || 0)) } : o);
  const items = [...codes].sort().map(code => {
    const o = valued(open[code], code) || z, p = valued(prev[code], code) || z, b = pur[code] || z, e0 = end[code] || null;
    // 10/21 打合せ：単価＝（前月末在庫金額＋当月仕入高金額）÷（前月末在庫数＋当月仕入数）。在庫計上前（実在庫登録のみ）の当月末金額はこの単価で評価。金額がなければ商品マスタの単価
    const avg = p.qty + b.qty > 0 && p.value + b.value > 0 ? r2((p.value + b.value) / (p.qty + b.qty)) : (e0?.price || tk(code));
    const keep = e0?.posted && e0.value;
    const e = e0 ? { ...e0, value: keep ? e0.value : Math.round(e0.qty * (avg || 0)), price: keep ? e0.price : avg } : null;
    const used = e ? { qty: r2(p.qty + b.qty - e.qty), value: p.value + b.value - e.value } : null;
    return { item: code, name: names[code]?.item_nam || code, unit: names[code]?.unit || '', opening: { qty: o.qty, value: o.value }, prev: { qty: p.qty, value: p.value }, purchase: b, used, end: e ? { qty: e.qty, value: e.value } : null, price: avg ?? null, posted: e ? !!e0.posted : null };
  });
  const t = (k, f) => items.reduce((n, x) => n + (x[k]?.[f] || 0), 0);
  const co2 = await one(c, 'SELECT company_name1, company_name2 FROM company_info_m ORDER BY company_info_id LIMIT 1');
  return { title: '材料受払表', ref: 'NO26 / 添付帳票⑧', month, period: cr, fiscalStart: fs, company: [co2?.company_name1, co2?.company_name2].filter(Boolean).join(' '), items, totals: { opening: t('opening', 'value'), prev: t('prev', 'value'), purchase: t('purchase', 'value'), used: t('used', 'value'), end: t('end', 'value'), openingQty: t('opening', 'qty'), prevQty: t('prev', 'qty'), purchaseQty: t('purchase', 'qty'), usedQty: t('used', 'qty'), endQty: t('end', 'qty') },
    note: '仕入の集計期間は締日単位（既定20日締め、現行と同じ）。実在庫は月度ごとの登録値。当月使用高＝前月末在庫＋当月仕入−当月末在庫（実在庫未登録の月は空欄）。金額のない在庫（評価額 0）は商品マスタの単価で評価。評価方法は確認待ち（Q07）。' };
}

// ---------- NO25 配合計算（暫定：配合マスタ×材料単価＋経費単価 → genka_m） ----------
export async function mixCalc(c, q) {
  const month = isoMonth(q.month, '対象月');
  const recipes = await rows(c, "SELECT category1 product, category2 material, category3 r FROM code_m WHERE code_key='MIX' AND code_dtl_abr<>'0' ORDER BY category1, category2");
  const [prev, end] = [await inv(c, addMonths(month, -1)), await inv(c, month)];
  const cr = closingRange(month, q.closing);
  const pur = Object.fromEntries((await rows(c, 'SELECT item_cd, SUM(quantity) q, SUM(net_amount) v FROM purchase WHERE purchase_date BETWEEN ? AND ? GROUP BY item_cd', [cr.from, cr.to])).map(r => [r.item_cd, { qty: num(r.q), value: num(r.v) }]));
  const names = Object.fromEntries((await rows(c, 'SELECT item_cd, item_nam, unit_name(unit) unit FROM item_m')).map(r => [r.item_cd, r]));
  // 手入力の材料単価（マスタ管理 → 材料単価）。登録があれば最優先
  const manual = Object.fromEntries((await rows(c, "SELECT category2, code_dtl_nam FROM code_m WHERE code_key='MATPR' AND category1=? AND code_dtl_abr<>'0'", [month.replace('-', '')])).map(r => [r.category2, num(r.code_dtl_nam)]));
  // Material unit price: 手入力 → moving average of 前月末在庫＋当月仕入 → 当月末評価単価.
  const price = code => {
    if (manual[code] > 0) return { price: manual[code], source: '手入力単価' };
    const p = prev[code], b = pur[code], qty = (p?.qty || 0) + (b?.qty || 0);
    if (qty > 0) return { price: r2(((p?.value || 0) + (b?.value || 0)) / qty), source: '移動平均（前月末在庫＋当月仕入）' };
    if (end[code]) return { price: end[code].price, source: '当月末評価単価' };
    return { price: null, source: '単価なし' };
  };
  const products = [];
  for (const r of recipes) {
    let p = products.find(x => x.item === r.product); if (!p) products.push(p = { item: r.product, name: names[r.product]?.item_nam || r.product, unit: names[r.product]?.unit || '', lines: [], ratio: 0, haigo: 0, missing: false });
    const pr = price(r.material), ratio = num(r.r) / 100;
    p.lines.push({ material: r.material, name: names[r.material]?.item_nam || r.material, ratio, price: pr.price, source: pr.source, cost: pr.price === null ? null : r2(pr.price * ratio / 100) });
    p.ratio = r2(p.ratio + ratio); if (pr.price === null) p.missing = true; else p.haigo = r2(p.haigo + pr.price * ratio / 100);
  }
  const saved = Object.fromEntries((await rows(c, "SELECT * FROM genka_m WHERE nengetsu=? AND delete_f<>'1'", [Number(month.replace('-', ''))])).map(r => [r.item_cd, { haigo: num(r.haigo_tanka), denki: num(r.denki), touyu: num(r.touyu), seizou: num(r.seizou), ippann: num(r.ippann), total: num(r.total) }]));
  products.forEach(p => (p.saved = saved[p.item] || null));
  // 推定：経費単価＝当月計上の経費（定時請求＋小口）÷ 当月の製品出荷数量。科目の振り分けは現行仕訳パターンから推定。
  const from = cr.from, to = cr.to, prodCodes = products.map(p => p.item);
  const prodQty = Object.fromEntries((prodCodes.length ? await rows(c, `SELECT item_cd, SUM(quantity) q FROM sales_trn WHERE sales_date BETWEEN ? AND ? AND item_cd IN (${prodCodes.map(() => '?').join(',')}) GROUP BY item_cd`, [toNum(from), toNum(to), ...prodCodes]) : []).map(r => [r.item_cd, num(r.q)]));
  const tons = r2(Object.values(prodQty).reduce((n, v) => n + v, 0));
  const exp = Object.fromEntries((await rows(c, "SELECT l.account_code a, SUM(l.gross_amount) v FROM expense_line l JOIN expense_document d ON d.expense_id=l.expense_id AND d.status='POSTED' WHERE d.booked_on BETWEEN ? AND ? GROUP BY l.account_code", [from, to])).map(r => [r.a, num(r.v)]));
  const sumOf = codes => codes.reduce((n, k) => n + (exp[k] || 0), 0);
  const kerosene = Object.keys(names).filter(k => /灯油/.test(names[k]?.item_nam || ''));
  const keroseneUsed = kerosene.reduce((n, k) => { const p = prev[k], b = pur[k], e = end[k]; return n + (e ? (p?.value || 0) + (b?.value || 0) - e.value : 0); }, 0);
  const basis = { denki: ['8242'], seizou: ['8244', '8243'], ippann: ['8255', '8256', '8260', '8312', '8317', '8318', '8319', '8323', '8330', '83181'] };
  const amounts = { denki: sumOf(basis.denki), touyu: keroseneUsed, seizou: sumOf(basis.seizou), ippann: sumOf(basis.ippann) };
  const suggest = { tons, amounts, basis: '電気=8242動力用水光熱費／灯油=材料「灯油」の当月使用高／製造=8244機械等経費＋8243運賃／一般=一般管理費系科目（8255・8256・8260・8312・8317〜8319・8323・8330・83181）。いずれも当月計上額÷当月製品出荷数量（推定）',
    ...Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, tons > 0 ? r2(v / tons) : 0])) };
  // 理論使用量（製品出荷数量×配合率）と実使用量（材料受払：前月末＋仕入−当月末）の比較
  const usage = [...new Set(recipes.map(r => r.material))].map(m => {
    const theoretical = r2(recipes.filter(r => r.material === m).reduce((n, r) => n + (prodQty[r.product] || 0) * num(r.r) / 10000, 0));
    const e = end[m], actual = e ? r2((prev[m]?.qty || 0) + (pur[m]?.qty || 0) - e.qty) : null;
    return { material: m, name: names[m]?.item_nam || m, theoretical, actual, diff: actual === null ? null : r2(actual - theoretical) };
  });
  return { title: '配合計算', ref: 'NO25（推定）', month, products, suggest, usage, production: prodQty, note: '配合表・経費配賦基準の資料が未提供のため推定。配合率は「マスタ管理 → 配合」、材料単価は「マスタ管理 → 材料単価」の手入力を優先し、無ければ移動平均（前月末在庫＋当月仕入）。経費単価は当月の経費÷製品出荷数量で自動算出（推定値・手修正可）。結果は原価（genka_m）に保存し、「マスタ管理 → 原価」で照会できます。' };
}
export async function saveMix(c, ctx, p) {
  const d = await mixCalc(c, { month: p.month, closing: p.closing });
  check(d.products.length, '配合マスタが登録されていません');
  const ov = {}; for (const k of ['denki', 'touyu', 'seizou', 'ippann']) { const t = String(p[k] ?? '0').trim(); check(/^\d{1,9}(\.\d{1,2})?$/.test(t), '経費単価は0以上の数値（小数2桁まで）で入力してください'); ov[k] = Number(t); }
  const bad = d.products.filter(x => x.missing); check(!bad.length, '材料単価が無い製品があります: ' + bad.map(x => x.name).join('、') + '（マスタ管理 → 材料単価 で手入力できます）');
  const ym = Number(d.month.replace('-', ''));
  for (const x of d.products) {
    const total = Math.round(x.haigo + ov.denki + ov.touyu + ov.seizou + ov.ippann);
    await c.query("INSERT INTO genka_m (nengetsu,item_cd,haigo_tanka,denki,touyu,seizou,ippann,total,delete_f) VALUES (?,?,?,?,?,?,?,?,'0') ON DUPLICATE KEY UPDATE haigo_tanka=VALUES(haigo_tanka),denki=VALUES(denki),touyu=VALUES(touyu),seizou=VALUES(seizou),ippann=VALUES(ippann),total=VALUES(total),delete_f='0'",
      [ym, x.item, x.haigo, ov.denki, ov.touyu, ov.seizou, ov.ippann, total]);
  }
  await audit(c, ctx, 'genka_m', d.month, 'mix.calc', { products: d.products.map(x => x.item), ...ov });
  return { saved: d.products.length };
}

// ---------- JV（出資金）配分 ----------
// 税率の表示は現行 HJR011 と同じ「10%」「0%」（非課税・対象外は 0%。2026-11-04。処税率コードは出さない）
const rateLabel = code => { const t = taxDecode(code); return `${t?.taxable ? t.rate : 0}%`; };
// month＝帳票の月度（YYYY-MM）。その月度で有効な構成員・出資比率（2026-11-02 適用開始月度の履歴）
export async function jvMembers(c, month) {
  return jvAsOf(await rows(c, 'SELECT code, start_month, name, ratio, seq, active FROM app_jv_member'), month).filter(m => m.active)
    .map(m => ({ code: m.code, name: m.name, ratio: num(m.ratio) / 100, seq: num(m.seq) })).sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));
}
// 構成員の登録なし・比率合計が100%でないときは帳票を出さずに理由を返す（⑪⑫⑬共通。⑪は 2026-11-04 から）
export async function members(c, month) {
  const ms = await jvMembers(c, month);
  check(ms.length, `${month} 月度の JV構成員・出資比率をマスタ管理で登録してください`);
  const sum = Math.round(ms.reduce((n, m) => n + m.ratio * 100, 0)); check(sum === 10000, `${month} 月度の JV構成員の出資比率の合計が100%ではありません（${sum / 100}%）`);
  return ms;
}
// Each member gets floor(amount × ratio); the remainder goes to the first member (現行帳票と同じ扱い).
export const allocate = (amount, ms) => { const parts = ms.map(m => Math.floor(Math.abs(amount) * m.ratio * 100 / 10000) * Math.sign(amount)); parts[0] += amount - parts.reduce((a, b) => a + b, 0); return parts; };
// 10/21 打合せ：指示画面は「締切日（対象月20日）」。締切日の月度（前月21日〜当月20日）を対象にする（従来の期間指定も可）
async function jvRange(c, q) {
  const P = await companyPeriod(c);
  if (!q.closing) { const r = range(q); return { ...r, closing: '', month: P.labelOf(r.to) }; }   // 期間指定は終了日の月度の比率
  const closing = isoDate(q.closing, '締切日'), month = P.labelOf(closing);
  return { ...P.monthRange(month), closing, month };
}
// NO35 出資金請求明細表（定時請求分）／出資金請求合計表（定時請求分）
// 10/21 打合せ：定時請求データをもとに支払日ごと・科目ごとに出力。明細表は入力単位（明細行）、合計表は科目ごとに集計。
// 支払日が翌月15日と翌々月末のものが混在する。端数調整（データの読込 0/1 と端数調整画面）は要検討のため、按分は各社切捨て・端数は第1構成員。
export async function jvExpenses(c, q) {
  const { from, to, closing, month } = await jvRange(c, q), ms = await members(c, month), summary = q.layout === 'summary';
  const ls = await rows(c, `SELECT d.document_no, d.due_on, d.booked_on, d.memo, l.line_no, l.account_code, a.account_name, l.source_tax_code, l.gross_amount, l.tax_amount, l.memo line_memo, v.vendor_name
    FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN vendor v ON v.vendor_id=d.vendor_id
    WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? ORDER BY COALESCE(d.due_on, d.booked_on), l.account_code, d.document_no, l.line_no`, [from, to]);
  const accounts = [], rates = [], zero = () => ms.map(() => 0);
  for (const l of ls) {
    const due = String(l.due_on || l.booked_on).slice(0, 10);
    let a = accounts.find(x => x.due === due && x.account === l.account_code);
    if (!a) accounts.push(a = { due, account: l.account_code, name: l.account_name || '', rows: [], count: 0, gross: 0, net: 0, tax: 0, parts: zero(), taxParts: zero() });
    const gross = num(l.gross_amount), tax = num(l.tax_amount), parts = allocate(gross, ms), rate = rateLabel(l.source_tax_code);
    // 出資消費税＝明細ごとの出資金額から税率で内税を逆算（切捨て）した合計。現行 HJR011 合計表（26/05/20 締）の 3 社とも一致（2026-11-04）
    const t = taxDecode(l.source_tax_code), r10 = tax && t?.taxable ? Math.round(t.rate * 10) : 0;
    const ptax = parts.map(v => (r10 ? Math.sign(v) * Math.floor(Math.abs(v) * r10 / (1000 + r10)) : 0));
    ptax.forEach((v, k) => (a.taxParts[k] += v));
    let g = rates.find(x => x.rate === rate);
    if (!g) rates.push(g = { rate, gross: 0, net: 0, tax: 0, parts: zero(), taxParts: zero() });
    g.gross += gross; g.net += gross - tax; g.tax += tax; parts.forEach((v, k) => { g.parts[k] += v; g.taxParts[k] += ptax[k]; });
    if (!summary) a.rows.push({ date: due, no: l.document_no, vendor: l.vendor_name, memo: l.line_memo || l.memo, taxCode: l.source_tax_code, rate, gross, net: gross - tax, tax, parts });
    a.count++; a.gross += gross; a.net += gross - tax; a.tax += tax; parts.forEach((v, k) => (a.parts[k] += v));
  }
  // 合計表の出資金額は明細表の科目計と同じ（明細ごとの按分の合計。現行 HJR011 の合計表＝明細表の科目計。2026-11-04 再按分をやめた）
  // 出資本体＝出資金額−出資消費税（現行の合計表の見出し：出資金額・出資本体・出資消費税。2026-11-02）
  for (const a of [...accounts, ...rates]) a.netParts = a.parts.map((v, k) => v - a.taxParts[k]);
  rates.sort((x, y) => parseFloat(y.rate) - parseFloat(x.rate));   // 合計の下の税率別（10%・8%・0%）
  const add = (as, f) => ms.map((_, k) => as.reduce((n, a) => n + a[f][k], 0)), tot = (as, f) => as.reduce((n, a) => n + a[f], 0);
  const days = [...new Set(accounts.map(a => a.due))].map(due => { const as = accounts.filter(a => a.due === due); return { due, gross: tot(as, 'gross'), net: tot(as, 'net'), tax: tot(as, 'tax'), parts: add(as, 'parts'), netParts: add(as, 'netParts'), taxParts: add(as, 'taxParts') }; });
  const totals = { gross: tot(accounts, 'gross'), net: tot(accounts, 'net'), tax: tot(accounts, 'tax'), parts: add(accounts, 'parts'), netParts: add(accounts, 'netParts'), taxParts: add(accounts, 'taxParts') };
  return { title: summary ? '出資金請求合計表（定時請求分）' : '出資金請求明細表（定時請求分）', ref: 'NO35 / 添付帳票⑫', layout: summary ? 'summary' : 'detail', closing, from, to, members: ms, accounts, days, totals, rates,
    note: `締切日 ${closing || to} の月度（${from}〜${to}）の定時請求を、支払日ごと・科目ごとに${summary ? '集計して' : '明細行単位で'}${month} 月度の出資比率で按分。各社切捨て、端数は第1構成員${summary ? '。出資金額は明細ごとの按分の合計、出資消費税は明細ごとに出資金額から税率で逆算（切捨て）した合計' : ''}。端数調整の入力（現行の「データの読込 0/1」）は要検討。` };
}
// 入金科目は現行 HJR031 の表記（2026-11-04）：当座預金　売掛金入金／当座預金　受取手形満期日／雑　費　売掛金入金／雑損失　売掛金入金／（空白）現金売上
const PART_ACCOUNT = { BANK: '当座預金', NOTE: '当座預金', FEE: '雑　費', COOP: '雑　費', LOSS: '雑損失' };
const PART_MEMO = { NOTE: '受取手形満期日' };
// 末尾の合計（現行 HJR031）：＊配分する入金額＊＝当座預金への入金と現金売上、＊配分しない入金額＊＝雑費・雑損失（手数料・協力費・端数の損失）、＊入金額　合計＊＝両方
export const JV_NOALLOC = new Set(['FEE', 'COOP', 'LOSS']);
// NO36 入金明細及び配分表
// 10/21 打合せ：対象は当座預金に入金されるもの（振込・受取手形）、入金に付随する手数料（雑費）、現金売上。指示画面は締切日。
// 2026-11-01：雑費に協力費（8330-107）も含める（現行 HJW030 の見本で雑費の行が 手数料＋協力費 の金額。例 新晃 550）
// 2026-11-04：現行どおり 雑損失（LOSS）も入れる。受取手形は満期日の行（当座預金　受取手形満期日）にし、満期日で期間に入れる。現金売上の入金先は現場名
// 入金額配賦登録（HJW030）の表示用に 区分（売掛金入金／受取手形／現金売上）と 請求締日（消し込んだ請求の締日）を返す
export async function jvReceipts(c, q) {
  const { from, to, closing, month } = await jvRange(c, q), ms = await members(c, month);
  const rs = await rows(c, `SELECT r.receipt_id, r.receipt_no, CASE WHEN k.component_kind='NOTE' THEN COALESCE(k.maturity_date, r.receipt_date) ELSE r.receipt_date END d, c.customers_name, k.component_no, k.component_kind, k.amount FROM receipt r JOIN receipt_component k ON k.receipt_id=r.receipt_id LEFT JOIN client_m c ON c.customers_cd=r.customers_cd
    WHERE r.status='POSTED' AND k.component_kind IN ('BANK','NOTE','FEE','COOP','LOSS') AND (CASE WHEN k.component_kind='NOTE' THEN COALESCE(k.maturity_date, r.receipt_date) ELSE r.receipt_date END) BETWEEN ? AND ? ORDER BY 3, r.receipt_id, k.component_no`, [from, to]);
  const lines = rs.map(r => { const amount = num(r.amount); return { key: `R:${r.receipt_id}:${r.component_no}`, date: String(r.d instanceof Date ? r.d.toISOString() : r.d).slice(0, 10), no: r.receipt_no, account: PART_ACCOUNT[r.component_kind] || r.component_kind, memo: PART_MEMO[r.component_kind] || '売掛金入金', kbn: r.component_kind === 'NOTE' ? '受取手形' : '売掛金入金', noAlloc: JV_NOALLOC.has(r.component_kind), customer: r.customers_name, amount, parts: allocate(amount, ms) }; });
  const ids = [...new Set(rs.map(r => r.receipt_id))], billed = {};
  if (ids.length) for (const a of await rows(c, `SELECT DISTINCT a.receipt_id, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${ids.map(() => '?').join(',')}) ORDER BY h.closing_date`, ids)) (billed[a.receipt_id] ||= []).push(fromNum(a.closing_date));
  const span = ds => (ds.length > 2 ? `${ds[0]}〜${ds[ds.length - 1]}（${ds.length}件）` : ds.join('・'));   // 何か月分もまとめて消し込んだ入金は 最初〜最後（件数）
  for (const l of lines) l.billed = span(billed[l.key.split(':')[1]] || []);
  // 現金売上（決済方法 1＝現金）：売上日・得意先ごとに集計
  // 現金売上：売上日・得意先・現場名ごとに集計。入金先は現場名（現行 HJR031 の見本：現金売上　緑区藤塚）、現場名がなければ得意先名
  const cash = await rows(c, `SELECT s.sales_date d, s.customers_cd, MAX(c.customers_name) customers_name, TRIM(CONCAT_WS(' ', NULLIF(TRIM(s.field_name1), ''), NULLIF(TRIM(s.field_name2), ''))) site, COUNT(*) n, SUM(s.money + s.consumption_tax) v FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd
    WHERE s.payment_method_cd=1 AND s.sales_date BETWEEN ? AND ? GROUP BY s.sales_date, s.customers_cd, 4 ORDER BY s.sales_date, s.customers_cd, 4`, [toNum(from), toNum(to)]);
  for (const r of cash) { const amount = num(r.v); if (amount) lines.push({ key: `C:${fromNum(r.d)}:${r.customers_cd}${r.site ? ':' + r.site : ''}`, legacy: r.site ? `C:${fromNum(r.d)}:${r.customers_cd}` : '', date: fromNum(r.d), no: `${num(r.n)}件`, account: '', memo: '現金売上', kbn: '現金売上', billed: '', noAlloc: false, customer: r.site || r.customers_name || r.customers_cd, amount, parts: allocate(amount, ms) }); }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  // 入金額配賦登録（端数調整）の値があれば使う。金額が変わった行（合計が一致しない）は自動配分に戻す
  // N-39（2026-11-04）：現金売上のキーに現場名を足す前（b773b13 より前）の調整（C:売上日:得意先）は、その日・得意先の現金売上が 1 行だけなら引き継ぐ（合計が合わなければ下で自動配分に戻る）
  const keys = [...new Set(lines.flatMap(l => [l.key, l.legacy].filter(Boolean)))], legacyCount = {};
  for (const l of lines) if (l.legacy) legacyCount[l.legacy] = (legacyCount[l.legacy] || 0) + 1;
  const adj = lines.length ? Object.fromEntries((await rows(c, `SELECT alloc_key, parts FROM app_jv_alloc WHERE alloc_key IN (${keys.map(() => '?').join(',')})`, keys)).map(r => [r.alloc_key, JSON.parse(r.parts)])) : {};
  for (const l of lines) {
    l.auto = l.parts; const a = adj[l.key] || (l.legacy && legacyCount[l.legacy] === 1 ? adj[l.legacy] : null); if (!a) continue;
    const parts = ms.map(m => Number(a[m.code] ?? NaN));
    if (parts.every(Number.isSafeInteger) && parts.reduce((n, v) => n + v, 0) === l.amount) { l.parts = parts; l.adjusted = true; }
  }
  const sum = ls => ({ amount: ls.reduce((n, l) => n + l.amount, 0), parts: ms.map((_, k) => ls.reduce((n, l) => n + l.parts[k], 0)) });
  return { title: '入金明細及び配分表', ref: 'NO36 / 添付帳票⑬（HJR031）', closing, from, to, members: ms, lines, alloc: sum(lines.filter(l => !l.noAlloc)), noAlloc: sum(lines.filter(l => l.noAlloc)), totals: sum(lines),
    note: `締切日 ${closing || to} の月度（${from}〜${to}）。対象は当座預金への入金（振込・受取手形の満期日）、入金時の手数料・協力費（雑費）・雑損失、現金売上（10/21 打合せ・現行 HJR031）。${month} 月度の出資比率で配分。各社切捨て、端数は第1構成員。入金分配端数調整登録で調整した行は調整後の金額（${lines.filter(l => l.adjusted).length}行）。` };
}
// 入金額配賦登録（現行 HJW030）：締切日の月度の NO36 対象行について構成員別の配分額を調整して登録。行ごとに合計＝入金額。自動配分と同じなら調整を消す
export async function saveJvAllocations(c, ctx, p) {
  const d = await jvReceipts(c, { closing: p.closing }), ms = d.members;
  check(Array.isArray(p.rows) && p.rows.length <= 2000, '配分の指定が不正です');
  let saved = 0, cleared = 0;
  for (const [i, r] of p.rows.entries()) {
    const l = d.lines.find(x => x.key === r.key); check(l, `${i + 1}行目：対象の入金が見つかりません。再表示してください`);
    const parts = ms.map(m => yen(r.parts?.[m.code] ?? 0, `${l.date} ${l.customer} ${m.name}`, { negative: true }));
    const sum = parts.reduce((n, v) => n + v, 0);
    check(sum === l.amount, `${l.date} ${l.customer}：配分の合計 ${sum.toLocaleString()} が入金額 ${l.amount.toLocaleString()} と一致しません`);
    await c.query('DELETE FROM app_jv_alloc WHERE alloc_key IN (?,?)', [l.key, l.legacy || l.key]);   // 旧キー（N-39）も消す
    if (parts.every((v, k) => v === l.auto[k])) { cleared++; continue; }
    await c.query('INSERT INTO app_jv_alloc (alloc_key,parts,updated_by,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(6))', [l.key, JSON.stringify(Object.fromEntries(ms.map((m, k) => [m.code, parts[k]]))), ctx.user.login_id]); saved++;
  }
  await audit(c, ctx, 'app_jv_alloc', d.closing || d.to, 'jv.alloc.save', { closing: d.closing, saved, cleared });
  return { saved, cleared };
}

// ---------- Excel ----------
// 入金明細及び配分表の入金科目＝科目＋摘要（同じ文字なら1つだけ。例 当座預金　売掛金入金）
const jvAccount = l => (l.memo && l.memo !== l.account ? `${l.account}　${l.memo}`.trim() : l.account);
const head = (d, sub) => [[T(d.title)], [`${sub}　出力日 ${today()}`], []];
export async function miscBook(c, kind, q) {
  if (kind === 'shipment-summary') {
    const d = await shipmentSummary(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    d.sections.forEach((sc, k) => {
      if (sc.other) out.push([], [T(`${d.title}${sc.title}`)]);
      out.push(['', '商品名・製品名', '', '数量', '', '金額'].map(H));
      for (const g of sc.groups) { g.items.forEach((x, i) => out.push([i ? '' : g.label, x.item, x.name, x.qty, x.unit, x.net])); out.push(['', '', S(`【${g.label}計】`), '', '', S(g.net)], []); }
      out.push(['', '', S('【合　計】'), '', '', S(sc.net)]);
      if (k === d.sections.length - 1 && sc.other) out.push([], ['', '', S('【総合計】'), '', '', S(d.total)]);
    });
    return { name: `商品・製品別出荷集計表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '出荷集計表', rows: out, widths: [6, 8, 26, 11, 4, 14] }]) };
  }
  if (kind === 'customer-items') {
    const d = await customerItems(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    d.sections.forEach(sc => {
      if (sc.other) out.push([], [T(`${d.title}　${sc.title}`)]);
      out.push(['得意先', '', '品名', '', '単位', '累計数量', '累計金額'].map(H));
      for (const cu of sc.customers) { cu.items.forEach((x, i) => out.push([i ? '' : cu.customer, i ? '' : cu.name, x.item, x.name, x.unit, x.qty, x.net])); out.push(['', '', '', S('得意先計'), '', S(cu.qty), S(cu.net)], []); }
      out.push(['', '', '', S('総合計'), '', S(sc.qty), S(sc.net)], ['', '', '', S('値引'), '', S(sc.discount.qty), S(sc.discount.net)]);
    });
    return { name: `得意先別商品別出荷累計表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '出荷累計表', rows: out, widths: [9, 24, 8, 24, 6, 12, 14] }]) };
  }
  if (kind === 'cash-sales') {
    const d = await cashSales(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['得意先', '', '', '売上日', '伝票No', '商品名', '', '数量', '', '単価', '金額', '処税率', '運送', '備考'].map(H));
    for (const cu of d.customers) { cu.rows.forEach((r, i) => out.push([i ? '' : cu.customer, i ? '' : cu.name, r.site, r.date, r.no, r.item, r.itemName, r.qty, r.unit, r.price, r.net, r.tax, r.carry, r.remarks])); out.push(['', '', '', '', '', '', S('*** 得意先計 ***'), '', '', '', S(cu.net)]); }
    return { name: `現金売上明細表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '現金売上明細表', rows: out, widths: [8, 18, 20, 11, 12, 7, 22, 9, 4, 10, 12, 7, 8, 20] }]) };
  }
  if (kind === 'material-ledger') {
    // 現行 HAR491（添付帳票⑧ p.1）の形式：1〜2行目の表題、期首残高〜当月末在庫の2段見出し、数量3桁・金額・単価1桁、0 は空欄、動きのない材料は出さない、【合計】に数量も（2026-11-02）
    const d = await materialLedger(c, q), jst = new Date(Date.now() + 9 * 3600e3).toISOString(), yy = v => `${v.slice(2, 4)}/${v.slice(5, 7)}/${v.slice(8, 10)}`;
    const Q = v => ({ v: v || '', s: 'qty3' }), A = v => ({ v: v || '', s: 'num' });
    const out = [
      ['HAR491', ...Array(11).fill(''), { v: `作成日 ${yy(jst)} ${jst.slice(11, 19)}`, s: 'right' }],
      [{ v: `${yy(d.period.to)} 締`, s: 'center' }, '', '', '', { v: '材　料　受　払　表', s: 'titleC' }, ...Array(7).fill(''), { v: d.company, s: 'right' }],
      [],
      ['', '', ...['期　首　残　高', '前　月　末　在　庫', '当　月　仕　入　高', '当　月　使　用　高', '当　月　末　在　庫'].flatMap(label => [{ v: label, s: 'center' }, { v: '', s: 'center' }])],
      ['', '', ...Array(5).fill([{ v: '数　量', s: 'center' }, { v: '金　額', s: 'center' }]).flat(), { v: '単　価', s: 'center' }],
    ];
    const parts = x => [x.opening, x.prev, x.purchase, x.used, x.end];
    for (const x of d.items.filter(x => parts(x).some(o => o && (o.qty || o.value)))) out.push([x.item, x.name, ...parts(x).flatMap(o => [Q(o?.qty), A(o?.value)]), { v: x.price || '', s: 'price1' }]);
    const t = d.totals; out.push(['【合計】', '', Q(t.openingQty), A(t.opening), Q(t.prevQty), A(t.prev), Q(t.purchaseQty), A(t.purchase), Q(t.usedQty), A(t.used), Q(t.endQty), A(t.end)]);
    const merges = ['A2:D2', 'E2:I2', 'C4:D4', 'E4:F4', 'G4:H4', 'I4:J4', 'K4:L4'];
    const heights = Object.fromEntries(out.map((_, i) => [i, i < 5 ? 18 : 24]));
    return { name: `材料受払表_${d.month}.xlsx`, body: xlsx([{ name: '材料受払表', rows: out, merges, heights, gridlines: false, printTitles: '4:5', header: '&RPAGE: &P', widths: [8, 24, 14, 13, 14, 13, 14, 13, 14, 13, 14, 13, 13] }]) };
  }
  const MIX_W = [9, 22, 9, 22, 10, 11, 26, 12, 8, 10, 8, 10];
  if (kind === 'mix') {
    const d = await mixCalc(c, q), out = head(d, `対象月 ${d.month}`);
    out.push(['製品CD', '製品名', '材料CD', '材料名', '配合率(%)', '材料単価', '単価根拠', '配合金額'].map(H));
    for (const p of d.products) {
      for (const l of p.lines) out.push([p.item, p.name, l.material, l.name, l.ratio, l.price ?? '', l.source, l.cost ?? '']);
      out.push(['', S(`${p.name} 配合単価`), '', '', S(p.ratio), '', '', S(p.haigo)]);
      if (p.saved) out.push(['', '保存済原価', '電気', p.saved.denki, '灯油', p.saved.touyu, '製造', p.saved.seizou, '一般', p.saved.ippann, '合計', p.saved.total]);
    }
    // 区切りの見出し（経費単価・材料使用量の比較）は名前の分だけ結合して色付け（2026-11-07 ユーザー指示：同じ様式の帳票を全部直す）
    out.push([], band(MIX_W, ['経費単価（推定）']), ['', '製品出荷数量', d.suggest.tons, '電気', d.suggest.denki, '灯油', d.suggest.touyu, '製造', d.suggest.seizou, '一般', d.suggest.ippann], [d.suggest.basis], [],
      band(MIX_W, ['材料使用量の比較']), ['材料CD', '材料名', '理論使用量', '実使用量', '差異'].map(H), ...d.usage.map(u => [u.material, u.name, u.theoretical, u.actual ?? '', u.diff ?? '']), []);
    return { name: `配合計算_${d.month}.xlsx`, body: xlsx([{ name: '配合計算', rows: out, widths: MIX_W }]) };
  }
  // 合計表：現行 HJR011 の見出し（支払日・科目名・支払金額・支払本体・支払消費税、構成員ごとに「** 構成員名 **」の下に出資金額・出資本体・出資消費税。2026-11-02）
  const summarySheet = (d, out) => {
    const m3 = (p, n, t) => p.flatMap((v, k) => [v, n[k], t[k]]), r0 = out.length;
    out.push(['', '', '', '', '', ...d.members.flatMap(m => [`**　${m.name}　**`, '', ''])].map(H));
    out.push(['支払日', '科目名', '支払金額', '支払本体', '支払消費税', ...d.members.flatMap(() => ['出資金額', '出資本体', '出資消費税'])].map(H));
    // 現行どおり支払日計は出さず、＊合計＊の下に税率別の行（2026-11-04）
    for (const a of d.accounts) out.push([a.due, a.name, a.gross, a.net, a.tax, ...m3(a.parts, a.netParts, a.taxParts)]);
    out.push(['', S('＊合計＊'), S(d.totals.gross), S(d.totals.net), S(d.totals.tax), ...m3(d.totals.parts, d.totals.netParts, d.totals.taxParts).map(S)], []);
    for (const g of d.rates) out.push(['', { v: g.rate, s: 'right' }, g.gross, g.net, g.tax, ...m3(g.parts, g.netParts, g.taxParts)]);
    const col = i => { let n = i + 1, t = ''; while (n) { t = String.fromCharCode(65 + (n - 1) % 26) + t; n = Math.floor((n - 1) / 26); } return t; };
    const merges = d.members.map((_, k) => `${col(5 + k * 3)}${r0 + 1}:${col(7 + k * 3)}${r0 + 1}`);
    return { name: d.title.slice(0, 28), rows: out, merges, widths: [11, 18, 13, 13, 12, ...d.members.flatMap(() => [13, 13, 12])] };
  };
  if (kind === 'jv-expenses' || kind === 'jv-receipts') {
    const d = kind === 'jv-expenses' ? await jvExpenses(c, q) : await jvReceipts(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    if (kind === 'jv-expenses') {
      // 見出しは現行の出資金請求明細表と同じ：税率・支払金額・支払額本体・支払消費税、構成員は2段（構成員名／出資金額）（2026-11-02）
      const detail = d.layout === 'detail';
      if (!detail) return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([summarySheet(d, out)]) };
      // 現行 HJR011 の並び（2026-11-04）：支払日は支払日の 1 行目、科目は科目の 1 行目だけ。＊科目計＊ → ＊支払日計＊ → ＊合計＊ → 税率別（10%・0%）。伝票No は出さない
      const pre = ['支払日', '科目名', '支払先', '摘要', '税率'], amt = x => [x.gross, x.net, x.tax, ...x.parts], sum = x => amt(x).map(S);
      out.push([...pre.map(() => ''), '', '', '', ...d.members.map(m => m.name)].map(H));
      out.push([...pre, '支払金額', '支払額本体', '支払消費税', ...d.members.map(() => '出資金額')].map(H));
      for (const day of d.days) {
        d.accounts.filter(x => x.due === day.due).forEach((ac, i) => {
          ac.rows.forEach((r, k) => out.push([!i && !k ? day.due : '', k ? '' : `${ac.account} ${ac.name}`, r.vendor, r.memo, r.rate, r.gross, r.net, r.tax || '', ...r.parts]));
          out.push(['', S('＊科目計＊'), '', '', '', ...sum(ac)], []);
        });
        out.push(['', S('＊支払日計＊'), '', '', '', ...sum(day)], []);
      }
      out.push([S('＊合　計＊'), '', '', '', '', ...sum(d.totals)], []);
      for (const g of d.rates) out.push(['', '', '', '', { v: g.rate, s: 'right' }, ...amt(g)]);
    } else {
      // 現行 HJR031 の見出し：入金日・入金科目・入金先・入金額、構成員は2段（構成員名／配分額）。入金科目は科目＋摘要（2026-11-02）
      // 現行 HJR031：構成員の欄は 5 つ固定（空きは見出し「配分額」だけ）。末尾は ＊配分する入金額＊・＊配分しない入金額＊・＊入金額　合計＊（2026-11-04）
      const pad = Math.max(0, 5 - d.members.length), blank = Array(pad).fill('');
      out.push(['', '', '', '', ...d.members.map(m => m.name), ...blank].map(H));
      out.push(['入金日', '入金科目', '入金先', '入金額', ...d.members.map(() => '配分額'), ...blank.map(() => '配分額')].map(H));
      for (const l of d.lines) out.push([l.date, jvAccount(l), l.customer, l.amount, ...l.parts]);
      for (const [label, t] of [['＊配分する入金額＊', d.alloc], ['＊配分しない入金額＊', d.noAlloc], ['＊入金額　合計＊', d.totals]]) out.push([], ['', '', S(label), S(t.amount), ...t.parts.map(S)]);
      return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title.slice(0, 28), rows: out, widths: [11, 26, 34, 13, ...d.members.map(() => 14), ...blank.map(() => 10)] }]) };
    }
    // 明細表の下に合計表を続けて出す（1 シート。2026-11-07 ユーザー指示で 2 シート → 1 シート。合計表のボタンは 2026-11-03 に画面から削除）
    const ds = await jvExpenses(c, { ...q, layout: 'summary' });
    out.push([], [], [T(ds.title)], []);
    const sm = summarySheet(ds, out), dw = [11, 20, 30, 24, 7, 13, 13, 12, ...d.members.map(() => 14)];
    const widths = Array.from({ length: Math.max(dw.length, sm.widths.length) }, (_, i) => Math.max(dw[i] || 0, sm.widths[i] || 0));
    return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ ...sm, name: d.title.slice(0, 28), widths }]) };
  }
  check(false, '帳票の種類が不正です');
}
export const MISC = { 'shipment-summary': shipmentSummary, 'customer-items': customerItems, 'cash-sales': cashSales, 'material-ledger': materialLedger, mix: mixCalc, 'jv-expenses': jvExpenses, 'jv-receipts': jvReceipts };
