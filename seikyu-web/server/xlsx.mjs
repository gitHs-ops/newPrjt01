// Minimal dependency-free .xlsx writer (stored ZIP). Cells: string | number | {v, s:'bold'|'num'|'title'|'sum'}.
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), fname = Buffer.from(name, 'utf8'), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(fname.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(fname.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(h, fname, data); central.push(c, fname); offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const x = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
// qty：数量（小数2桁）。dashTop／dashBottom／dashTopNum：現行の帳票（HAR 系の印刷）と同じ破線の区切り（空のセルも {v:'', s} で線を引く）
const STYLE = { bold: 1, num: 2, title: 3, sum: 4, qty: 5, dashTop: 6, dashBottom: 7, dashTopNum: 8 };
// r*：整形版の帳票（2026-10-29 請求書発行確認表から）。濃紺の帯・薄い罫線・合計ボックス
Object.assign(STYLE, { rTitle: 9, rSub: 10, rCompany: 11, rBand: 12, rBandR: 13, rHead: 14, rSite: 15, rCell: 16, rNum: 17, rQty: 18, rCenter: 19, rSubTotL: 20, rSubTotN: 21, rSumL: 22, rSumN: 23, rTotL: 24, rTotN: 25, rRateL: 26, rRateN: 27, rTitleC: 28, rSubR: 29, rCust: 30, rBig: 31, rTotBig: 32, rBandC: 33, rText: 34, rCompanyW: 35 });
// 現行の帳票の桁：qty3 数量（小数3桁）、price1 単価（小数1桁）、center 見出しの中央寄せ、right 右寄せの文字、titleC 中央寄せの表題（HAR491 材料受払表 2026-11-02）
Object.assign(STYLE, { qty3: 36, price1: 37, center: 38, right: 39, titleC: 40 });
// band：グループ名の小見出し（列見出し bold より薄い灰青 F1F5F9。2026-11-07 ユーザー指示「ヘッダーと違う、もっと薄い色」）
Object.assign(STYLE, { band: 41 });
// rHeadHi／rBigHi：請求書（提案書様式）の 当月御買上額・当月御請求額 の枠（見出し 水色 C6DBF1、金額 太字 14pt。2026-11-08 ユーザー指示）
Object.assign(STYLE, { rHeadHi: 42, rBigHi: 43 });
// i*：請求書（提案書様式）2026-11-08 ユーザー提示の Excel 見本：黒の罫線、表題は枠、（罫線は 2026-11-17 帳票イメージ_20261108.xlsx の請求書に合わせて 表の罫線 中太→細線・表題 太枠→中太枠・御中の下線 中太→細線）、見出しは灰 D9D9D9、請求額の見出しは水色 DDEBF7、文字 11pt
// t*：帳票イメージ_20261108.xlsx の様式（2026-11-17 ユーザー指示「모든 장표 출력은 이 파일의 스타일대로」）。listify() が一覧・リストの帳票をこの書式に置き換える
// v*：請求書（提案書様式）の文字の大きさを 帳票イメージ_20261108.xlsx の請求書に合わせたもの（2026-11-17 ユーザー指示）。
// 本文 10pt・見出し 10pt 太字・会社名／御中／現場／請求額の見出し 11pt 太字・請求額 13pt 太字・得意先名 14pt 太字・表題 16pt 太字（中太枠）・共同企業体名 9pt。罫線は細線。納品書（plans.mjs）の i* は変えない
Object.assign(STYLE, { vTitle: 78, vText: 79, vTextR: 80, vBold: 81, vCust: 82, vBoxHi: 83, vBoxH: 84, vBoxBig: 85, vBoxNum: 86, vHead: 87, vCellC: 88, vCell: 89, vNum: 90, vQty: 91, vFit9: 92, vFit: 93 });
Object.assign(STYLE, { tTitle: 59, tCond: 60, tInfo: 61, tHead: 62, tText: 63, tCenter: 64, tRight: 65, tNum: 66, tQty: 67, tQty3: 68, tPrice1: 69, tBand: 70, tSumL: 71, tSumN: 72, tSumQ: 73, tGrandL: 74, tGrandN: 75, tGrandQ: 76, tPlain: 77 });
Object.assign(STYLE, { iTitle: 44, iText: 45, iTextR: 46, iBold: 47, iCust: 48, iBoxHi: 49, iBoxH: 50, iBoxBig: 51, iBoxNum: 52, iHead: 53, iCellC: 54, iCell: 55, iNum: 56, iQty: 57, iTextFit: 58 });   // iTextFit：長い文字は縮小して枠に収める（共同企業体名）
// 印刷は横1ページに収める（pageSetUpPr fitToPage が無いと fitToWidth が効かず、右の列が次のページに分かれる）
// header：印刷時のページヘッダー（例 '&R&P 頁'）。printTitles：各ページに繰り返す見出し行（例 '4:5'。xlsx() で定義名にする）
function sheetXml({ rows: given0, widths = [], header, footer, heights = {}, merges: given = [], gridlines = true, portrait = false, margins = [0.5, 0.6], listed = false }) {
  const rows = listed ? given0 : evenBands(given0);   // listify 済みはグループ名の結合も決まっている
  const merges = [...given, ...rows.flatMap((r, ri) => (r?.span > 1 ? [`${col(r.start || 0)}${ri + 1}:${col((r.start || 0) + r.span - 1)}${ri + 1}`] : []))];
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows.map((r, ri) => `<row r="${ri + 1}"${heights[ri] ? ` ht="${heights[ri]}" customHeight="1"` : ''}>${(r || []).map((cell, ci) => {
    if (cell === null || cell === undefined || cell === '') return '';
    const o = typeof cell === 'object' ? cell : { v: cell }, ref = col(ci) + (ri + 1);
    const s = STYLE[o.s] ?? (typeof o.v === 'number' ? 2 : 0);
    if (o.v === '' || o.v === null || o.v === undefined) return `<c r="${ref}" s="${s}"/>`;
    return typeof o.v === 'number' && Number.isFinite(o.v) ? `<c r="${ref}" s="${s}"><v>${o.v}</v></c>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(o.v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const hf = header || footer ? `<headerFooter>${header ? `<oddHeader>${x(header)}</oddHeader>` : ''}${footer ? `<oddFooter>${x(footer)}</oddFooter>` : ''}</headerFooter>` : '';
  const mc = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const sv = gridlines ? '' : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${sv}${cols}<sheetData>${body}</sheetData>${mc}<pageMargins left="${margins[0]}" right="${margins[0]}" top="${margins[1]}" bottom="${margins[1]}" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${portrait ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="0"/>${hf}</worksheet>`;
}
// 小見出しの行（得意先・仕入先・組織などのグループ名）：名前が入る分の列だけ結合して見出しの色を付ける（2026-11-07 ユーザー指示。
// 1 セルだけ・全列だと不自然）。cells は列の位置どおり：最初の値が名前（その列から）、次に値のある列の手前まで結合。結合は sheetXml が row.span・row.start から作る。
// 結合の幅はシートの中で揃える（いちばん長い名前に合わせる。行ごとに違うと読みにくい：2026-11-07 ユーザー指摘）。右に値のある行はその手前まで
const textWidth = s => [...String(s ?? '')].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2000 || (ch >= '｡' && ch <= 'ﾟ') ? 1 : 2), 0);
export function band(widths, cells) {
  const has = c => c !== '' && c !== null && c !== undefined, start = Math.max(0, cells.findIndex(has)), name = cells[start];
  const stop = cells.findIndex((c, i) => i > start && has(c)), max = (stop > 0 ? stop : Math.max(widths.length, start + 1)) - start;
  const need = textWidth(name) * 1.1 + 2; let span = 1, w = widths[start] ?? 9;
  while (span < max && w < need) w += widths[start + span++] ?? 9;
  const row = cells.slice(); row[start] = { v: name, s: 'band' };
  Object.assign(row, { span, start, max }); return row;
}
function evenBands(rows) {
  const uni = {}; for (const r of rows) if (r?.span) uni[r.start] = Math.max(uni[r.start] || 0, r.span);
  return rows.map(r => {
    if (!r?.span) return r;
    const span = Math.min(uni[r.start], r.max), row = r.slice();
    for (let i = 0; i < span; i++) row[r.start + i] = { v: i ? '' : r[r.start].v, s: 'band' };
    return Object.assign(row, { span, start: r.start });
  });
}
// ---------- 帳票イメージ_20261108 の様式（2026-11-17 ユーザー指示） ----------
// 各帳票の行（表題・抽出条件・見出し・明細・合計）の内容はそのままにして、書式と配置だけを帳票イメージに合わせる：
//   A 列と 1 行目は余白、表題は中央（字間を空ける）、抽出条件は左、出力日・会社名などは右上、見出しは灰色 F2F2F2、
//   明細は縦の罫線＋行の間の細線、小計は太字網掛け FAFAFA、総合計は太字網掛け EDEDED、グループ名は E8EEF7、
//   フッターに頁番号、見出し行を各頁に繰り返す、ＭＳ ゴシック 9pt、余白 左右 0.4・上下 0.6。明細の間の空行は詰める。
// 請求書・納品書（doc: true）は文書の様式なのでそのまま。
const TITLE_S = new Set(['title', 'titleC', 'rTitle', 'rTitleC', 'iTitle', 'vTitle']), HEAD_S = new Set(['bold', 'rHead', 'iHead', 'vHead', 'rHeadHi', 'rBand', 'rBandR', 'rBandC']);
const SUM_S = new Set(['sum', 'rSubTotL', 'rSubTotN', 'rSumL', 'rSumN', 'rTotL', 'rTotN', 'rTotBig']), BAND_S = new Set(['band', 'rSite', 'rCust']);
const QTY_S = new Set(['qty', 'rQty', 'iQty']), CENTER_S = new Set(['center', 'rCenter', 'iCellC']), RIGHT_S = new Set(['right', 'rSubR']);
const cellOf = c => (c !== null && typeof c === 'object' ? c : { v: c ?? '' }), filled = c => { const v = cellOf(c).v; return v !== '' && v !== null && v !== undefined; };
const spaced = t => String(t).replace(/([぀-ヿ一-鿿々・])(?=[぀-ヿ一-鿿々・])/g, '$1 ');
const colNo = c => { let n = 0; for (const ch of c) n = n * 26 + ch.charCodeAt(0) - 64; return n; };   // 'A' → 1
function listify(sh) {
  const rows0 = evenBands(sh.rows || []);
  const kind = r => {
    const cs = (r || []).map(cellOf).filter(filled);
    if (!cs.length) return 'empty';
    if (cs.some(c => TITLE_S.has(c.s))) return 'title';
    if ((r || []).some(c => BAND_S.has(cellOf(c).s))) return 'band';
    if (cs.every(c => HEAD_S.has(c.s))) return 'head';
    const txt = cs.filter(c => typeof c.v === 'string').map(c => c.v.replace(/[\s　]/g, ''));
    const isSum = cs.some(c => SUM_S.has(c.s)) || (cs.some(c => typeof c.v === 'number') && txt.some(x => /^(.{0,8}計|合計|総合計)$/.test(x)));
    if (isSum) return txt.some(x => /総合計|会社合計/.test(x)) ? 'grand' : 'sum';
    return 'data';
  };
  const K = rows0.map(kind), t = K.indexOf('title');
  // 現行の様式で見出しに書式の無い帳票（自動仕訳リスト）は printTitles の行を見出しにする
  const pt = sh.printTitles ? sh.printTitles.split(':').map(Number) : null;
  if (pt) for (let i = pt[0] - 1; i < pt[1]; i++) if (i > t + 1 && K[i] !== 'empty' && K[i] !== 'title') K[i] = 'head';
  const start = K.findIndex((k, i) => i > t + (t >= 0 ? 1 : -1) && (k === 'head' || k === 'band'));
  const W = Math.max(sh.widths?.length || 0, ...rows0.slice(Math.max(start, 0)).map(r => (r || []).length), 1);
  // 右上に出すもの：抽出条件の行の「出力日…／作成日…」と、表題の行の表題以外（会社名・日付）
  const info = [], condAt = t >= 0 && t + 1 < rows0.length && (start < 0 || t + 1 < start) ? t + 1 : -1;
  const rows = rows0.map(r => Object.assign((r || []).slice(), r?.span ? { span: r.span, start: r.start, max: r.max } : {}));
  if (condAt >= 0) rows[condAt] = rows[condAt].map(c => {
    const o = cellOf(c); if (typeof o.v !== 'string') return c;
    const m = o.v.match(/[\s　]*((出力日時?|作成日|出力)[\s　:：]*[0-9０-９/\-:年月日 ]+)/); if (!m) return c;
    info.push(m[1].trim()); return o.v.replace(m[0], '').trim();
  });
  if (t >= 0) rows[t].forEach(c => { const o = cellOf(c); if (filled(o) && !TITLE_S.has(o.s)) info.push(String(o.v)); });
  const out = [[]], heights = { 0: 12 }, map = [];
  let firstHead = -1, lastHead = -1;
  rows.forEach((r, i) => {
    const k = K[i];
    if (k === 'empty' && start >= 0 && i > start && K.slice(i + 1).some(x => x !== 'empty')) { map[i] = out.length; return; }   // 明細の間の空行は詰める
    const n = out.length; map[i] = n; let row;
    const sty = c => {
      const o = cellOf(c), v = o.v ?? '', num = typeof v === 'number', s = o.s;
      if (k === 'head') return { v, s: 'tHead' };
      if (k === 'band') return { v, s: 'tBand' };
      if (k === 'sum' || k === 'grand') { const g = k === 'grand' ? 'tGrand' : 'tSum'; return { v, s: num ? (QTY_S.has(s) ? g + 'Q' : g + 'N') : g + 'L' }; }
      if (num) return { v, s: QTY_S.has(s) ? 'tQty' : s === 'qty3' ? 'tQty3' : s === 'price1' ? 'tPrice1' : 'tNum' };
      return { v, s: CENTER_S.has(s) ? 'tCenter' : RIGHT_S.has(s) ? 'tRight' : 'tText' };
    };
    if (i === t) { row = [{ v: spaced(cellOf(r.find(c => TITLE_S.has(cellOf(c).s))).v), s: 'tTitle' }]; heights[n] = 26; }
    else if (start >= 0 && i >= start && k !== 'empty') {
      row = Array.from({ length: Math.max(W, r.length) }, (_, j) => sty(r[j]));
      if (r.span) Object.assign(row, { span: r.span, start: r.start, max: r.max });
      heights[n] = k === 'head' ? 16 : 15;
      if (k === 'head' && (firstHead < 0 || lastHead === n - 1)) { if (firstHead < 0) firstHead = n; lastHead = n; }
    } else row = r.map(c => (filled(c) ? { v: cellOf(c).v, s: i === condAt ? 'tCond' : 'tPlain' } : ''));
    out.push(row);
  });
  // 右上（最終列・右寄せ）：1 つ目は抽出条件の行、2 つ目以降は次の行（空いていなければ抽出条件の行にまとめる）
  if (info.length) {
    const r1 = condAt >= 0 ? map[condAt] : t >= 0 ? map[t] + 1 : 1, r2 = r1 + 1;
    const free = (start < 0 || r2 < map[start]) && !(out[r2] || []).some(filled);
    const put = (ri, text) => { while (out.length <= ri) out.push([]); out[ri][W - 1] = { v: text, s: 'tInfo' }; };
    if (free && info.length > 1) { put(r1, info[0]); put(r2, info.slice(1).join('　')); } else put(r1, info.join('　'));
  }
  // A 列の余白：すべての行を 1 列右へ（表題は表の幅で結合して中央）
  const shifted = out.map((r, n) => {
    const row = ['', ...(r || [])];
    if (n === map[t]) Object.assign(row, { span: W, start: 1, max: W });
    else if (r?.span) Object.assign(row, { span: r.span, start: (r.start || 0) + 1, max: r.max });
    return row;
  });
  for (const [i, h] of Object.entries(sh.heights || {})) if (map[i] !== undefined) heights[map[i]] = h;
  // 元の結合（材料受払表の見出しなど）は新しい位置へ。表題の行の結合は表題の結合と重なるので外す
  const merges = (sh.merges || []).filter(m => !(t >= 0 && m.match(/\d+/g).some(x => Number(x) === t + 1)))
    .map(m => m.replace(/([A-Z]+)(\d+)/g, (_, c, r) => col(colNo(c)) + (map[r - 1] + 1)));
  return { ...sh, listed: true, rows: shifted, widths: [1.5, ...(sh.widths || [])], heights, merges, gridlines: false, header: undefined, footer: '&C&P / &N 頁', margins: [0.4, 0.6],
    printTitles: lastHead >= 0 ? `1:${lastHead + 1}` : undefined };
}
export function xlsx(sheets0) {
  const sheets = sheets0.map(s => (s.doc ? s : listify(s)));
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.some(s => s.printTitles) ? `<definedNames>${sheets.map((s, i) => s.printTitles ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${x(s.name).slice(0, 31).replace(/'/g, "''")}'!$${s.printTitles.replace(':', ':$')}</definedName>` : '').join('')}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="8"><numFmt numFmtId="164" formatCode="#,##0;[Red]-#,##0"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="166" formatCode="#,##0.000;[Red]-#,##0.000"/><numFmt numFmtId="167" formatCode="#,##0.0;[Red]-#,##0.0"/><numFmt numFmtId="168" formatCode="#,##0;-#,##0"/><numFmt numFmtId="169" formatCode="#,##0.00;-#,##0.00"/><numFmt numFmtId="170" formatCode="#,##0.000;-#,##0.000"/><numFmt numFmtId="171" formatCode="#,##0.0;-#,##0.0"/></numFmts><fonts count="21"><font><sz val="10"/><name val="Meiryo UI"/></font><font><b/><sz val="10"/><name val="Meiryo UI"/></font><font><b/><sz val="14"/><name val="Meiryo UI"/></font><font><b/><sz val="16"/><color rgb="FF1E3A5F"/><name val="Meiryo UI"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Meiryo UI"/></font><font><sz val="9"/><color rgb="FF64748B"/><name val="Meiryo UI"/></font><font><b/><sz val="10"/><color rgb="FF1E3A5F"/><name val="Meiryo UI"/></font><font><b/><sz val="20"/><color rgb="FF1E3A5F"/><name val="Meiryo UI"/></font><font><b/><sz val="12"/><name val="Meiryo UI"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Meiryo UI"/></font><font><sz val="11"/><name val="Meiryo UI"/></font><font><b/><sz val="11"/><name val="Meiryo UI"/></font><font><b/><sz val="14"/><name val="Meiryo UI"/></font><font><b/><sz val="18"/><name val="Meiryo UI"/></font><font><b/><sz val="16"/><name val="Meiryo UI"/></font><font><sz val="9"/><name val="ＭＳ ゴシック"/><family val="3"/><charset val="128"/></font><font><b/><sz val="9"/><name val="ＭＳ ゴシック"/><family val="3"/><charset val="128"/></font><font><sz val="10"/><name val="ＭＳ ゴシック"/><family val="3"/><charset val="128"/></font><font><b/><sz val="16"/><name val="ＭＳ ゴシック"/><family val="3"/><charset val="128"/></font><font><b/><sz val="13"/><name val="Meiryo UI"/></font><font><sz val="9"/><name val="Meiryo UI"/></font></fonts><fills count="13"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6DBF1"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFAFAFA"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/></patternFill></fill></fills><borders count="15"><border/><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border><border><left/><right/><top style="dashed"/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="dashed"/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFCBD5E1"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FF1E3A5F"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF94A3B8"/></top><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border><border><left style="medium"/><right style="medium"/><top style="medium"/><bottom style="medium"/><diagonal/></border><border><left style="thick"/><right style="thick"/><top style="thick"/><bottom style="thick"/><diagonal/></border><border><left/><right/><top/><bottom style="medium"/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="hair"/><bottom style="hair"/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="hair"/><diagonal/></border><border><left/><right/><top/><bottom style="thin"/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="94"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="3" xfId="0" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="5" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="5" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="6" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="1" fillId="0" borderId="6" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="1" fillId="0" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="4" fillId="3" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="8" fillId="0" borderId="5" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="8" fillId="0" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="164" fontId="9" fillId="3" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="6" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="2" fillId="0" borderId="7" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>${[
      [0, 13, 0, 8, 'center'], [0, 10, 0, 0, 'left'], [0, 10, 0, 0, 'right'], [0, 11, 0, 0, 'left'], [0, 12, 0, 14, 'right'],
      [0, 11, 8, 12, 'center'], [0, 10, 0, 12, 'center'], [164, 14, 0, 12, 'center'], [164, 10, 0, 12, 'right'],
      [0, 11, 7, 12, 'center'], [0, 10, 0, 12, 'center'], [0, 10, 0, 12, 'left'], [164, 10, 0, 12, 'right'], [165, 10, 0, 12, 'right'],
      [0, 10, 0, 0, 'left" shrinkToFit="1'],
      // t*（帳票イメージ_20261108）：59 表題 60 抽出条件 61 右上 62 見出し 63〜69 明細 70 グループ名 71〜73 小計 74〜76 総合計 77 その他
      [0, 18, 0, 0, 'center'], [0, 17, 0, 0, 'left'], [0, 15, 0, 0, 'right'], [0, 16, 9, 12, 'center" wrapText="1'],
      [0, 15, 0, 11, 'left'], [0, 15, 0, 11, 'center'], [0, 15, 0, 11, 'right'], [168, 15, 0, 11, 'right'], [169, 15, 0, 11, 'right'], [170, 15, 0, 11, 'right'], [171, 15, 0, 11, 'right'],
      [0, 16, 10, 13, 'left'], [0, 16, 11, 13, 'left'], [168, 16, 11, 13, 'right'], [169, 16, 11, 13, 'right'], [0, 16, 12, 12, 'left'], [168, 16, 12, 12, 'right'], [169, 16, 12, 12, 'right'],
      [0, 15, 0, 0, 'left'],
      // v*（請求書・帳票イメージ_20261108 の文字の大きさ）：78 表題 79 本文 80 本文右 81 太字 82 得意先名 83〜86 請求額の枠 87 見出し 88〜91 明細 92 共同企業体名 93 縮小
      [0, 14, 0, 8, 'center'], [0, 0, 0, 0, 'left'], [0, 0, 0, 0, 'right'], [0, 11, 0, 0, 'left'], [0, 12, 0, 14, 'right'],
      [0, 11, 8, 12, 'center'], [0, 0, 0, 12, 'center'], [164, 19, 0, 12, 'right'], [164, 10, 0, 12, 'right'],
      [0, 1, 7, 12, 'center'], [0, 0, 0, 12, 'center'], [0, 0, 0, 12, 'left'], [164, 0, 0, 12, 'right'], [165, 0, 0, 12, 'right'],
      [0, 20, 0, 0, 'left" shrinkToFit="1'], [0, 0, 0, 0, 'left" shrinkToFit="1'],
    ].map(([n, f, fill, b, h]) => `<xf numFmtId="${n}" fontId="${f}" fillId="${fill}" borderId="${b}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${h}" vertical="center"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files);
}
