// 帳票の Excel(.xlsx) 出力。画面の印刷表示と同じデータ（sales.mjs の statement）を使う。
import { xlsx } from './xlsx.mjs';
import { billingList, billingConfirm, receiptPlan, arLedger } from './sales.mjs';
import { today, jst } from './domain.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const shipKb = k => (Number(k) === 5 ? '訂正' : '売上');

// NO12 請求一覧表（確認用）— 現行 HAR431 の項目
export async function billingListBook(c, q) {
  const d = await billingList(c, q), out = [[T('請求一覧表（確認用）')], [`締日 ${d.closing === 31 ? '月末' : d.closing + '日'}　請求日 ${d.end}　出力日 ${today()}`], [],
    ['得意先CD', '得意先名', '現場名', '売上額', '税額', '値引額', '請求額', '状態'].map(H)];
  for (const x of d.rows) { if (!x.sites.length) continue; x.sites.forEach((s, i) => out.push([i ? '' : x.customer, i ? '' : x.name, s.siteName, s.net, s.tax, 0, s.total, i ? '' : x.stateName])); out.push(['', S('得意先計'), '', S(x.net), S(x.tax), S(0), S(x.current), '']); }
  const sum = k => d.rows.reduce((n, x) => n + x[k], 0);
  out.push([S('会社合計'), '', '', S(sum('net')), S(sum('tax')), S(0), S(sum('current')), '']); // 今回の請求が無い得意先（繰越・入金だけ）は行を出さない
  return { name: `請求一覧表_${d.month}_${d.closing}日締.xlsx`, body: xlsx([{ name: '請求一覧表', rows: out, widths: [10, 26, 24, 13, 12, 10, 13, 9] }]) };
}
// NO13 請求書発行確認表 — 現行 HAR430 の項目
export async function billingConfirmBook(c, q) {
  // 現行 HAR430 の項目：締日・請求日付・売上締切日、売上日・伝票No・区分・商品名・数量・単位・単価・金額・税率・運送・備考、（売上額）（消費税額）（値引額）（今回請求額）、税率別
  const d = await billingConfirm(c, q), cl = d.closing === 31 ? '月末' : d.closing + '日', ymd = iso => iso.slice(2).replaceAll('-', '/');
  const out = [[T(d.unissued ? '請求書発行確認表（未発行を含む）' : '請求書発行確認表'), '', '', '', '', '', '', '', '', '', '', d.company], [`締日 ${cl}　請求日付 ${ymd(d.end)}　売上締切日 ${ymd(d.end)}　作成日 ${ymd(today())}`], []];
  for (const x of d.rows) {
    out.push([H(`${x.customer} ${x.name}`), '', '', H(x.lastIssue ? `${x.lastIssue.no}回目発行 ${jst(x.lastIssue.at, 10)}` : '未発行')], ['売上日', '伝票No', '区分', '商品CD', '商品名', '数量', '単位', '単価', '金額', '税率', '運送', '備考'].map(H));
    for (const l of x.lines) out.push([ymd(l.date), l.orderNo, shipKb(l.shipKb), l.item, l.itemName, l.quantity, l.unit, l.price, l.net, `${l.taxRate}%`, l.carry, l.siteName]);
    out.push(['', S('（売上額）'), S(x.net), '', S('（消費税額）'), S(x.tax), '', S('（値引額）'), S(0), '', S('（今回請求額）'), S(x.current)]);
    for (const r of x.byRate || []) out.push(['', `${r.rate} %`, r.net, '', '', r.tax]);
    out.push([]);
  }
  if (!d.rows.length) out.push([d.unissued ? '対象の請求はありません' : '発行済みの請求書はありません']);
  return { name: `請求書発行確認表_${d.month}${d.unissued ? '_未発行含む' : ''}.xlsx`, body: xlsx([{ name: '発行確認表', rows: out, widths: [10, 13, 6, 8, 24, 9, 5, 10, 12, 6, 8, 24] }]) };
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
    ['得意先CD', '得意先名', '請求年月', '締日', '前回残高', '当月請求金額', '今回請求金額', '消込金額', '今回残高', '請求書状況'].map(H)];
  for (const r of rows) out.push([r.customer, r.name, r.month, r.closing, r.prev, r.current, r.claim, r.cleared, r.remain, STATES[r.status] || '']);
  const sum = k => rows.reduce((n, r) => n + r[k], 0);
  out.push([S('合計'), '', '', '', '', S(sum('current')), '', S(sum('cleared')), S(rows.filter(r => r.latest).reduce((n, r) => n + r.remain, 0)), '']);
  return { name: `請求残高照会_${today()}.xlsx`, body: xlsx([{ name: '請求残高照会', rows: out, widths: [10, 30, 10, 12, 14, 14, 14, 14, 14, 10] }]) };
}
