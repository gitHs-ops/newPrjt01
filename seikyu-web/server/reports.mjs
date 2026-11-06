// 帳票の Excel(.xlsx) 出力。画面の印刷表示と同じデータ（sales.mjs の statement）を使う。
import { xlsx, band } from './xlsx.mjs';
import { billingList, billingConfirm, billingPrecheck, PRECHECK_PLAN, receiptPlan, arLedger } from './sales.mjs';
import { today, jst } from './domain.mjs';
import { arReport, apReport } from './ledger.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const kindOf = l => (Number(l.shipKb) === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上'); // 区分は請求書と同じ 赤／黒／売上

const PRECHECK_W = [10, 13, 6, 8, 24, 9, 5, 10, 12, 6, 8, 24], CONFIRM_W = [10, 14, 6, 8, 24, 9, 5, 10, 12, 6, 13, 24];
// 発行前確認一覧（請求データ作成前の未請求掛売上。現行 HAR430 と同じ明細項目）
export async function billingPrecheckBook(c, q) {
  const d = await billingPrecheck(c, q), clOf = n => (Number(n) === 31 ? '月末' : n + '日'), all = d.closing === 'all', cl = all ? 'すべて' : clOf(d.closing), ymd = iso => iso.slice(2).replaceAll('-', '/');
  const out = [[T('発行前確認一覧'), '', '', '', '', '', '', '', '', '', '', d.company], [all ? `締日 すべて（${d.month}）　作成日 ${ymd(today())}` : `締日 ${cl}　請求期間 ${ymd(d.start)}〜${ymd(d.end)}　売上締切日 ${ymd(d.end)}　作成日 ${ymd(today())}`], []];
  for (const x of d.rows) {
    out.push(band(PRECHECK_W, [`${x.customer} ${x.name}`, '', '', H(PRECHECK_PLAN[x.plan]), '', ...(all ? [H(`${clOf(x.closing)}締　請求期間 ${ymd(x.start)}〜${ymd(x.end)}`)] : [])]), ['売上日', '伝票No', '区分', '商品CD', '商品名', '数量', '単位', '単価', '金額', '処税率', '運送', '現場名']);
    for (const l of x.lines) out.push([ymd(l.date), l.orderNo, kindOf(l), l.item, l.itemName, { v: l.quantity, s: 'qty' }, l.unit, l.price, l.net, `${l.taxRate}%`, l.carry, l.siteName]);
    out.push(['', S('（売上額）'), S(x.net), '', S('（消費税額）'), S(x.tax), '', S('（値引額）'), S(0), '', S('（今回請求額）'), S(x.current)]);
    for (const r of x.byRate || []) out.push(['', `${r.rate} %`, r.net, '', '', r.tax]);
    out.push([]);
  }
  if (!d.rows.length) out.push(['請求データ作成の対象となる未請求の掛売上はありません']);
  return { name: `発行前確認一覧_${d.month}_${cl}締.xlsx`, body: xlsx([{ name: '発行前確認一覧', rows: out, widths: PRECHECK_W }]) };
}

