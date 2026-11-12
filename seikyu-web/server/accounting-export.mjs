// NO20 会計連携（データダウンロード）。会計システムは勘定奉行（奉行クラウド）が前提（10/14 打合せ・QA 回答 2026-10-08）。
//  bugyo   … 勘定奉行向け（借貸併記 CSV、見出しは会計設定の OBC受入記号／未登録は項目名、税区分は処税率→奉行税区分の対応表）
//  generic … 借貸併記（現行自動仕訳リストと同じ並び）UTF-8 BOM CSV、科目・内訳はコード＋名称
//  yayoi   … 弥生会計「仕訳日記帳」インポート形式（25項目、Shift_JIS）。科目は名称、税区分は処税率を分解して変換
// 補助科目は内訳科目だけ。得意先・業者は取引先コードで連携し、取引先コード変換表（code_m PCNV）があれば会計の取引先コードに置き換える（2026-11-03）。
// 勘定奉行の取引先コードは半角英数のため、カナを含むコードが変換表に無いと勘定奉行CSVは出力しない
import iconv from 'iconv-lite';
import { check, isoDate, csv, DomainError } from './domain.mjs';
import { audit, rows as dbRows } from './db.mjs';
import { journalList, LISTS } from './journal-lists.mjs';
import { decode } from './taxcode.mjs';
import { bugyoSettings, bugyoFile } from './bugyo.mjs';

