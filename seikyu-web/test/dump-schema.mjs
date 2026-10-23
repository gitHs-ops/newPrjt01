// 結合テスト用 DDL（test/schema/schema.sql）を本番 DB のカタログから作る（読み取りのみ）。
// 使い方: DATABASE_URL=<本番DB> node test/dump-schema.mjs
// 対象は業務表（ledger.mjs の TABLES）。app_* / kb_* と関数 unit_name は起動時に schema.mjs が作る。
import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { TABLES } from '../server/ledger.mjs';

const url = process.env.DATABASE_URL; if (!url) throw Error('DATABASE_URL を指定してください');
const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
await c.connect();
const q = (sql, args = []) => c.query(sql, args).then(r => r.rows);
const names = Object.keys(TABLES).sort();
const ident = n => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replaceAll('"', '""')}"`);

const cols = await q(`SELECT c.relname t, a.attname n, format_type(a.atttypid, a.atttypmod) ty, a.attnotnull nn, a.attidentity idn, pg_get_expr(d.adbin, d.adrelid) def,
    CASE WHEN a.attcollation <> 0 AND a.attcollation <> ty.typcollation THEN (SELECT collname FROM pg_collation WHERE oid = a.attcollation) END coll
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = current_schema() JOIN pg_type ty ON ty.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`, [names]);
const cons = await q(`SELECT c.relname t, k.conname n, k.contype ty, pg_get_constraintdef(k.oid) def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = current_schema() WHERE c.relname = ANY($1) ORDER BY c.relname, k.contype, k.conname`, [names]);
const idx = await q(`SELECT i.tablename t, i.indexname n, i.indexdef def FROM pg_indexes i WHERE i.schemaname = current_schema() AND i.tablename = ANY($1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = i.indexname) ORDER BY i.tablename, i.indexname`, [names]);
const seqs = [...new Set(cols.map(x => /nextval\('([^']+)'/.exec(x.def || '')?.[1]).filter(Boolean))];

const out = [`-- 結合テスト用 DDL（本番 DB のカタログから test/dump-schema.mjs で生成、${new Date().toISOString().slice(0, 10)}）。業務表 ${names.length} 表`];
for (const sq of seqs) out.push(`CREATE SEQUENCE IF NOT EXISTS ${sq.replace(/::regclass$/, '')};`);
for (const t of names) {
  const cs = cols.filter(x => x.t === t); if (!cs.length) throw Error(`本番 DB に表 ${t} がありません`);
  const lines = cs.map(x => `  ${ident(x.n)} ${x.ty}${x.coll ? ` COLLATE "${x.coll}"` : ''}${x.idn ? ` GENERATED ${x.idn === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : x.def ? ` DEFAULT ${x.def}` : ''}${x.nn ? ' NOT NULL' : ''}`);
  for (const k of cons.filter(x => x.t === t && x.ty !== 'f')) lines.push(`  CONSTRAINT ${ident(k.n)} ${k.def}`);
  out.push(`CREATE TABLE ${ident(t)} (\n${lines.join(',\n')}\n);`);
}
for (const k of cons.filter(x => x.ty === 'f')) out.push(`ALTER TABLE ${ident(k.t)} ADD CONSTRAINT ${ident(k.n)} ${k.def};`);
for (const i of idx) out.push(`${i.def.replace(/ ON [a-z_]+\./, ' ON ')};`);
await c.end();
await mkdir(new URL('./schema/', import.meta.url), { recursive: true });
await writeFile(new URL('./schema/schema.sql', import.meta.url), out.join('\n') + '\n');
console.log(`test/schema/schema.sql: ${names.length} tables, ${cons.length} constraints, ${idx.length} indexes, ${seqs.length} sequences`);
