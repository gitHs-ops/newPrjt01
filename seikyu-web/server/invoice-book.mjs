// NO10 請求書の一括ダウンロード：発行済み請求書（最新の発行スナップショット）を Excel にまとめる。現場ごとに1シート（指摘 No.18）
import { check, today } from './domain.mjs';
import { issuedDocument } from './sales.mjs';
import { xlsx } from './xlsx.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
// 請求書を現場ごとに分ける（画面の印刷 splitBySite と同じ）：前回・入金・繰越は1枚目だけ。消費税は税率ごとに得意先の税額を現場の金額で按分（端数は金額の大きい現場）
function splitBySite(s) {
  const m = new Map(); for (const l of s.lines) { const k = `${l.site || ''}|${l.siteName || ''}`; if (!m.has(k)) m.set(k, { name: l.siteName || '（現場なし）', lines: [], net: 0 }); const g = m.get(k); g.lines.push(l); g.net += l.net; }
  const gs = [...m.values()]; if (gs.length <= 1) return [{ ...s, siteName: gs[0]?.name || '', page: 1, pages: 1 }];
  const bk = gs.map(() => []);
  for (const b of s.buckets) {
    const nets = gs.map(g => g.lines.filter(l => l.taxRate === b.rate).reduce((n, l) => n + l.net, 0)), taxes = nets.map(n => (b.net ? Math.floor(b.tax * n / b.net) : 0));
    taxes[nets.indexOf(Math.max(...nets))] += b.tax - taxes.reduce((a, t) => a + t, 0);
    nets.forEach((n, k) => { if (n || taxes[k]) bk[k].push({ rate: b.rate, net: n, tax: taxes[k] }); });
  }
  return gs.map((g, k) => { const tax = bk[k].reduce((n, b) => n + b.tax, 0), total = g.net + tax, first = k === 0;
    return { ...s, lines: g.lines, buckets: bk[k], net: g.net, tax, total, prevBalance: first ? s.prevBalance ?? s.carried : 0, received: first ? s.received ?? 0 : 0, carried: first ? s.carried : 0, grandTotal: (first ? s.carried : 0) + total, siteName: g.name, page: k + 1, pages: gs.length }; });
}
export async function invoiceBook(c, q) {
  const ids = [...new Set(String(q.ids || '').split(',').map(Number).filter(Boolean))];
  check(ids.length > 0 && ids.length <= 200, '請求書を選択してください（最大200件）');
  const sheets = [];
  for (const id of ids) {
    let doc; try { doc = await issuedDocument(c, id); } catch { check(false, `請求No.${id} は未発行です。発行後にダウンロードしてください`); }
    for (const s of splitBySite(doc)) {
      const rows = [[T('請 求 書'), '', '', '', '', '', `請求No. ${s.invoiceId}-${s.issueNo}${s.issueNo > 1 ? '（再発行）' : ''}`],
        [`${s.customer.name} 御中`, '', '', '', '', '', s.company.name], [s.customer.address, '', '', '', '', '', s.company.address],
        [`請求期間 ${s.periodStart} 〜 ${s.closing}`, '', '', '', '', '', `TEL ${s.company.tel}`], [`お支払期日 ${s.due}`, '', '', '', '', '', `発行日 ${s.issuedOn || ''}`],
        [H(`現場：${s.siteName || '（現場なし）'}${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}`)], [],
        ['前回御請求額', '御入金額', '差引繰越額', '今回お買上額', '消費税額', '今回御請求額'].map(H),
        [s.prevBalance ?? s.carried, s.received ?? 0, s.carried, s.net, s.tax, s.grandTotal].map(S), [],
        ['税率区分', '対象額(税抜)', '消費税'].map(H), ...s.buckets.map(b => [`${b.rate}%対象`, b.net, b.tax]), [],
        ['日付', '伝票No', '現場', '品名', '数量', '単価', '金額', '税率', '備考'].map(H)];
      for (const l of s.lines) rows.push([l.date, l.orderNo + (l.shipKb === 5 ? (l.quantity < 0 ? ' 赤' : ' 黒') : ''), l.siteName || '', l.itemName, { v: l.quantity, s: 'qty' }, l.price, l.net, `${l.taxRate}%`, l.remarks || '']);
      rows.push(['', '', S('現場計'), '', '', '', S(s.net)]); // ラベルは「現場」列
      sheets.push({ name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, widths: [12, 14, 20, 20, 9, 10, 13, 7, 16] });
    }
  }
  return { name: `請求書_${today()}_${ids.length}件.xlsx`, body: xlsx(sheets) };
}
