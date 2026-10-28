// ② 自動仕訳リスト（帳票一覧⑥⑦⑨・9/17資料ア〜エ）。現行 HAR363/HAR413/HAR152/HAR733/CS5785 と同じ「借方・貸方を1行に併記」形式。
// 削減案5により全リストを同一フォーマットで出力する。エ（銀行別随時支払一覧表）のみ別形式。
import { check, isoDate, fromNum, today } from './domain.mjs';
import { rows } from './db.mjs';
import { xlsx } from './xlsx.mjs';

export const LISTS = {
  A01: { title: '売掛金計上自動仕訳リスト', ref: 'NO8 / 帳票⑦（HAR363）', prefix: 'R', source: 'billing_head' },
  B01: { title: '入金自動仕訳リスト', ref: 'NO18 / 帳票⑥（HAR413）', prefix: 'B', source: 'receipt' },
  C01: { title: '在庫計上自動仕訳リスト', ref: 'NO28 / 帳票⑨', prefix: '', source: 'inventory_count' },
  D01: { title: '定時請求自動仕訳リスト', ref: 'NO31 / 資料ア（HAR152）', prefix: 'S', source: 'expense_document' },
  E01: { title: '小口現金出納分自動仕訳リスト', ref: 'NO34 / 資料イ（HAR733）', prefix: 'K', source: 'expense_document' },
  F01: { title: '支払内訳自動仕訳リスト', ref: 'NO38 / 資料ウ（CS5785）', prefix: 'U', source: 'payment' },
  G03: { title: '小口現金補充仕訳リスト', ref: 'G-03（現行は手入力）', prefix: '', source: 'petty_refill' },
};
export const BANK_LIST = { title: '銀行別随時支払一覧表', ref: 'NO39 / 資料エ（HAR321）' };
const ph = a => a.map(() => '?').join(',');
const range = q => {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日');
  check(from <= to, '期間が不正です'); check((Date.parse(to) - Date.parse(from)) / 864e5 <= 400, '期間は400日以内で指定してください');
  return { from, to };
};

