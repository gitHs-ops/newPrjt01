import { randomUUID } from 'node:crypto';
import { check, toNum, DomainError } from './domain.mjs';

export async function tx(pool, fn) {
  const c = await pool.getConnection();
  // READ COMMITTED: after waiting on a row lock, balance sub-queries must see the other transaction's commit.
  try { await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
  catch (e) { try { await c.rollback(); } catch {} throw e; }
  finally { c.release(); }
}
export const rows = async (c, sql, args = []) => (await c.query(sql, args))[0];
export const one = async (c, sql, args = []) => (await c.query(sql, args))[0][0];

// numbering_m: one row per document type; present_value holds the last issued sequence.
export const NUMBERING = { sales: [1, 'S', '売上No'], receipt: [2, 'R', '入金No'], payment: [3, 'T', '支払No'], expense: [4, 'E', '経費伝票No'], purchase: [5, 'P', '仕入伝票No'] };
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
const insertLine = (c, id, no, l) => c.query('INSERT INTO journal_line (journal_id,line_no,side,account_code,sub_code,department_code,source_tax_code,amount,customers_cd,vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
  [id, no, l.side, l.account, l.sub || null, l.dept || null, l.tax || null, l.amount, l.customer || null, l.vendor || null]);

export async function postJournal(c, { date, pattern, sourceType, sourceId, lines }) {
  const live = lines.filter(l => l.amount !== 0);
  for (const l of live) { check(Number.isSafeInteger(l.amount) && l.amount > 0, '仕訳金額が不正です'); check(['D', 'C'].includes(l.side), '貸借区分が不正です'); }
  const dr = live.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), cr = live.filter(l => l.side === 'C').reduce((n, l) => n + l.amount, 0);
  check(dr === cr && dr > 0, '仕訳の貸借が一致しません');
  const prev = await one(c, "SELECT COALESCE(MAX(posting_revision),0) r, COALESCE(SUM(status='POSTED' AND reversal_of IS NULL),0) live FROM journal_entry WHERE source_type=? AND source_id=?", [sourceType, String(sourceId)]);
  check(!Number(prev.live), '仕訳は作成済みです');
  const [r] = await c.query("INSERT INTO journal_entry (journal_date,pattern_code,source_type,source_id,posting_revision,status,created_at) VALUES (?,?,?,?,?,'POSTED',UTC_TIMESTAMP(6))", [date, pattern, sourceType, String(sourceId), Number(prev.r) + 1]);
  let no = 0;
  for (const l of live) await insertLine(c, r.insertId, ++no, l);
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
