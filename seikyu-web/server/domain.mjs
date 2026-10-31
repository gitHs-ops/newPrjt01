// Pure business helpers. Money is integer JPY; quantities are decimal strings (2 places).
export class DomainError extends Error {}
export class Conflict extends Error {}
export class Forbidden extends Error {}
export const check = (ok, msg) => { if (!ok) throw new DomainError(msg); };

export const RATES = [0, 8, 10];
// 決済方法（現行 Java code_m A0001）：1 現金 / 2 掛売 / 3 カード
export const METHODS = { 1: '現金', 2: '掛売', 3: 'カード' };
export const CASH = 1, CREDIT = 2, CARD = 3;

export function yen(v, label = '金額', { negative = false, max = 1e12 } = {}) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  check(/^-?\d+$/.test(s), `${label}は整数で入力してください`);
  const n = Number(s);
  check(Number.isSafeInteger(n) && Math.abs(n) <= max && (negative || n >= 0), `${label}が範囲外です`);
  return n;
}
// Returns {text, scaled} where scaled is BigInt quantity * 100.
export function qty(v, label = '数量', { max = 99999.99, positive = true, allowNegative = false } = {}) {
  const s = String(v ?? '').trim();
  check(/^-?\d+(\.\d{1,2})?$/.test(s), `${label}は小数2桁以内の数値で入力してください`);
  const neg = s.startsWith('-'), [a, b = ''] = s.replace('-', '').split('.');
  const scaled = BigInt(a + b.padEnd(2, '0')) * (neg ? -1n : 1n);
  check(Math.abs(Number(s)) <= max, `${label}が範囲外です`);
  if (positive) check(scaled > 0n, `${label}は0より大きい値を入力してください`);
  else if (!allowNegative) check(scaled >= 0n, `${label}は0以上で入力してください`);
  const abs = (neg ? -scaled : scaled).toString().padStart(3, '0');
  return { text: (neg ? '-' : '') + abs.slice(0, -2) + '.' + abs.slice(-2), scaled };
}
export const lineAmount = (q, price) => Number((q.scaled * BigInt(price)) / 100n); // 円未満切り捨て
export function taxOf(net, rate) { check(RATES.includes(Number(rate)), '税率が不正です'); return Math.floor(net * Number(rate) / 100); }

export function isoDate(v, label = '日付') {
  check(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v, `${label}が不正です`);
  check(v >= '2000-01-01' && v <= '2100-12-31', `${label}が範囲外です`);
  return v;
}
export function isoMonth(v, label = '年月') { check(typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v), `${label}が不正です`); return v; }
export const toNum = iso => Number(String(iso).replaceAll('-', ''));
export const fromNum = n => { const s = String(n ?? ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : ''; };
const endOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function closingDay(v) { const d = yen(v, '締日'); check(d >= 1 && d <= 31, '締日は1〜31です（31=月末、月末より大きい日は月末）'); return d; }
// Billing period for month + closing day: (previous closing + 1) .. closing.
export function period(month, closing) {
  isoMonth(month, '請求年月'); const day = closingDay(closing);
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${String(Math.min(day, endOf(y, m))).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(y, m - 2, Math.min(day, endOf(y, m - 1)) + 1));
  return { start: prev.toISOString().slice(0, 10), end };
}
// Default payment due date: end of the month following the closing date (assumption, see README).
export function dueDate(end) { const [y, m] = end.split('-').map(Number); return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); }
// 営業日：土日は休日、ほかにカレンダーマスタ（code_m HOL）の登録日も休日。休日なら翌営業日へ（2026-10-31 ユーザー指示）
export const isHoliday = (iso, holidays) => { const w = new Date(iso + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6 || holidays.has(iso); };
export function nextBusinessDay(iso, holidays) {
  const d = new Date(iso + 'T00:00:00Z');
  for (let i = 0; i < 60 && isHoliday(d.toISOString().slice(0, 10), holidays); i++) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
// DB timestamps are UTC ("YYYY-MM-DD HH:MM:SS[.ffffff]"); printed documents use Japan time.
export const jst = (v, len = 19) => { if (!v) return ''; const d = new Date(String(v).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z'); return isNaN(d) ? String(v) : new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, len); };
export function addMonths(month, n) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); }
export function text(v, label, max, { required = true, pattern } = {}) {
  const s = String(v ?? '').trim();
  if (required) check(s.length > 0, `${label}を入力してください`);
  check([...s].length <= max, `${label}は${max}文字以内で入力してください`);
  if (pattern && s) check(pattern.test(s), `${label}の形式が不正です`);
  return s;
}
export const bool = v => v === true || v === 'true' || v === '1' || v === 1 || v === '有効';

export function csv(rows) {
  // 数式インジェクション対策で先頭の = + @ - 等に ' を付ける。ただし数値（-12345 等）はそのまま（マイナス金額が '-12345 にならないように）
  const q = v => { const s = String(v ?? ''); return '"' + (/^-?\d+(\.\d+)?$/.test(s) ? s : s.replace(/^[=+@\-\t\r]/, "'$&")).replaceAll('"', '""') + '"'; };
  return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
export function parseCsv(input) {
  const s = String(input).replace(/^﻿/, ''); const out = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { if (quoted && s[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); if (row.some(x => x !== '')) out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  check(!quoted, 'CSVの引用符が閉じていません');
  row.push(cell); if (row.some(x => x !== '')) out.push(row);
  return out.map(r => r.map(x => x.replace(/^'(?=[=+@\-])/, '')));
}
