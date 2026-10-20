// NO20 会計連携（データダウンロード）。会計システムは勘定奉行（奉行クラウド）が前提（10/14 打合せ・QA 回答 2026-10-08）。
//  bugyo   … 勘定奉行向け（借貸併記 CSV、見出しは会計設定の OBC受入記号／未登録は項目名、税区分は処税率→奉行税区分の対応表）
//  generic … 借貸併記（現行自動仕訳リストと同じ並び）UTF-8 BOM CSV、科目・内訳はコード＋名称
//  yayoi   … 弥生会計「仕訳日記帳」インポート形式（25項目、Shift_JIS）。科目は名称、税区分は処税率を分解して変換
import iconv from 'iconv-lite';
import { check, isoDate, csv, DomainError } from './domain.mjs';
import { audit } from './db.mjs';
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
  let file;
  if (format === 'bugyo') {
    file = bugyoFile(slips.map(s => ({ date: s.date, slipNo: s.slipNo, memo: `${s.pattern} ${s.sourceNo}`,
      pairs: s.pairs.map(p => ({ dr: p.dr, cr: p.cr, memo: [p.dr?.memo1 || p.cr?.memo1, p.dr?.memo2 || p.cr?.memo2].filter(Boolean).join(' ') })) })), await bugyoSettings(c), `会計連携_勘定奉行_${from}_${to}.csv`);
  } else if (format === 'generic') {
    const rows = [['伝票日付', '伝票番号', '行', '借方部門', '借方科目CD', '借方科目名', '借方補助CD', '借方補助名', '借方税区分', '借方金額', '貸方部門', '貸方科目CD', '貸方科目名', '貸方補助CD', '貸方補助名', '貸方税区分', '貸方金額', '摘要1', '摘要2', '取引先CD', 'パターン', '元伝票', '状態']];
    for (const s of slips) s.pairs.forEach((p, i) => {
      const d = p.dr || {}, cr = p.cr || {};
      rows.push([s.date, s.slipNo, i + 1, d.dept, d.account, d.accountName, d.sub, d.subName, d.tax, d.amount ?? '', cr.dept, cr.account, cr.accountName, cr.sub, cr.subName, cr.tax, cr.amount ?? '',
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
