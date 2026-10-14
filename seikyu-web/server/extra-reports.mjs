// 残りの帳票（資料未着のため推定仕様）: NO30 定時請求入力明細表（組織別）, NO33 小口現金出納簿, NO40 商品売上登録リスト, NO44 入金予定チェックリスト
import { check, isoDate, isoMonth, toNum, fromNum, today, METHODS } from './domain.mjs';
import { rows, one } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { allocate } from './misc-reports.mjs';

const num = v => Number(v || 0);
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const range = q => { const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です'); return { from, to }; };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

// ---------- NO30 定時請求入力明細表（組織別）：現行 HAR136 の並び（部門→業者→請求明細） ----------
export async function payableInputList(c, q) {
  const month = isoMonth(q.month, '月度');
  const co = await one(c, 'SELECT plant_name FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const ls = await rows(c, `SELECT d.document_no, d.booked_on, d.due_on, d.memo, d.gross_amount, l.department_code, l.account_code, l.sub_code, l.source_tax_code, a.account_name, s.sub_name, v.vendor_code, v.vendor_name,
      (SELECT COALESCE(SUM(pa.amount),0) FROM payment_allocation pa JOIN payment p ON p.payment_id=pa.payment_id AND p.status='POSTED' WHERE pa.expense_id=d.expense_id) paid
    FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code
    LEFT JOIN vendor v ON v.vendor_id=d.vendor_id WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? ORDER BY l.department_code, v.vendor_code, d.document_no, l.line_no`, [month + '-01', monthEnd(month)]);
  const depts = [];
  for (const r of ls) {
    let dp = depts.find(x => x.dept === r.department_code); if (!dp) depts.push(dp = { dept: r.department_code, name: r.department_code === '063' ? co?.plant_name || '' : '', vendors: [], total: 0 });
    let v = dp.vendors.find(x => x.vendor === r.vendor_code); if (!v) dp.vendors.push(v = { vendor: r.vendor_code, name: r.vendor_name, rows: [], total: 0 });
    const amount = num(r.gross_amount);
    v.rows.push({ no: r.document_no, date: r.booked_on, due: r.due_on || '', account: r.account_code, sub: r.sub_code || '', accountName: r.account_name, subName: r.sub_name || '', orderRemain: 0, amount, offset: 0, memo: r.memo, ratio: '100.0%', tax: r.source_tax_code, paid: num(r.paid) });
    v.total += amount; dp.total += amount;
  }
  return { title: '定時請求データ入力明細表（組織別）', ref: 'NO30 / 添付帳票⑩（HAR136）', month, depts, total: depts.reduce((n, x) => n + x.total, 0),
    note: '発注残金額・相殺金額は発注管理・相殺ルール未確定（Q03）のため0。現比（按分比率）は100%。部門名は自社情報の工場名（部門063）を表示。' };
}
// ---------- NO33 小口現金出納簿（定額資金前渡制を仮定） ----------
export async function pettyCashBook(c, q) {
  const { from, to } = range(q), fund = num(q.fund ?? 100000);
  check(Number.isSafeInteger(fund) && fund >= 0, '定額資金が不正です');
  const ls = await rows(c, `SELECT d.document_no, d.booked_on, d.memo, d.gross_amount, l.account_code, l.sub_code, l.source_tax_code, a.account_name, v.vendor_name FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id AND l.line_no=1
    LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN vendor v ON v.vendor_id=d.vendor_id WHERE d.expense_kind='PETTY_CASH' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? ORDER BY d.booked_on, d.document_no`, [from, to]);
  let ms = null; try { ms = (await rows(c, "SELECT code_dtl code, code_dtl_nam name, category1 r, category2 seq FROM code_m WHERE code_key='JV' AND code_dtl_abr<>'0'")).map(m => ({ code: m.code, name: m.name, ratio: num(m.r) / 100, seq: num(m.seq) })).sort((a, b) => a.seq - b.seq); if (Math.round(ms.reduce((n, m) => n + m.ratio * 100, 0)) !== 10000) ms = null; } catch { ms = null; }
  let balance = fund; const out = [];
  for (const r of ls) { const amount = num(r.gross_amount); balance -= amount; out.push({ date: r.booked_on, no: r.document_no, payee: r.vendor_name || '', memo: r.memo, account: r.account_code, sub: r.sub_code || '', accountName: r.account_name, tax: r.source_tax_code, amount, balance, parts: ms ? allocate(amount, ms) : null }); }
  const spent = out.reduce((n, r) => n + r.amount, 0);
  return { title: '小口現金出納簿', ref: 'NO33 / 添付帳票⑪（HAR051）', from, to, fund, members: ms, rows: out, spent, closing: fund - spent, replenish: spent,
    note: '定額資金前渡制を仮定（期首に定額資金を受入、期中の支払後残高、次期補充額＝支払合計）。現金補充の仕訳は手入力扱い（Q11）。JV構成員が登録されていれば出資比率で配分。' };
}
// ---------- NO40 商品売上登録リスト（得意先別・売上日・区分・伝票No） ----------
export async function salesRegister(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.*, c.customers_name, i.unit FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN item_m i ON i.item_cd=s.item_cd
    WHERE s.sales_date BETWEEN ? AND ? ORDER BY s.customers_cd, s.sales_date, s.ship_kb, s.order_no`, [toNum(from), toNum(to)]);
  const customers = [];
  for (const r of rs) {
    let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name, rows: [], net: 0, tax: 0 });
    cu.rows.push({ date: fromNum(r.sales_date), kind: `${r.ship_kb === '2' ? '訂正' : '売上'}・${METHODS[r.payment_method_cd] || ''}`, no: r.order_no, site: [r.field_name1, r.field_name2].filter(Boolean).join(' '), item: `${r.item_cd} ${r.item_name || ''}`, qty: num(r.quantity), unit: r.unit || '', price: num(r.unit_price), net: num(r.money), tax: num(r.consumption_tax), billed: r.process_status === '1' ? '請求済' : r.payment_method_cd == 1 ? '未請求' : '対象外' });
    cu.net += num(r.money); cu.tax += num(r.consumption_tax);
  }
  return { title: '商品売上登録リスト', ref: 'NO40 / 添付帳票⑮', from, to, customers, total: customers.reduce((n, x) => n + x.net, 0), tax: customers.reduce((n, x) => n + x.tax, 0) };
}
// ---------- NO44 入金予定チェックリスト（得意先別・工事（現場）別） ----------
export async function receiptSchedule(c, q) {
  const to = q.to ? isoDate(q.to, '入金予定日（まで）') : '';
  const heads = await rows(c, `SELECT h.*, c.customers_name, (SELECT COALESCE(SUM(a.amount),0) FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.invoice_id=h.invoice_id) paid
    FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd WHERE h.invoice_flag<>'0' ${to ? 'AND h.claim_processing_period<=?' : ''} ORDER BY h.customers_cd, h.claim_processing_period`, to ? [toNum(to)] : []);
  const banks = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const firstBank = (await one(c, "SELECT code_dtl FROM code_m WHERE code_key='BANK' AND category1<>'0' ORDER BY code_dtl LIMIT 1"))?.code_dtl || '';
  const customers = [];
  for (const h of heads) {
    const total = num(h.money) + num(h.consumption_tax), balance = total - num(h.paid); if (balance <= 0) continue;
    let cu = customers.find(x => x.customer === h.customers_cd);
    if (!cu) {
      // 入金方法・入金先は過去の入金実績から推定（手形の実績があれば手形、現金のみなら現金、それ以外は振込）
      const kinds = (await rows(c, "SELECT DISTINCT k.component_kind k FROM receipt r JOIN receipt_component k ON k.receipt_id=r.receipt_id WHERE r.customers_cd=? AND r.status='POSTED'", [h.customers_cd])).map(r => r.k);
      const bank = (await one(c, "SELECT jl.sub_code b FROM receipt r JOIN journal_entry je ON je.source_type='receipt' AND je.source_id=CAST(r.receipt_id AS CHAR) AND je.reversal_of IS NULL JOIN journal_line jl ON jl.journal_id=je.journal_id AND jl.account_code='1112' WHERE r.customers_cd=? ORDER BY r.receipt_date DESC LIMIT 1", [h.customers_cd]))?.b || firstBank;
      customers.push(cu = { customer: h.customers_cd, name: h.customers_name, method: kinds.includes('NOTE') ? '手形' : kinds.length && kinds.every(k => k === 'CASH') ? '現金' : '振込', bank: bank ? `${bank} ${banks[bank] || ''}` : '', rows: [], billed: 0, due: 0 });
    }
    const w = `customers_cd=? AND closing_yymm=? AND claim_processing_period=?${h.field_cd ? ' AND field_cd=? AND field_suffix=?' : ''}`;
    const sites = await rows(c, `SELECT field_cd, field_suffix, MAX(field_name) name, SUM(money) net FROM billing_detail WHERE ${w} GROUP BY field_cd, field_suffix ORDER BY field_cd, field_suffix`, [h.customers_cd, h.closing_yymm, h.closing_date, ...(h.field_cd ? [h.field_cd, h.field_suffix] : [])]);
    const net = sites.reduce((n, s) => n + num(s.net), 0) || 1; let left = balance;
    sites.forEach((s, i) => {
      const billed = Math.round(total * num(s.net) / net), due = i === sites.length - 1 ? left : Math.round(balance * num(s.net) / net); left -= due;
      cu.rows.push({ site: `${s.field_cd}-${s.field_suffix}`, siteName: s.name, closing: fromNum(h.closing_date), invoiceId: h.invoice_id, billed, dueDate: fromNum(h.claim_processing_period), due, overdue: fromNum(h.claim_processing_period) < today() });
      cu.billed += billed; cu.due += due;
    });
  }
  return { title: '入金予定チェックリスト', ref: 'NO44 / 添付帳票⑳', to, customers, total: customers.reduce((n, x) => n + x.due, 0),
    note: '入金予定日は請求の支払期日（締日の翌月末・仮）、入金予定額は請求残高を現場別売上比で按分。入金方法・入金先は過去の入金実績からの推定。' };
}

