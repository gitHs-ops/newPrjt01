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
export const NUMBERING = { sales: [101, 'S', '売上No'], receipt: [102, 'R', '入金No'], payment: [103, 'T', '支払No'], expense: [104, 'E', '経費伝票No'] };
export async function nextNo(c, kind) {
  const [key, prefix] = NUMBERING[kind];
  const r = await one(c, 'SELECT present_value FROM numbering_m WHERE numbering_key=? FOR UPDATE', [key]);
  if (!r) throw Error('numbering_m not initialized: ' + kind);
  const next = Number(r.present_value) + 1;
  await c.query('UPDATE numbering_m SET present_value=? WHERE numbering_key=?', [String(next), key]);
  return prefix + String(next).padStart(8, '0');
}
// 月次確定・自動仕訳別確定の月は 20日締めの会計月（前月21日〜当月20日。2026-11-27 ユーザー指示：暦月から変更）。YYYY-MM はそのまま
export const cycleMonth = iso => { const s = String(iso instanceof Date ? iso.toISOString() : iso); if (s.length < 10) return s.slice(0, 7); const [y, m] = s.split('-').map(Number); return Number(s.slice(8, 10)) > 20 ? new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7) : s.slice(0, 7); };
export const cycleRange = month => { const [y, m] = month.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 2, 21)).toISOString().slice(0, 10), to: `${month}-20` }; };
export const isClosed = async (c, iso) => !!(await one(c, 'SELECT period FROM app_period_close WHERE period=?', [cycleMonth(iso)]));
// pattern（A01〜F01）を付けると仕訳別確定（app_journal_close）も見る（2026-11-26 ユーザー指示：月次確定のほかに自動仕訳ごとに確定）
// 入金（B01）・支払内訳（F01）は対象外（2026-11-27 ユーザー指示：仕訳別確定の画面から除外）
// 並びは業務の流れ（メニューの順：売掛金計上 → 定時請求 → 小口現金 → 在庫計上。2026-11-27 ユーザー指示）
export const JOURNAL_CLOSE = { A01: '売掛金計上', D01: '定時請求', E01: '小口現金出納分', C01: '在庫計上' };
// 計上の［実行］で自動的に確定する自動仕訳（2026-11-27 打合せ 01:07「自動仕訳を実行したら自動で確定済み。解除だけ手で」）。小口現金出納分 E01 は計上の実行が無いため手で確定
export const AUTO_CLOSE = { A01: '売掛金計上', C01: '在庫計上', D01: '定時請求計上' };
export async function autoCloseJournal(c, ctx, month, pattern) {
  const [r] = await c.query('INSERT IGNORE INTO app_journal_close (period, pattern, closed_at, closed_by) VALUES (?, ?, UTC_TIMESTAMP(6), ?)', [month, pattern, ctx?.user?.login_id || 'system']);
  await audit(c, ctx, 'app_journal_close', `${month}:${pattern}`, 'journal.autoclose', { month, pattern, name: JOURNAL_CLOSE[pattern] });
  return r;
}
export async function assertOpen(c, iso, pattern) {
  const ym = cycleMonth(iso);   // 20日締めの会計月（2026-11-27）
  const r = await one(c, 'SELECT period FROM app_period_close WHERE period=? FOR SHARE', [ym]);
  check(!r, `${ym}（${cycleRange(ym).from}〜${cycleRange(ym).to}）は月次確定済みのため登録・変更できません`);
  if (pattern && JOURNAL_CLOSE[pattern]) check(!(await one(c, 'SELECT 1 x FROM app_journal_close WHERE period=? AND pattern=? FOR SHARE', [ym, pattern])), `${ym} の${JOURNAL_CLOSE[pattern]}（${JOURNAL_CLOSE[pattern]}自動仕訳）は月次確定事前チェックで確定済みのため登録・変更・計上できません`);
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
export const formatSlipNo = (series, n) => series + String(n).padStart(series ? 5 : 6, '0'); // 現行（移行データ）の形式
// 10/26 打合せ「伝票番号の採番」：伝票別に頭1桁の英数＋処理西暦年度（4桁）＋5桁連番。連番は伝票の種類×年度ごとに 1 から（2026-10-28）
export const formatSlipNoFy = (series, fy, n) => `${series}${fy}${String(n).padStart(5, '0')}`;
// 年度の最初の1件が同時に来ても重複しないよう、行を確保してからロックする
export async function nextSlipNoFy(c, series, date) {
  const fy = (await companyPeriod(c)).fyOf(date instanceof Date ? date.toISOString().slice(0, 10) : String(date || today()).slice(0, 10)), key = `${series}${fy}`; // 処理年度＝日付の会計年度（期首の西暦）
  await c.query('INSERT IGNORE INTO app_slip_series (series,last_no) VALUES (?,0)', [key]);
  const r = await one(c, 'SELECT last_no FROM app_slip_series WHERE series=? FOR UPDATE', [key]), n = Number(r?.last_no ?? 0) + 1;
  await c.query('UPDATE app_slip_series SET last_no=? WHERE series=?', [n, key]);
  return formatSlipNoFy(series, fy, n);
}
// 次に振る番号の見込み（採番しない。登録画面に予定の伝票No を出す。2026-11-23 ユーザー指示）。同時に別の登録があれば実際の番号は変わる
export async function peekSlipNoFy(c, series, date) {
  const fy = (await companyPeriod(c)).fyOf(String(date || today()).slice(0, 10)), r = await one(c, 'SELECT last_no FROM app_slip_series WHERE series=?', [`${series}${fy}`]);
  return formatSlipNoFy(series, fy, Number(r?.last_no ?? 0) + 1);
}
// 伝票の番号（2026-11-03 ユーザー指示）：英字＋処理年度4桁＋5桁連番（例 N202600001）。仕訳の伝票番号（SLIP_SERIES）とは別の系列。
//  請求書 C・入金 N・定時請求 T・小口現金 G・支払（銀行別随時支払）Z・実在庫 V・商品仕入 P。請求書の K（年月＋請求ID）は小口現金の自動仕訳 K と重なるためやめる。
//  登録済みの伝票の番号は変えない（発行済みの請求書は控えの番号のまま）
export const DOC_SERIES = { invoice: 'C', receipt: 'N', payable: 'T', petty: 'G', payment: 'Z', count: 'V', purchase: 'P' };
// 番号の列を持たない請求書（ref＝請求ID）・実在庫（ref＝月度）は app_doc_no に保存する。登録済みならその番号
export async function docNo(c, kind, ref, date) {
  const r = await one(c, 'SELECT doc_no FROM app_doc_no WHERE kind=? AND ref=?', [kind, String(ref)]); if (r) return r.doc_no;
  const no = await nextSlipNoFy(c, DOC_SERIES[kind], date);
  await c.query('INSERT INTO app_doc_no (kind,ref,doc_no) VALUES (?,?,?)', [kind, String(ref), no]);
  return no;
}
// 請求書番号：app_doc_no の C 番号。無い（2026-11-03 より前の）請求は現行の K＋締日の年月＋請求ID5桁
export const legacyInvoiceNo = (closing, id) => 'K' + String(closing).slice(0, 7).replace('-', '') + String(id).padStart(5, '0');
export async function invoiceNos(c, list) {
  const ids = list.map(x => String(x.id)), m = new Map();
  if (ids.length) for (const r of await rows(c, `SELECT ref, doc_no FROM app_doc_no WHERE kind='invoice' AND ref IN (${ids.map(() => '?').join(',')})`, ids)) m.set(r.ref, r.doc_no);
  return new Map(list.map(x => [Number(x.id), m.get(String(x.id)) || legacyInvoiceNo(x.closing, x.id)]));
}
// 売掛金計上（A01）は締日単位で一括計上し、1伝票に45得意先（1請求＝1得意先）まで載せて分割する（Q08：現行 R00829・R00830 が借方45行、R00831 が残り）。
export const AR_SLIP_MAX = 45;
// slip … 同じ伝票にまとめる仕訳の共有状態 { no, count, max }（請求締め1回分）。省略時は1仕訳＝1伝票。
export async function assignSlipNo(c, journalId, pattern, slip, date) {
  const series = SLIP_SERIES[pattern]; if (series === undefined) return '';
  let no = slip?.no && slip.count < slip.max ? slip.no : '';
  if (!no) {
    no = await nextSlipNoFy(c, series, date);
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
// 売掛金計上（請求 A01）の取消・作り直し：会計連携前の締日（app_acct_link に無い月度）の仕訳は逆仕訳を作らず削除する（現行 HAR363 どおり、
// 2026-11-17 ユーザー指示「現行どおり」）。会計連携済みの月度は従来どおり逆仕訳。月度＝前月21日〜当月20日（20日締め）
const arMonthOf = d => { const s = String(d).slice(0, 10), [y, m] = s.split('-').map(Number); return Number(s.slice(8)) > 20 ? new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7) : s.slice(0, 7); };
export async function discardOrReverseJournal(c, { sourceType, sourceId, date }) {
  const entries = await rows(c, "SELECT journal_id, journal_date FROM journal_entry WHERE source_type=? AND source_id=? AND status='POSTED' AND reversal_of IS NULL FOR UPDATE", [sourceType, String(sourceId)]);
  let n = 0;
  for (const e of entries) {
    if (await one(c, 'SELECT 1 x FROM app_acct_link WHERE month=?', [arMonthOf(e.journal_date)])) continue;
    for (const t of ['journal_line', 'app_slip_no', 'journal_entry']) await c.query(`DELETE FROM ${t} WHERE journal_id=?`, [e.journal_id]);
    n++;
  }
  return n + await reverseJournal(c, { sourceType, sourceId, date });
}
export function mapSqlError(e) {
  if (e instanceof DomainError) return e;
  const m = { ER_DUP_ENTRY: 'コードまたは番号が重複しています', ER_NO_REFERENCED_ROW_2: '参照先のマスタが存在しません', ER_ROW_IS_REFERENCED_2: '他のデータから参照されているため変更できません',
    ER_CHECK_CONSTRAINT_VIOLATED: '入力値が制約に違反しています', ER_DATA_TOO_LONG: '入力値が長すぎます', ER_WARN_DATA_OUT_OF_RANGE: '数値が範囲外です' }[e?.code];
  return m ? new DomainError(m) : null;
}
