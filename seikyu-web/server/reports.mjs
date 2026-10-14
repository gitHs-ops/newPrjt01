// 帳票の Excel(.xlsx) 出力。画面の印刷表示と同じデータ（sales.mjs の statement）を使う。
import { xlsx } from './xlsx.mjs';
import { billingList, billingConfirm } from './sales.mjs';
import { today, jst } from './domain.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const shipKb = k => (Number(k) === 2 ? '訂正' : '売上');

// NO12 請求一覧表（確認用）
export async function billingListBook(c, q) {
  const d = await billingList(c, q), r = d.rows;
  const sum = k => r.reduce((n, x) => n + x[k], 0);
  const rows = [[T('請求一覧表（確認用）')], [`請求年月 ${d.month}　締日 ${d.closing === 31 ? '月末' : d.closing + '日'}（${d.end}）　出力日 ${today()}`], [],
    ['得意先CD', '得意先名', '前回請求額', '御入金額', '差引繰越額', '今回お買上額', '消費税額', '今回請求額', '明細件数', '状態'].map(H),
    ...r.map(x => [x.customer, x.name, x.prevBalance, x.received, x.carried, x.net, x.tax, x.total, x.lineCount, x.stateName]),
    [S('合計'), S(''), S(sum('prevBalance')), S(sum('received')), S(sum('carried')), S(sum('net')), S(sum('tax')), S(sum('total')), S(sum('lineCount')), S('')]];
  return { name: `請求一覧表_${d.month}_${d.closing}日締.xlsx`, body: xlsx([{ name: '請求一覧表', rows, widths: [10, 28, 13, 13, 13, 14, 12, 14, 9, 9] }]) };
}
// NO13 請求書発行確認表（同じ計算、得意先ごとに明細まで出力）
export async function billingConfirmBook(c, q) {
  const d = await billingConfirm(c, q), rows = [[T('請求書発行確認表')], [`請求年月 ${d.month}　締日 ${d.end}　出力日 ${today()}`], []];
  for (const x of d.rows) {
    rows.push([H('得意先'), H(`${x.customer} ${x.name}`), H(''), H('発行'), H(x.lastIssue ? `${x.lastIssue.no}回目 ${jst(x.lastIssue.at, 10)} ${x.lastIssue.by}` : ''), H(''), H(''), H(''), H('')]);
    rows.push(['前回請求額', x.prevBalance, '御入金額', x.received, '差引繰越額', x.carried, '今回お買上額', x.net, '']);
    rows.push(['消費税額', x.tax, '今回請求額', x.total, '支払期日', x.due, '', '', '']);
    rows.push(['日付', '伝票No', '区分', '現場', '商品', '数量', '単価', '金額', '税率'].map(H));
    let siteKey = null, sub = 0;
    const flush = () => { if (siteKey !== null) rows.push(['', '', '', '', S('現場小計'), '', '', S(sub), '']); };
    for (const l of x.lines) {
      if (l.site !== siteKey) { flush(); siteKey = l.site; sub = 0; }
      sub += l.net; rows.push([l.date, l.orderNo, shipKb(l.shipKb), l.siteName, l.itemName, l.quantity, l.price, l.net, `${l.taxRate}%`]);
    }
    flush(); rows.push([]);
  }
  if (!d.rows.length) rows.push(['発行済みの請求書はありません']);
  return { name: `請求書発行確認表_${d.month}.xlsx`, body: xlsx([{ name: '発行確認表', rows, widths: [12, 14, 8, 26, 20, 11, 11, 13, 8] }]) };
}
