// NO20 会計連携（データダウンロード）。会計システム（製品）・受入形式は未確定（Q14/Q19）のため推定で2形式を用意：
//  generic … 借貸併記（現行自動仕訳リストと同じ並び）UTF-8 BOM CSV、科目・内訳はコード＋名称
//  yayoi   … 弥生会計「仕訳日記帳」インポート形式（25項目、Shift_JIS）。科目は名称、税区分は現行処税率から推定変換
import iconv from 'iconv-lite';
import { check, isoDate, today, csv } from './domain.mjs';
import { audit } from './db.mjs';
import { journalList, LISTS } from './journal-lists.mjs';

// 現行処税率（Q01 確認待ち）→ 弥生の税区分（推定）
export const YAYOI_TAX = { '9': '対象外', '11': '課税売上10%', '141': '課対仕入10%', '148': '課対仕入8%(軽)', '41': '対象外', '10%': '課対仕入10%', '8%': '課対仕入8%(軽)', '非課税': '非課仕入', '対象外': '対象外' };
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
  const format = q.format === 'yayoi' ? 'yayoi' : 'generic', slips = await entries(c, from, to);
  check(slips.length, '期間内の仕訳がありません');
  let body, name;
  if (format === 'generic') {
    const rows = [['伝票日付', '伝票番号', '行', '借方部門', '借方科目CD', '借方科目名', '借方補助CD', '借方補助名', '借方税区分', '借方金額', '貸方部門', '貸方科目CD', '貸方科目名', '貸方補助CD', '貸方補助名', '貸方税区分', '貸方金額', '摘要1', '摘要2', '取引先CD', 'パターン', '元伝票', '状態']];
    for (const s of slips) s.pairs.forEach((p, i) => {
      const d = p.dr || {}, cr = p.cr || {};
      rows.push([s.date, s.slipNo, i + 1, d.dept, d.account, d.accountName, d.sub, d.subName, d.tax, d.amount ?? '', cr.dept, cr.account, cr.accountName, cr.sub, cr.subName, cr.tax, cr.amount ?? '',
        d.memo1 || cr.memo1 || '', d.memo2 || cr.memo2 || '', d.memo1Code || cr.memo1Code || '', s.pattern, s.sourceNo, s.status]);
    });
    body = Buffer.from(csv(rows), 'utf8'); name = `会計連携_汎用_${from}_${to}.csv`;
  } else {
    const q2 = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t; };
    const lines = [];
    for (const s of slips) s.pairs.forEach((p, i, all) => {
      const flag = all.length === 1 ? '2000' : i === 0 ? '2110' : i === all.length - 1 ? '2101' : '2100';
      const d = p.dr, cr = p.cr, memo = [d?.memo1 || cr?.memo1, d?.memo2 || cr?.memo2].filter(Boolean).join(' ').slice(0, 64);
      lines.push([flag, s.slipNo.replace(/\D/g, '').slice(-6), '', s.date.replaceAll('-', '/'),
        d?.accountName || '', d?.subName || '', d?.dept || '', d ? YAYOI_TAX[d.tax] || '対象外' : '', d?.amount ?? '', '',
        cr?.accountName || '', cr?.subName || '', cr?.dept || '', cr ? YAYOI_TAX[cr.tax] || '対象外' : '', cr?.amount ?? '', '',
        memo, '', '', '0', '', `${s.pattern} ${s.sourceNo}`, '0', '0', 'no'].map(q2).join(','));
    });
    body = iconv.encode(lines.join('\r\n') + '\r\n', 'Shift_JIS'); name = `会計連携_弥生_${from}_${to}.csv`;
  }
  await audit(c, ctx, 'journal_entry', `${from}..${to}`, 'accounting.export', { format, slips: slips.length });
  return { file: { name, body, type: format === 'yayoi' ? 'text/csv; charset=Shift_JIS' : 'text/csv; charset=utf-8' } };
}