// NO12 請求一覧表（確認用）— 現行 HAR431 の項目
export async function billingListBook(c, q) {
  const d = await billingList(c, q), out = [[T('請求一覧表（確認用）')], [`締日 ${d.closing === 31 ? '月末' : d.closing + '日'}　請求日 ${d.end}　出力日 ${today()}`], [],
    ['得意先名', '', '現場名', '売上額', '税額', '値引額', '請求額'].map(H)];
  // 現行 HAR431（2026-11-03）：得意先ごとに 1 行（現場別発行の得意先だけ現場ごと）。得意先計は 2 行以上のときだけ。状態は出さない
  // 2026-11-04：得意先はコード＋名称を 1 列、現場別の 2 行目から現場No（2・3…）、計は「得意先合計」「会社　合計」（現行 HAR431 の表記）
  for (const x of d.rows) { if (!x.bookRows.length) continue; x.bookRows.forEach((s, i) => out.push([i ? '' : `${x.customer} ${x.name || ''}`, i ? i + 1 : '', s.siteName, s.net, s.tax, 0, s.total])); if (x.bookRows.length > 1) out.push(['', '', S('得意先合計'), S(x.net), S(x.tax), S(0), S(x.current)]); }
  const sum = k => d.rows.reduce((n, x) => n + x[k], 0);
  out.push([], ['', '', S('会社　合計'), S(sum('net')), S(sum('tax')), S(0), S(sum('current'))]); // 今回の請求が無い得意先（繰越・入金だけ）は行を出さない
  return { name: `請求一覧表_${d.month}_${d.closing}日締.xlsx`, body: xlsx([{ name: '請求一覧表', rows: out, widths: [34, 5, 24, 13, 12, 10, 13] }]) };
}
// NO13 請求書発行確認表 — 現行 HAR430 の項目
// 2026-11-04 現行 HAR430 の並び：見出し（締日・請求日付・売上締切日）と列見出しは各ページの先頭に 1 回。得意先の行は請求現場ごと（2 つ目から 現場No・現場名）。
// 明細の列 売上日 伝票No. （区分・商品CD）商品名 数量 （単位）単価 金額 （税率）運送 備考、現場ごとに（売上額）（消費税額）（値引額）（今回請求額）と税率別
export async function billingConfirmBook(c, q) {
  // 2026-11-05 ユーザー指示：一般の帳票（現金売上明細表など）と同じ出力スタイル（表題・薄青の見出し・合計の枠）。並び・項目は現行 HAR430 のまま
  const d = await billingConfirm(c, q), ymd = iso => iso.slice(2).replaceAll('-', '/');
  const out = [[T(d.unissued ? '請求書発行確認表（未発行を含む）' : '請求書発行確認表'), '', '', '', '', '', '', '', '', '', '', d.company],
    [`締日 ${d.closing}　請求日付 ${ymd(d.end)}　売上締切日 ${ymd(d.end)}　作成日 ${ymd(today())}`], [],
    ['売上日', '伝票No.', '', '', '商品名', '数量', '', '単価', '金額', '', '運送', '備考'].map(H)];
  for (const x of d.rows) for (const g of x.sites) {
    out.push(band(CONFIRM_W, [`${x.customer}　${x.name}`, '', '', '', '', ...(g.no > 1 ? [g.no, '', g.name] : [])]));
    for (const l of g.lines) out.push([ymd(l.date), l.orderNo, kindOf(l), l.item, l.itemName, { v: l.quantity, s: 'qty' }, l.unit, l.price, l.net, `${l.taxRate}%`, l.carry, l.siteName]);
    out.push(['', S('（売上額）'), S(g.net), '', S('（消費税額）'), S(g.tax), '', S('（値引額）'), S(0), '', S('（今回請求額）'), S(g.current)]);
    for (const r of g.byRate) out.push(['', `${r.rate} %`, r.net, '', '', r.tax]);
    out.push([]);
  }
  if (!d.rows.length) out.push([d.unissued ? '対象の請求はありません' : '発行済みの請求書はありません']);
  return { name: `請求書発行確認表_${d.month}${d.unissued ? '_未発行含む' : ''}.xlsx`, body: xlsx([{ name: '発行確認表', rows: out, printTitles: '1:4', footer: '&L&8請求書発行確認表&R&8&P / &N', widths: CONFIRM_W }]) };
}

// 入金予定一覧（提案書 スライド18・10/14 打合せ）— 画面と同じ条件・項目
export async function receiptPlanBook(c, q) {
  const d = await receiptPlan(c, q), range = `${d.from || '過去すべて'} 〜 ${d.to || '指定なし'}`, t = d.totals;
  const out = [[T('入金予定一覧')], [`入金予定月 ${range}${d.overdueOnly ? '（予定日経過・未入金のみ）' : ''}${q.customer ? `　得意先 ${q.customer}` : ''}　基準日 ${d.today}　出力日 ${today()}`], [],
    ['得意先CD', '得意先名', '請求年月（締日）', '請求金額', 'サイト', '入金予定日', '経過日数', '入金予定金額', '入金金額', '残高', '状態'].map(H)];
  for (const r of d.rows) out.push([r.customer, r.name, r.closing, r.total, r.site, r.due, r.days || '', r.planned, r.paid, r.balance, r.overdue ? '予定日経過・未入金' : '']);
  out.push([S('合計'), `${d.rows.length}件`, '', '', '', '', '', S(t.planned), S(t.paid), S(t.balance), t.overdueCount ? `経過 ${t.overdueCount}件` : '']);
  return { name: `入金予定一覧_${d.from || '過去'}_${d.to || '指定なし'}.xlsx`, body: xlsx([{ name: '入金予定一覧', rows: out, widths: [10, 30, 13, 13, 16, 12, 9, 14, 13, 13, 18] }]) };
}

