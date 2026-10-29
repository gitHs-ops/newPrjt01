// 2026-10-21 再構成で追加した帳票（添付帳票⑭⑰・10/19 打合せの振込先一覧）。画面・印刷・Excel は共通形式
// { title, ref, sub, columns: [{ key, label, num }], groups: [{ title, rows, totals }], totals } で返し、app.js / genericBook で描画する。
import { check, isoDate, isoMonth, today } from './domain.mjs';
import { rows } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { PURCHASE_KINDS, listExpenses } from './payables.mjs';

const num = v => Number(v || 0);
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const sum = (list, k) => list.reduce((n, r) => n + num(r[k]), 0);

// ⑭ 商品仕入登録リスト（現行 HAR011）：仕入日 → 仕入先 の2段ブレイク（10-29 画面レビュー No.14）・伝票明細
// 伝票No.：10/28 打合せ（No.21）「伝票番号は5桁＋行番号2桁の枝番」（例 53192-01）。内部の仕入伝票No（P00000009）の下5桁で表示
export const purchaseNo = (no, line) => `${String(no || '').replace(/\D/g, '').slice(-5).padStart(5, '0')}-${String(line || 1).padStart(2, '0')}`;
export async function purchaseRegister(c, q) {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です');
  const rs = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, i.item_nam, unit_name(i.unit) unit FROM purchase p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN item_m i ON i.item_cd=p.item_cd
    WHERE p.purchase_date BETWEEN ? AND ? ORDER BY p.purchase_date, v.vendor_code, p.source_document_no, p.line_no`, [from, to]);
  const groups = [];
  for (const r of rs) {
    let g = groups.find(x => x.date === r.purchase_date && x.code === r.vendor_code);
    if (!g) groups.push(g = { date: r.purchase_date, code: r.vendor_code, title: `仕入先 ${r.vendor_code} ${r.vendor_name}`, label: '仕入先計', rows: [] });
    // 運賃の行は現行どおり数量・単価 0.00 で、処税率の右に「運賃」
    const fr = r.line_kind === '2';
    g.rows.push({ date: r.purchase_date, kind: PURCHASE_KINDS[r.purchase_kb || '1'], no: purchaseNo(r.source_document_no, r.line_no), item: `${r.item_cd} ${r.item_nam || ''}`,
      qty: fr ? 0 : num(r.quantity), unit: r.unit || '', price: fr ? 0 : num(r.unit_price), net: num(r.net_amount), account: '', subName: '', tax: `${r.source_tax_code || ''}${fr ? ' 運賃' : ''}` });
  }
  for (const g of groups) g.totals = { net: sum(g.rows, 'net') };
  // 仕入日の見出し（その日の最初の仕入先の前）と仕入日計（その日の最後の仕入先の後）
  groups.forEach((g, i) => {
    if (groups[i - 1]?.date !== g.date) g.head = `仕入日 ${g.date}`;
    if (groups[i + 1]?.date !== g.date) g.foot = { label: `仕入日計 ${g.date}`, totals: { net: groups.filter(x => x.date === g.date).reduce((n, x) => n + x.totals.net, 0) } };
  });
  return { title: '商品仕入登録リスト', ref: '帳票⑭（HAR011）', from, to, sub: `仕入日 ${from} 〜 ${to}`,
    // 項目名は現行の見本（HAR011・添付帳票⑭ p.1-2）どおり（2026-10-29）。単位は仕入数量の右で見出しなし。科目ｺｰﾄﾞ・内訳名は見本でも空欄。摘要は見本にないので出さない
    columns: [{ key: 'date', label: '仕入日', w: 11 }, { key: 'kind', label: '区分', w: 8 }, { key: 'no', label: '伝票No.', w: 10 }, { key: 'item', label: '商品名', w: 30 }, { key: 'qty', label: '仕入数量', num: 1, w: 11 }, { key: 'unit', label: '', w: 4 },
      { key: 'price', label: '仕入単価', num: 1, w: 11 }, { key: 'net', label: '仕入金額', num: 1, w: 13 }, { key: 'account', label: '科目ｺｰﾄﾞ', w: 9 }, { key: 'subName', label: '内訳名', w: 14 }, { key: 'tax', label: '処税率', w: 10 }],
    groups, totals: { net: groups.reduce((n, g) => n + g.totals.net, 0) } };
}
// ⑰ 在庫登録リスト（現行 HAR061）：月度の在庫数量
export async function inventoryRegister(c, q) {
  const month = isoMonth(q.month, '対象月');
  const rs = await rows(c, `SELECT n.*, i.item_nam, unit_name(i.unit) unit, i.item_product_kb FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd WHERE n.period_start=? AND n.status IN ('POSTED','DRAFT') ORDER BY i.item_product_kb, n.item_cd`, [month + '-01']);
  const groups = [['2', '製品'], ['1', '材料・商品']].map(([k, t]) => ({ title: t, rows: rs.filter(r => (k === '2') === (r.item_product_kb === '2')).map(r => ({ code: r.item_cd, name: r.item_nam || '', qty: num(r.quantity), unit: r.unit || '', price: num(r.valuation_price), value: num(r.valuation_amount) })) }))
    .filter(g => g.rows.length);
  for (const g of groups) g.totals = { value: sum(g.rows, 'value') };
  return { title: '在庫登録リスト', ref: '帳票⑰（HAR061）', month, sub: `${month} 月度（${monthEnd(month)} 現在）`,
    columns: [{ key: 'code', label: 'コード' }, { key: 'name', label: '商品・製品名' }, { key: 'qty', label: '在庫数量', num: 1 }, { key: 'unit', label: '単位' }, { key: 'price', label: '評価単価', num: 1 }, { key: 'value', label: '評価額', num: 1 }],
    groups, totals: { value: groups.reduce((n, g) => n + g.totals.value, 0) } };
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
export const NEW_REPORTS = { 'purchase-register': purchaseRegister, 'inventory-register': inventoryRegister, 'transfer-list': transferList };
export async function genericBook(c, kind, q) {
  const d = await NEW_REPORTS[kind](c, q), H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' });
  const out = [[{ v: d.title, s: 'title' }], [`${d.sub}　出力日 ${today()}`], [], d.columns.map(col => H(col.label))];
  const totalRow = (label, t) => d.columns.map((col, i) => (i === 0 ? S(label) : t[col.key] !== undefined ? S(t[col.key]) : ''));
  // g.head：上位ブレイクの見出し、g.label：グループ計の名称、g.foot：上位ブレイクの計（任意）
  for (const g of d.groups) { if (g.head) out.push([{ v: g.head, s: 'title' }]); out.push([H(g.title)]); for (const r of g.rows) out.push(d.columns.map(col => r[col.key] ?? '')); out.push(totalRow(g.label || '計', g.totals)); if (g.foot) out.push(totalRow(g.foot.label, g.foot.totals)); }
  out.push(totalRow('総合計', d.totals));
  return { name: `${d.title}_${(d.from || d.month || d.to || today())}.xlsx`, body: xlsx([{ name: d.title, rows: out, widths: d.columns.map(col => col.w ?? (col.num ? 13 : 18)) }]) };
}