// 処税率 → 弥生の税区分（2桁目＝区分、3桁目＝税率）
export function yayoiTax(code) {
  const t = decode(code); if (!t) return null;
  const rate = t.rate === 8 ? '8%(軽)' : `${t.rate}%`;
  if (t.kind === 9) return '対象外';
  if (t.side === 'S') return t.kind === 1 ? (t.taxable ? `課税売上${rate}` : '対象外') : t.kind === 2 ? '非課売上' : '輸出売上';
  if (!t.taxable) return t.kind === 7 ? '非課仕入' : '対象外';
  return { 4: '課対仕入', 5: '非対仕入', 6: '共対仕入' }[t.kind] + rate;
}
async function entries(c, from, to) {
  const out = [];
  for (const pattern of Object.keys(LISTS)) {
    const d = await journalList(c, { pattern, from, to });
    for (const s of d.slips) out.push({ ...s, pattern });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}
export async function accountingExport(c, ctx, q) {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です');
  const format = ['yayoi', 'bugyo'].includes(q.format) ? q.format : 'generic', slips = await entries(c, from, to);
  check(slips.length, '期間内の仕訳がありません');
  const bad = [...new Set(slips.flatMap(s => s.pairs.flatMap(p => [p.dr?.tax, p.cr?.tax])).filter(t => t && !decode(t)))];
  if (format !== 'generic' && bad.length) throw new DomainError('処税率として解釈できないコードがあります: ' + bad.join(', '));
  const conv = new Map((await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='PCNV' AND category3<>'0'")).map(r => [r.code_dtl, r.code_dtl_nam])), missing = new Map();
  const link = x => {
    if (!x) return x;
    const code = x.partnerCode ? conv.get(`${x.partnerKind}:${x.partnerCode}`) || x.partnerCode : '';
    if (code && !/^[0-9A-Za-z]+$/.test(code)) missing.set(`${x.partnerKind}:${x.partnerCode}`, `${x.partnerKind === 'C' ? '得意先' : '業者'} ${x.partnerCode} ${x.partnerName}`);
    return { ...x, sub: x.inner, subName: x.innerName, partner: code };
  };
  for (const s of slips) s.pairs = s.pairs.map(p => ({ ...p, dr: link(p.dr), cr: link(p.cr) }));
  if (format === 'bugyo' && missing.size) throw new DomainError(`取引先コードに半角英数以外の文字がある得意先・業者が ${missing.size} 件あります。マスタ管理の「取引先コード変換表」で会計の取引先コードを登録してください: ${[...missing.values()].slice(0, 10).join(' / ')}${missing.size > 10 ? ' ほか' : ''}`);
  let file;
  if (format === 'bugyo') {
    file = bugyoFile(slips.map(s => ({ date: s.date, slipNo: s.slipNo, memo: `${s.pattern} ${s.sourceNo}`,
      pairs: s.pairs.map(p => ({ dr: p.dr, cr: p.cr, memo: [p.dr?.memo1 || p.cr?.memo1, p.dr?.memo2 || p.cr?.memo2].filter(Boolean).join(' ') })) })), await bugyoSettings(c), `会計連携_勘定奉行_${from}_${to}.csv`);
  } else if (format === 'generic') {
    const rows = [['伝票日付', '伝票番号', '行', '借方部門', '借方科目CD', '借方科目名', '借方補助CD', '借方補助名', '借方取引先CD', '借方取引先名', '借方税区分', '借方金額', '貸方部門', '貸方科目CD', '貸方科目名', '貸方補助CD', '貸方補助名', '貸方取引先CD', '貸方取引先名', '貸方税区分', '貸方金額', '摘要1', '摘要2', '摘要1コード', 'パターン', '元伝票', '状態']];
    for (const s of slips) s.pairs.forEach((p, i) => {
      const d = p.dr || {}, cr = p.cr || {};
      rows.push([s.date, s.slipNo, i + 1, d.dept, d.account, d.accountName, d.sub, d.subName, d.partner, d.partnerName, d.tax, d.amount ?? '', cr.dept, cr.account, cr.accountName, cr.sub, cr.subName, cr.partner, cr.partnerName, cr.tax, cr.amount ?? '',
        d.memo1 || cr.memo1 || '', d.memo2 || cr.memo2 || '', d.memo1Code || cr.memo1Code || '', s.pattern, s.sourceNo, s.status]);
    });
    file = { name: `会計連携_汎用_${from}_${to}.csv`, body: Buffer.from(csv(rows), 'utf8'), type: 'text/csv; charset=utf-8' };
  } else {
    const q2 = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t; };
    const lines = [];
    for (const s of slips) s.pairs.forEach((p, i, all) => {
      const flag = all.length === 1 ? '2000' : i === 0 ? '2110' : i === all.length - 1 ? '2101' : '2100';
      const d = p.dr, cr = p.cr, memo = [d?.memo1 || cr?.memo1, d?.memo2 || cr?.memo2].filter(Boolean).join(' ').slice(0, 64);
      lines.push([flag, s.slipNo.replace(/\D/g, '').slice(-6), '', s.date.replaceAll('-', '/'),
        d?.accountName || '', d?.subName || '', d?.dept || '', d ? yayoiTax(d.tax) || '対象外' : '', d?.amount ?? '', '',
        cr?.accountName || '', cr?.subName || '', cr?.dept || '', cr ? yayoiTax(cr.tax) || '対象外' : '', cr?.amount ?? '', '',
        memo, '', '', '0', '', `${s.pattern} ${s.sourceNo}`, '0', '0', 'no'].map(q2).join(','));
    });
    file = { name: `会計連携_弥生_${from}_${to}.csv`, body: iconv.encode(lines.join('\r\n') + '\r\n', 'Shift_JIS'), type: 'text/csv; charset=Shift_JIS' };
  }
  await audit(c, ctx, 'journal_entry', `${from}..${to}`, 'accounting.export', { format, slips: slips.length });
  return { file };
}

// マスタの会計システム（勘定奉行）形式の出力（D-059・D-060。2026-11-12 結合テスト IT-13）：取引先（得意先・業者）・部門・勘定科目・補助科目（内訳科目＝銀行・内訳）。
// 取引先コードは取引先コード変換表で会計の取引先コードに置き換える（変換表に無いカナ付きコードがあると出力しない。仕訳の勘定奉行CSVと同じ）。有効なものだけ。文字コードは勘定奉行連携の設定
export const BUGYO_MASTERS = { partners: '取引先', depts: '部門', accounts: '勘定科目', subaccounts: '補助科目' };
export async function accountingMasters(c, ctx, q) {
  const kind = String(q.kind || ''); check(BUGYO_MASTERS[kind], '出力するマスタが不正です');
  let out;
  if (kind === 'partners') {
    const conv = new Map((await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='PCNV' AND category3<>'0'")).map(r => [r.code_dtl, r.code_dtl_nam])), missing = [];
    const list = [...(await dbRows(c, "SELECT customers_cd code, customers_name name FROM client_m WHERE delete_f<>'1' ORDER BY customers_cd")).map(r => ({ ...r, kind: 'C' })),
      ...(await dbRows(c, 'SELECT vendor_code code, vendor_name name FROM vendor WHERE active ORDER BY vendor_code')).map(r => ({ ...r, kind: 'V' }))];
    out = [['取引先コード', '取引先名称'], ...list.map(r => { const code = conv.get(`${r.kind}:${r.code}`) || r.code; if (!/^[0-9A-Za-z]+$/.test(code)) missing.push(`${r.kind === 'C' ? '得意先' : '業者'} ${r.code} ${r.name}`); return [code, r.name]; })];
    if (missing.length) throw new DomainError(`取引先コードに半角英数以外の文字がある得意先・業者が ${missing.length} 件あります。マスタ管理の「取引先コード変換表」で会計の取引先コードを登録してください: ${missing.slice(0, 10).join(' / ')}${missing.length > 10 ? ' ほか' : ''}`);
  } else if (kind === 'depts') out = [['部門コード', '部門名称'], ...(await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='DEPT' AND COALESCE(category1,'')<>'0' ORDER BY code_dtl")).map(r => [r.code_dtl, r.code_dtl_nam])];
  else if (kind === 'accounts') out = [['勘定科目コード', '勘定科目名称'], ...(await dbRows(c, 'SELECT account_code, account_name FROM account_subject WHERE active ORDER BY account_code')).map(r => [r.account_code, r.account_name])];
  else out = [['勘定科目コード', '補助科目コード', '補助科目名称'], ...(await dbRows(c, 'SELECT s.account_code, s.sub_code, s.sub_name FROM account_subsubject s JOIN account_subject a ON a.account_code=s.account_code AND a.active WHERE s.active ORDER BY s.account_code, s.sub_code')).map(r => [r.account_code, r.sub_code, r.sub_name])];
  const { encoding } = await bugyoSettings(c), text = csv(out), name = `会計連携_勘定奉行_${BUGYO_MASTERS[kind]}マスタ.csv`;
  await audit(c, ctx, 'master', kind, 'accounting.masters', { kind, rows: out.length - 1 });
  return { file: { name, body: encoding === 'utf-8' ? Buffer.from(text, 'utf8') : iconv.encode(text.replace(/^\uFEFF/, ''), 'Shift_JIS'), type: `text/csv; charset=${encoding === 'utf-8' ? 'utf-8' : 'Shift_JIS'}` } };
}
