import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { prepare } from './schema.mjs';
import { seedIfEmpty } from './seed.mjs';
import { createApp } from './http.mjs';

const e = process.env;
const conn = e.MYSQL_URL_OVERRIDE ? { uri: e.MYSQL_URL_OVERRIDE } : { host: e.MYSQLHOST, port: Number(e.MYSQLPORT || 3306), database: e.MYSQLDATABASE, user: e.MYSQLUSER, password: e.MYSQLPASSWORD };
if (!conn.uri) for (const k of ['MYSQLHOST', 'MYSQLDATABASE', 'MYSQLUSER', 'MYSQLPASSWORD']) if (!e[k]) throw Error('Missing environment variable: ' + k);
const pool = mysql.createPool({ ...conn, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, decimalNumbers: true, connectionLimit: 8, queueLimit: 50, connectTimeout: 10000,
  ...(e.MYSQL_SSL_CA ? { ssl: { ca: e.MYSQL_SSL_CA, rejectUnauthorized: true } } : {}) });
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
try {
  await prepare(pool);
  if (e.SEED_DEMO !== '0' && await seedIfEmpty(pool)) console.log('Sample data created');
  const server = await createApp({ pool, publicDir: new URL('../public/', import.meta.url), version });
  server.listen(Number(e.PORT || 8080), '0.0.0.0', () => console.log(`APLink seikyu-web ${version} listening`));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(async () => { await pool.end(); process.exit(0); }));
} catch (err) {
  console.error('Startup failed:', err.code || err.name, err.message);
  await pool.end(); process.exitCode = 1;
}
