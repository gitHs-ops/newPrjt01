// 処税率（現行 AS400 の 3 桁コード）。定義は顧客資料「消費税区分.xlsx」（山田様 2026-07-06）。
//   1桁目 税込区分: 1=税込み（内税） / 2=外税 / 空白=外税（2 と同じ）。2026-11-24 打合せ No.16：仕入（2桁目 4〜6）は 空白＝非課税、外税は実際には使わない。2026-10-22 確定：10/21 打合せ・現行 HAW050 の集計（141=内税）・消費税区分.xlsx（1=税込み）による
//   2桁目 税区分  : 1 課税売上 / 2 非課税売上 / 3 輸出売上 / 4 課税売上対応仕入 / 5 非課税売上対応仕入 / 6 その他仕入（共通）/ 7 非課税仕入 / 9 対象外
//   3桁目 税率区分: 空白 0% / 1 10% / 2 3% / 3 6% / 4 2.8% / 5 5% / 8 8%
// 保存形は空白を 0 にした 3 桁（例 141, 041, 011, 090）。現行の帳票は「 41」「 11」「 9 」のように空白を詰めて表示する。
import { check } from './domain.mjs';

export const TAX_KIND = { 1: '課税売上', 2: '非課税売上', 3: '輸出売上', 4: '課税売上対応仕入', 5: '非課税売上対応仕入', 6: '共通対応仕入', 7: '非課税仕入', 9: '対象外' };
// 3桁目（税率区分）→ 税率％。初期値は消費税区分.xlsx。マスタ管理 › 税率区分（code_m A0008）の内容で置き換える（setRateDigits。起動時とマスタ保存時）
export const DEFAULT_RATE_DIGITS = { 0: 0, 1: 10, 2: 3, 3: 6, 4: 2.8, 5: 5, 8: 8 };
export const TAX_RATE = { ...DEFAULT_RATE_DIGITS };
// 消費税区分.xlsx が意味を明記している非課税のコード（例「   4 1　非課税という意味。」）
export const NON_TAX = new Set(['041']);
// 旧来の入力値（仕入・経費の税区分）からの読み替え
const LEGACY = { '10%': '141', '8%': '148', 非課税: '070', 対象外: '090' };

// 空白・桁不足を含む表記を 3 桁に正規化する。不正なら null。
export function normalize(v) {
  const raw = String(v ?? '');
  if (LEGACY[raw.trim()]) return LEGACY[raw.trim()];
  let s = raw.replaceAll('　', ' ').replace(/[^\d ]/g, '');
  if (!s.trim()) return null;
  if (s.trim() === '9') return '090'; // 「 9 」「  9」「9」= 対象外
  if (/^0+$/.test(s.trim())) return '000'; // 「  0」＝空白・空白・0＝消費税なし（商品仕入の既定。2026-11-24 打合せ No.22）
  s = s.padStart(3, ' ').replaceAll(' ', '0');
  return s.length === 3 && '012'.includes(s[0]) && TAX_KIND[s[1]] && s[2] in TAX_RATE ? s : null;
}
// 税額の計算方法
//   taxable: 消費税額を持つか（課税売上・課税仕入で税率 > 0）
//   excl   : 外税（金額は税抜、税額は別行＝仮受/仮払消費税）か。1桁目 2 または空白（10/21 打合せ：「2 は外税。ブランクでも同じ意味」）
export function decode(v) {
  const code = normalize(v); if (!code) return null;
  const [incl, kind, r] = code, rate = TAX_RATE[r], k = Number(kind);
  const side = k === 0 || k === 9 ? '' : k <= 3 ? 'S' : 'P';
  // 「 41」は消費税区分.xlsx の例示どおり非課税（2026-11-16。外税 10% として計算していたのはプロトタイプの誤り）
  // 仕入（2桁目 4・5・6）は 1桁目 空白＝非課税、1＝内税（2026-11-24 打合せ No.16。外税 2 は実際には使わないが、入っていれば外税）。売上（1〜3）は従来どおり空白＝外税
  const taxable = rate > 0 && [1, 4, 5, 6].includes(k) && !NON_TAX.has(code) && !(incl === '0' && side === 'P');
  const excl = taxable && incl !== '1';
  const how = !taxable ? '' : excl ? '外税' : '税込';
  const name = k === 0 ? '消費税なし' : k === 9 ? '対象外' : NON_TAX.has(code) || (incl === '0' && side === 'P') ? '非課税' : !taxable && [4, 5, 6].includes(k) ? `非課税・不課税（${TAX_KIND[k]}）` : `${TAX_KIND[k]}${rate && [1, 4, 5, 6].includes(k) ? ' ' + rate + '%' : ''}${how ? `（${how}）` : ''}`;
  return { code, display: k === 0 ? '  0' : (incl === '0' ? ' ' : incl) + kind + (r === '0' ? ' ' : r), incl, kind: k, rate, side, taxable, excl, name };
}
export const mustDecode = (v, label = '処税率') => { const d = decode(v); check(d, `${label}「${v ?? ''}」は処税率として不正です（例 141・148・041・011・090）`); return d; };
// 税額：税込なら内税計算、外税なら金額×税率。円未満切捨て（端数処理 Q02）。
export function taxOf(amount, v) { const d = decode(v); if (!d?.taxable) return 0; const r = Math.round(d.rate * 10); return Math.floor(amount * r / (d.excl ? 1000 : 1000 + r)); }

// 画面の選択肢（よく使うもの）。これ以外の組合せも decode できれば入力可。251（非課税売上対応仕入 10% 外税）は 2026-11-01 追加
const CATALOG_CODES = ['000', '090', '011', '111', '018', '118', '211', '020', '030', '141', '148', '241', '248', '151', '251', '161', '070', '041'];
export const CATALOG = CATALOG_CODES.map(decode);
// 税率区分マスタの内容を反映する（list：[{ digit, rate }]）。0 は 0% 固定。CATALOG（画面の選択肢）も作り直す
export function setRateDigits(list) {
  const next = { 0: 0 };
  for (const x of list || []) { const d = String(x.digit ?? '').trim(), r = Number(x.rate); if (/^[1-9]$/.test(d) && Number.isFinite(r) && r >= 0 && r <= 100) next[d] = r; }
  for (const k of Object.keys(TAX_RATE)) delete TAX_RATE[k];
  Object.assign(TAX_RATE, next);
  CATALOG.splice(0, CATALOG.length, ...CATALOG_CODES.map(decode).filter(Boolean));
  return { ...TAX_RATE };
}
// 税率％ → 3桁目（同じ税率が複数なら小さい数字）
export const digitOfRate = rate => Object.keys(TAX_RATE).filter(k => k !== '0').sort().find(k => TAX_RATE[k] === Number(rate));
