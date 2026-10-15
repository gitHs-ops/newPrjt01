// PostgreSQL 接続（mysql2/promise と同じ呼び方で使えるようにする薄い層）
// - プレースホルダ ? → $1…、INSERT は自動採番列を RETURNING して insertId を返す
// - 旧 MySQL 方言のうち、業務 SQL に残るもの（INSERT IGNORE・ON DUPLICATE KEY UPDATE・UTC_TIMESTAMP・CAST AS CHAR）をここで読み替える
// - 値の型は mysql2（dateStrings・decimalNumbers）と同じ形で返す：日付・日時は文字列、numeric/bigint は数値、boolean は 1/0
import pg from 'pg';

const P = pg.types;
for (const oid of [1082, 1114, 1184, 1083]) P.setTypeParser(oid, (v) => v);
P.setTypeParser(20, (v) => Number(v));
P.setTypeParser(1700, (v) => Number(v));
P.setTypeParser(16, (v) => (v === 't' ? 1 : 0));

// 旧 MySQL のエラーコードに読み替える（mapSqlError・http.mjs が参照）
const CODE = { 23505: 'ER_DUP_ENTRY', 23514: 'ER_CHECK_CONSTRAINT_VIOLATED', 22001: 'ER_DATA_TOO_LONG', 22003: 'ER_WARN_DATA_OUT_OF_RANGE', '22P02': 'ER_TRUNCATED_WRONG_VALUE' };
function mapError(e) {
  if (!e || !e.code || e.pgCode) return e;
  e.pgCode = e.code;
  if (e.code === '23503') e.code = /update or delete on table/.test(e.message) ? 'ER_ROW_IS_REFERENCED_2' : 'ER_NO_REFERENCED_ROW_2';
  else if (CODE[e.code]) e.code = CODE[e.code];
  return e;
}

// ? を $n に（文字列・識別子・コメントの中は変えない）
function placeholders(sql) {
  let out = '', n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') { const j = sql.indexOf(ch, i + 1); const end = j < 0 ? sql.length : j; out += sql.slice(i, end + 1); i = end; continue; }
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const end = j < 0 ? sql.length : j; out += sql.slice(i, end); i = end - 1; continue; }
    out += ch === '?' ? '$' + ++n : ch;
  }
  return out;
}

export function createPool(connectionString, { max = 8, ssl } = {}) {
  const pool = new pg.Pool({ connectionString, max, ssl, options: '-c TimeZone=UTC', connectionTimeoutMillis: 10000 });
  let meta = null;
  async function loadMeta() {
    if (meta) return meta;
    const ids = await pool.query("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = current_schema() AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')");
    const pks = await pool.query(`SELECT tc.table_name t, string_agg(k.column_name, ',' ORDER BY k.ordinal_position) c FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
      WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY' GROUP BY tc.table_name`);
    meta = { id: new Map(ids.rows.map((r) => [r.t, r.c])), pk: new Map(pks.rows.map((r) => [r.t, r.c.split(',')])) };
    return meta;
  }
  const cache = new Map();
  function translate(sql) {
    let hit = cache.get(sql);
    if (hit) return hit;
    let s = sql.replace(/`(\w+)`/g, '"$1"').replace(/UTC_TIMESTAMP\(\d*\)/gi, 'LOCALTIMESTAMP').replace(/\bAS\s+CHAR\s*\)/gi, 'AS TEXT)')
      // CONCAT の引数のプレースホルダは型が決まらないので text にする
      .replace(/\bCONCAT\(([^()]*)\)/gi, (m, inner) => 'CONCAT(' + inner.replace(/\?/g, '?::text') + ')');
    const ins = /^\s*INSERT\s+(IGNORE\s+)?INTO\s+"?(\w+)"?/i.exec(s), table = ins && ins[2];
    if (ins && ins[1]) { s = s.replace(/^\s*INSERT\s+IGNORE\s+INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING'; }
    const dup = /\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+([\s\S]*)$/i.exec(s);
    if (dup) {
      const pk = meta.pk.get(table);
      if (!pk) throw Error('no primary key for ON DUPLICATE KEY UPDATE: ' + table);
      s = s.slice(0, dup.index) + ` ON CONFLICT (${pk.map((c) => '"' + c + '"').join(', ')}) DO UPDATE SET ` + dup[1].replace(/VALUES\((\w+)\)/gi, 'EXCLUDED.$1');
    }
    // 外部結合を含む行ロックは主表だけをロックする（PostgreSQL は NULL 側をロックできない）
    const lock = /\bFOR\s+(UPDATE|SHARE)\s*$/i.exec(s);
    if (lock && /\bJOIN\b/i.test(s)) {
      const f = /\bFROM\s+"?(\w+)"?(?:\s+(?:AS\s+)?(?!(?:WHERE|LEFT|RIGHT|INNER|JOIN|CROSS|ORDER|GROUP|LIMIT)\b)(\w+))?/i.exec(s);
      if (f) s = s.slice(0, lock.index) + `FOR ${lock[1].toUpperCase()} OF ${f[2] || f[1]}`;
    }
    const idCol = ins && !/\bRETURNING\b/i.test(s) ? meta.id.get(table) : null;
    if (idCol) s += ` RETURNING "${idCol}"`;
    hit = { text: placeholders(s), idCol, insert: !!ins };
    cache.set(sql, hit);
    return hit;
  }
  async function run(client, sql, args = []) {
    if (/^\s*SET\s+TRANSACTION\b/i.test(sql)) return [{ affectedRows: 0, insertId: 0 }];
    await loadMeta();
    const t = translate(sql);
    let r;
    try { r = await client.query(t.text, (args || []).map((v) => (v === undefined ? null : v))); }
    catch (e) { if (process.env.PG_DEBUG) console.error('[pg]', e.code, e.message, '\n  SQL:', t.text.slice(0, 600)); throw mapError(e); }
    if (t.insert || r.command !== 'SELECT') return [{ insertId: t.idCol && r.rows[0] ? Number(r.rows[0][t.idCol]) : 0, affectedRows: r.rowCount }, undefined];
    return [r.rows, r.fields];
  }
  const api = {
    query: (sql, args) => run(pool, sql, args),
    async getConnection() {
      const client = await pool.connect();
      return {
        query: (sql, args) => run(client, sql, args),
        beginTransaction: () => client.query('BEGIN ISOLATION LEVEL READ COMMITTED'),
        commit: () => client.query('COMMIT'),
        rollback: () => client.query('ROLLBACK'),
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
    resetMeta() { meta = null; cache.clear(); },
    pg: pool,
  };
  return api;
}
