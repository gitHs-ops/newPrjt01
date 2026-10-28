// 勘定奉行（奉行クラウド）向け仕訳データ。QA回答（オービック 2026-10-08）：CSV または Excel で受入。
// 列は「OBC受入記号」を見出しに付ければ順不同、または奉行側の受入マッピングで対応できる。
// 受入記号・税区分コードは「データ受入形式一覧表」で確定するため、会計設定で記号と税区分の対応を登録できるようにしておく（未登録は項目名・処税率のまま出力）。
import iconv from 'iconv-lite';
import { check, csv } from './domain.mjs';
import { rows, audit } from './db.mjs';
import { decode, taxOf } from './taxcode.mjs';

export const BUGYO_ITEMS = [
  ['date', '伝票日付'], ['slipNo', '伝票番号'], ['row', '行番号'],
  ['drDept', '借方部門コード'], ['drAccount', '借方勘定科目コード'], ['drSub', '借方補助科目コード'], ['drTax', '借方税区分'], ['drAmount', '借方金額'], ['drTaxAmount', '借方消費税額'],
  ['crDept', '貸方部門コード'], ['crAccount', '貸方勘定科目コード'], ['crSub', '貸方補助科目コード'], ['crTax', '貸方税区分'], ['crAmount', '貸方金額'], ['crTaxAmount', '貸方消費税額'],
  ['memo', '摘要'],
];
export async function bugyoSettings(c) {
  const s = Object.fromEntries((await rows(c, "SELECT k, v FROM kb_setting WHERE k LIKE 'obc_%'")).map(r => [r.k, r.v]));
  const parse = v => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
  return { symbols: parse(s.obc_symbols), taxMap: parse(s.obc_tax), encoding: s.obc_encoding || 'shift_jis' };
}
export async function saveBugyoSettings(c, ctx, p) {
  const symbols = {}, taxMap = {};
  for (const [k] of BUGYO_ITEMS) { const v = String(p.symbols?.[k] || '').trim(); check(v.length <= 40 && !/[",\r\n]/.test(v), '受入記号に使えない文字があります'); if (v) symbols[k] = v; }
  for (const [code, v] of Object.entries(p.taxMap || {})) { const t = decode(code); check(t, `処税率「${code}」が不正です`); const x = String(v || '').trim(); check(x.length <= 20, '奉行の税区分コードが長すぎます'); if (x) taxMap[t.code] = x; }
  const encoding = p.encoding === 'utf-8' ? 'utf-8' : 'shift_jis';
  for (const [k, v] of [['obc_symbols', JSON.stringify(symbols)], ['obc_tax', JSON.stringify(taxMap)], ['obc_encoding', encoding]])
    await c.query('INSERT INTO kb_setting (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, v]);
  await audit(c, ctx, 'kb_setting', 'obc', 'kb.setting.save', { symbols: Object.keys(symbols).length, tax: Object.keys(taxMap).length, encoding });
  return bugyoSettings(c);
}
// slips: [{ date, slipNo, memo, pairs: [{ dr: {dept, account, sub, tax, amount, taxAmount?}, cr: {...}, memo }] }]
export function bugyoFile(slips, settings, name) {
  const head = BUGYO_ITEMS.map(([k, label]) => settings.symbols[k] || label);
  const tax = code => { if (!code) return ''; const t = decode(code); return settings.taxMap[t?.code] || t?.code || code; };
  // 消費税額：税込（内税）は金額から計算、外税・別記は仮受/仮払消費税の行で計上済みのため空欄
  const taxAmt = x => (decode(x.tax)?.excl ? '' : x.taxAmount !== undefined ? x.taxAmount : taxOf(x.amount, x.tax));
  const side = x => (x ? [x.dept || '', x.account, x.sub || '', tax(x.tax), x.amount, taxAmt(x)] : ['', '', '', '', '', '']);
  const out = [head];
  for (const s of slips) s.pairs.forEach((p, i) => out.push([s.date.replaceAll('-', '/'), s.slipNo, i + 1, ...side(p.dr), ...side(p.cr), String(p.memo || s.memo || '').slice(0, 60)]));
  const text = csv(out);
  return { name, body: settings.encoding === 'utf-8' ? Buffer.from(text, 'utf8') : iconv.encode(text.replace(/^﻿/, ''), 'Shift_JIS'), type: `text/csv; charset=${settings.encoding === 'utf-8' ? 'utf-8' : 'Shift_JIS'}` };
}
