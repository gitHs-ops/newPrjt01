// ④ 在庫・出資金・出荷集計: NO25 配合計算, NO26 材料受払表, NO35 出資金請求明細表(定時), NO36 入金明細配分表, NO41〜43 出荷集計
import { check, isoDate, isoMonth, toNum, fromNum, today, addMonths, METHODS } from './domain.mjs';
import { taxOf } from './taxcode.mjs';
import { rows, one, audit } from './db.mjs';
import { xlsx } from './xlsx.mjs';

const num = v => Number(v || 0);
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const range = q => { const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です'); return { from, to }; };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;
// 締日（既定20日：現行の材料受払表は20日締め）による月度の期間
const closingRange = (month, closing) => { const d = Number(closing || 20); if (d >= 31) return { from: month + '-01', to: monthEnd(month), label: '暦月' }; const prev = addMonths(month, -1); return { from: `${prev}-${String(Math.min(d, 28) + 1).padStart(2, '0')}`, to: `${month}-${String(d).padStart(2, '0')}`, label: `${d}日締め` }; };

// ---------- NO41 商品・製品別出荷集計表 ----------
export async function shipmentSummary(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.item_cd, MAX(s.item_name) item_name, MAX(i.unit) unit, s.payment_method_cd m, COUNT(*) n, SUM(s.quantity) qty, SUM(s.money) net, SUM(s.consumption_tax) tax
    FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.item_cd, s.payment_method_cd ORDER BY s.item_cd`, [toNum(from), toNum(to)]);
  const items = [];
  for (const r of rs) {
    let it = items.find(x => x.item === r.item_cd); if (!it) items.push(it = { item: r.item_cd, name: r.item_name, unit: r.unit || '', count: 0, qty: 0, net: 0, tax: 0, credit: 0, cash: 0, card: 0 });
    it.count += num(r.n); it.qty = r2(it.qty + num(r.qty)); it.net += num(r.net); it.tax += num(r.tax); it[{ 1: 'credit', 2: 'cash', 3: 'card' }[r.m] || 'credit'] += num(r.net);
  }
  const t = k => items.reduce((n, x) => n + x[k], 0);
  return { title: '商品・製品別出荷集計表', ref: 'NO41 / 添付帳票⑯', from, to, items, totals: { count: t('count'), net: t('net'), tax: t('tax'), credit: t('credit'), cash: t('cash'), card: t('card') } };
}
// ---------- NO42 得意先別商品別出荷累計表 ----------
export async function customerItems(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.customers_cd, c.customers_name, s.item_cd, MAX(s.item_name) item_name, MAX(i.unit) unit, COUNT(*) n, SUM(s.quantity) qty, SUM(s.money) net, SUM(s.consumption_tax) tax
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN item_m i ON i.item_cd=s.item_cd WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.customers_cd, c.customers_name, s.item_cd ORDER BY s.customers_cd, s.item_cd`, [toNum(from), toNum(to)]);
  const customers = [];
  for (const r of rs) {
    let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name, items: [], net: 0, tax: 0 });
    cu.items.push({ item: r.item_cd, name: r.item_name, unit: r.unit || '', count: num(r.n), qty: r2(num(r.qty)), net: num(r.net), tax: num(r.tax) }); cu.net += num(r.net); cu.tax += num(r.tax);
  }
  return { title: '得意先別商品別出荷累計表', ref: 'NO42 / 添付帳票⑱', from, to, customers, total: customers.reduce((n, x) => n + x.net, 0) };
}
// ---------- NO43 現金売上明細表 ----------
export async function cashSales(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.*, c.customers_name FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd WHERE s.payment_method_cd=1 AND s.sales_date BETWEEN ? AND ? ORDER BY s.customers_cd, s.sales_date, s.order_no`, [toNum(from), toNum(to)]);
  const customers = [];
  for (const r of rs) {
    let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name, rows: [], net: 0, tax: 0, total: 0 });
    const row = { date: fromNum(r.sales_date), no: r.order_no, site: [r.field_name1, r.field_name2].filter(Boolean).join(' '), item: r.item_name, qty: num(r.quantity), price: num(r.unit_price), net: num(r.money), tax: num(r.consumption_tax), total: num(r.payment_money) || num(r.money) + num(r.consumption_tax) };
    cu.rows.push(row); cu.net += row.net; cu.tax += row.tax; cu.total += row.total;
  }
  return { title: '現金売上明細表', ref: 'NO43 / 添付帳票⑲', from, to, customers, total: customers.reduce((n, x) => n + x.total, 0), note: '現金売上の得意先（実CDか諸口99999か）は確認待ち（Q17）。' };
}

// ---------- NO26 材料受払表（月次：前月末在庫＋当月仕入−当月末在庫＝当月使用） ----------
async function inv(c, month) {
  return Object.fromEntries((await rows(c, "SELECT item_cd, quantity, valuation_price, valuation_amount FROM inventory_count WHERE period_start=? AND location_code='MAIN' AND status='POSTED'", [month + '-01'])).map(r => [r.item_cd, { qty: num(r.quantity), price: num(r.valuation_price), value: num(r.valuation_amount) }]));
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
  const kinds = await rows(c, "SELECT item_cd, item_nam, unit, item_product_kb FROM item_m WHERE item_product_kb='1'"); // 1=材料（現行 Java）
  kinds.forEach(k => codes.add(k.item_cd));
  const names = Object.fromEntries((await rows(c, 'SELECT item_cd, item_nam, unit FROM item_m')).map(r => [r.item_cd, r]));
  const z = { qty: 0, value: 0 };
  const items = [...codes].sort().map(code => {
    const o = open[code] || z, p = prev[code] || z, b = pur[code] || z, e = end[code] || null;
    const used = e ? { qty: r2(p.qty + b.qty - e.qty), value: p.value + b.value - e.value } : null;
    return { item: code, name: names[code]?.item_nam || code, unit: names[code]?.unit || '', opening: { qty: o.qty, value: o.value }, prev: { qty: p.qty, value: p.value }, purchase: b, used, end: e ? { qty: e.qty, value: e.value } : null, price: e?.price ?? null };
  });
  const t = (k, f) => items.reduce((n, x) => n + (x[k]?.[f] || 0), 0);
  return { title: '材料受払表', ref: 'NO26 / 添付帳票⑧', month, period: cr, fiscalStart: fs, items, totals: { opening: t('opening', 'value'), prev: t('prev', 'value'), purchase: t('purchase', 'value'), used: t('used', 'value'), end: t('end', 'value') },
    note: '仕入の集計期間は締日単位（既定20日締め、現行と同じ）。実在庫は月度ごとの登録値。当月使用高＝前月末在庫＋当月仕入−当月末在庫（実在庫未登録の月は空欄）。評価方法は確認待ち（Q07）。' };
}

// ---------- NO25 配合計算（暫定：配合マスタ×材料単価＋経費単価 → genka_m） ----------
export async function mixCalc(c, q) {
  const month = isoMonth(q.month, '対象月');
  const recipes = await rows(c, "SELECT category1 product, category2 material, category3 r FROM code_m WHERE code_key='MIX' AND code_dtl_abr<>'0' ORDER BY category1, category2");
  const [prev, end] = [await inv(c, addMonths(month, -1)), await inv(c, month)];
  const cr = closingRange(month, q.closing);
  const pur = Object.fromEntries((await rows(c, 'SELECT item_cd, SUM(quantity) q, SUM(net_amount) v FROM purchase WHERE purchase_date BETWEEN ? AND ? GROUP BY item_cd', [cr.from, cr.to])).map(r => [r.item_cd, { qty: num(r.q), value: num(r.v) }]));
  const names = Object.fromEntries((await rows(c, 'SELECT item_cd, item_nam, unit FROM item_m')).map(r => [r.item_cd, r]));
  // Material unit price: moving average of 前月末在庫＋当月仕入, else 当月末評価単価.
  const price = code => {
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
  return { title: '配合計算', ref: 'NO25（推定）', month, products, suggest, usage, production: prodQty, note: '配合表・経費配賦基準の資料が未提供のため推定。配合率は「マスタ管理 → 配合」。経費単価は当月の経費÷製品出荷数量で自動算出（推定値・手修正可）。結果は原価マスタ genka_m に保存。' };
}
export async function saveMix(c, ctx, p) {
  const d = await mixCalc(c, { month: p.month, closing: p.closing });
  check(d.products.length, '配合マスタが登録されていません');
  const ov = {}; for (const k of ['denki', 'touyu', 'seizou', 'ippann']) { const t = String(p[k] ?? '0').trim(); check(/^\d{1,9}(\.\d{1,2})?$/.test(t), '経費単価は0以上の数値（小数2桁まで）で入力してください'); ov[k] = Number(t); }
  const bad = d.products.filter(x => x.missing); check(!bad.length, '材料単価が無い製品があります: ' + bad.map(x => x.name).join('、'));
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
async function members(c) {
  const ms = (await rows(c, "SELECT code_dtl code, code_dtl_nam name, category1 r, category2 seq FROM code_m WHERE code_key='JV' AND code_dtl_abr<>'0'")).map(m => ({ code: m.code, name: m.name, ratio: num(m.r) / 100, seq: num(m.seq) })).sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));
  check(ms.length, 'JV構成員・出資比率をマスタ管理で登録してください');
  const sum = Math.round(ms.reduce((n, m) => n + m.ratio * 100, 0)); check(sum === 10000, `JV構成員の出資比率の合計が100%ではありません（${sum / 100}%）`);
  return ms;
}
// Each member gets floor(amount × ratio); the remainder goes to the first member (現行帳票と同じ扱い).
export const allocate = (amount, ms) => { const parts = ms.map(m => Math.floor(Math.abs(amount) * m.ratio * 100 / 10000) * Math.sign(amount)); parts[0] += amount - parts.reduce((a, b) => a + b, 0); return parts; };
// NO35 出資金請求明細表（定時請求分）
export async function jvExpenses(c, q) {
  const { from, to } = range(q), ms = await members(c);
  const ds = await rows(c, `SELECT d.*, l.account_code, a.account_name, l.source_tax_code, v.vendor_name FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id AND l.line_no=1
    LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN vendor v ON v.vendor_id=d.vendor_id
    WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? ORDER BY l.account_code, d.due_on, d.document_no`, [from, to]);
  const accounts = [];
  for (const d of ds) {
    let a = accounts.find(x => x.account === d.account_code); if (!a) accounts.push(a = { account: d.account_code, name: d.account_name, rows: [], gross: 0, net: 0, tax: 0, parts: ms.map(() => 0) });
    const gross = num(d.gross_amount), tax = taxOf(gross, d.source_tax_code), parts = allocate(gross, ms);
    a.rows.push({ date: d.due_on || d.booked_on, no: d.document_no, vendor: d.vendor_name, memo: d.memo, taxCode: d.source_tax_code, gross, net: gross - tax, tax, parts });
    a.gross += gross; a.net += gross - tax; a.tax += tax; parts.forEach((v, i) => (a.parts[i] += v));
  }
  const totals = { gross: accounts.reduce((n, a) => n + a.gross, 0), net: accounts.reduce((n, a) => n + a.net, 0), tax: accounts.reduce((n, a) => n + a.tax, 0), parts: ms.map((_, i) => accounts.reduce((n, a) => n + a.parts[i], 0)) };
  return { title: '出資金請求明細表（定時請求分）', ref: 'NO35 / 添付帳票⑫', from, to, members: ms, accounts, totals, note: '定時請求（計上日が期間内）を出資比率で配分。各社切捨て、端数は第1構成員。税額は税区分(10%/8%)から内税計算。' };
}
const PART_ACCOUNT = { BANK: '当座預金', CASH: '現金', NOTE: '受取手形', FEE: '雑費（手数料）', COOP: '雑費（協力会費）', DEPOSIT: '預り金', DISCOUNT: '雑損失' };
// NO36 入金明細配分表
export async function jvReceipts(c, q) {
  const { from, to } = range(q), ms = await members(c);
  const rs = await rows(c, `SELECT r.receipt_id, r.receipt_no, r.receipt_date, c.customers_name, k.component_kind, k.amount FROM receipt r JOIN receipt_component k ON k.receipt_id=r.receipt_id LEFT JOIN client_m c ON c.customers_cd=r.customers_cd
    WHERE r.status='POSTED' AND r.receipt_date BETWEEN ? AND ? ORDER BY r.receipt_date, r.receipt_id, k.component_no`, [from, to]);
  const lines = rs.map(r => { const amount = num(r.amount); return { date: r.receipt_date, no: r.receipt_no, account: PART_ACCOUNT[r.component_kind] || r.component_kind, memo: '売掛金入金', customer: r.customers_name, amount, parts: allocate(amount, ms) }; });
  return { title: '入金明細及び配分表', ref: 'NO36 / 添付帳票⑬', from, to, members: ms, lines, totals: { amount: lines.reduce((n, l) => n + l.amount, 0), parts: ms.map((_, i) => lines.reduce((n, l) => n + l.parts[i], 0)) } };
}

// ---------- Excel ----------
const head = (d, sub) => [[T(d.title)], [`${d.ref}　${sub}　出力日 ${today()}`], []];
export async function miscBook(c, kind, q) {
  if (kind === 'shipment-summary') {
    const d = await shipmentSummary(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['商品CD', '商品名', '単位', '件数', '出荷数量', '売上金額', '消費税', '掛売', '現金', 'カード'].map(H));
    for (const x of d.items) out.push([x.item, x.name, x.unit, x.count, x.qty, x.net, x.tax, x.credit, x.cash, x.card]);
    const t = d.totals; out.push([S('合計'), '', '', S(t.count), '', S(t.net), S(t.tax), S(t.credit), S(t.cash), S(t.card)]);
    return { name: `商品別出荷集計表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '出荷集計表', rows: out, widths: [10, 24, 6, 8, 12, 14, 12, 14, 12, 12] }]) };
  }
  if (kind === 'customer-items') {
    const d = await customerItems(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['得意先CD', '得意先名', '商品CD', '商品名', '単位', '件数', '出荷数量', '売上金額', '消費税'].map(H));
    for (const cu of d.customers) { for (const x of cu.items) out.push([cu.customer, cu.name, x.item, x.name, x.unit, x.count, x.qty, x.net, x.tax]); out.push(['', S(`${cu.name} 計`), '', '', '', '', '', S(cu.net), S(cu.tax)]); }
    out.push(['', S('総合計'), '', '', '', '', '', S(d.total)]);
    return { name: `得意先別商品別出荷累計表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '出荷累計表', rows: out, widths: [10, 24, 10, 24, 6, 8, 12, 14, 12] }]) };
  }
  if (kind === 'cash-sales') {
    const d = await cashSales(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['得意先CD', '得意先名', '売上日', '伝票No', '現場', '商品', '数量', '単価', '金額', '消費税', '合計'].map(H));
    for (const cu of d.customers) { for (const r of cu.rows) out.push([cu.customer, cu.name, r.date, r.no, r.site, r.item, r.qty, r.price, r.net, r.tax, r.total]); out.push(['', S(`${cu.name} 計`), '', '', '', '', '', '', S(cu.net), S(cu.tax), S(cu.total)]); }
    out.push(['', S('総合計'), '', '', '', '', '', '', '', '', S(d.total)], [d.note]);
    return { name: `現金売上明細表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '現金売上明細表', rows: out, widths: [10, 22, 11, 11, 22, 20, 9, 10, 12, 10, 12] }]) };
  }
  if (kind === 'material-ledger') {
    const d = await materialLedger(c, q), out = head(d, `対象月 ${d.month}（期首 ${d.fiscalStart}）`);
    out.push(['材料CD', '材料名', '期首 数量', '期首 金額', '前月来 数量', '前月来 金額', '当月仕入 数量', '当月仕入 金額', '当月使用 数量', '当月使用 金額', '当月末 数量', '当月末 金額', '単価'].map(H));
    for (const x of d.items) out.push([x.item, x.name, x.opening.qty, x.opening.value, x.prev.qty, x.prev.value, x.purchase.qty, x.purchase.value, x.used?.qty ?? '', x.used?.value ?? '', x.end?.qty ?? '', x.end?.value ?? '', x.price ?? '']);
    const t = d.totals; out.push([S('【合計】'), '', '', S(t.opening), '', S(t.prev), '', S(t.purchase), '', S(t.used), '', S(t.end), ''], [d.note]);
    return { name: `材料受払表_${d.month}.xlsx`, body: xlsx([{ name: '材料受払表', rows: out, widths: [9, 22, 11, 13, 11, 13, 11, 13, 11, 13, 11, 13, 11] }]) };
  }
  if (kind === 'mix') {
    const d = await mixCalc(c, q), out = head(d, `対象月 ${d.month}`);
    out.push(['製品CD', '製品名', '材料CD', '材料名', '配合率(%)', '材料単価', '単価根拠', '配合金額'].map(H));
    for (const p of d.products) {
      for (const l of p.lines) out.push([p.item, p.name, l.material, l.name, l.ratio, l.price ?? '', l.source, l.cost ?? '']);
      out.push(['', S(`${p.name} 配合単価`), '', '', S(p.ratio), '', '', S(p.haigo)]);
      if (p.saved) out.push(['', '保存済原価', '電気', p.saved.denki, '灯油', p.saved.touyu, '製造', p.saved.seizou, '一般', p.saved.ippann, '合計', p.saved.total]);
    }
    out.push([], [H('経費単価（推定）'), '製品出荷数量', d.suggest.tons, '電気', d.suggest.denki, '灯油', d.suggest.touyu, '製造', d.suggest.seizou, '一般', d.suggest.ippann], [d.suggest.basis], [],
      [H('材料使用量の比較'), '', '理論使用量', '実使用量', '差異'], ...d.usage.map(u => [u.material, u.name, u.theoretical, u.actual ?? '', u.diff ?? '']), [], [d.note]);
    return { name: `配合計算_${d.month}.xlsx`, body: xlsx([{ name: '配合計算', rows: out, widths: [9, 22, 9, 22, 10, 11, 26, 12, 8, 10, 8, 10] }]) };
  }
  if (kind === 'jv-expenses' || kind === 'jv-receipts') {
    const d = kind === 'jv-expenses' ? await jvExpenses(c, q) : await jvReceipts(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    const names = d.members.map(m => `${m.name}（${m.ratio}%）`);
    if (kind === 'jv-expenses') {
      out.push(['支払日', '伝票No', '科目', '支払先', '摘要', '税区分', '支払金額', '支払本体', '消費税', ...names].map(H));
      for (const a of d.accounts) { for (const r of a.rows) out.push([r.date, r.no, `${a.account} ${a.name}`, r.vendor, r.memo, r.taxCode, r.gross, r.net, r.tax, ...r.parts]); out.push(['', '', S('＊科目計＊'), '', '', '', S(a.gross), S(a.net), S(a.tax), ...a.parts.map(S)]); }
      out.push(['', '', S('合計'), '', '', '', S(d.totals.gross), S(d.totals.net), S(d.totals.tax), ...d.totals.parts.map(S)], [], [H('出資金請求合計表（科目別）')], ['科目', '支払金額', '支払本体', '消費税', ...names].map(H));
      for (const a of d.accounts) out.push([`${a.account} ${a.name}`, a.gross, a.net, a.tax, ...a.parts]);
      out.push([d.note]);
    } else {
      out.push(['入金日', '入金No', '入金科目', '摘要', '入金先', '入金額', ...names].map(H));
      for (const l of d.lines) out.push([l.date, l.no, l.account, l.memo, l.customer, l.amount, ...l.parts]);
      out.push(['', '', S('合計'), '', '', S(d.totals.amount), ...d.totals.parts.map(S)]);
    }
    return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title.slice(0, 28), rows: out, widths: [11, 12, 18, 22, 20, 12, 12, 12, 12, 16, 16, 16, 16] }]) };
  }
  check(false, '帳票の種類が不正です');
}
export const MISC = { 'shipment-summary': shipmentSummary, 'customer-items': customerItems, 'cash-sales': cashSales, 'material-ledger': materialLedger, mix: mixCalc, 'jv-expenses': jvExpenses, 'jv-receipts': jvReceipts };