// ---------- Excel ----------
const head = (d, sub) => [[T(d.title)], [`${d.ref}　${sub}　出力日 ${today()}`], []];
export async function extraBook(c, kind, q) {
  if (kind === 'payable-input') {
    const d = await payableInputList(c, q), out = head(d, `${d.month} 月度`);
    for (const dp of d.depts) {
      out.push([H(`部門 : ${dp.dept} ${dp.name}`)]);
      for (const v of dp.vendors) {
        out.push([H('業者'), H(`${v.vendor} ${v.name}`)], ['請求No', '計上日', '科目', '内訳', '科目名', '内訳名', '発注残金額', '請求金額', '相殺金額', '摘要', '現比', '処税率', '支払済'].map(H));
        for (const r of v.rows) out.push([r.no, r.date, r.account, r.sub, r.accountName, r.subName, r.orderRemain, r.amount, r.offset, r.memo, r.ratio, r.tax, r.paid]);
        out.push(['', '', '', '', S('業者計'), '', '', S(v.total)]);
      }
      out.push(['', '', '', '', S('部門計'), '', '', S(dp.total)], []);
    }
    out.push(['', '', '', '', S('総合計'), '', '', S(d.total)], [d.note]);
    return { name: `定時請求入力明細表_${d.month}.xlsx`, body: xlsx([{ name: '定時請求入力明細表', rows: out, widths: [12, 11, 7, 6, 14, 14, 11, 12, 10, 22, 7, 7, 11] }]) };
  }
  if (kind === 'petty-book') {
    const d = await pettyCashBook(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`), mh = d.members ? d.members.map(m => `${m.name}（${m.ratio}%）`) : [];
    out.push(['支払日', '伝票No', '支払先', '摘要', '科目コード', '科目名', '税率', '受入', '支払額', '残高', ...mh].map(H), [d.from, '', '', '前期繰越（定額資金）', '', '', '', d.fund, '', d.fund]);
    for (const r of d.rows) out.push([r.date, r.no, r.payee, r.memo, `${r.account}${r.sub ? '-' + r.sub : ''}`, r.accountName, r.tax, '', r.amount, r.balance, ...(r.parts || [])]);
    out.push(['', '', '', S('合計'), '', '', '', S(d.fund), S(d.spent), S(d.closing)], ['', '', '', '次期補充額', '', '', '', '', d.replenish], [d.note]);
    return { name: `小口現金出納簿_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '小口現金出納簿', rows: out, widths: [11, 12, 16, 24, 10, 14, 7, 11, 11, 11, 14, 14, 14] }]) };
  }
  if (kind === 'sales-register') {
    const d = await salesRegister(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['得意先CD', '得意先名', '売上日', '区分', '伝票No', '現場', '商品', '数量', '単位', '単価', '金額', '消費税', '請求'].map(H));
    for (const cu of d.customers) { for (const r of cu.rows) out.push([cu.customer, cu.name, r.date, r.kind, r.no, r.site, r.item, r.qty, r.unit, r.price, r.net, r.tax, r.billed]); out.push(['', S(`${cu.name} 計`), '', '', '', '', '', '', '', '', S(cu.net), S(cu.tax)]); }
    out.push(['', S('総合計'), '', '', '', '', '', '', '', '', S(d.total), S(d.tax)]);
    return { name: `商品売上登録リスト_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '商品売上登録リスト', rows: out, widths: [9, 20, 11, 12, 11, 20, 20, 9, 5, 10, 12, 10, 8] }]) };
  }
  if (kind === 'receipt-schedule') {
    const d = await receiptSchedule(c, q), out = head(d, d.to ? `入金予定日 ${d.to} まで` : '全期間');
    out.push(['得意先CD', '得意先名', '工事（現場）', '現場名', '請求締日', '請求No', '請求金額', '入金予定日', '入金予定額', '現金・手形', '入金先'].map(H));
    for (const cu of d.customers) { for (const r of cu.rows) out.push([cu.customer, cu.name, r.site, r.siteName, r.closing, r.invoiceId, r.billed, r.dueDate + (r.overdue ? ' 超過' : ''), r.due, cu.method, cu.bank]); out.push(['', S(`${cu.name} 計`), '', '', '', '', S(cu.billed), '', S(cu.due)]); }
    out.push(['', S('総合計'), '', '', '', '', '', '', S(d.total)], [d.note]);
    return { name: `入金予定チェックリスト_${today()}.xlsx`, body: xlsx([{ name: '入金予定チェックリスト', rows: out, widths: [9, 20, 12, 22, 11, 8, 12, 14, 12, 9, 20] }]) };
  }
  check(false, '帳票の種類が不正です');
}
export const EXTRA = { 'payable-input': payableInputList, 'petty-book': pettyCashBook, 'sales-register': salesRegister, 'receipt-schedule': receiptSchedule };