export async function journalList(c, q) {
  const def = LISTS[q.pattern]; check(def, '仕訳リストの種類が不正です');
  const { from, to } = range(q);
  const es = await rows(c, 'SELECT e.*, n.slip_no FROM journal_entry e LEFT JOIN app_slip_no n ON n.journal_id=e.journal_id WHERE e.pattern_code=? AND e.journal_date BETWEEN ? AND ? ORDER BY e.journal_date, e.journal_id', [q.pattern, from, to]);
  const ids = es.map(e => e.journal_id);
  const ls = ids.length ? await rows(c, `SELECT l.*, a.account_name, s.sub_name, cu.customers_name, v.vendor_code, v.vendor_name FROM journal_line l
    LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code
    LEFT JOIN client_m cu ON cu.customers_cd=l.customers_cd LEFT JOIN vendor v ON v.vendor_id=l.vendor_id WHERE l.journal_id IN (${ph(ids)}) ORDER BY l.journal_id, l.line_no`, ids) : [];
  // Source documents for 摘要 (memo) columns.
  const src = new Map(), srcIds = [...new Set(es.filter(e => e.source_type === def.source).map(e => Number(e.source_id)))];
  if (srcIds.length) {
    if (def.source === 'billing_head') for (const r of await rows(c, `SELECT h.invoice_id id, h.closing_date, h.customers_cd, c.customers_name FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd WHERE h.invoice_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: 'K' + fromNum(r.closing_date).slice(0, 7).replace('-', '') + String(r.id).padStart(5, '0'), memo2: `${fromNum(r.closing_date)}締` });
    if (def.source === 'receipt') {
      for (const r of await rows(c, `SELECT receipt_id id, receipt_no FROM receipt WHERE receipt_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.receipt_no, closings: [], note: '' });
      for (const a of await rows(c, `SELECT a.receipt_id, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${ph(srcIds)}) ORDER BY a.receipt_id, a.invoice_id`, srcIds)) src.get(a.receipt_id)?.closings.push(fromNum(a.closing_date));
      for (const k of await rows(c, `SELECT receipt_id, maturity_date FROM receipt_component WHERE component_kind='NOTE' AND receipt_id IN (${ph(srcIds)})`, srcIds)) if (src.get(k.receipt_id)) src.get(k.receipt_id).note = `手形 期日${k.maturity_date || ''}`;
    }
    if (def.source === 'inventory_count') for (const r of await rows(c, `SELECT n.inventory_id id, n.item_cd, i.item_nam FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd WHERE n.inventory_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: 'V' + r.id, item: `${r.item_cd} ${r.item_nam || ''}` });
    if (def.source === 'expense_document') for (const r of await rows(c, `SELECT d.expense_id id, d.document_no, d.memo FROM expense_document d WHERE d.expense_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.document_no, memo2: r.memo });
    if (def.source === 'payment') for (const r of await rows(c, `SELECT payment_id id, payment_no FROM payment WHERE payment_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.payment_no });
  }
  const DEDUCT = { '8330|101': '手数料', '8330|107': '協力費', '8850|': '値引き', '4170|': '預り金充当' };
  const slips = es.map(e => {
    const s = e.source_type === 'inventory_month' ? { no: `棚卸 ${e.source_id.slice(0, 4)}-${e.source_id.slice(4)}月度` } : src.get(Number(e.source_id)) || { no: '' }, lines = ls.filter(l => l.journal_id === e.journal_id);
    const partnerLine = lines.find(l => l.customers_cd || l.vendor_id), partner = partnerLine ? { code: partnerLine.customers_cd || partnerLine.vendor_code, name: partnerLine.customers_name || partnerLine.vendor_name } : null;
    let creditNo = 0;
    const side = l => {
      if (!l) return null;
      let sub = l.sub_code || '', subName = l.sub_name || '';
      if (!sub && l.customers_cd) { sub = l.customers_cd; subName = l.customers_name || ''; }
      if (!sub && l.vendor_id) { sub = l.vendor_code; subName = l.vendor_name || ''; }
      if (!sub && l.account_code === '8130' && partner) { sub = partner.code; subName = partner.name; }
      let memo2 = s.memo2 || '';
      if (e.pattern_code === 'B01') {
        memo2 = DEDUCT[`${l.account_code}|${l.sub_code || ''}`] || (l.account_code === '1120' ? s.note : '');
        if (l.side === 'C' && l.account_code === '1131') memo2 = s.closings?.[creditNo++] || '';
      }
      // 在庫計上（C01）：現行 HAR463 と同じく 摘要1＝前月末在庫／当月末在庫（商品は 1360 の内訳1）。2026-10-28 摘要1＝商品・摘要2＝前月末在庫 から変更
      if (e.pattern_code === 'C01') return { dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: l.source_tax_code || '', amount: Number(l.amount),
        memo1Code: '', memo1: (l.side === 'D' ? l.account_code === '82316' : l.account_code === '1360') ? '前月末在庫' : '当月末在庫', memo2: '' };
      return { dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: l.source_tax_code || '', amount: Number(l.amount),
        memo1Code: partner?.code || '', memo1: partner?.name || '', memo2 };
    };
    const dr = lines.filter(l => l.side === 'D'), cr = lines.filter(l => l.side === 'C'), pairs = [];
    // Inventory pairs follow the 洗替 order (前月末戻し, 当月末計上) even if one side is zero.
    for (let i = 0; i < Math.max(dr.length, cr.length); i++) pairs.push({ dr: side(dr[i]), cr: side(cr[i]) });
    const total = dr.reduce((n, l) => n + Number(l.amount), 0);
    return { id: e.journal_id, date: e.journal_date, slipNo: e.slip_no || String(e.journal_id), sourceNo: s.no, status: e.reversal_of ? `逆仕訳（#${e.reversal_of}）` : e.status === 'REVERSED' ? '取消済' : '', pairs, total };
  });
  // NO8: 売掛金計上は締日単位で一括、1伝票に最大45得意先（Q08：R00829→R00830 が45得意先目で分割）。請求締めで同じ伝票番号を振った請求をまとめて1伝票で表示する。
  if (q.pattern === 'A01' && q.group !== 'none') {
    const merged = [], bySlip = new Map();
    for (const s of slips) {
      // 逆仕訳は自分の伝票番号のまま。後で取り消された請求も計上した伝票の一部として残す。
      const key = s.status.startsWith('逆仕訳') ? null : `${s.date}|${s.slipNo}`, m = key && bySlip.get(key);
      if (!m) { const x = { ...s, nos: [s.sourceNo], voided: s.status ? 1 : 0 }; merged.push(x); if (key) bySlip.set(key, x); continue; }
      m.nos.push(s.sourceNo); m.pairs = m.pairs.concat(s.pairs); m.total += s.total; if (s.status) m.voided++;
    }
    for (const m of merged) {
      if (m.nos.length > 1) { m.sourceNo = `${m.nos[0]}〜${m.nos[m.nos.length - 1]}（${m.nos.length}件）`; m.status = m.voided ? `取消済 ${m.voided}件を含む` : ''; }
      delete m.nos; delete m.voided;
    }
    slips.splice(0, slips.length, ...merged);
  }
  const dates = [...new Set(slips.map(s => s.date))].map(date => ({ date, total: slips.filter(s => s.date === date).reduce((n, s) => n + s.total, 0) }));
  return { pattern: q.pattern, ...def, from, to, slips, dates, total: slips.reduce((n, s) => n + s.total, 0) };
}

