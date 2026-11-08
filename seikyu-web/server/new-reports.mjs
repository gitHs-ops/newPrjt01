// 2026-10-21 再構成で追加した帳票（添付帳票⑭⑰・10/19 打合せの振込先一覧）。画面・印刷・Excel は共通形式
// { title, ref, sub, columns: [{ key, label, num }], groups: [{ title, rows, totals }], totals } で返し、app.js / genericBook で描画する。
import { check, isoDate, isoMonth, today, toNum } from './domain.mjs';
import { rows, one } from './db.mjs';
import { xlsx, band } from './xlsx.mjs';
import { PURCHASE_KINDS, PURCHASE_UNITS, listExpenses } from './payables.mjs';
import { decode } from './taxcode.mjs';

const num = v => Number(v || 0);
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const sum = (list, k) => list.reduce((n, r) => n + num(r[k]), 0);

// ⑭ 商品仕入登録リスト（現行 HAR011）：仕入日 → 仕入先 の2段ブレイク（10-29 画面レビュー No.14）・伝票明細
// 伝票No.：P＋処理年度4桁＋5桁連番（10/24 大西さん回答）＋行番号2桁の枝番（10/28 打合せ No.21）。例 P202600001-01
export const purchaseNo = (no, line) => `${no || ''}-${String(line || 1).padStart(2, '0')}`;
export async function purchaseRegister(c, q) {
  // 11/04 打合せ No.19：月 1 回、指定月（初期表示は当月）の前月21日〜当月20日を仕入先別・仕入日ごとに出す。month 指定がなければ従来の from/to
  let from, to;
  if (q.month) { check(/^\d{4}-\d{2}$/.test(q.month), '月を指定してください'); const [y, m] = q.month.split('-').map(Number); from = new Date(Date.UTC(y, m - 2, 21)).toISOString().slice(0, 10); to = `${q.month}-20`; }
  else { from = isoDate(q.from, '開始日'); to = isoDate(q.to, '終了日'); }
  check(from <= to, '期間が不正です');
  const rs = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, i.item_nam, unit_name(i.unit) item_unit FROM purchase p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN item_m i ON i.item_cd=p.item_cd
    WHERE p.purchase_date BETWEEN ? AND ? ORDER BY v.vendor_code, p.purchase_date, p.source_document_no, p.line_no`, [from, to]);
  const groups = [];
  for (const r of rs) {
    let g = groups.find(x => x.code === r.vendor_code);   // 仕入先別（11/04 No.19）。仕入日・区分は仕入日が変わった行だけ
    // 仕入先の見出しは現行 HAR011 どおり「コード　仕入先名」（2026-11-04）
    if (!g) groups.push(g = { code: r.vendor_code, title: `${r.vendor_code}　${r.vendor_name}`, rows: [] });
    // 運賃の行は現行どおり数量・単価 0.00 で、処税率の右に「運賃」。処税率はコードの右に名称（画面の選択リストと同じ。2026-11-01）
    const fr = r.line_kind === '2';
    // 現行 HAR011：仕入日・区分は仕入先の 1 行目だけ、伝票No. は伝票の 1 行目だけ（2 行目からは枝番だけ）。slip＝伝票No.＋枝番（2026-11-04）
    const first = g.last !== r.purchase_date; g.last = r.purchase_date; const slip = purchaseNo(r.source_document_no, r.line_no), sameSlip = g.rows.at(-1)?.doc === r.source_document_no;
    g.rows.push({ date: first ? `${r.purchase_date.slice(2, 4)}/${r.purchase_date.slice(5, 7)}/${r.purchase_date.slice(8, 10)}` : '', kind: first ? PURCHASE_KINDS[r.purchase_kb || '1'] : '', no: sameSlip ? slip.slice(-2) : slip, slip, doc: r.source_document_no, item: r.item_cd ? `${r.item_cd} ${r.item_nam || ''}` : '運賃',
      qty: fr ? 0 : num(r.quantity), unit: r.unit ? PURCHASE_UNITS[r.unit] ?? '' : r.item_unit || '', price: fr ? 0 : num(r.unit_price), net: num(r.net_amount), account: '', subName: '', tax: `${r.source_tax_code || ''}${fr ? ' 運賃' : ''}` });   // 処税率はコードだけ（現行 HAR011。2026-11-04）
  }
  // 現行 HAR011 には仕入日の見出し・仕入先計・仕入日計・総合計が無い（2026-11-04）
  for (const g of groups) delete g.last;
  return { title: '商品仕入登録リスト', ref: '帳票⑭（HAR011）', from, to, sub: `仕入日 ${from} 〜 ${to}`,
    // 項目名は現行の見本（HAR011・添付帳票⑭ p.1-2）どおり（2026-10-29）。単位は仕入数量の右で見出しなし。科目ｺｰﾄﾞ・内訳名は見本でも空欄。摘要は見本にないので出さない
    columns: [{ key: 'date', label: '仕入日', w: 11 }, { key: 'kind', label: '区分', w: 8 }, { key: 'no', label: '伝票No.', w: 15 }, { key: 'item', label: '商品名', w: 30 }, { key: 'qty', label: '仕入数量', num: 1, w: 11 }, { key: 'unit', label: '', w: 4 },
      { key: 'price', label: '仕入単価', num: 1, dec: 1, w: 11 }, { key: 'net', label: '仕入金額', num: 1, w: 13 }, { key: 'account', label: '科目ｺｰﾄﾞ', w: 9 }, { key: 'subName', label: '内訳名', w: 14 }, { key: 'tax', label: '処税率', w: 30 }],
    groups };
}
// ⑰ 在庫登録リスト（現行 HAR061）：月度の在庫数量。項目はコード・商品・製品名・在庫数量・単位だけ（評価単価・評価額は出さない。2026-11-03 ユーザー指示の見本）
export async function inventoryRegister(c, q) {
  const month = isoMonth(q.month, '対象月');
  const rs = await rows(c, `SELECT n.*, i.item_nam, unit_name(i.unit) unit, i.item_product_kb FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd WHERE n.period_start=? AND n.status IN ('POSTED','DRAFT') ORDER BY i.item_product_kb, n.item_cd`, [month + '-01']);
  const no = (await one(c, "SELECT doc_no FROM app_doc_no WHERE kind='count' AND ref=?", [month]))?.doc_no || ''; // 実在庫の伝票No（V＋年度＋連番。2026-11-03）
  // 製品・材料の区分見出し・小計・総合計は保留（2026-11-03 ユーザー指示の見本）。並びは製品 → 材料・商品のまま
  const list = [...rs.filter(r => r.item_product_kb === '2'), ...rs.filter(r => r.item_product_kb !== '2')];
  const groups = list.length ? [{ rows: list.map(r => ({ code: r.item_cd, name: r.item_nam || '', qty: num(r.quantity), unit: r.unit || '' })) }] : [];
  return { title: '在庫登録リスト', ref: '帳票⑰（HAR061）', month, sub: `${month} 月度（${monthEnd(month)} 現在）${no ? '　伝票No ' + no : ''}`,
    columns: [{ key: 'code', label: 'コード' }, { key: 'name', label: '商品・製品名' }, { key: 'qty', label: '在庫数量', num: 1 }, { key: 'unit', label: '単位' }],
    groups }; // 総合計も出さない（2026-11-03）
}
// 振込先一覧（10/19 打合せ）：支払予定日が基準日までの未払がある業者を、業者マスタの振込サイクル・振込元口座・振込先口座とともに一覧
export async function transferList(c, q) {
  const to = q.to ? isoDate(q.to, '支払予定日') : today();
  const open = (await listExpenses(c, { kind: 'PAYABLE', open: true })).filter(e => (e.due || e.date) <= to);
  const vs = await rows(c, `SELECT v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, b.holder_name, vp.category1 m, vp.category2 d, vp.category3 cycle, vp.code_dtl_abr from_bank
    FROM vendor v LEFT JOIN bank_account b ON b.bank_account_id=v.bank_account_id LEFT JOIN code_m vp ON vp.code_key='VPAY' AND vp.code_dtl=v.vendor_code ORDER BY v.vendor_code`);
  const TYPE = { 1: '普通', 2: '当座', 4: '貯蓄' }, groups = [];
  for (const cycle of ['15', '31', '']) {
    const list = vs.filter(v => (v.cycle || '') === cycle).map(v => {
      const mine = open.filter(e => e.vendor === v.vendor_code); if (!mine.length) return null;
      return { code: v.vendor_code, name: v.vendor_name, terms: v.m !== null && v.m !== undefined && (v.m !== '' || v.d !== '') ? `${v.m || 1}か月後 ${v.d === '31' || !v.d ? '月末' : v.d + '日'}` : '翌月末（未設定）',
        from: v.from_bank || '（未設定）', payee: v.bank_code ? `${v.bank_code}-${v.branch_code} ${TYPE[v.account_type_code] || ''} ${v.account_number}` : '振込先未登録', holder: v.holder_name || '',
        due: mine.map(e => e.due).sort()[0] || '', docs: mine.length, balance: mine.reduce((n, e) => n + e.balance, 0) };
    }).filter(Boolean);
    if (list.length) groups.push({ title: cycle === '15' ? '振込サイクル：15日' : cycle === '31' ? '振込サイクル：月末' : '振込サイクル：未設定', rows: list, totals: { balance: sum(list, 'balance') } });
  }
  return { title: '振込先一覧', ref: '10/19 打合せ（支払処理）', to, sub: `支払予定日 ${to} まで`,
    columns: [{ key: 'code', label: '業者CD' }, { key: 'name', label: '業者名' }, { key: 'terms', label: '支払繰延' }, { key: 'from', label: '振込元口座' }, { key: 'payee', label: '振込先（銀行-支店 種別 口座）' }, { key: 'holder', label: '受取人' },
      { key: 'due', label: '最早支払予定日' }, { key: 'docs', label: '伝票数', num: 1 }, { key: 'balance', label: '未払残高', num: 1 }],
    groups, totals: { balance: groups.reduce((n, g) => n + g.totals.balance, 0) } };
}
// ---------- ㉖㉗㉘ 日報（現行 MEN120 日次業務 16・17・18。他帳票分26_27_28.pdf、2026-11-08 追加） ----------
// 指定日の 前日累計（月度の初日〜前日）・当日・累計（月度の初日〜当日）。月度は現行どおり 20 日締め（前月21日〜当月20日）
const ymd = d => toNum(d);
const dayRange = q => {
  const d = isoDate(q.date, '日付'), y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  const from = day > 20 ? `${d.slice(0, 7)}-21` : new Date(Date.UTC(y, m - 2, 21)).toISOString().slice(0, 10);
  return { d, from };
};
const DAY_COLS = (first, firstLabel) => [{ key: 'code', label: first ? 'コード' : '', w: 9 }, ...(firstLabel ? [{ key: 'party', label: firstLabel, w: 26 }] : []), { key: 'name', label: '品名', w: 28 }, { key: 'unit', label: '単位', w: 5 },
  { key: 'pq', label: '前日累計数量', num: 1, dec: 1, w: 12 }, { key: 'pv', label: '前日累計金額', num: 1, w: 13 }, { key: 'dq', label: '当日数量', num: 1, dec: 1, w: 11 }, { key: 'dv', label: '当日金額', num: 1, w: 13 },
  { key: 'cq', label: '累計数量', num: 1, dec: 1, w: 11 }, { key: 'cv', label: '累計金額', num: 1, w: 13 }];
const r2d = v => Math.round(v * 100) / 100;
const dayRow = (r, d) => { const dq = r2d(num(r.dq)), dv = num(r.dv), cq = r2d(num(r.cq)), cv = num(r.cv); return { pq: r2d(cq - dq), pv: cv - dv, dq, dv, cq, cv }; };
const daySum = list => ['pq', 'pv', 'dq', 'dv', 'cq', 'cv'].reduce((o, k) => ({ ...o, [k]: k.endsWith('q') ? r2d(list.reduce((n, x) => n + x[k], 0)) : list.reduce((n, x) => n + x[k], 0) }), {});
// ㉖ 商品別出荷日報（現行 HAR511）：商品ごと。合計 → 値引計 → 他社納入分 → 総合計
export async function itemShipDaily(c, q) {
  const { d, from } = dayRange(q);
  const rs = await rows(c, `SELECT s.item_cd, MAX(COALESCE(NULLIF(i.item_nam, ''), s.item_name)) item_name, MAX(unit_name(i.unit)) unit,
      CASE WHEN s.ship_kb='9' THEN 9 WHEN (CASE WHEN s.ship_kb='5' THEN o.ship_kb ELSE s.ship_kb END) IN ('2','4') THEN 1 ELSE 0 END sect,
      CASE WHEN k.category1='2' THEN 2 ELSE 1 END kg,
      SUM(CASE WHEN s.sales_date=? THEN s.quantity ELSE 0 END) dq, SUM(CASE WHEN s.sales_date=? THEN s.money ELSE 0 END) dv, SUM(s.quantity) cq, SUM(s.money) cv
    FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN sales_trn o ON s.ship_kb='5' AND o.order_no=s.sales_no AND o.order_suffix=1
      LEFT JOIN code_m k ON k.code_key='A0000' AND k.code_dtl=CAST(COALESCE(s.shipping_kb, o.shipping_kb) AS TEXT)
    WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.item_cd, 4, 5 ORDER BY 4, s.item_cd, 5`, [ymd(d), ymd(d), ymd(from), ymd(d)]);
  // 現行 HAR511 の手書き（p2）「出荷伝票登録の納入区分の 現着→1、引取→2 とする」：商品コードの枝番 -1＝現着・-2＝引取（納入区分マスタの「引取（運賃なし）」）で行を分ける（2026-11-08）
  const row = r => ({ code: `${r.item_cd}-${Number(r.kg) === 2 ? 2 : 1}`, name: String(r.item_name || '').trim(), unit: r.unit || '', ...dayRow(r, d) });
  const own = rs.filter(r => Number(r.sect) === 0).map(row), disc = rs.filter(r => Number(r.sect) === 9).map(row), other = rs.filter(r => Number(r.sect) === 1).map(row);
  const groups = [];
  if (own.length) groups.push({ rows: own, label: '合　計', totals: daySum(own) });
  if (disc.length) groups.push({ rows: [], label: '値引計', totals: daySum(disc) });
  if (other.length) groups.push({ head: '（他社納入分）', rows: other, label: '合　計', totals: daySum(other) });
  const all = [...own, ...disc, ...other];
  return { title: '商品別出荷日報', ref: '帳票㉖（HAR511）', date: d, from, to: d, sub: `${d}（月度 ${from} 〜）`, columns: DAY_COLS(true), groups, ...(all.length ? { totals: daySum(all) } : {}) };
}
// ㉗ 得意先別出荷日報（現行 HAR531）：得意先ごとに商品別、得意先計。最後に値引・総合計
export async function customerShipDaily(c, q) {
  const { d, from } = dayRange(q);
  const rs = await rows(c, `SELECT s.customers_cd, MAX(c.customers_name) customers_name, s.item_cd, MAX(COALESCE(NULLIF(i.item_nam, ''), s.item_name)) item_name, MAX(unit_name(i.unit)) unit,
      CASE WHEN s.ship_kb='9' THEN 9 ELSE 0 END sect,
      SUM(CASE WHEN s.sales_date=? THEN s.quantity ELSE 0 END) dq, SUM(CASE WHEN s.sales_date=? THEN s.money ELSE 0 END) dv, SUM(s.quantity) cq, SUM(s.money) cv
    FROM sales_trn s LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN client_m c ON c.customers_cd=s.customers_cd
    WHERE s.sales_date BETWEEN ? AND ? GROUP BY s.customers_cd, s.item_cd, 6 ORDER BY 6, s.customers_cd, s.item_cd`, [ymd(d), ymd(d), ymd(from), ymd(d)]);
  const groups = [], all = [];
  for (const r of rs.filter(x => Number(x.sect) === 0)) {
    let g = groups.find(x => x.cd === r.customers_cd); if (!g) groups.push(g = { cd: r.customers_cd, title: `${r.customers_cd}　${r.customers_name || ''}`, rows: [], label: '得意先計' });
    const x = { code: r.item_cd, name: String(r.item_name || '').trim(), unit: r.unit || '', ...dayRow(r, d) }; g.rows.push(x); all.push(x);
  }
  groups.forEach(g => { g.totals = daySum(g.rows); delete g.cd; });
  const disc = rs.filter(x => Number(x.sect) === 9).map(r => ({ ...dayRow(r, d) }));
  if (disc.length) { groups.push({ rows: [], label: '値　引', totals: daySum(disc) }); all.push(...disc); }
  return { title: '得意先別出荷日報', ref: '帳票㉗（HAR531）', date: d, from, to: d, sub: `${d}（月度 ${from} 〜）`, columns: DAY_COLS(true), groups, ...(all.length ? { totals: daySum(all) } : {}) };
}
// ㉘ 商品別仕入日報（現行 HAR521）：仕入先ごとに商品別。商品仕入登録の区分 1＝仕入、2＝他社納入 を分けて、それぞれ合計
export async function itemPurchaseDaily(c, q) {
  const { d, from } = dayRange(q);
  const rs = await rows(c, `SELECT COALESCE(p.purchase_kb, '1') kb, v.vendor_code, MAX(v.vendor_name) vendor_name, p.item_cd, MAX(i.item_nam) item_name, MAX(unit_name(i.unit)) unit,
      SUM(CASE WHEN p.purchase_date=? THEN p.quantity ELSE 0 END) dq, SUM(CASE WHEN p.purchase_date=? THEN p.net_amount ELSE 0 END) dv, SUM(p.quantity) cq, SUM(p.net_amount) cv
    FROM purchase p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN item_m i ON i.item_cd=p.item_cd
    WHERE p.purchase_date BETWEEN ? AND ? GROUP BY 1, v.vendor_code, p.item_cd ORDER BY 1, v.vendor_code, p.item_cd`, [d, d, from, d]);
  const groups = [], all = [];
  for (const [kb, label] of [['1', '仕入'], ['2', '他社納入']]) {
    const mine = rs.filter(r => String(r.kb || '1') === kb); if (!mine.length) continue;
    const gs = [];
    for (const r of mine) {
      let g = gs.find(x => x.cd === r.vendor_code); if (!g) gs.push(g = { cd: r.vendor_code, title: `${r.vendor_code}　${r.vendor_name || ''}`, rows: [] });
      const x = { code: r.item_cd || '', name: r.item_cd ? String(r.item_name || '').trim() : '運賃・金額のみ', unit: r.unit || '', ...dayRow(r, d) }; g.rows.push(x);
    }
    const sec = gs.flatMap(g => g.rows); all.push(...sec);
    gs.forEach(g => delete g.cd); gs[0].head = `区分 ${kb}．${label}`; gs[gs.length - 1].foot = { label: `${label} 合計`, totals: daySum(sec) };
    groups.push(...gs);
  }
  return { title: '商品別仕入日報', ref: '帳票㉘（HAR521）', date: d, from, to: d, sub: `${d}（月度 ${from} 〜）`, columns: DAY_COLS(true), groups, ...(all.length ? { totals: daySum(all) } : {}) };
}
export const NEW_REPORTS = { 'purchase-register': purchaseRegister, 'inventory-register': inventoryRegister, 'transfer-list': transferList, 'item-ship-daily': itemShipDaily, 'customer-ship-daily': customerShipDaily, 'item-purchase-daily': itemPurchaseDaily };
export async function genericBook(c, kind, q) {
  const d = await NEW_REPORTS[kind](c, q), H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' });
  const out = [[{ v: d.title, s: 'title' }], [`${d.sub}　出力日 ${today()}`], [], d.columns.map(col => H(col.label))];
  const merges = [], W = d.columns.map(col => col.w ?? (col.num ? 13 : 18));   // g.title（仕入先など）は名前が入る分の列だけ結合して色付け（band）
  const totalRow = (label, t) => d.columns.map((col, i) => (i === 0 ? S(label) : t[col.key] !== undefined ? S(t[col.key]) : ''));
  // g.title の行は表の全列を結合して見出しの色を付ける（1セルだけだと不自然。2026-11-06 ユーザー指摘）
  // g.head：上位ブレイクの見出し、g.label：グループ計の名称、g.foot：上位ブレイクの計（任意）。g.title・g.totals が無いグループは見出し・計の行を出さない
  for (const g of d.groups) { if (g.head) out.push([{ v: g.head, s: 'title' }]); if (g.title) out.push(band(W, [g.title])); for (const r of g.rows) out.push(d.columns.map(col => r[col.key] ?? '')); if (g.totals) out.push(totalRow(g.label || '計', g.totals)); if (g.foot) out.push(totalRow(g.foot.label, g.foot.totals)); }
  if (d.totals) out.push(totalRow('総合計', d.totals));
  return { name: `${d.title}_${(d.from || d.month || d.to || today())}.xlsx`, body: xlsx([{ name: d.title, rows: out, merges, widths: W }]) };
}
