import { readFile } from 'node:fs/promises';
import { createPool } from './pg.mjs';
import { prepare } from './schema.mjs';
import { seedIfEmpty } from './seed.mjs';
import { createApp } from './http.mjs';

const e = process.env;
if (!e.DATABASE_URL) throw Error('Missing environment variable: DATABASE_URL');
// Railway の内部ネットワーク（*.railway.internal）は TLS なし、外部接続は TLS
const internal = /@[^/]*\.railway\.internal[:/]|@(localhost|127\.0\.0\.1)[:/]/.test(e.DATABASE_URL);
const pool = createPool(e.DATABASE_URL, { max: 8, ssl: internal ? false : { rejectUnauthorized: false } });
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
try {
  await prepare(pool);
  if (e.SEED_DEMO !== '0' && await seedIfEmpty(pool)) console.log('Sample data created');
  const server = await createApp({ pool, publicDir: new URL('../public/', import.meta.url), version });
  server.listen(Number(e.PORT || 8080), '0.0.0.0', () => console.log(`APLink seikyu-web ${version} listening (PostgreSQL)`));
  // 請求データのまとめ（app_billing_line）が無い請求を裏で作る
  import('./sales.mjs').then(m => m.backfillSummaries(pool)).then(n => n && console.log(`billing summary backfilled: ${n}`)).catch(err => console.error('billing summary backfill failed:', err.message));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(async () => { await pool.end(); process.exit(0); }));
} catch (err) {
  console.error('Startup failed:', err.code || err.name, err.message);
  await pool.end(); process.exitCode = 1;
}
