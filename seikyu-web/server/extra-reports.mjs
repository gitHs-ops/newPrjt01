// 残りの帳票（資料未着のため推定仕様）: NO30 定時請求入力明細表（組織別）, NO33 小口現金出納簿, NO40 商品売上登録リスト, NO44 入金予定チェックリスト
import { check, isoDate, isoMonth, toNum, fromNum, today, METHODS } from './domain.mjs';
import { rows, one } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { decode as taxDecode, TAX_RATE } from './taxcode.mjs';
import { allocate, members as jvMembersChecked } from './misc-reports.mjs';
import { companyPeriod } from './period.mjs';
import { customerSite, siteDue, slipNoOf, priceOf } from './sales.mjs';

const num = v => Number(v || 0);
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const range = q => { const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です'); return { from, to }; };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

// ---------- NO30 定時請求入力明細表（組織別）：現行 HAR136 の並び（部門→業者→請求明細） ----------
export async function payableInputList(c, q) {
  const month = isoMonth(q.month, '月度'), d = Number(q.closing || 20), prev = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  const from = d >= 31 ? month + '-01' : `${prev}-${String(d + 1).padStart(2, '0')}`, to = d >= 31 ? monthEnd(month) : `${month}-${String(d).padStart(2, '0')}`;
  const deptNames = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='DEPT'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  // 10/19 打合せ：出力指示は 締切日・部門コード・区分（ブランク＝工事、1＝組織）・業者コード
  // 10/21 打合せ：業者コードはブランクなら出力しない。From〜To で範囲指定、下段（To）に 9999999 で全業者（From 未入力なら先頭から）
  const kb = String(q.kb ?? '1') === '1' ? '1' : '', dept = String(q.dept || '').trim();
  // 業者コードは英字を大文字に揃えて比較（v001＝V001）
  const up = v => String(v ?? '').trim().toUpperCase();
  const vFrom = up(q.vendorFrom ?? q.vendor), vTo0 = up(q.vendorTo ?? q.vendor), vTo = vTo0 || vFrom, toAll = /^9{7,}$/.test(vTo);
  const none = !vFrom && !vTo0;
  const cmp = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b));
  check(!vFrom || toAll || cmp(vFrom, vTo) <= 0, `業者コードの範囲が不正です（From ${vFrom} ＞ To ${vTo}）`);
  const inRange = code => !none && (!vFrom || cmp(up(code), vFrom) >= 0) && (toAll || cmp(up(code), vTo) <= 0);
  const all = !vFrom && toAll;
  const fetch = async (from, to) => (await rows(c, `SELECT d.document_no, d.bill_no, d.booked_on, d.due_on, d.memo, l.gross_amount, l.tax_amount, l.memo line_memo, l.memo_code, l.department_code, l.account_code, l.sub_code, l.source_tax_code, a.account_name, s.sub_name, v.vendor_code, v.vendor_name,
      (SELECT COALESCE(SUM(pa.amount),0) FROM payment_allocation pa JOIN payment p ON p.payment_id=pa.payment_id AND p.status='POSTED' WHERE pa.expense_id=d.expense_id) paid
    FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code
    LEFT JOIN vendor v ON v.vendor_id=d.vendor_id WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ?${dept ? ' AND l.department_code=?' : ''} ORDER BY ${kb ? 'l.department_code' : 'l.memo_code'}, v.vendor_code, d.bill_no, d.document_no, l.line_no`, dept ? [from, to, dept] : [from, to]))
    .filter(r => inRange(r.vendor_code));
  const ls = await fetch(from, to);
  // 支払条件（現行 HAR136 の業者合計の上の行「（ 翌月 15 日払 ）」）：業者マスタの支払繰延区分（code_m VPAY）。繰延最低限度額以上は翌々月末。未設定は翌月末
  const vcodes = [...new Set(ls.map(r => r.vendor_code))];
  const vpay = vcodes.length ? Object.fromEntries((await rows(c, `SELECT code_dtl, category1 m, category2 d, code_dtl_nam mn FROM code_m WHERE code_key='VPAY' AND code_dtl IN (${vcodes.map(() => '?').join(',')})`, vcodes)).map(r => [r.code_dtl, r])) : {};
  const monthWord = m => ({ 0: '当月', 1: '翌月', 2: '翌々月' }[m] ?? `${m}か月後`);
  const termOf = (code, total) => { const p = vpay[code], min = Number(p?.mn || 0); if (min && total >= min) return '翌々月 31 日払'; const m = p?.m !== undefined && p?.m !== null && p?.m !== '' ? Number(p.m) : 1, d = Number(p?.d || 31); return `${monthWord(m)} ${d} 日払`; };
  const depts = [];
  for (const r of ls) {
    // 区分 1＝組織：部門ごと／ブランク＝工事：摘要コード（工事コード7桁）ごと
    const key = kb ? r.department_code : r.memo_code || '', label = kb ? deptNames[r.department_code] || '' : key ? '' : '工事コードなし';
    let dp = depts.find(x => x.dept === key); if (!dp) depts.push(dp = { dept: key, name: label, vendors: [], total: 0 });
    let v = dp.vendors.find(x => x.vendor === r.vendor_code); if (!v) dp.vendors.push(v = { vendor: r.vendor_code, name: r.vendor_name, rows: [], total: 0, tax: 0, offset: 0 });
    const amount = num(r.gross_amount), tax = num(r.tax_amount);
    v.rows.push({ no: r.bill_no || '', docNo: r.document_no, date: r.booked_on, due: r.due_on || '', account: r.account_code, sub: r.sub_code || '', accountName: r.account_name, subName: r.sub_name || '', orderRemain: 0, amount, offset: 0, memoCode: r.memo_code || '', memo: r.line_memo || r.memo, tax: r.source_tax_code, paid: num(r.paid) });
    v.total += amount; v.tax += tax; dp.total += amount; dp.tax = (dp.tax || 0) + tax;
  }
  // 現行 HAR136 の部門（工事）の末尾：工事合計（内消費税）、当月支払額（税抜）・当月出来高・支払率、累計支払額（期首〜締切日の税抜）・累計出来高・支払率。出来高のデータはないため 0
  const P = await companyPeriod(c), cum = await fetch(P.fyRange(P.fyOf(to)).from, to);
  for (const dp of depts) {
    dp.offset = 0;
    for (const v of dp.vendors) v.term = termOf(v.vendor, v.total);
    const mine = cum.filter(r => (kb ? r.department_code : r.memo_code || '') === dp.dept);
    dp.paid = dp.total - dp.tax; dp.cumPaid = mine.reduce((n, r) => n + num(r.gross_amount) - num(r.tax_amount), 0); dp.done = 0; dp.cumDone = 0;
  }
  const vendorLabel = none ? '未入力（出力しない）' : all ? '全業者（9999999）' : vFrom === vTo ? vFrom : `${vFrom || '（最初）'} 〜 ${vTo}`;
  return { title: `定時請求データ入力明細表（${kb ? '組織' : '工事'}別）`, ref: 'NO30 / 添付帳票⑩（HAR136）', month, from, to, depts, total: depts.reduce((n, x) => n + x.total, 0),
    kb, groupLabel: kb ? '部門' : '工事', dept: dept ? `${dept} ${deptNames[dept] || ''}`.trim() : '全部門', vendor: vendorLabel,
    note: '月度は20日締め（現行と同じ）。区分 1＝組織（部門別）、ブランク＝工事（摘要コード＝工事コード別）。業者コードはブランクなら出力しない・From〜To で範囲・To に 9999999 で全業者（10/21）。請求No は業者ごとの4桁連番。発注残金額は発注管理が対象外のため0、相殺金額は定時請求時点では0（支払時に相殺）。現比は振込のみのため削除（10/19）。' };
}
// ---------- NO33 小口現金出納簿（定額資金前渡制を仮定） ----------
export async function pettyCashBook(c, q) {
  const { from, to } = range(q);
  const set = await one(c, "SELECT code_dtl_abr v FROM code_m WHERE code_key='SET' AND code_dtl='PETTYFUND'"), fund = num(set?.v || 100000);
  const sumBefore = async (sql) => num(Object.values(await one(c, sql, [from]))[0]);
  const refBefore = await sumBefore("SELECT COALESCE(SUM(l.amount),0) FROM journal_entry e JOIN journal_line l ON l.journal_id=e.journal_id AND l.account_code='1111' AND l.side='D' WHERE e.source_type='petty_refill' AND e.reversal_of IS NULL AND e.status='POSTED' AND e.journal_date<?");
  const payBefore = await sumBefore("SELECT COALESCE(SUM(gross_amount),0) FROM expense_document WHERE expense_kind='PETTY_CASH' AND status='POSTED' AND booked_on<?");
  const opening = fund + refBefore - payBefore;
  const refills = (await rows(c, "SELECT e.journal_date d, l.amount v FROM journal_entry e JOIN journal_line l ON l.journal_id=e.journal_id AND l.account_code='1111' AND l.side='D' WHERE e.source_type='petty_refill' AND e.reversal_of IS NULL AND e.status='POSTED' AND e.journal_date BETWEEN ? AND ?", [from, to])).map(r => ({ date: r.d, amount: num(r.v) }));
  // 明細の行ごとに1行（2026-10-29：1支払日＝1伝票・行ごとに支払先。以前は1行目の科目で伝票合計を出していた）。支払先＝行の業者／行の支払先、旧データは伝票の業者・支払先
  const ls = await rows(c, `SELECT d.document_no, d.booked_on, d.memo, d.payee, l.gross_amount, l.line_no, l.account_code, l.sub_code, l.source_tax_code, l.memo line_memo, l.payee line_payee, a.account_name, v.vendor_name, lv.vendor_name line_vendor_name FROM expense_document d JOIN expense_line l ON l.expense_id=d.expense_id
    LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN vendor v ON v.vendor_id=d.vendor_id LEFT JOIN vendor lv ON lv.vendor_id=l.vendor_id WHERE d.expense_kind='PETTY_CASH' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? ORDER BY d.booked_on, d.document_no, l.line_no`, [from, to]);
  // 出資比率は期間の終了日の月度で有効なもの（2026-11-02 適用開始月度の履歴）
  // 現行 HJR051 は構成員の列が常に出る。構成員の登録なし・合計が100%でないときは列を黙って消さず、⑫⑬と同じくエラーで理由を返す（2026-11-04）
  const ms = await jvMembersChecked(c, (await companyPeriod(c)).labelOf(to));
  const events = [...refills.map(r => ({ ...r, kind: 'in' })), ...ls.map(r => ({ kind: 'out', date: r.booked_on, r }))].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'in' ? -1 : 1));
  let balance = opening; const out = [];
  for (const e of events) {
    if (e.kind === 'in') { balance += e.amount; out.push({ date: e.date, no: '', payee: '', memo: '現金補充（受入）', account: '1111', sub: '', accountName: '現金', tax: '', received: e.amount, amount: 0, balance, parts: null }); continue; }
    const r = e.r, amount = num(r.gross_amount); balance -= amount;
    const payee = r.line_vendor_name || r.line_payee || r.vendor_name || (r.payee ?? (r.line_memo && r.line_memo !== r.memo ? r.line_memo : ''));
    const t = taxDecode(r.source_tax_code); // 税率は現行 HJR051 と同じ「10%」「0%」（非課税・対象外は 0%）
    out.push({ date: r.booked_on, no: r.document_no, payee, memo: r.line_memo || r.memo, account: r.account_code, sub: r.sub_code || '', accountName: r.account_name, tax: r.source_tax_code, rate: `${t?.taxable ? t.rate : 0}%`, received: 0, amount, balance, parts: ms ? allocate(amount, ms) : null });
  }
  const spent = out.reduce((n, r) => n + r.amount, 0), received = out.reduce((n, r) => n + r.received, 0);
  return { title: '小口現金出納簿', ref: 'NO33 / 添付帳票⑪（HAR051）', from, to, fund, opening, members: ms, rows: out, received, spent, closing: opening + received - spent, replenish: Math.max(0, fund - (opening + received - spent)),
    note: '前期繰越＝定額資金（設定値）＋補充累計−支払累計。現金補充は「小口現金」画面で登録（仕訳 G-03 相当：現金／当座預金）。次期補充額＝定額資金−期末残高（定額資金前渡制・推定）。JV構成員が登録されていれば出資比率で配分。' };
}
// ---------- NO40 商品売上登録リスト：現行 HAR021 の並び（2026-11-04）。得意先は小見出し 1 行、その下に明細。小計・合計なし ----------
//   列：売上日 区分 伝票No 商品名 数量 単位 売上単価 売上金額 処税率 運送区分 運賃 現場（現場CD＋名称1） 現場名2 在庫品コード
//   売上日・区分は前の行と同じなら空白（現行どおり）。売上単価は単価＋運賃（現行と同じく 売上金額＝数量×売上単価）
//   処税率は売上（外税・課税売上）の 3 桁コード「2 1 税率区分」。運送区分は納入区分が引取（category1=2）なら 2 先方、それ以外は 1 現場
//   在庫品コードは商品コードと違うときだけ出す
const SR_KIND = { 1: '売上', 2: '他社', 3: '他社', 4: '他社', 5: '訂正', 9: '値引' };
const RATE_DIGIT = Object.fromEntries(Object.entries(TAX_RATE).map(([k, v]) => [v, k]));
export async function salesRegister(c, q) {
  const { from, to } = range(q);
  const rs = await rows(c, `SELECT s.*, c.customers_name, unit_name(i.unit) unit, sl.unit_price slip_price, sl.freight slip_freight,
      (SELECT COUNT(*) FROM sales_trn x WHERE x.sales_no=s.order_no AND x.order_no<>s.order_no) corrections, (SELECT k.category1 FROM code_m k WHERE k.code_key='A0000' AND k.code_dtl=CAST(s.shipping_kb AS TEXT)) kbn_cat
    FROM sales_trn s LEFT JOIN client_m c ON c.customers_cd=s.customers_cd LEFT JOIN item_m i ON i.item_cd=s.item_cd LEFT JOIN shipment_slip sl ON sl.order_no=s.order_no
    WHERE s.sales_date BETWEEN ? AND ? ORDER BY s.customers_cd, s.sales_date, CASE WHEN s.ship_kb='5' AND COALESCE(s.sales_no, '')<>'' THEN s.sales_no ELSE s.order_no END, s.sales_suffix, s.order_no`, [toNum(from), toNum(to)]);
  const customers = [];
  for (const r of rs) {
    let cu = customers.find(x => x.customer === r.customers_cd); if (!cu) customers.push(cu = { customer: r.customers_cd, name: r.customers_name, rows: [] });
    const prev = cu.rows[cu.rows.length - 1], date = fromNum(r.sales_date), kind = SR_KIND[r.ship_kb] || '', rate = num(r.tax_rate);
    cu.rows.push({ date, kind, showDate: prev?.date !== date, showKind: prev?.date !== date || prev?.kind !== kind, no: slipNoOf(r), item: r.item_cd || '', itemName: r.item_name || '',
      qty: num(r.quantity), unit: r.unit || '', price: num(r.unit_price), net: num(r.money), tax: rate ? `21${RATE_DIGIT[rate] ?? ''}` : '090',
      carry: r.kbn_cat === '2' ? '2 先方' : '1 現場', freight: priceOf(r.unit_price, r.slip_price, r.slip_freight).freight,
      site: [r.field_cd, String(r.field_name1 || '').trim()].filter(Boolean).join(' '), site2: String(r.field_name2 || '').trim(), stock: r.item_zaiko_cd && r.item_zaiko_cd !== r.item_cd ? r.item_zaiko_cd : '' });
  }
  return { title: '商品売上登録リスト', ref: 'NO40 / 添付帳票⑮（HAR021）', from, to, customers };
}
// ---------- NO44 入金予定チェックリスト（得意先別・工事（現場）別） ----------
export async function receiptSchedule(c, q) {
  // 10/14 打合せ：入金予定日の範囲（過去年月〜現在）を指定し、予定日を過ぎても未入金の得意先・残高を表示（overdue=1 で超過分のみ）
  const to = q.to ? isoDate(q.to, '入金予定日（まで）') : '', from = q.from ? isoDate(q.from, '入金予定日（から）') : '', overdueOnly = q.overdue === '1';
  // 残高のある請求が対象（2026-10-23：未発行も含め、発行の有無は行に表示。入金消込と同じ）。
  // 支払期日（claim_processing_period）が無い請求（移行データは 0）は、得意先マスタの回収条件（未設定は締日の翌月末）で入金予定日を計算する
  const sites = new Map(), now = today();
  const all = await rows(c, `SELECT h.*, c.customers_name, (SELECT COALESCE(SUM(a.amount),0) FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.invoice_id=h.invoice_id) paid,
    EXISTS (SELECT 1 FROM invoice_issue i WHERE i.invoice_id=h.invoice_id) issued FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd ORDER BY h.customers_cd, h.closing_date, h.invoice_id`);
  const heads = [];
  for (const h of all) {
    let dueDate = fromNum(h.claim_processing_period), computed = false;
    if (!dueDate) { if (!sites.has(h.customers_cd)) sites.set(h.customers_cd, await customerSite(c, h.customers_cd)); dueDate = siteDue(fromNum(h.closing_date), sites.get(h.customers_cd)); computed = true; }
    if ((from && dueDate < from) || (to && dueDate > to) || (overdueOnly && dueDate >= now)) continue;
    heads.push({ ...h, dueDate, computed });
  }
  heads.sort((a, b) => String(a.customers_cd).localeCompare(String(b.customers_cd)) || a.dueDate.localeCompare(b.dueDate));
  const banks = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const firstBank = (await one(c, "SELECT code_dtl FROM code_m WHERE code_key='BANK' AND category1<>'0' ORDER BY code_dtl LIMIT 1"))?.code_dtl || '';
  const customers = [];
  for (const h of heads) {
    const total = num(h.money) + num(h.consumption_tax), balance = total - num(h.paid); if (balance <= 0) continue;
    let cu = customers.find(x => x.customer === h.customers_cd);
    if (!cu) {
      // 入金方法・入金先は過去の入金実績から推定（手形の実績があれば手形、現金のみなら現金、それ以外は振込）
      const site = await one(c, "SELECT category3 method, code_dtl_abr bank FROM code_m WHERE code_key='CSITE' AND code_dtl=?", [h.customers_cd]);
      const kinds = (await rows(c, "SELECT DISTINCT k.component_kind k FROM receipt r JOIN receipt_component k ON k.receipt_id=r.receipt_id WHERE r.customers_cd=? AND r.status='POSTED'", [h.customers_cd])).map(r => r.k);
      const bank = (await one(c, "SELECT jl.sub_code b FROM receipt r JOIN journal_entry je ON je.source_type='receipt' AND je.source_id=CAST(r.receipt_id AS CHAR) AND je.reversal_of IS NULL JOIN journal_line jl ON jl.journal_id=je.journal_id AND jl.account_code='1112' WHERE r.customers_cd=? ORDER BY r.receipt_date DESC LIMIT 1", [h.customers_cd]))?.b || firstBank;
      const methodName = { 1: '振込', 2: '手形', 4: '現金' }[site?.method] || (kinds.includes('NOTE') ? '手形' : kinds.length && kinds.every(k => k === 'CASH') ? '現金' : '振込');
      const bk = site?.bank || bank;
      customers.push(cu = { customer: h.customers_cd, name: h.customers_name, method: methodName, methodSource: site?.method ? '得意先マスタ' : '入金実績から推定', bank: bk ? `${bk} ${banks[bk] || ''}` : '', rows: [], billed: 0, due: 0 });
    }
    // 現場別の内訳（billing_detail）。移行データは明細の claim_processing_period が締日と異なる（例 締日 3/20・明細 3/28）ため、
    // 締日で見つからなければ請求年月＋現場で探し、それでも無ければ請求1件を1行（請求の現場）で出す（得意先見出しだけ出て行が空になるのを防ぐ）
    const field = h.field_cd ? ' AND field_cd=? AND field_suffix=?' : '', fargs = h.field_cd ? [h.field_cd, h.field_suffix] : [];
    const partsOf = (cond, args) => rows(c, `SELECT field_cd, field_suffix, MAX(field_name) name, SUM(money) net FROM billing_detail WHERE customers_cd=? AND closing_yymm=?${cond}${field} GROUP BY field_cd, field_suffix ORDER BY field_cd, field_suffix`, [h.customers_cd, h.closing_yymm, ...args, ...fargs]);
    let parts = await partsOf(' AND claim_processing_period=?', [h.closing_date]);
    if (!parts.length) parts = await partsOf('', []);
    if (!parts.length) parts = [{ field_cd: h.field_cd || '', field_suffix: h.field_suffix || '', name: '', net: 1 }];
    const net = parts.reduce((n, s) => n + num(s.net), 0) || 1; let left = balance;
    for (const [i, s] of parts.entries()) {
      const billed = Math.round(total * num(s.net) / net), due = i === parts.length - 1 ? left : Math.round(balance * num(s.net) / net); left -= due;
      const fm = s.field_cd ? await one(c, 'SELECT field_name1, field_name2 FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [h.customers_cd, s.field_cd, s.field_suffix]) : null; // 工事略名＝現場マスタ（現行 HAR381）
      cu.rows.push({ siteNo: s.field_cd ? `${s.field_cd}-${s.field_suffix}` : '', siteShort: fm ? [fm.field_name1, fm.field_name2].map(v => String(v || '').trim()).filter(Boolean).join(' ') : '', site: `${s.field_cd}-${s.field_suffix}`, siteName: s.name, closing: fromNum(h.closing_date), invoiceId: h.invoice_id, issued: !!h.issued, billed, dueDate: h.dueDate, computed: h.computed, due, overdue: h.dueDate < now });
      cu.billed += billed; cu.due += due;
    }
  }
  return { title: overdueOnly ? '入金予定チェックリスト（予定日超過・未入金）' : '入金予定チェックリスト', ref: 'NO44 / 添付帳票⑳', from, to, sub: `入金予定日 ${from || '（最初）'} 〜 ${to || '（最後）'}${overdueOnly ? '・超過分のみ' : ''}`, overdue: customers.reduce((n, x) => n + x.rows.filter(r => r.overdue).reduce((m, r) => m + r.due, 0), 0), customers, total: customers.reduce((n, x) => n + x.due, 0),
    note: '対象は残高のある請求（未発行を含む。発行欄に表示）。入金予定日は請求の支払期日（得意先マスタの回収条件、未設定は締日の翌月末）。支払期日を持たない移行データは同じ規則で計算（※印）。入金予定額は請求残高を現場別売上比で按分。入金方法・入金先は得意先マスタ、未設定なら過去の入金実績から推定。' };
}

// ---------- Excel ----------
const head = (d, sub) => [[T(d.title)], [`${sub}　出力日 ${today()}`], []];
export async function extraBook(c, kind, q) {
  if (kind === 'payable-input') {
    // 現行 HAR136 の並び（2026-11-04）：見出し 2 段（業者CD 業者名／請求No 科目 内訳 科目名 内訳名 発注残金額 請求金額 相殺金額 摘要 処税率 相殺（支払）業者）
    // 業者の行 → 明細 → 請求金額の計と支払条件 → 業者合計・（内消費税）。部門（工事）の末尾に 工事合計・（内消費税）と 当月／累計の支払額・出来高・支払率
    const d = await payableInputList(c, q), out = head(d, `${d.month} 月度　区分 ${d.kb ? '1 組織' : 'ブランク 工事'}　業者 ${d.vendor}`), pct = (a, b) => `${b ? (Math.floor(a / b * 10000) / 100).toFixed(2) : '0.00'} %`;
    for (const dp of d.depts) {
      out.push([H(`${d.groupLabel} : ${dp.dept} ${dp.name}`)], ['業者CD', '業者名'].map(H), ['', '請求No.', '科目', '内訳', '科目名', '内訳名', '発注残金額', '請求金額', '相殺金額', '摘要', '処税率', '相殺（支払）業者'].map(H));
      for (const v of dp.vendors) {
        out.push([v.vendor, v.name]);
        for (const r of v.rows) out.push(['', r.no, r.account, r.sub, r.accountName, r.subName, r.orderRemain, r.amount, r.offset, r.memo, r.tax, '']);
        out.push(['', '', '', '', '', '', '', v.total, '', `（ ${v.term} ）`], ['', '', '', '', '', S('業者合計'), '', S(v.total), S(v.offset), S(v.total - v.offset)], ['', '', '', '', '', '（内消費税', '', v.tax, 0, `${v.tax.toLocaleString('ja-JP')} ）`], []);
      }
      out.push(['', '', '', '', '', S('工事合計'), '', S(dp.total), S(dp.offset), S(dp.total - dp.offset)], ['', '', '', '', '', '（内消費税', '', dp.tax, 0, `${dp.tax.toLocaleString('ja-JP')} ）`], []);
      out.push(['', '', '', '', '', '', '', '', '', H('当月支払額'), H('当月出来高'), H('支払率')], ['', '', '', '', '', '', '', '', '', dp.paid, dp.done, pct(dp.paid, dp.done)]);
      out.push(['', '', '', '', '', '', '', '', '', H('累計支払額'), H('累計出来高'), H('支払率')], ['', '', '', '', '', '', '', '', '', dp.cumPaid, dp.cumDone, pct(dp.cumPaid, dp.cumDone)], []);
    }
    return { name: `定時請求入力明細表_${d.month}.xlsx`, body: xlsx([{ name: '定時請求入力明細表', rows: out, widths: [9, 30, 7, 6, 16, 16, 11, 13, 11, 26, 9, 14] }]) };
  }
  if (kind === 'petty-book') {
    // 構成員の列は現行 HJR051 と同じく名称だけ。列幅は名称が切れないよう全角2・半角1で計算（2026-10-29）
    const d = await pettyCashBook(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`), mh = d.members ? d.members.map(m => m.name) : [];
    const mw = mh.map(n => Math.max(12, [...n].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0) + 2));
    // 現行 HJR051 と同じ並び・表示（2026-10-29）：支払日・支払先・摘要・科目コード（科目 内訳）・科目名・税率（%）・支払額・構成員別。伝票No・受入・残高の列、前期繰越・現金補充の行は出さない
    out.push(['支払日', '支払先', '摘要', '科目コード', '科目名', '税率', '支払額', ...mh].map(H));
    const pay = d.rows.filter(r => r.amount), sumParts = rs => mh.map((_, k) => rs.reduce((n, r) => n + (r.parts?.[k] || 0), 0));
    for (const r of pay) out.push([r.date, r.payee, r.memo, `${r.account}${r.sub ? ' ' + r.sub : ''}`, r.accountName, r.rate, r.amount, ...(r.parts || [])]);
    // 現行 HJR051 の末尾：＊計＊（支払額・構成員別の合計）→ 税率別の小計（税率の高い順。構成員別は各行の配分の合計）
    out.push(['', '', S('＊ 計 ＊'), '', '', '', S(d.spent), ...sumParts(pay).map(S)]);
    for (const rate of [...new Set(pay.map(r => r.rate))].sort((x, y) => parseFloat(y) - parseFloat(x))) {
      const rs = pay.filter(r => r.rate === rate); out.push(['', '', '', '', '', rate, rs.reduce((n, r) => n + r.amount, 0), ...sumParts(rs)]);
    }
    return { name: `小口現金出納簿_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '小口現金出納簿', rows: out, widths: [11, 22, 26, 12, 16, 7, 12, ...mw] }]) };
  }
  if (kind === 'sales-register') {
    const d = await salesRegister(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['売上日', '区分', '伝票No', '商品名', '', '数量', '', '売上単価', '売上金額', '処税率', '運送区分', '運賃', '現場', '', '在庫品コード'].map(H));
    for (const cu of d.customers) { out.push([H(`${cu.customer} ${cu.name || ''}`)]); for (const r of cu.rows) out.push([r.showDate ? r.date : '', r.showKind ? r.kind : '', r.no, r.item, r.itemName, r.qty, r.unit, r.price, r.net, r.tax, r.carry, r.freight, r.site, r.site2, r.stock]); }
    return { name: `商品売上登録リスト_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '商品売上登録リスト', rows: out, widths: [11, 6, 13, 7, 22, 9, 4, 10, 12, 7, 9, 7, 30, 24, 11] }]) };
  }
  if (kind === 'receipt-schedule') {
    const d = await receiptSchedule(c, q), out = head(d, d.sub);
    // 現行 HAR381 の並び（2026-11-04）：得意先名（コード＋名称）工事No. 工事略名 請求金額 請求日 入金予定日 入金予定額 現金予定額 手形予定額 入金先名。
    // 現金予定額＝振込・現金、手形予定額＝手形。入金先名（現行は入金する別の得意先）は得意先マスタに項目が無いため空欄
    const yy = x => (x ? `${x.slice(2, 4)}/${x.slice(5, 7)}/${x.slice(8, 10)}` : '');
    out.push(['得　意　先　名', '工事No.', '工　事　略　名', '請求金額', '請求日', '入金予定日', '入金予定額', '現金予定額', '手形予定額', '入　金　先　名'].map(H));
    for (const cu of d.customers) for (const r of cu.rows) { const note = cu.method === '手形'; out.push([`${cu.customer} ${cu.name || ''}`, r.siteNo, r.siteShort, r.billed, yy(r.closing), yy(r.dueDate), r.due, note ? '' : r.due, note ? r.due : '', '']); }
    const cash = d.customers.filter(x => x.method !== '手形').reduce((n, x) => n + x.due, 0);
    out.push([], [S('合　計'), '', '', S(d.customers.reduce((n, x) => n + x.billed, 0)), '', '', S(d.total), S(cash), S(d.total - cash), '']);
    return { name: `入金予定チェックリスト_${today()}.xlsx`, body: xlsx([{ name: '入金予定チェックリスト', rows: out, widths: [34, 9, 22, 13, 10, 10, 13, 13, 13, 30] }]) };
  }
  check(false, '帳票の種類が不正です');
}
export const EXTRA = { 'payable-input': payableInputList, 'petty-book': pettyCashBook, 'sales-register': salesRegister, 'receipt-schedule': receiptSchedule };