// 得意先別残高照会（画面と同じ項目）：前回請求額・御入金額・差引繰越額・今回お買上額・消費税・今回請求額・支払期日・請求書状況
export async function billingBalanceBook(c, q) {
  const d = await billingList(c, q), cl = d.closing === 31 ? '月末' : d.closing + '日', STATES = { none: '未作成', draft: '未発行', issued: '発行済' };
  if (STATES[q.state]) d.rows = d.rows.filter(r => r.state === q.state); // 請求書状況で絞込
  const out = [[T('得意先別残高照会')], [`${d.month} ${cl}締（${d.end}）${STATES[q.state] ? '　請求書状況 ' + STATES[q.state] : ''}　出力日 ${today()}`], [],
    ['得意先CD', '得意先名', '前回請求額', '御入金額', '差引繰越額', '今回お買上額', '消費税', '今回請求額', '支払期日', '請求書状況'].map(H)];
  for (const r of d.rows) out.push([r.customer, r.name, r.prevBalance, r.received, r.carried, r.net, r.tax, r.total, r.due || '', r.stateName]);
  const sum = k => d.rows.reduce((n, r) => n + (r[k] || 0), 0);
  out.push([S('合計'), '', S(sum('prevBalance')), S(sum('received')), S(sum('carried')), S(sum('net')), S(sum('tax')), S(sum('total')), '', '']);
  return { name: `得意先別残高照会_${d.month}_${cl}締.xlsx`, body: xlsx([{ name: '得意先別残高照会', rows: out, widths: [10, 30, 14, 14, 14, 14, 12, 14, 12, 10] }]) };
}

// 請求残高照会（得意先×請求年月）：画面と同じ項目・同じ絞込（得意先・請求年月・請求書状況）
export async function arLedgerBook(c, q) {
  const STATES = { draft: '未発行', issued: '発行済', partial: '一部入金', paid: '入金済', credit: 'クレジット' };
  const d = await arLedger(c, q), rows = STATES[q.state] ? d.rows.filter(r => r.status === q.state) : d.rows;
  const cond = [q.customer ? `得意先 ${q.customer}` : '', q.month ? `請求年月 ${q.month}` : '', STATES[q.state] ? `請求書状況 ${STATES[q.state]}` : ''].filter(Boolean).join('　');
  const out = [[T('請求残高照会')], [`${cond ? cond + '　' : ''}出力日 ${today()}`], [],
    ['得意先CD', '得意先名', '請求年月', '締日', '前回残高', '当月請求金額', '今回請求金額', '消込金額', '消込残高', '請求書状況'].map(H)];
  for (const r of rows) out.push([r.customer, r.name, r.month, r.closing, r.prev, r.current, r.claim, r.cleared, r.remain, STATES[r.status] || '']);
  const sum = k => rows.reduce((n, r) => n + r[k], 0);
  out.push([S('合計'), '', '', '', '', S(sum('current')), '', S(sum('cleared')), S(rows.filter(r => r.latest).reduce((n, r) => n + r.remain, 0)), '']);
  return { name: `請求残高照会_${today()}.xlsx`, body: xlsx([{ name: '請求残高照会', rows: out, widths: [10, 30, 10, 12, 14, 14, 14, 14, 14, 10] }]) };
}

// 売掛金残高一覧・未払残高一覧（画面と同じ項目。2026-11-02 ［⇩ Excel］追加）
export async function arBook(c) {
  const rs = await arReport(c), sum = k => rs.reduce((n, r) => n + r[k], 0);
  const out = [[T('売掛金残高一覧')], [`出力日 ${today()}`], [], ['得意先CD', '得意先名', '締日', '開始残高', '請求累計', '消込累計', '売掛残高', '期日超過', '未請求(税抜)'].map(H)];
  for (const r of rs) out.push([r.customer, r.name, r.closing === 31 ? '月末' : r.closing + '日', r.opening, r.billed, r.received, r.balance, r.overdue, r.unbilled]);
  out.push([S('合計'), `${rs.length}件`, '', ...['opening', 'billed', 'received', 'balance', 'overdue', 'unbilled'].map(k => S(sum(k)))]);
  return { name: `売掛金残高一覧_${today()}.xlsx`, body: xlsx([{ name: '売掛金残高一覧', rows: out, widths: [10, 34, 8, 14, 14, 14, 14, 14, 14] }]) };
}
export async function apBook(c) {
  const rs = await apReport(c), sum = k => rs.reduce((n, r) => n + r[k], 0);
  const out = [[T('未払残高一覧')], [`出力日 ${today()}`], [], ['業者CD', '業者名', '計上累計', '支払累計', '未払残高'].map(H)];
  for (const r of rs) out.push([r.vendor, r.name, r.billed, r.paid, r.balance]);
  out.push([S('合計'), `${rs.length}件`, ...['billed', 'paid', 'balance'].map(k => S(sum(k)))]);
  return { name: `未払残高一覧_${today()}.xlsx`, body: xlsx([{ name: '未払残高一覧', rows: out, widths: [10, 34, 14, 14, 14] }]) };
}
