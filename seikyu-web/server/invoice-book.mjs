// NO10 請求書の一括ダウンロード：発行済み請求書（最新の発行スナップショット）を Excel にまとめる。現場ごとに1シート（指摘 No.18）
import { check, today } from './domain.mjs';
import { issuedDocument, siteLabel } from './sales.mjs';
import { xlsx } from './xlsx.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
// 現場ごとの発行回数（現場別発行より前の発行分は請求の発行回数）
const siteNo = s => s.siteIssueNo?.[siteLabel(s.siteName)] ?? s.issueNo;
const jp = d => (d ? `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日` : '');
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
// sites：{請求ID: [現場名]}（JSON、2026-10-27 現場別発行）。指定した現場はその現場の最新の発行分、指定が無い請求は最新の発行分で発行した現場
export async function invoiceBook(c, q) {
  const ids = [...new Set(String(q.ids || '').split(',').map(Number).filter(Boolean))];
  check(ids.length > 0 && ids.length <= 200, '請求書を選択してください（最大200件）');
  let want = {}; try { want = q.sites ? JSON.parse(q.sites) : {}; } catch { check(false, '現場の指定が正しくありません'); }
  const sheets = [];
  for (const id of ids) {
    const pages = [];
    if (Array.isArray(want[id]) && want[id].length) {
      for (const n of [...new Set(want[id].map(siteLabel))]) {
        let doc; try { doc = await issuedDocument(c, id, n); } catch { check(false, `請求No.${id} の現場「${n}」は未発行です。発行後にダウンロードしてください`); }
        pages.push(...splitBySite(doc).filter(s => siteLabel(s.siteName) === n));
      }
    } else {
      let doc; try { doc = await issuedDocument(c, id); } catch { check(false, `請求No.${id} は未発行です。発行後にダウンロードしてください`); }
      pages.push(...splitBySite(doc).filter(s => !doc.sites || doc.sites.includes(siteLabel(s.siteName))));
    }
    for (const s of pages) {
      // 印刷の請求書（提案書 スライド14 の様式）と同じ項目・見出し（指摘 No.17）。税率区分は印刷と同じく末尾に
      const no = s.invoiceNo || 'K' + String(s.closing).slice(0, 7).replace('-', '') + String(s.invoiceId).padStart(5, '0');
      const tax10 = s.buckets.filter(b => b.rate !== 8).reduce((n, b) => n + b.tax, 0), tax8 = s.buckets.filter(b => b.rate === 8).reduce((n, b) => n + b.tax, 0);
      const kind = l => (l.shipKb === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上'), banks = s.company.banks || (s.company.bankText ? [s.company.bankText] : []);
      const rows = [[T('請 求 書'), '', '', '', '', '', `請求書番号: ${no}`],
        ['', '', '', '', '', '', `${jp(s.issuedOn || today())}${siteNo(s) > 1 ? `　${s.company.saisyutsu || '再発行'}（${siteNo(s)}回目）` : ''}`],
        [s.customer.address, '', '', '', '', '', s.company.name], [`${s.customer.name} 御中`, '', '', '', '', '', s.company.address],
        ['毎度ありがとうございます。下記のとおり御請求申し上げます。', '', '', '', '', '', `TEL ${s.company.tel}${s.company.fax ? ' FAX ' + s.company.fax : ''}`],
        [`${jp(s.periodStart)} 〜 ${jp(s.closing)}`, '', '', '', '', '', s.company.invoiceNo ? `登録番号: ${s.company.invoiceNo}` : ''],
        [H(`現場：${s.siteName || '（現場なし）'}${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}`), '', '', '', '', '', banks.length ? `取引銀行 ${banks.join(' ／ ')}` : ''],
        ['', '', '', '', '', '', `お支払期日 ${s.due}`], [],
        ['前回残高', '今回入金額', '今回請求額(税抜)', '今回消費税', '今回消費税(軽減)', '今回請求額(税込)', '今回残高'].map(H),
        [s.prevBalance ?? s.carried, s.received ?? 0, s.net, tax10, tax8, s.total, s.grandTotal].map(S), [],
        ['月日', '伝票NO', '区分', '品名', '数量', '単位', '単価', '金額'].map(H)];
      for (const l of s.lines) rows.push([String(l.date).slice(5).replace('-', '/'), l.orderNo, kind(l), l.itemName, { v: l.quantity, s: 'qty' }, l.unit || '', l.price, l.net]);
      rows.push(['', '', '', '', '', '', S('現場計'), S(s.net)], [], ['税率区分', '対象額(税抜)', '消費税'].map(H), ...s.buckets.map(b => [`${b.rate}%対象`, b.net, b.tax]));
      sheets.push({ name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, widths: [16, 16, 16, 26, 12, 14, 26, 14] });
    }
  }
  return { name: `請求書_${today()}_${ids.length}件.xlsx`, body: xlsx(sheets) };
}
