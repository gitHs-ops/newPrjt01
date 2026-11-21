// 残りの帳票（資料未着のため推定仕様）: NO30 定時請求入力明細表（組織別）, NO33 小口現金出納簿, NO40 商品売上登録リスト, NO44 入金予定チェックリスト
import { check, isoDate, isoMonth, toNum, fromNum, today, METHODS, closingPeriodOfDate } from './domain.mjs';
import { rows, one } from './db.mjs';
import { xlsx, band } from './xlsx.mjs';
import { decode as taxDecode, digitOfRate } from './taxcode.mjs';
import { allocate, members as jvMembersChecked } from './misc-reports.mjs';
import { companyPeriod } from './period.mjs';
import { customerSite, siteDue, slipNoOf, priceOf } from './sales.mjs';

const num = v => Number(v || 0);
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const range = q => { const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です'); return { from, to }; };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

// ---------- NO30 定時請求入力明細表（組織別）：現行 HAR136 の並び（部門→業者→請求明細） ----------
export async function payableInputList(c, q) {
  // 検索条件は締切日（定時請求データ入力の入力項目と同じ。2026-11-20 ユーザー指示）：前月の同じ締日の翌日〜締切日。month＋closing（旧）も受ける
  const cdate = q.date ? isoDate(q.date, '締切日') : null;
  const month = cdate ? cdate.slice(0, 7) : isoMonth(q.month, '月度'), d = Number(q.closing || 20), prev = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  const { from, to } = cdate ? closingPeriodOfDate(cdate) : { from: d >= 31 ? month + '-01' : `${prev}-${String(d + 1).padStart(2, '0')}`, to: d >= 31 ? monthEnd(month) : `${month}-${String(d).padStart(2, '0')}` };
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
  const fetch = async (from, to) => (await rows(c, `SELECT d.document_no, d.bill_no, d.booked_on, d.due_on, d.memo, l.gross_amount, l.tax_amount, l.memo line_memo, l.memo_code, l.department_code, l.account_code, l.sub_code, l.source_tax_code, a.account_name, s.sub_name, v.vendor_code, v.vendor_name, v.pref, v.addr1, v.addr2,
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
    let v = dp.vendors.find(x => x.vendor === r.vendor_code); if (!v) dp.vendors.push(v = { vendor: r.vendor_code, name: r.vendor_name, address: `${r.pref || ''}${r.addr1 || ''}${r.addr2 || ''}` /* 住所1・住所2 を続けて 1 つに（2026-11-20 ユーザー指示） */, docs: [], rows: [], total: 0, tax: 0 });
    const amount = num(r.gross_amount), tax = num(r.tax_amount);
    v.rows.push({ no: r.bill_no || '', docNo: r.document_no, date: r.booked_on, due: r.due_on || '', account: r.account_code, sub: r.sub_code || '', accountName: r.account_name, subName: r.sub_name || '', orderRemain: 0, amount, offset: 0, memoCode: r.memo_code || '', memo: r.line_memo || r.memo, tax: r.source_tax_code, paid: num(r.paid) });
    // 現行 HAR136：伝票（定時請求 1 件）ごとに 請求金額の計と支払条件の行（2026-11-20 ユーザー指示）
    let doc = v.docs.find(x => x.docNo === r.document_no); if (!doc) v.docs.push(doc = { docNo: r.document_no, rows: [], total: 0, tax: 0 });
    doc.rows.push(v.rows[v.rows.length - 1]); doc.total += amount; doc.tax += tax;
    v.total += amount; v.tax += tax; dp.total += amount; dp.tax = (dp.tax || 0) + tax;
  }
  // 支払条件は定時請求 1 件（伝票）の合計で判定（繰延最低限度額は 1 件の合計）。当月／累計の支払額・出来高・支払率は出さない（2026-11-20 ユーザー指示）
  for (const dp of depts) for (const v of dp.vendors) for (const x of v.docs) x.term = termOf(v.vendor, x.total);
  const vendorLabel = none ? '未入力（出力しない）' : all ? '全業者（9999999）' : vFrom === vTo ? vFrom : `${vFrom || '（最初）'} 〜 ${vTo}`;
  return { title: '定時請求データ入力明細表' /* 現行の帳票名どおり（組織別／工事別）は付けない。部門は表題の下に（2026-11-20 ユーザー指示） */, ref: 'NO30 / 添付帳票⑩（HAR136）', month, date: cdate, from, to, depts, total: depts.reduce((n, x) => n + x.total, 0), tax: depts.reduce((n, x) => n + (x.tax || 0), 0),
    kb, allVendors: !!all, groupLabel: kb ? '部門' : '工事', dept: dept ? `${dept} ${deptNames[dept] || ''}`.trim() : '全部門', vendor: vendorLabel,
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
      qty: num(r.quantity), unit: r.unit || '', price: num(r.unit_price), net: num(r.money), tax: rate ? `21${digitOfRate(rate) ?? ''}` : '090',
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
// 相殺（支払）業者の列は出さない（2026-11-20 ユーザー指示）
const PAYIN_W = [12, 11, 7, 24, 15.5, 16, 24, 12] /* 伝票No・科目・内訳・科目名・内訳名・請求金額・摘要・処税率（2026-11-21 様式） */, SALES_REG_W = [11, 6, 13, 7, 22, 9, 4, 10, 12, 7, 9, 7, 30, 24, 11];
export async function extraBook(c, kind, q) {
  if (kind === 'payable-input') {
    // 2026-11-21 ユーザー指示（定時請求入力明細表_2026-11-20 (4).xlsx の様式）：業者・業者名の列は出さず、伝票No を先頭の列に。
    // 部門の行 → 業者ごとに「業者 : コード　名称　住所」の行（幅いっぱい）→ 見出し 1 段 → 伝票ごとに 明細・請求金額の計・支払条件 → 業者計・（内消費税）
    // 部門（工事）が 1 つだけなら、部門の行を出さず表の上（抽出条件の行）に「部門 : コード 名称」を出す（2026-11-21 ユーザー指示）
    const d = await payableInputList(c, q), one1 = d.depts.length === 1 ? d.depts[0] : null;
    const out = head(d, `${one1 ? `${d.groupLabel} : ${`${one1.dept} ${one1.name || ""}`.trim()}　` : d.dept === '全部門' ? '' : '部門 ' + d.dept + '　'}${d.date ? `締切日 ${d.date}` : `${d.month} 月度`}　区分 ${d.kb ? '組織' : '工事'}${d.allVendors ? '' : '　業者 ' + d.vendor}`);   // 出力日は右上（2026-11-21 ユーザー指示）。全業者（9999999）・全部門は表示しない、区分は 組織／工事 だけ（2026-11-20 ユーザー指示）
    const W = PAYIN_W.length, last = String.fromCharCode(64 + W);
    // （内消費税）は請求金額の列に 1 セルで（下は実線。業者・部門の区切り）
    const taxEnd = t => Array.from(PAYIN_W, (_, j) => ({ v: j === 5 ? `（内消費税 ${Number(t || 0).toLocaleString('ja-JP')}）` : '', s: 'jEnd' }));
    const sumRow = (label, n) => ['', '', '', '', S(label), S(n)];
    const merges = [];
    for (const dp of d.depts) {
      if (!one1) out.push(Object.assign(band(PAYIN_W, [` ${d.groupLabel} : ${dp.dept} ${dp.name}`]), { span: W, start: 0, max: W }));   // 部門の行は表の幅いっぱい（2026-11-19）
      for (const v of dp.vendors) {
        // 業者の行（業者マスタの内容：業者・業者名・住所1＋住所2）は表の幅いっぱいを 1 セルに結合（薄い黄）
        out.push(Array.from(PAYIN_W, (_, j) => ({ v: j ? '' : ` 業者 : ${`${v.vendor}　${v.name}　${v.address}`.trim()}`, s: 'vendorRow' }))); merges.push(`A${out.length}:${last}${out.length}`);
        out.push(['伝票No', '科目', '内訳', '科目名', '内訳名', '請求金額', '摘要', '処税率'].map(H));
        for (const x of v.docs) {
          for (const r of x.rows) out.push([{ v: r.docNo, s: 'center' }, r.account, r.sub, r.accountName, r.subName, r.amount, r.memo, { v: r.tax, s: 'center' }]);   // 伝票No・処税率は中央（様式どおり）
          out.push(['', '', '', '', '', x.total, `（ ${x.term} ）`, '']);
        }
        out.push(sumRow('業者計', v.total), taxEnd(v.tax), []);
      }
      if (!one1) out.push(sumRow(`${d.groupLabel}計`, dp.total), taxEnd(dp.tax), []);   // 部門が 1 つなら部門計は総合計と同じため出さない（2026-11-21 ユーザー指示）
    }
    if (d.depts.length) out.push(sumRow('総　合　計', d.total), taxEnd(d.tax));
    return { name: `定時請求入力明細表_${d.date || d.month}.xlsx`, body: xlsx([{ name: '定時請求入力明細表', rows: out, widths: PAYIN_W, merges }]) };
  }
  if (kind === 'petty-book') {
    // 構成員の列は現行 HJR051 と同じく名称だけ。列幅は名称が切れないよう全角2・半角1で計算（2026-10-29）
    const d = await pettyCashBook(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`), mh = d.members ? d.members.map(m => m.name) : [];
    const mw = mh.map(n => Math.max(12, [...n].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0) + 2));
    // 現行 HJR051 と同じ並び・表示（2026-10-29）：支払日・支払先・摘要・科目コード（科目 内訳）・科目名・税率（%）・支払額・構成員別。伝票No・受入・残高の列、前期繰越・現金補充の行は出さない
    // 帳票イメージ（案）_20261107 REP-CSH-0010（2026-11-21 ユーザー指示）：科目・内訳を別の列に、構成員名の下に出資比率の行。上段だけの見出しは 2 段を縦に結合
    const h0 = out.length + 1, merges = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(c => `${c}${h0}:${c}${h0 + 1}`), pct = r => `${Number.isInteger(r) ? r.toFixed(1) : r}%`;
    out.push(['支払日', '支払先', '摘要', '科目', '内訳', '科目名', '税率', '支払額', ...mh].map(H));
    out.push(['', '', '', '', '', '', '', '', ...(d.members || []).map(m => pct(m.ratio))].map(H));
    const pay = d.rows.filter(r => r.amount), sumParts = rs => mh.map((_, k) => rs.reduce((n, r) => n + (r.parts?.[k] || 0), 0));
    for (const r of pay) out.push([r.date, r.payee, r.memo, r.account, r.sub, r.accountName, r.rate, r.amount, ...(r.parts || [])]);
    // 現行 HJR051 の末尾：＊計＊（支払額・構成員別の合計）→ 税率別の小計（税率の高い順。構成員別は各行の配分の合計）
    out.push(['', '', S('＊ 計 ＊'), '', '', '', '', S(d.spent), ...sumParts(pay).map(S)]);
    for (const rate of [...new Set(pay.map(r => r.rate))].sort((x, y) => parseFloat(y) - parseFloat(x))) {
      const rs = pay.filter(r => r.rate === rate); out.push(['', '', '', '', '', '', rate, rs.reduce((n, r) => n + r.amount, 0), ...sumParts(rs)]);
    }
    return { name: `小口現金出納簿_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '小口現金出納簿', rows: out, merges, widths: [11, 22, 26, 8, 6, 16, 7, 12, ...mw] }]) };
  }
  if (kind === 'sales-register') {
    const d = await salesRegister(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['売上日', '区分', '伝票No', '商品名', '', '数量', '', '売上単価', '売上金額', '処税率', '運送区分', '運賃', '現場', '', '在庫品コード'].map(H));
    for (const cu of d.customers) { out.push(band(SALES_REG_W, [`${cu.customer} ${cu.name || ''}`])); for (const r of cu.rows) out.push([r.showDate ? r.date : '', r.showKind ? r.kind : '', r.no, r.item, r.itemName, { v: r.qty, s: 'qty' }, r.unit, r.price, r.net, r.tax, r.carry, r.freight, r.site, r.site2, r.stock]); }   // 数量は小数 2 桁（整数の書式だと 12.5t が 13 と表示される。2026-11-16）
    return { name: `商品売上登録リスト_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '商品売上登録リスト', rows: out, widths: SALES_REG_W }]) };
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
