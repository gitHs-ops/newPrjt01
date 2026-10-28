import { randomUUID } from 'node:crypto';
import { check, toNum, DomainError, today } from './domain.mjs';
import { companyPeriod } from './period.mjs';

export async function tx(pool, fn) {
  const c = await pool.getConnection();
  // READ COMMITTED: after waiting on a row lock, balance sub-queries must see the other transaction's commit.
  try { await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
  catch (e) { try { await c.rollback(); } catch {} throw e; }
  finally { c.release(); }
}
export const rows = async (c, sql, args = []) => (await c.query(sql, args))[0];
export const one = async (c, sql, args = []) => (await c.query(sql, args))[0][0];

// numbering_m: one row per document type; present_value holds the last issued sequence.
// numbering_m のキー 1〜6 は現行 Java（出荷予定・出荷・修正再発行・カード等、値はタブ区切り YY・MM・連番）が使うため、本システムは 101 番台を使う
export const NUMBERING = { sales: [101, 'S', '売上No'], receipt: [102, 'R', '入金No'], payment: [103, 'T', '支払No'], expense: [104, 'E', '経費伝票No'], purchase: [105, 'P', '仕入伝票No'] };
export async function nextNo(c, kind) {
  const [key, prefix] = NUMBERING[kind];
  const r = await one(c, 'SELECT present_value FROM numbering_m WHERE numbering_key=? FOR UPDATE', [key]);
  if (!r) throw Error('numbering_m not initialized: ' + kind);
  const next = Number(r.present_value) + 1;
  await c.query('UPDATE numbering_m SET present_value=? WHERE numbering_key=?', [String(next), key]);
  return prefix + String(next).padStart(8, '0');
}
export async function assertOpen(c, iso) {
  const r = await one(c, 'SELECT period FROM app_period_close WHERE period=? FOR SHARE', [String(iso).slice(0, 7)]);
  check(!r, `${String(iso).slice(0, 7)} は月次確定済みのため登録・変更できません`);
}
export async function audit(c, ctx, entity, id, action, summary = {}) {
  await c.query('INSERT INTO audit_event (occurred_at,actor_id,entity_type,entity_id,action,request_id,change_summary) VALUES (UTC_TIMESTAMP(6),?,?,?,?,?,?)',
    [ctx?.user?.login_id || 'system', entity, String(id), action, ctx?.requestId || randomUUID(), JSON.stringify(summary)]);
}
export const stamp = () => {
  const d = new Date(Date.now() + 9 * 3600e3).toISOString();
  return { update_day: toNum(d.slice(0, 10)), update_time: Number(d.slice(11, 19).replaceAll(':', '')), update_pgm: 'WEB', update_ws: 'WEB' };
};

export const line = (side, account, amount, extra = {}) => ({ side, account, amount, ...extra });
// 伝票番号は現行（仕訳帳 AC2205）の系列ごとの連番を引き継ぐ：R 売掛計上・B 入金・S 定時請求・K 小口現金・U 支払、接頭辞なし6桁＝在庫計上・小口補充。
export const SLIP_SERIES = { A01: 'R', B01: 'B', D01: 'S', E01: 'K', F01: 'U', C01: 'I', G03: '' }; // 頭1桁：更新処理について.xlsx Sheet1（K小口・B入金・U定時支払・R売掛・I在庫・S請求書）。G03 小口補充は資料になし
export const SLIP_SEED = { R: 819, B: 27587, S: 14435, K: 2032, U: 14402, I: 0, '': 100321 }; // 現行の最終番号（次は R00820・B27588・S14436・K02033・U14403・100322）
export const formatSlipNo = (series, n) => series + String(n).padStart(series ? 5 : 6, '0'); // 現行（移行データ）の形式
// 10/26 打合せ「伝票番号の採番」：伝票別に頭1桁の英数＋処理西暦年度（4桁）＋5桁連番。連番は伝票の種類×年度ごとに 1 から（2026-10-28）
export const formatSlipNoFy = (series, fy, n) => `${series}${fy}${String(n).padStart(5, '0')}`;
// 売掛金計上（A01）は締日単位で一括計上し、1伝票に45得意先（1請求＝1得意先）まで載せて分割する（Q08：現行 R00829・R00830 が借方45行、R00831 が残り）。
export const AR_SLIP_MAX = 45;
// slip … 同じ伝票にまとめる仕訳の共有状態 { no, count, max }（請求締め1回分）。省略時は1仕訳＝1伝票。
export async function assignSlipNo(c, journalId, pattern, slip, date) {
  const series = SLIP_SERIES[pattern]; if (series === undefined) return '';
  let no = slip?.no && slip.count < slip.max ? slip.no : '';
  if (!no) {
    const fy = (await companyPeriod(c)).fyOf(date instanceof Date ? date.toISOString().slice(0, 10) : String(date || today()).slice(0, 10)), key = `${series}${fy}`; // 処理年度＝仕訳日付の会計年度（期首の西暦）
    const r = await one(c, 'SELECT last_no FROM app_slip_series WHERE series=? FOR UPDATE', [key]), n = Number(r?.last_no ?? 0) + 1;
    await c.query('INSERT INTO app_slip_series (series,last_no) VALUES (?,?) ON DUPLICATE KEY UPDATE last_no=VALUES(last_no)', [key, n]);
    no = formatSlipNoFy(series, fy, n);
    if (slip) Object.assign(slip, { no, count: 0 });
  }
  if (slip) slip.count++;
  await c.query('INSERT INTO app_slip_no (journal_id,slip_no) VALUES (?,?)', [journalId, no]);
  return no;
}
const insertLine = (c, id, no, l) => c.query('INSERT INTO journal_line (journal_id,line_no,side,account_code,sub_code,department_code,source_tax_code,amount,customers_cd,vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
  [id, no, l.side, l.account, l.sub || null, l.dept || null, l.tax || null, l.amount, l.customer || null, l.vendor || null]);

export async function postJournal(c, { date, pattern, sourceType, sourceId, lines, slip }) {
  const live = lines.filter(l => l.amount !== 0);
  for (const l of live) { check(Number.isSafeInteger(l.amount) && l.amount > 0, '仕訳金額が不正です'); check(['D', 'C'].includes(l.side), '貸借区分が不正です'); }
  const dr = live.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), cr = live.filter(l => l.side === 'C').reduce((n, l) => n + l.amount, 0);
  check(dr === cr && dr > 0, '仕訳の貸借が一致しません');
  const prev = await one(c, "SELECT COALESCE(MAX(posting_revision),0) r, COUNT(*) FILTER (WHERE status='POSTED' AND reversal_of IS NULL) live FROM journal_entry WHERE source_type=? AND source_id=?", [sourceType, String(sourceId)]);
  check(!Number(prev.live), '仕訳は作成済みです');
  const [r] = await c.query("INSERT INTO journal_entry (journal_date,pattern_code,source_type,source_id,posting_revision,status,created_at) VALUES (?,?,?,?,?,'POSTED',UTC_TIMESTAMP(6))", [date, pattern, sourceType, String(sourceId), Number(prev.r) + 1]);
  let no = 0;
  for (const l of live) await insertLine(c, r.insertId, ++no, l);
  await assignSlipNo(c, r.insertId, pattern, slip, date);
  return r.insertId;
}
// Reversal keeps the original entry, inserts a mirrored entry and marks the original REVERSED.
export async function reverseJournal(c, { sourceType, sourceId, date }) {
  const entries = await rows(c, "SELECT * FROM journal_entry WHERE source_type=? AND source_id=? AND status='POSTED' AND reversal_of IS NULL FOR UPDATE", [sourceType, String(sourceId)]);
  for (const e of entries) {
    const lines = await rows(c, 'SELECT * FROM journal_line WHERE journal_id=? ORDER BY line_no', [e.journal_id]);
    const max = await one(c, 'SELECT MAX(posting_revision) r FROM journal_entry WHERE source_type=? AND source_id=?', [sourceType, String(sourceId)]);
    const [r] = await c.query("INSERT INTO journal_entry (journal_date,pattern_code,source_type,source_id,posting_revision,reversal_of,status,created_at) VALUES (?,?,?,?,?,?,'POSTED',UTC_TIMESTAMP(6))", [date, e.pattern_code, sourceType, String(sourceId), Number(max.r) + 1, e.journal_id]);
    for (const l of lines) await insertLine(c, r.insertId, l.line_no, { side: l.side === 'D' ? 'C' : 'D', account: l.account_code, sub: l.sub_code, dept: l.department_code, tax: l.source_tax_code, amount: Number(l.amount), customer: l.customers_cd, vendor: l.vendor_id });
    await assignSlipNo(c, r.insertId, e.pattern_code, undefined, date || e.journal_date);
    await c.query("UPDATE journal_entry SET status='REVERSED' WHERE journal_id=?", [e.journal_id]);
  }
  return entries.length;
}
export function mapSqlError(e) {
  if (e instanceof DomainError) return e;
  const m = { ER_DUP_ENTRY: 'コードまたは番号が重複しています', ER_NO_REFERENCED_ROW_2: '参照先のマスタが存在しません', ER_ROW_IS_REFERENCED_2: '他のデータから参照されているため変更できません',
    ER_CHECK_CONSTRAINT_VIOLATED: '入力値が制約に違反しています', ER_DATA_TOO_LONG: '入力値が長すぎます', ER_WARN_DATA_OUT_OF_RANGE: '数値が範囲外です' }[e?.code];
  return m ? new DomainError(m) : null;
}
