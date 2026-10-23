// NO10 請求書の一括ダウンロード：発行済み請求書（最新の発行スナップショット）を1請求書=1シートの Excel にまとめる。
import { check, today } from './domain.mjs';
import { issuedDocument } from './sales.mjs';
import { xlsx } from './xlsx.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
export async function invoiceBook(c, q) {
  const ids = [...new Set(String(q.ids || '').split(',').map(Number).filter(Boolean))];
  check(ids.length > 0 && ids.length <= 200, '請求書を選択してください（最大200件）');
  const sheets = [];
  for (const id of ids) {
    let s; try { s = await issuedDocument(c, id); } catch { check(false, `請求No.${id} は未発行です。発行後にダウンロードしてください`); }
    const rows = [[T('請 求 書'), '', '', '', '', '', `請求No. ${s.invoiceId}-${s.issueNo}${s.issueNo > 1 ? '（再発行）' : ''}`],
      [`${s.customer.name} 御中`, '', '', '', '', '', s.company.name], [s.customer.address, '', '', '', '', '', s.company.address],
      [`請求期間 ${s.periodStart} 〜 ${s.closing}`, '', '', '', '', '', `TEL ${s.company.tel}`], [`お支払期日 ${s.due}`, '', '', '', '', '', `発行日 ${s.issuedOn || ''}`], [],
      ['前回御請求額', '御入金額', '差引繰越額', '今回お買上額', '消費税額', '今回御請求額'].map(H),
      [s.prevBalance ?? s.carried, s.received ?? 0, s.carried, s.net, s.tax, s.grandTotal].map(S), [],
      ['税率区分', '対象額(税抜)', '消費税'].map(H), ...s.buckets.map(b => [`${b.rate}%対象`, b.net, b.tax]), [],
      ['日付', '伝票No', '現場', '品名', '数量', '単価', '金額', '税率', '備考'].map(H)];
    let site = null, sub = 0;
    const flush = () => { if (site !== null) rows.push(['', '', '', S('現場小計'), '', '', S(sub)]); };
    for (const l of s.lines) { if ((l.site || '') !== site) { flush(); site = l.site || ''; sub = 0; } sub += l.net; rows.push([l.date, l.orderNo + (l.shipKb === 5 ? (l.quantity < 0 ? ' 赤' : ' 黒')  : ''), l.siteName || '', l.itemName, l.quantity, l.price, l.net, `${l.taxRate}%`, l.remarks || '']); }
    flush();
    sheets.push({ name: `${s.invoiceId}_${s.customer.code}`.slice(0, 31), rows, widths: [12, 14, 20, 20, 9, 10, 13, 7, 16] });
  }
  return { name: `請求書_${today()}_${ids.length}件.xlsx`, body: xlsx(sheets) };
}
