// 帳票の Excel(.xlsx) 出力。画面の印刷表示と同じデータ（sales.mjs の statement）を使う。
import { xlsx } from './xlsx.mjs';
import { billingList, billingConfirm, billingPrecheck, PRECHECK_PLAN, arLedger } from './sales.mjs';
import { today, jst } from './domain.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const kindOf = l => (Number(l.shipKb) === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上'); // 区分は請求書と同じ 赤／黒／売上

// 発行前確認一覧（請求データ作成前の未請求掛売上。現行 HAR430 と同じ明細項目）
export async function billingPrecheckBook(c, q) {
  const d = await billingPrecheck(c, q), clOf = n => (Number(n) === 31 ? '月末' : n + '日'), all = d.closing === 'all', cl = all ? 'すべて' : clOf(d.closing), ymd = iso => iso.slice(2).replaceAll('-', '/');
  const out = [[T('発行前確認一覧'), '', '', '', '', '', '', '', '', '', '', d.company], [all ? `締日 すべて（${d.month}）　作成日 ${ymd(today())}` : `締日 ${cl}　請求期間 ${ymd(d.start)}〜${ymd(d.end)}　売上締切日 ${ymd(d.end)}　作成日 ${ymd(today())}`], []];
  for (const x of d.rows) {
    out.push([H(`${x.customer} ${x.name}`), '', '', H(PRECHECK_PLAN[x.plan]), '', ...(all ? [H(`${clOf(x.closing)}締　請求期間 ${ymd(x.start)}〜${ymd(x.end)}`)] : [])], ['売上日', '伝票No', '区分', '商品CD', '商品名', '数量', '単位', '単価', '金額', '税率', '運送', '現場名']);
    for (const l of x.lines) out.push([ymd(l.date), l.orderNo, kindOf(l), l.item, l.itemName, { v: l.quantity, s: 'qty' }, l.unit, l.price, l.net, `${l.taxRate}%`, l.carry, l.siteName]);
    out.push(['', S('（売上額）'), S(x.net), '', S('（消費税額）'), S(x.tax), '', S('（値引額）'), S(0), '', S('（今回請求額）'), S(x.current)]);
    for (const r of x.byRate || []) out.push(['', `${r.rate} %`, r.net, '', '', r.tax]);
    out.push([]);
  }
  if (!d.rows.length) out.push(['請求データ作成の対象となる未請求の掛売上はありません']);
  return { name: `発行前確認一覧_${d.month}_${cl}締.xlsx`, body: xlsx([{ name: '発行前確認一覧', rows: out, widths: [10, 13, 6, 8, 24, 9, 5, 10, 12, 6, 8, 24] }]) };
}

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
// 2026-10-29 整形版：A4 横・目盛線なし、得意先ごとに濃紺の帯、見出しは下線付き、明細は薄い罫線、現場は淡い帯、合計は枠付きのボックス（今回請求額は濃紺）
export async function billingConfirmBook(c, q) {
  // 現行 HAR430 の項目：締日・請求日付・売上締切日、売上日・伝票No・区分・商品名・数量・単位・単価・金額・税率・運送・備考、（売上額）（消費税額）（値引額）（今回請求額）、税率別
  const d = await billingConfirm(c, q), cl = d.closing === 31 ? '月末' : d.closing + '日', ymd = iso => iso.slice(2).replaceAll('-', '/');
  const N = 12, out = [], heights = {}, merges = [], st = (v, s) => ({ v, s });
  const ref = (r, c0, c1) => `${String.fromCharCode(65 + c0)}${r}:${String.fromCharCode(65 + c1)}${r}`; // r は 1 始まり
  const push = (cells, h) => { out.push(cells); if (h) heights[out.length - 1] = h; return out.length; };
  const fill = (s, at = {}) => Array.from({ length: N }, (_, i) => st(at[i] ?? '', s)); // 帯・罫線は空のセルにも書式を付ける
  const title = push([st(d.unissued ? '請求書発行確認表（未発行を含む）' : '請求書発行確認表', 'rTitle'), '', '', '', '', '', '', '', '', st(d.company, 'rCompany')], 30);
  merges.push(ref(title, 0, 8), ref(title, 9, 11));
  const sub = push([st(`締日 ${cl}　　請求日付 ${ymd(d.end)}　　売上締切日 ${ymd(d.end)}　　作成日 ${ymd(today())}　　対象 ${d.rows.length} 社`, 'rSub')], 18);
  merges.push(ref(sub, 0, 11)); push([], 8);
  const HEAD = ['売上日', '伝票No', '区分', '商品CD', '商品名', '数量', '単位', '単価', '金額', '税率', '運送', '備考'];
  const sumRow = (label, v, ls, ns) => { const r = push(['', '', '', '', '', st(label, ls), st('', ls), st('', ls), st(v, ns)], 20); merges.push(ref(r, 5, 7)); };
  for (const x of d.rows) {
    const b = push(fill('rBand', { 0: `${x.customer}　${x.name}` }), 24);
    out[b - 1][8] = st(x.lastIssue ? `${x.lastIssue.no}回目発行　${jst(x.lastIssue.at, 10)}` : '未発行', 'rBandR');
    merges.push(ref(b, 0, 7), ref(b, 8, 11));
    push(HEAD.map(h => st(h, 'rHead')), 20);
    // 帳票②と同じく現場ごとに区切る（現場が2つ以上なら現場計）。数量は小数2桁、備考は現場名
    const groups = new Map(); for (const l of x.lines) { const k = `${l.site}|${l.siteName}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
    for (const ls of groups.values()) {
      const sr = push(fill('rSite', { 0: `現場：${ls[0].siteName || '（現場なし）'}` }), 19); merges.push(ref(sr, 0, 11));
      for (const l of ls) push([st(ymd(l.date), 'rCenter'), st(l.orderNo, 'rCell'), st(kindOf(l), 'rCenter'), st(l.item, 'rCenter'), st(l.itemName, 'rCell'), st(l.quantity, 'rQty'), st(l.unit, 'rCenter'), st(l.price, 'rNum'), st(l.net, 'rNum'), st(`${l.taxRate}%`, 'rCenter'), st(l.carry, 'rCell'), st(l.siteName, 'rCell')], 18);
      if (groups.size > 1) { const r = push(['', '', '', '', '', '', '', st('現場計', 'rSubTotL'), st(ls.reduce((n, l) => n + l.net, 0), 'rSubTotN')], 19); }
    }
    push([], 6);
    // 合計は枠付きのボックス（ラベルは F〜H を結合、金額は I）。今回請求額は濃紺で強調
    sumRow('売上額', x.net, 'rSumL', 'rSumN'); sumRow('消費税額', x.tax, 'rSumL', 'rSumN'); sumRow('値引額', 0, 'rSumL', 'rSumN'); sumRow('今回請求額', x.current, 'rTotL', 'rTotN');
    for (const r of x.byRate || []) { const a = push(['', '', '', '', '', st(`${r.rate}% 対象額`, 'rRateL'), '', '', st(r.net, 'rRateN'), st('消費税', 'rRateL'), st(r.tax, 'rRateN')], 16); merges.push(ref(a, 5, 7)); }
    push([], 14);
  }
  if (!d.rows.length) push([d.unissued ? '対象の請求はありません' : '発行済みの請求書はありません']);
  return { name: `請求書発行確認表_${d.month}${d.unissued ? '_未発行含む' : ''}.xlsx`, body: xlsx([{ name: '発行確認表', rows: out, heights, merges, gridlines: false, footer: '&L&8請求書発行確認表&R&8&P / &N', widths: [9, 12, 5.5, 7.5, 26, 9, 5, 10, 12, 6, 8, 26] }]) };
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
