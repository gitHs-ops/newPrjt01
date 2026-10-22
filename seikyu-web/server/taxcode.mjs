// 処税率（現行 AS400 の 3 桁コード）。定義は顧客資料「消費税区分.xlsx」（山田様 2026-07-06）。
//   1桁目 税込区分: 1=税込み（内税） / 2=外税 / 空白=外税（2 と同じ。10/21 打合せで確認。消費税区分.xlsx の「空白=非課税・不課税」を改める）
//   2桁目 税区分  : 1 課税売上 / 2 非課税売上 / 3 輸出売上 / 4 課税売上対応仕入 / 5 非課税売上対応仕入 / 6 その他仕入（共通）/ 7 非課税仕入 / 9 対象外
//   3桁目 税率区分: 空白 0% / 1 10% / 2 3% / 3 6% / 4 2.8% / 5 5% / 8 8%
// 保存形は空白を 0 にした 3 桁（例 141, 041, 011, 090）。現行の帳票は「 41」「 11」「 9 」のように空白を詰めて表示する。
import { check } from './domain.mjs';

export const TAX_KIND = { 1: '課税売上', 2: '非課税売上', 3: '輸出売上', 4: '課税売上対応仕入', 5: '非課税売上対応仕入', 6: '共通対応仕入', 7: '非課税仕入', 9: '対象外' };
export const TAX_RATE = { 0: 0, 1: 10, 2: 3, 3: 6, 4: 2.8, 5: 5, 8: 8 };
// 旧来の入力値（仕入・経費の税区分）からの読み替え
const LEGACY = { '10%': '141', '8%': '148', 非課税: '070', 対象外: '090' };

// 空白・桁不足を含む表記を 3 桁に正規化する。不正なら null。
export function normalize(v) {
  const raw = String(v ?? '');
  if (LEGACY[raw.trim()]) return LEGACY[raw.trim()];
  let s = raw.replaceAll('　', ' ').replace(/[^\d ]/g, '');
  if (!s.trim()) return null;
  if (s.trim() === '9') return '090'; // 「 9 」「  9」「9」= 対象外
  s = s.padStart(3, ' ').replaceAll(' ', '0');
  return s.length === 3 && '012'.includes(s[0]) && TAX_KIND[s[1]] && s[2] in TAX_RATE ? s : null;
}
// 税額の計算方法
//   taxable: 消費税額を持つか（課税売上・課税仕入で税率 > 0）
//   excl   : 外税（金額は税抜、税額は別行＝仮受/仮払消費税）か。1桁目 2 または空白（10/21 打合せ：「2 は外税。ブランクでも同じ意味」）
export function decode(v) {
  const code = normalize(v); if (!code) return null;
  const [incl, kind, r] = code, rate = TAX_RATE[r], k = Number(kind);
  const side = k <= 3 ? 'S' : k <= 7 ? 'P' : '';
  const taxable = rate > 0 && [1, 4, 5, 6].includes(k);
  const excl = taxable && incl !== '1';
  const how = !taxable ? '' : excl ? '外税' : '税込';
  const name = k === 9 ? '対象外' : !taxable && [4, 5, 6].includes(k) ? `非課税・不課税（${TAX_KIND[k]}）` : `${TAX_KIND[k]}${rate && [1, 4, 5, 6].includes(k) ? ' ' + rate + '%' : ''}${how ? `（${how}）` : ''}`;
  return { code, display: (incl === '0' ? ' ' : incl) + kind + (r === '0' ? ' ' : r), incl, kind: k, rate, side, taxable, excl, name };
}
export const mustDecode = (v, label = '処税率') => { const d = decode(v); check(d, `${label}「${v ?? ''}」は処税率として不正です（例 141・148・041・011・090）`); return d; };
// 税額：税込なら内税計算、外税なら金額×税率。円未満切捨て（端数処理 Q02）。
export function taxOf(amount, v) { const d = decode(v); if (!d?.taxable) return 0; const r = Math.round(d.rate * 10); return Math.floor(amount * r / (d.excl ? 1000 : 1000 + r)); }

// 画面の選択肢（よく使うもの）。これ以外の組合せも decode できれば入力可。
export const CATALOG = ['090', '011', '111', '018', '118', '211', '020', '030', '141', '148', '241', '248', '151', '161', '070', '041'].map(decode);
