// NO10 請求書の一括ダウンロード：発行済み請求書（最新の発行スナップショット）を Excel にまとめる。現場ごとに1シート（指摘 No.18）
import { check, today } from './domain.mjs';
import { issuedDocument, siteLabel } from './sales.mjs';
import { xlsx } from './xlsx.mjs';
import { digitOfRate } from './taxcode.mjs';

const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
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
// 2026-11-04 請求書は請求現場（明細の現場CD・枝番）ごとに1枚（現行 帳票③④⑤）。現場CD の無い明細は現場名ごとに1枚（2026-11-12）。納入先（明細の現場名）は備考に出すだけ。工事名は請求現場の名称（現場マスタ。s.siteNames）。
// 一部の納入先だけを発行した回（現場別発行）は、その納入先の明細・金額だけ。消費税は splitBySite と同じ按分（納入先ごと）を請求現場ごとに足す。want＝納入先の名前（無ければ全部）
const invoicePages = (s, want) => {
  const parts = splitBySite(s), mine = want ? parts.filter(p => want.includes(siteLabel(p.siteName))) : parts, g = new Map();
  // 現場CD の無い明細は現場名（納入先）ごとに 1 枚（請求一覧照会と同じ単位。2026-11-12 テスト指摘 STEP⑥ 得意先 1057）。コード無しの現場が先、出てきた順
  const keyOf = p => { const st = p.lines[0]?.site || ''; return st && st !== '|' ? st : '|' + siteLabel(p.siteName); }, noCode = k => k.startsWith('|');
  for (const p of mine) { const k = keyOf(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
  const keys = [...g.keys()].sort((a, b) => (noCode(a) || noCode(b) ? noCode(b) - noCode(a) : a < b ? -1 : a > b ? 1 : 0)), whole = keys.length === 1 && mine.length === parts.length;
  return keys.map((k, i) => {
    const ps = g.get(k), buckets = []; for (const p of ps) for (const b of p.buckets) { const x = buckets.find(y => y.rate === b.rate); if (x) { x.net += b.net; x.tax += b.tax; } else buckets.push({ ...b }); }
    const net = whole ? s.net : ps.reduce((n, p) => n + p.net, 0), tax = whole ? s.tax : ps.reduce((n, p) => n + p.tax, 0), total = net + tax, keep = new Set(ps.flatMap(p => p.lines));
    const no = Math.max(...ps.map(p => p.siteIssueNo?.[siteLabel(p.siteName)] ?? p.issueNo ?? 0));
    return { ...s, lines: s.lines.filter(l => keep.has(l)), buckets: whole ? s.buckets : buckets, net, tax, total, discount: 0, prevBalance: 0, received: 0, carried: 0, grandTotal: total, siteName: noCode(k) ? (g.get(k)[0].siteName === '（現場なし）' ? '' : g.get(k)[0].siteName) : s.siteNames?.[k] || '', page: i + 1, pages: keys.length, pageIssueNo: no || undefined };
  });
};
// 現行の請求書（帳票③④⑤、2026-11-04）：印刷の legacyInvoice と同じ並び。A4 横・目盛線なし
// 当月値引額の欄は設けない（D-022・D-006。0 を出すのは請求書発行確認表②・請求一覧表①だけ。2026-11-16）
// 版の表示（2026-11-20 ユーザー指示）：④ 訂正分・⑤ 修正版の請求書は表題の横に【訂正分】【修正版】。③ 初回発行版（通常の発行）は出さない
const EDITION = { diff: '訂正分', all: '修正版' }, edition = s => (EDITION[s.kind] ? `【${EDITION[s.kind]}】` : '');
const zipOf = z => (z ? `〒 ${String(z).replace(/^(\d{3})-?(\d{4})$/, '$1-$2')}` : '');
function legacySheet(s) {
  const c = s.company, u = s.customer, ymd = d => String(d || '').slice(2).replaceAll('-', '/'), day = Number(String(s.closing).slice(8)), banks = c.banks || (c.bankText ? [c.bankText] : []);
  const rows = [], heights = {}, merges = [], st = (v, k) => ({ v, s: k });
  const ref = (r, c0, c1) => `${String.fromCharCode(65 + c0)}${r}:${String.fromCharCode(65 + c1)}${r}`;
  const push = (cells, h) => { rows.push(cells); if (h) heights[rows.length - 1] = h; return rows.length; };
  merges.push(ref(push([st(`請　求　書${edition(s) ? '　' + edition(s) : ''}`, 'rTitleC')], 30), 0, 7));
  // 「再発行（N回目）」は出さない（2026-11-17 ユーザー指示）
  const left = [[zipOf(u.postcode), 'rText'], ...(u.postcode === undefined ? [[u.address || '', 'rText']] : [[[u.pref, u.addr1].filter(Boolean).join('　'), 'rText'], [u.addr2 || '', 'rText']]), ['', 'rText'], [`${u.name}　　御中`, 'rCust']];
  const right = [[zipOf(c.postcode), 'rText'], [[c.pref, c.addr1].filter(Boolean).join('') + (c.addr2 ? ' ' + c.addr2 : '') || c.address || '', 'rText'], [c.name1 || c.name, 'rText'], ...(c.invoiceNo ? [[c.invoiceNo, 'rText']] : []), [`${c.name2 ? c.name2 + '　　' : ''}TEL. ${c.tel}`, 'rText'], ['', 'rText'], ...banks.map(b => [b, 'rSubR']), ...(banks.length ? [[c.name1 || c.name, 'rSubR']] : [])];
  for (let k = 0; k < Math.max(left.length, right.length); k++) { const [lv, ls] = left[k] || ['', 'rText'], [rv, rs] = right[k] || ['', 'rText'], r = push([st(lv, ls), '', '', '', st(rv, rs)], 17); merges.push(ref(r, 0, 3), ref(r, 4, 7)); }
  push([], 10);
  push(['', '', '', '', '', st('請求年月日', 'rCenter'), st('得意先コード', 'rCenter'), st('締日', 'rCenter')]);
  push(['', '', '', '', '', st(ymd(s.closing), 'rCenter'), st(u.code, 'rCenter'), st(day >= 28 ? 31 : day, 'rCenter')]);
  push([], 10);
  merges.push(ref(push([st('工　事　名', 'rCenter'), '', '', st('当月御買上額', 'rCenter'), '', st('消費税額', 'rCenter'), '', st('当月御請求額', 'rCenter')]), 0, 2), ref(rows.length, 3, 4), ref(rows.length, 5, 6));
  merges.push(ref(push([st(s.siteName || '', 'rCenter'), '', '', st(s.net, 'rNum'), '', st(s.tax, 'rNum'), '', st(s.total, 'rNum')]), 0, 2), ref(rows.length, 3, 4), ref(rows.length, 5, 6));
  push([], 12);
  // 明細の右端の区分（見出しなし）は現行 帳票③④⑤ どおり税率区分（処税率の 3 桁目。10%＝1）。請求書番号は現行に無いので出さない（2026-11-25 ユーザー指示「現行どおり」）
  push(['年月日', '伝票番号', '商品名', '数量', '単位', '単価', '金額', '備考', ''].map(h => st(h, 'rHead')), 18);
  // 全部の請求書（⑤）の赤黒の行（box）は現行どおり枠で囲む（2026-11-18）。枠の上下は box の続きの最初・最後の行
  s.lines.forEach((l, k) => {
    const b = l.box ? (s.lines[k - 1]?.box ? (s.lines[k + 1]?.box ? 'M' : 'B') : (s.lines[k + 1]?.box ? 'T' : 'S')) : '', bx = (name, side = 'I') => (b ? `box${b}${side}_${name}` : name);
    push([st(ymd(l.date), bx('rCenter', 'L')), st(l.orderNo, bx('rCell')), st(l.itemName, bx('rCell')), st(l.quantity, bx('rQty')), st(l.unit || '', bx('rCenter')), st(l.price, bx('rNum')), st(l.net, bx('rNum')), st(`${l.siteName || ''}${l.remarks ? ' ' + l.remarks : ''}`, bx('rCell')), st(digitOfRate(l.taxRate) ?? '', bx('rCenter', 'R'))], 17);
  });
  push([], 8);
  for (const b of s.buckets) { push(['', '', '', '', '', '', st(b.net, 'rNum'), st(`${b.rate}%`, 'rCell')]); push(['', '', '', '', '', '', st(b.tax, 'rNum'), st('税', 'rCell')]); }
  return { name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, heights, merges, gridlines: false, widths: [10, 11, 30, 10, 6, 11, 13, 34, 4] };
}
// 提案書様式の請求書（2026-11-08 ユーザー提示の Excel 見本どおり）：A4 縦・目盛線なし・黒の罫線。
// 2026-11-17 文字の大きさ・列の幅・行の高さを 帳票イメージ_20261108.xlsx の請求書に合わせた（ユーザー指示）。列の幅は見本の B〜K と同じ並び
// （A 月日 8.5・B 伝票NO 13・C 区分 5・D:F 品名 12＋9＋24（見本の備考の幅を品名に）・G 数量 8・H 単位 5・I 単価 9・J 金額 11。合計は見本とほぼ同じなので印刷の縮小率も見本と同じ）。
// 表題は D:E の中太枠。左に得意先（〒・住所・名称 御中（下線）・現場・挨拶・対象期間）、右（F〜J）に請求書番号・日付と発行元（会社名・〒住所・TEL・登録番号・取引銀行（銀行・支店／種別・口座番号））。
// 請求額の枠は 当月御買上額（A:C）・今回消費税（D:E）・当月御請求額（F）。明細は空行を足して 11 行以上。税率ごとの内訳は末尾の税率区分（適格請求書の記載事項）
const MIN_LINES = 11;
function proposalSheet(s) {
  const c = s.company, u = s.customer;
  const no = s.invoiceNo || 'K' + String(s.closing).slice(0, 7).replace('-', '') + String(s.invoiceId).padStart(5, '0');
  const kind = l => (l.shipKb === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上');
  const banks = c.bankParts?.length ? c.bankParts : (c.banks || (c.bankText ? [c.bankText] : [])).map(t => ({ bank: t, branch: '', type: '', acc: '' }));
  const rows = [], heights = {}, merges = [], st = (v, k) => ({ v, s: k }), W = 10, H = 17.1;
  const ref = (r, c0, c1) => `${String.fromCharCode(65 + c0)}${r}:${String.fromCharCode(65 + c1)}${r}`;
  // cells：[[列, 終わりの列, 値, スタイル], ...]（終わりの列まで結合。結合した範囲は同じスタイルで罫線を引く）
  const row = (cells, h = H) => { const r = Array(W).fill(''); for (const [a, b, v, sk] of cells) { for (let k = a; k <= b; k++) r[k] = st(k === a ? v : '', sk); if (b > a) merges.push(ref(rows.length + 1, a, b)); } rows.push(r); heights[rows.length - 1] = h; };
  const custAddr = u.postcode === undefined ? u.address || '' : [u.pref, u.addr1, u.addr2].filter(Boolean).join('') || u.address || '';
  const coAddr = [zipOf(c.postcode), [c.pref, c.addr1].filter(Boolean).join('') + (c.addr2 ? ' ' + c.addr2 : '')].filter(Boolean).join('　') || c.address || '';
  row([[3, 4, '請　求　書', 'vTitle'], ...(edition(s) ? [[5, 6, edition(s), 'vBold']] : [])], 28); // 「再発行（N回目）」は出さない（2026-11-17 ユーザー指示）
  row([[6, 7, '請求書番号：', 'vTextR'], [8, 9, no, 'vText']]);
  row([[8, 9, jp(s.issuedOn || today()), 'vText']]);
  // 得意先コード・締日の行（現行 ③④⑤・帳票イメージ REP-INV-0020。2026-11-26 プロトタイプ再検証 E-4）。締日は現行どおり数字（28 以降は 31）
  { const dd = Number(String(s.closing).slice(8)); row([[6, 7, '得意先コード：', 'vTextR'], [8, 8, u.code, 'vText'], [9, 9, `締日 ${dd >= 28 ? 31 : dd}`, 'vText']]); }
  // 会社名1（太字）の下に会社名2（共同企業体名。長いので別の行）
  row([[0, 4, zipOf(u.postcode), 'vText'], [5, 9, c.name1 || c.name, 'vBold']]);
  row([[0, 4, custAddr, 'vText'], [5, 9, c.name1 ? c.name2 || '' : '', 'vFit9']]);
  row([]);
  row([[5, 9, coAddr, 'vFit']]);
  row([[0, 3, u.name, 'vCust'], [4, 4, '御中', 'vBold'], [5, 9, `TEL ${c.tel}${c.fax ? '　FAX ' + c.fax : ''}`, 'vText']], 24);
  row([[5, 9, c.invoiceNo ? `登録番号：${c.invoiceNo}` : '', 'vText']]);
  // 現場：請求現場（現場マスタ）の名称。現場コードの無い明細は納入先（明細の現場名）を出す
  row([[0, 4, `現場：${s.siteName || [...new Set(s.lines.map(l => l.siteName).filter(Boolean))].join('・') || '（現場なし）'}${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}`, 'vBold']]);
  // 取引銀行：銀行名・支店名の行と、種別・口座番号の行（2 行で 1 口座）。左は 3 行目から挨拶・対象期間
  const left = [[], [], [[0, 4, '毎度ありがとうございます。', 'vText']], [[0, 4, '下記のとおり御請求申し上げます。', 'vText']], [[1, 4, `${jp(s.periodStart)}　～　${jp(s.closing)}`, 'vText']]];
  const right = banks.flatMap((b, i) => [[...(i ? [] : [[5, 5, '取引銀行', 'vTextR']]), [6, 8, b.bank, 'vFit'], [9, 9, b.branch, 'vFit']], [[6, 8, b.type, 'vText'], [9, 9, b.acc, 'vFit']]]);
  for (let k = 0; k < Math.max(left.length, right.length); k++) row([...(left[k] || []), ...(right[k] || [])]);
  row([]);
  row([[0, 2, '当月御買上額', 'vBoxHi'], [3, 4, '今回消費税', 'vBoxH'], [5, 5, '当月御請求額', 'vBoxHi']]);
  row([[0, 2, s.net, 'vBoxBig'], [3, 4, s.tax, 'vBoxNum'], [5, 5, s.total, 'vBoxBig']], 24);
  row([]);
  row([[0, 0, '年月日', 'vHead'], [1, 1, '伝票NO', 'vHead'], [2, 2, '区分', 'vHead'], [3, 5, '品　　　名', 'vHead'], [6, 6, '数 量', 'vHead'], [7, 7, '単位', 'vHead'], [8, 8, '単 価', 'vHead'], [9, 9, '金　　額', 'vHead']]);
  // 全部の請求書（⑤）の赤黒の行（box）は現行どおり枠で囲む（2026-11-18）
  s.lines.forEach((l, k) => {
    const b = l.box ? (s.lines[k - 1]?.box ? (s.lines[k + 1]?.box ? 'M' : 'B') : (s.lines[k + 1]?.box ? 'T' : 'S')) : '', bx = (name, side = 'I') => (b ? `box${b}${side}_${name}` : name);
    row([[0, 0, String(l.date).slice(2, 10).replaceAll('-', '/'), bx('vCellC', 'L')], [1, 1, l.orderNo, bx('vCellC')], [2, 2, kind(l), bx('vCellC')], [3, 5, l.itemName, bx('vCell')], [6, 6, l.quantity, bx('vQty')], [7, 7, l.unit || '', bx('vCellC')], [8, 8, l.price, bx('vNum')], [9, 9, l.net, bx('vNum', 'R')]]);
  });
  for (let k = s.lines.length; k < MIN_LINES; k++) row([[0, 0, '', 'vCell'], [1, 1, '', 'vCell'], [2, 2, '', 'vCell'], [3, 5, '', 'vCell'], [6, 6, '', 'vCell'], [7, 7, '', 'vCell'], [8, 8, '', 'vCell'], [9, 9, '', 'vCell']]);
  row([]);
  row([[5, 5, '税率区分', 'vHead'], [6, 8, '対象額（税抜）', 'vHead'], [9, 9, '消費税', 'vHead']]);
  for (const b of s.buckets) row([[5, 5, `${b.rate}% 対象`, 'vCellC'], [6, 8, b.net, 'vNum'], [9, 9, b.tax, 'vNum']]);
  return { name: `${s.invoiceId}_${s.customer.code}${s.pages > 1 ? '_' + s.page : ''}`.slice(0, 31), rows, heights, merges, gridlines: false, portrait: true, margins: [0.4, 0.6],
    footer: `&L&8請求書番号 ${no}&R&8&P / &N`, widths: [9, 13, 5, 12, 9, 24, 8, 5, 9, 11] };   // 月日は yy/mm/dd（2026-11-26）
}
// sites：{請求ID: [現場名]}（JSON、2026-10-27 現場別発行）。指定した現場はその現場の最新の発行分、指定が無い請求は最新の発行分で発行した現場
// kind（new・diff・all）：その区分の最後の発行分（2026-11-18 現行 帳票③ 新規・④ 訂正分・⑤ 全部）
export async function invoiceBook(c, q) {
  const kind = ['new', 'diff', 'all'].includes(q.kind) ? q.kind : null;
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
        let doc; try { doc = await issuedDocument(c, id, n, kind); } catch { check(false, `請求No.${id} の現場「${n}」は未発行です。発行後にダウンロードしてください`); }
        if (!byIssue.has(doc.issueNo)) byIssue.set(doc.issueNo, { doc, names: [] }); byIssue.get(doc.issueNo).names.push(n);
      }
      for (const { doc, names } of byIssue.values()) pages.push(...invoicePages(doc, names));
    } else {
      let doc; try { doc = await issuedDocument(c, id, null, kind); } catch { check(false, `請求No.${id} は未発行です。発行後にダウンロードしてください`); }
      pages.push(...invoicePages(doc, doc.sites));
    }
    for (const s of pages) {
      if ((s.company.layout || 'legacy') !== 'proposal') { sheets.push(legacySheet(s)); continue; }
      sheets.push(proposalSheet(s));
    }
  }
  // シート名は重複させない（同じ請求の別の発行回が並ぶとき）
  const seen = new Map(); for (const sh of sheets) { const n = (seen.get(sh.name) || 0) + 1; seen.set(sh.name, n); if (n > 1) sh.name = `${sh.name.slice(0, 28)}_${n}`; }
  return { name: `請求書_${today()}_${ids.length}件.xlsx`, body: xlsx(sheets.map(s => ({ ...s, doc: true }))) };   // 請求書は文書の様式（帳票イメージの一覧様式にしない）
}
