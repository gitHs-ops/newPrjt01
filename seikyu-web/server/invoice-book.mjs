// NO10 請求書の一括ダウンロード：発行済み請求書（最新の発行スナップショット）を Excel にまとめる。現場ごとに1シート（指摘 No.18）
import { check, today } from './domain.mjs';
import { issuedDocument, siteLabel } from './sales.mjs';
import { xlsx } from './xlsx.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
// 現場ごとの発行回数（現場別発行より前の発行分は請求の発行回数）
const siteNo = s => s.pageIssueNo ?? s.siteIssueNo?.[siteLabel(s.siteName)] ?? s.issueNo;
const jp = d => (d ? `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日` : '');
// 請求書を現場ごとに分ける（画面の印刷 splitBySite と同じ）：前回残高・入金・繰越は載せない（2026-10-27 大西さん回答 A）。消費税は税率ごとに得意先の税額を現場の金額で按分（端数は金額の大きい現場）
function splitBySite(s) {
  const m = new Map(); for (const l of s.lines) { const k = `${l.site || ''}|${l.siteName || ''}`; if (!m.has(k)) m.set(k, { name: l.siteName || '（現場なし）', lines: [], net: 0 }); const g = m.get(k); g.lines.push(l); g.net += l.net; }
  const gs = [...m.values()]; if (gs.length <= 1) return [{ ...s, siteName: gs[0]?.name || '', page: 1, pages: 1 }];
  const bk = gs.map(() => []);
  for (const b of s.buckets) {
    const nets = gs.map(g => g.lines.filter(l => l.taxRate === b.rate).reduce((n, l) => n + l.net, 0)), taxes = nets.map(n => (b.net ? Math.floor(b.tax * n / b.net) : 0));
    taxes[nets.indexOf(Math.max(...nets))] += b.tax - taxes.reduce((a, t) => a + t, 0);
    nets.forEach((n, k) => { if (n || taxes[k]) bk[k].push({ rate: b.rate, net: n, tax: taxes[k] }); });
  }
  return gs.map((g, k) => { const tax = bk[k].reduce((n, b) => n + b.tax, 0), total = g.net + tax;
    return { ...s, lines: g.lines, buckets: bk[k], net: g.net, tax, total, prevBalance: 0, received: 0, carried: 0, grandTotal: total, siteName: g.name, page: k + 1, pages: gs.length }; });
}
// 2026-11-04 請求書は請求現場（明細の現場CD・枝番）ごとに1枚（現行 帳票③④⑤）。納入先（明細の現場名）は備考に出すだけ。工事名は請求現場の名称（現場マスタ。s.siteNames）。
// 一部の納入先だけを発行した回（現場別発行）は、その納入先の明細・金額だけ。消費税は splitBySite と同じ按分（納入先ごと）を請求現場ごとに足す。want＝納入先の名前（無ければ全部）
const invoicePages = (s, want) => {
  const parts = splitBySite(s), mine = want ? parts.filter(p => want.includes(siteLabel(p.siteName))) : parts, g = new Map();
  for (const p of mine) { const k = p.lines[0]?.site || '|'; if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
  const keys = [...g.keys()].sort((a, b) => (a === '|' ? -1 : b === '|' ? 1 : a < b ? -1 : a > b ? 1 : 0)), whole = keys.length === 1 && mine.length === parts.length;
  return keys.map((k, i) => {
    const ps = g.get(k), buckets = []; for (const p of ps) for (const b of p.buckets) { const x = buckets.find(y => y.rate === b.rate); if (x) { x.net += b.net; x.tax += b.tax; } else buckets.push({ ...b }); }
    const net = whole ? s.net : ps.reduce((n, p) => n + p.net, 0), tax = whole ? s.tax : ps.reduce((n, p) => n + p.tax, 0), total = net + tax, keep = new Set(ps.flatMap(p => p.lines));
    const no = Math.max(...ps.map(p => p.siteIssueNo?.[siteLabel(p.siteName)] ?? p.issueNo ?? 0));
    return { ...s, lines: s.lines.filter(l => keep.has(l)), buckets: whole ? s.buckets : buckets, net, tax, total, discount: 0, prevBalance: 0, received: 0, carried: 0, grandTotal: total, siteName: s.siteNames?.[k] || '', page: i + 1, pages: keys.length, pageIssueNo: no || undefined };
  });
};
// 現行の請求書（帳票③④⑤、2026-11-04）：印刷の legacyInvoice と同じ並び。A4 横・目盛線なし
const zipOf = z => (z ? `〒 ${String(z).replace(/^(\d{3})-?(\d{4})$/, '$1-$2')}` : '');
function legacySheet(s) {
  const c = s.company, u = s.customer, ymd = d => String(d || '').slice(2).replaceAll('-', '/'), day = Number(String(s.closing).slice(8)), banks = c.banks || (c.bankText ? [c.bankText] : []);
  const rows = [], heights = {}, merges = [], st = (v, k) => ({ v, s: k });
  const ref = (r, c0, c1) => `${String.fromCharCode(65 + c0)}${r}:${String.fromCharCode(65 + c1)}${r}`;
  const push = (cells, h) => { rows.push(cells); if (h) heights[rows.length - 1] = h; return rows.length; };
  merges.push(ref(push([st('請　求　書', 'rTitleC')], 30), 0, 7));
  if (siteNo(s) > 1) push(['', '', '', '', '', '', '', st(`${s.company.saisyutsu || '再発行'}（${siteNo(s)}回目）`, 'rSubR')]);
  const left = [[zipOf(u.postcode), 'rText'], ...(u.postcode === undefined ? [[u.address || '', 'rText']] : [[[u.pref, u.addr1].filter(Boolean).join('　'), 'rText'], [u.addr2 || '', 'rText']]), ['', 'rText'], [`${u.name}　　御中`, 'rCust']];
  const right = [[zipOf(c.postcode), 'rText'], [[c.pref, c.addr1].filter(Boolean).join('') + (c.addr2 ? ' ' + c.addr2 : '') || c.address || '', 'rText'], [c.name1 || c.name, 'rText'], ...(c.invoiceNo ? [[c.invoiceNo, 'rText']] : []), [`${c.name2 ? c.name2 + '　　' : ''}TEL. ${c.tel}`, 'rText'], ['', 'rText'], ...banks.map(b => [b, 'rSubR']), ...(banks.length ? [[c.name1 || c.name, 'rSubR']] : [])];
  for (let k = 0; k < Math.max(left.length, right.length); k++) { const [lv, ls] = left[k] || ['', 'rText'], [rv, rs] = right[k] || ['', 'rText'], r = push([st(lv, ls), '', '', '', st(rv, rs)], 17); merges.push(ref(r, 0, 3), ref(r, 4, 7)); }
  push([], 10);
  push(['', '', '', '', '', st('請求年月日', 'rCenter'), st('得意先コード', 'rCenter'), st('締日', 'rCenter')]);
  push(['', '', '', '', '', st(ymd(s.closing), 'rCenter'), st(u.code, 'rCenter'), st(day >= 28 ? 31 : day, 'rCenter')]);
  push([], 10);
  merges.push(ref(push([st('工　事　名', 'rCenter'), '', '', st('当月御買上額', 'rCenter'), '', st('消費税額', 'rCenter'), st('当月値引額', 'rCenter'), st('当月御請求額', 'rCenter')]), 0, 2), ref(rows.length, 3, 4));
  merges.push(ref(push([st(s.siteName || '', 'rCenter'), '', '', st(s.net, 'rNum'), '', st(s.tax, 'rNum'), st(s.discount || 0, 'rNum'), st(s.total, 'rNum')]), 0, 2), ref(rows.length, 3, 4));
  push([], 12);
  push(['年月日', '伝票番号', '商品名', '数量', '単位', '単価', '金額', '備考'].map(h => st(h, 'rHead')), 18);
  for (const l of s.lines) push([st(ymd(l.date), 'rCenter'), st(l.orderNo, 'rCell'), st(l.itemName, 'rCell'), st(l.quantity, 'rQty'), st(l.unit || '', 'rCenter'), st(l.price, 'rNum'), st(l.net, 'rNum'), st(`${l.siteName || ''}${l.remarks ? ' ' + l.remarks : ''}`, 'rCell')], 17);
  push([], 8);
  for (const b of s.buckets) { push(['', '', '', '', '', '', st(b.net, 'rNum'), st(`${b.rate}%`, 'rCell')]); push(['', '', '', '', '', '', st(b.tax, 'rNum'), st('税', 'rCell')]); }
  return { name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, heights, merges, gridlines: false, widths: [10, 11, 30, 10, 6, 11, 13, 34] };
}
// 提案書様式の請求書（2026-11-08 ユーザー提示の Excel 見本どおり）：A4 縦・目盛線なし・黒の罫線。列は A 月日・B 伝票NO・C 区分・D:E 品名・F 数量・G 単位・H 単価・I 金額。
// 表題は E の太枠。左に得意先（〒・住所・名称 御中（下線）・現場・挨拶・対象期間）、右に請求書番号・日付と発行元（会社名・〒住所・TEL・登録番号・取引銀行（銀行・支店／種別・口座番号））。
// 請求額の枠は 当月御買上額（A:C）・今回消費税（D）・当月御請求額（E）。明細は空行を足して 11 行以上。税率ごとの内訳は末尾の税率区分（適格請求書の記載事項）
const MIN_LINES = 11;
function proposalSheet(s) {
  const c = s.company, u = s.customer;
  const no = s.invoiceNo || 'K' + String(s.closing).slice(0, 7).replace('-', '') + String(s.invoiceId).padStart(5, '0');
  const kind = l => (l.shipKb === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上');
  const banks = c.bankParts?.length ? c.bankParts : (c.banks || (c.bankText ? [c.bankText] : [])).map(t => ({ bank: t, branch: '', type: '', acc: '' }));
  const rows = [], heights = {}, merges = [], st = (v, k) => ({ v, s: k }), W = 9;
  const ref = (r, c0, c1) => `${String.fromCharCode(65 + c0)}${r}:${String.fromCharCode(65 + c1)}${r}`;
  // cells：[[列, 終わりの列, 値, スタイル], ...]（終わりの列まで結合。結合した範囲は同じスタイルで罫線を引く）
  const row = (cells, h = 19.5) => { const r = Array(W).fill(''); for (const [a, b, v, sk] of cells) { for (let k = a; k <= b; k++) r[k] = st(k === a ? v : '', sk); if (b > a) merges.push(ref(rows.length + 1, a, b)); } rows.push(r); heights[rows.length - 1] = h; };
  const custAddr = u.postcode === undefined ? u.address || '' : [u.pref, u.addr1, u.addr2].filter(Boolean).join('') || u.address || '';
  const coAddr = [zipOf(c.postcode), [c.pref, c.addr1].filter(Boolean).join('') + (c.addr2 ? ' ' + c.addr2 : '')].filter(Boolean).join('　') || c.address || '';
  row([[4, 4, '請　求　書', 'iTitle'], ...(siteNo(s) > 1 ? [[8, 8, `${c.saisyutsu || '再発行'}（${siteNo(s)}回目）`, 'iTextR']] : [])], 36);
  row([[7, 7, '請求書番号：', 'iTextR'], [8, 8, no, 'iText']]);
  row([[8, 8, jp(s.issuedOn || today()), 'iText']]);
  row([[0, 4, zipOf(u.postcode), 'iText'], [5, 8, c.name, 'iBold']]);
  row([[0, 4, custAddr, 'iText']]);
  row([]);
  row([[5, 8, coAddr, 'iText']]);
  row([[0, 3, u.name, 'iCust'], [4, 4, '御中', 'iBold'], [5, 8, `TEL ${c.tel}${c.fax ? '　FAX ' + c.fax : ''}`, 'iText']], 24);
  row([[5, 8, c.invoiceNo ? `登録番号：${c.invoiceNo}` : '', 'iText']]);
  row([[0, 4, `現場：${s.siteName || '（現場なし）'}${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}`, 'iBold']]);
  // 取引銀行：銀行名・支店名の行と、種別・口座番号の行（2 行で 1 口座）。左は 3 行目から挨拶・対象期間
  const left = [[], [], [[0, 4, '毎度ありがとうございます。', 'iText']], [[0, 4, '下記のとおり御請求申し上げます。', 'iText']], [[1, 4, `${jp(s.periodStart)}　～　${jp(s.closing)}`, 'iText']]];
  const right = banks.flatMap((b, i) => [[...(i ? [] : [[5, 5, '取引銀行', 'iText']]), [6, 7, b.bank, 'iText'], [8, 8, b.branch, 'iText']], [[6, 7, b.type, 'iText'], [8, 8, b.acc, 'iText']]]);
  for (let k = 0; k < Math.max(left.length, right.length); k++) row([...(left[k] || []), ...(right[k] || [])]);
  row([], 12);
  row([[0, 2, '当月御買上額', 'iBoxHi'], [3, 3, '今回消費税', 'iBoxH'], [4, 4, '当月御請求額', 'iBoxHi']], 21);
  row([[0, 2, s.net, 'iBoxBig'], [3, 3, s.tax, 'iBoxNum'], [4, 4, s.total, 'iBoxBig']], 28);
  row([], 18);
  row([[0, 0, '月 日', 'iHead'], [1, 1, '伝票NO', 'iHead'], [2, 2, '区分', 'iHead'], [3, 4, '品　　　名', 'iHead'], [5, 5, '数 量', 'iHead'], [6, 6, '単位', 'iHead'], [7, 7, '単 価', 'iHead'], [8, 8, '金　　額', 'iHead']], 20);
  for (const l of s.lines) row([[0, 0, String(l.date).slice(5).replace('-', '/'), 'iCellC'], [1, 1, l.orderNo, 'iCellC'], [2, 2, kind(l), 'iCellC'], [3, 4, l.itemName, 'iCell'], [5, 5, l.quantity, 'iQty'], [6, 6, l.unit || '', 'iCellC'], [7, 7, l.price, 'iNum'], [8, 8, l.net, 'iNum']], 20);
  for (let k = s.lines.length; k < MIN_LINES; k++) row([[0, 0, '', 'iCell'], [1, 1, '', 'iCell'], [2, 2, '', 'iCell'], [3, 4, '', 'iCell'], [5, 5, '', 'iCell'], [6, 6, '', 'iCell'], [7, 7, '', 'iCell'], [8, 8, '', 'iCell']], 20);
  row([], 14);
  row([[5, 6, '税率区分', 'iHead'], [7, 7, '対象額（税抜）', 'iHead'], [8, 8, '消費税', 'iHead']], 20);
  for (const b of s.buckets) row([[5, 6, `${b.rate}% 対象`, 'iCellC'], [7, 7, b.net, 'iNum'], [8, 8, b.tax, 'iNum']], 20);
  return { name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, heights, merges, gridlines: false, portrait: true,
    footer: `&L&8請求書番号 ${no}&R&8&P / &N`, widths: [9.5, 17, 8, 17, 39, 12, 8, 15, 19] };
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
      // 納入先ごとに最新の発行分を取り、同じ発行回の納入先は1枚にまとめる
      const byIssue = new Map();
      for (const n of [...new Set(want[id].map(siteLabel))]) {
        let doc; try { doc = await issuedDocument(c, id, n); } catch { check(false, `請求No.${id} の現場「${n}」は未発行です。発行後にダウンロードしてください`); }
        if (!byIssue.has(doc.issueNo)) byIssue.set(doc.issueNo, { doc, names: [] }); byIssue.get(doc.issueNo).names.push(n);
      }
      for (const { doc, names } of byIssue.values()) pages.push(...invoicePages(doc, names));
    } else {
      let doc; try { doc = await issuedDocument(c, id); } catch { check(false, `請求No.${id} は未発行です。発行後にダウンロードしてください`); }
      pages.push(...invoicePages(doc, doc.sites));
    }
    for (const s of pages) {
      if ((s.company.layout || 'legacy') !== 'proposal') { sheets.push(legacySheet(s)); continue; }
      sheets.push(proposalSheet(s));
    }
  }
  // シート名は重複させない（同じ請求の別の発行回が並ぶとき）
  const seen = new Map(); for (const sh of sheets) { const n = (seen.get(sh.name) || 0) + 1; seen.set(sh.name, n); if (n > 1) sh.name = `${sh.name.slice(0, 28)}_${n}`; }
  return { name: `請求書_${today()}_${ids.length}件.xlsx`, body: xlsx(sheets) };
}