export async function bankPaymentList(c, q) {
  const { from, to } = range(q);
  const ps = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, (SELECT COALESCE(SUM(jl.amount),0) FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id AND jl.account_code='4171' AND jl.side='C' WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL) safety,
      (SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1) from_bank
    FROM payment p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN bank_account b ON b.bank_account_id=COALESCE(p.bank_account_id, v.bank_account_id)
    WHERE p.status='POSTED' AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, from_bank, v.vendor_code, p.payment_id`, [from, to]);
  const banks = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const dir = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BKDIR'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const days = [];
  for (const p of ps) {
    let d = days.find(x => x.date === p.paid_on); if (!d) days.push(d = { date: p.paid_on, rows: [], total: 0 });
    const bank = Number(p.bank_amount), fee = Number(p.fee_amount), offset = Number(p.offset_amount), safety = Number(p.safety);
    d.rows.push({ vendor: p.vendor_code, vendorName: p.vendor_name, no: p.payment_no, date: p.paid_on, billed: bank + fee + offset + safety, offset, safety, fee, vendorTotal: bank,
      method: '銀行振込', fromBankCode: p.from_bank || '', fromBank: p.from_bank ? `${p.from_bank} ${banks[p.from_bank] || ''}` : '', payeeBank: p.bank_code ? `${p.bank_code} ${dir[p.bank_code] || ''}`.trim() : '未登録', payeeBranch: p.branch_code ? `${p.branch_code} ${dir[p.bank_code + '-' + p.branch_code] || ''}`.trim() : '' });
    d.total += bank;
  }
  // 銀行別（支払元口座別）小計
  for (const d of days) { d.banks = [...new Set(d.rows.map(r => r.fromBank))].map(b => ({ bank: b, rows: d.rows.filter(r => r.fromBank === b), total: d.rows.filter(r => r.fromBank === b).reduce((n, r) => n + r.vendorTotal, 0) })); }
  return { ...BANK_LIST, from, to, days, total: days.reduce((n, d) => n + d.total, 0) };
}

// ---------- Excel ----------
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
// 自動仕訳リストの Excel は現行帳票（HAR463 在庫計上・HAR413 入金・HAR363 売掛・HAR152 定時請求・HAR733 小口・CS5785 支払内訳）と同じ2段レイアウト（2026-10-28）。
//   1段目：日付 ／ 借方の部・科目・内訳1・内訳2・処税率・借方金額 ／ 工種CD・摘要1・摘要1（借方）・摘要2（借方）／ 貸方の部・科目・内訳1・内訳2・処税率
//   2段目：伝票No ／ 借方の科目名・内訳1名 ／ 工種CD・摘要1・摘要1（貸方）・摘要2（貸方）／ 貸方の科目名・内訳1名・貸方金額
//   見出しの上下と合計行の上は破線。右端の元伝票・状態は新システムで追加した列。
const JOURNAL_COLS = 18, JOURNAL_WIDTHS = [12, 5, 9, 15, 6, 6, 13, 6, 8, 20, 20, 5, 9, 15, 6, 6, 13, 24];
const yymmdd = d => (d ? `${d.slice(2, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}` : '');
// cells：{列番号: 値}。style を付けると空の列にも同じ書式（破線）を付ける
const jrow = (cells, style) => Array.from({ length: JOURNAL_COLS }, (_, i) => { const v = cells[i] ?? ''; return style ? { v, s: typeof v === 'number' && style === 'dashTop' ? 'dashTopNum' : style } : v; });
export const JOURNAL_HEAD = [
  jrow({ 0: '日付', 1: '部', 2: '科目', 3: '内訳1', 4: '内訳2', 5: '処税率', 6: '借方金額', 7: '工種CD', 8: '摘要1', 9: '摘　要　1　（借　方）', 10: '摘　要　2　（借　方）', 11: '部', 12: '科目', 13: '内訳1', 14: '内訳2', 15: '処税率', 17: '元伝票' }, 'dashTop'),
  jrow({ 0: '伝票No', 1: '科　目　名', 3: '内　訳　1　名', 7: '工種CD', 8: '摘要1', 9: '摘　要　1　（貸　方）', 10: '摘　要　2　（貸　方）', 11: '科　目　名', 13: '内　訳　1　名', 16: '貸方金額', 17: '状態' }, 'dashBottom')];
const pairRows = (p, first, s) => {
  const dr = p.dr || {}, cr = p.cr || {}, amt = x => (x.account ? x.amount : '');
  return [jrow({ 0: first ? yymmdd(s.date) : '', 1: dr.dept, 2: dr.account, 3: dr.sub, 4: dr.sub2, 5: dr.tax, 6: amt(dr), 8: dr.memo1Code, 9: dr.memo1, 10: dr.memo2, 11: cr.dept, 12: cr.account, 13: cr.sub, 14: cr.sub2, 15: cr.tax, 17: first ? s.sourceNo : '' }),
    jrow({ 0: first ? s.slipNo : '', 1: dr.accountName, 3: dr.subName, 8: cr.memo1Code, 9: cr.memo1, 10: cr.memo2, 11: cr.accountName, 13: cr.subName, 16: amt(cr), 17: first ? s.status : '' })];
};
const totalRow = (label, amount) => jrow({ 9: label, 6: amount, 16: amount }, 'dashTop');
export async function journalListBook(c, q) {
  const d = await journalList(c, q), now = new Date(Date.now() + 9 * 36e5).toISOString();
  const out = [jrow({ 0: `出力 ${yymmdd(now.slice(0, 10))} ${now.slice(11, 19)}`, 7: T(d.title) }), [`期間 ${d.from} 〜 ${d.to}`], [], ...JOURNAL_HEAD];
  let lastDate = null;
  for (const s of d.slips) {
    if (lastDate && s.date !== lastDate) out.push(totalRow('日　付　合　計', d.dates.find(x => x.date === lastDate).total));
    lastDate = s.date;
    s.pairs.forEach((p, i) => out.push(...pairRows(p, !i, s)));
    out.push(totalRow('伝　票　合　計', s.total));
  }
  if (lastDate) out.push(totalRow('日　付　合　計', d.dates.find(x => x.date === lastDate).total));
  out.push(totalRow('総　合　計', d.total));
  if (!d.slips.length) out.push(['対象期間の仕訳はありません']);
  return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title.slice(0, 28), rows: out, widths: JOURNAL_WIDTHS, printTitles: '4:5', header: `&L${d.title}&R&P 頁` }]) };
}
export async function bankPaymentBook(c, q) {
  const d = await bankPaymentList(c, q);
  const out = [[T(d.title)], [`期間 ${d.from} 〜 ${d.to}　出力日 ${today()}`], []];
  const head = ['業者CD', '業者名', '伝票No', '日付', '請求金額', '相殺金額', '安全協力費', '手数料', '業者計', '支払方法', '支払元口座', '振込先銀行', '支店'].map(H);
  for (const day of d.days) {
    const [y, m, dd] = day.date.split('-');
    out.push([H(`${y.slice(2)}年${Number(m)}月${Number(dd)}日支払`)], head);
    for (const g of day.banks) { for (const r of g.rows) out.push([r.vendor, r.vendorName, r.no, r.date, r.billed, r.offset, r.safety, r.fee, r.vendorTotal, r.method, r.fromBank, r.payeeBank, r.payeeBranch]); out.push(['', S(`銀行計 ${g.bank}`), '', '', '', '', '', '', S(g.total)]); }
    out.push(['', S('支払日計'), '', '', S(day.rows.reduce((n, r) => n + r.billed, 0)), S(day.rows.reduce((n, r) => n + r.offset, 0)), S(0), S(day.rows.reduce((n, r) => n + r.fee, 0)), S(day.total)], []);
  }
  out.push(['', S('総合計'), '', '', '', '', '', '', S(d.total)]);
  if (!d.days.length) out.push(['対象期間の支払はありません']);
  return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title, rows: out, widths: [10, 26, 12, 11, 13, 11, 11, 10, 13, 10, 20, 10, 8] }]) };
}
