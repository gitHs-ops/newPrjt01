// End-to-end API test against a disposable MySQL database. Never point MYSQL_TEST_URL at production.
import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { prepare } from '../server/schema.mjs';
import { createApp } from '../server/http.mjs';

const url = process.env.MYSQL_TEST_URL;
test('workflow against MySQL business tables', { skip: !url && 'MYSQL_TEST_URL not set', timeout: 900000 }, async t => {
  const pool = mysql.createPool({ uri: url, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, decimalNumbers: true, connectionLimit: 6 });
  const env = { DEMO_USER: 'itest-admin', DEMO_PASSWORD: 'itest-password-0001', SCHEMA_SQL_DIR: process.env.SCHEMA_SQL_DIR };
  const saved = { DEMO_USER: process.env.DEMO_USER }; process.env.DEMO_USER = env.DEMO_USER;
  await prepare(pool, env);
  const server = await createApp({ pool, publicDir: new URL('../public/', import.meta.url), secureCookies: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '', csrf = '';
    const call = async (path, body) => {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}) }, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || ''; return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
    };
    return { call, get cookie() { return cookie; }, async login(id, pw) { const r = await call('/api/login', { loginId: id, password: pw }); if (r.status === 200) csrf = (await call('/api/session')).data.csrf; return r; } };
  };
  const tag = Date.now().toString(36).slice(-4).toUpperCase(), C = 'Q' + tag, d = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const pm = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 2, 1)).toISOString().slice(0, 7), sd = pm + '-15', month = pm;
  try {
    const anon = client();
    assert.equal((await anon.call('/api/dashboard')).status, 401);
    assert.equal((await anon.login(env.DEMO_USER, 'wrong-password-xx')).status, 401);
    const a = client(); assert.equal((await a.login(env.DEMO_USER, env.DEMO_PASSWORD)).status, 200);
    const noCsrf = await fetch(base + '/api/shipments', { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie }, body: '{}' });
    assert.equal(noCsrf.status, 403, 'CSRF token required');

    await t.test('masters with optimistic concurrency', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: C, name: '結合試験(架空)', closing: 31, active: true } }));
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: C, code: 'S' + tag, suffix: '000', name: '試験現場', active: true } }));
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'I' + tag, name: '試験商品', unit: 't', price: 1000, active: true } }));
      ok(await a.call('/api/masters/vendors', { mode: 'create', record: { code: 'V' + tag, name: '試験業者', bank: '0001', branch: '001', accountType: '1', account: '1234567', holder: 'ｼｹﾝ', active: true } }));
      ok(await a.call('/api/masters/banks', { mode: 'create', record: { code: 'B' + tag, name: '試験銀行', active: true } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'create', record: { code: C, name: 'dup', closing: 31 } })).status, 400);
      const cust = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      ok(await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: '結合試験(更新)' } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: 'stale' } })).status, 409);
      const bad = await a.call(`/api/masters/items/import`, { csv: `code,name,unit,price\nJ${tag},ok,t,10\nK${tag},${'x'.repeat(30)},t,10\n` });
      assert.equal(bad.status, 400); assert.match(bad.data.error, /3行目/);
      assert.ok(!(await a.call('/api/masters/items')).data.some(x => x.code === 'J' + tag), 'CSV import rolled back');
    });

    let invoiceId;
    await t.test('shipment → billing → issue → receipt with journals', async () => {
      const s1 = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '10.5', price: 1000, taxRate: 10, method: 1 });
      assert.equal(s1.status, 200, JSON.stringify(s1.data));
      await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '3', price: 999, taxRate: 8, method: 1 });
      const cash = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '1', price: 500, taxRate: 10, method: 2 });
      const run = await a.call('/api/billing/run', { month, closing: 31, customers: [C] });
      assert.equal(run.status, 200, JSON.stringify(run.data)); assert.equal(run.data.created, 1); invoiceId = run.data.ids[0];
      const inv = (await a.call('/api/invoices/' + invoiceId)).data;
      assert.equal(inv.net, 10500 + 2997); assert.equal(inv.tax, 1050 + 239); assert.equal(inv.lines.length, 2);
      assert.equal((await a.call('/api/billing/run', { month, closing: 31, customers: [C] })).status, 400, 'no double billing');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: s1.data.orderNo })).status, 400, 'billed shipment locked');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: cash.data.orderNo })).status, 200);
      assert.equal((await a.call('/api/receipts', { idempotencyKey: 'x' + tag, date: d, customer: C, bank: 100, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 100 }] })).status, 400, 'must be issued first');
      const issued = await a.call('/api/invoices/issue', { ids: [invoiceId] }); assert.equal(issued.status, 200);
      assert.equal(issued.data.documents[0].total, inv.total);
      // Two concurrent receipts that together exceed the balance: exactly one succeeds.
      const half = inv.total - 1000;
      const [r1, r2] = await Promise.all([1, 2].map(n => a.call('/api/receipts', { idempotencyKey: `c${n}-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] })));
      assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
      const again = await a.call('/api/receipts', { idempotencyKey: r1.status === 200 ? `c1-${tag}` : `c2-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] });
      assert.equal(again.data.duplicate, true);
      const fin = await a.call('/api/receipts', { idempotencyKey: 'f' + tag, date: d, customer: C, bank: 940, fee: 60, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] });
      assert.equal(fin.status, 200, JSON.stringify(fin.data));
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.status, 'paid');
      const rev = await a.call('/api/receipts/reverse', { id: fin.data.id }); assert.equal(rev.status, 200);
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.balance, 1000);
      const js = [...(await a.call('/api/journals?month=' + month)).data, ...(await a.call('/api/journals?month=' + d.slice(0, 7))).data].filter(j => ['billing_head', 'receipt'].includes(j.source));
      for (const j of js) assert.equal(j.lines.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), j.lines.filter(l => l.side === 'C').reduce((n, l) => n + l.amount, 0));
      assert.ok(js.some(j => j.reversalOf), 'reversal journal recorded');
    });

    await t.test('payables, payment and roles', async () => {
      const doc = await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '10%', amount: 50000, memo: '試験' });
      assert.equal(doc.status, 200, JSON.stringify(doc.data));
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 60000 }] })).status, 400);
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 50000 }] })).status, 200);
      assert.equal((await a.call('/api/expenses/reverse', { id: doc.data.id })).status, 400, 'paid document locked');
      const u = await a.call('/api/users', { loginId: 'viewer' + tag, name: '参照者', role: 3, password: 'viewer-password-01', enabled: true }); assert.equal(u.status, 200);
      const v = client(); assert.equal((await v.login('viewer' + tag, 'viewer-password-01')).status, 200);
      assert.equal((await v.call('/api/dashboard')).status, 200);
      assert.equal((await v.call('/api/shipments', { date: d })).status, 403);
      assert.equal((await v.call('/api/users')).status, 403);
      await a.call('/api/users', { id: u.data.id, name: '参照者', role: 3, enabled: false });
      assert.equal((await v.call('/api/dashboard')).status, 401, 'disabled user session revoked');
    });
    const raw = await fetch(base + '/api/export/journals?month=' + month, { headers: { cookie: a.cookie } }); const bytes = new Uint8Array(await raw.arrayBuffer());
    assert.equal(raw.status, 200); assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV has UTF-8 BOM for Excel');
  } finally {
    process.env.DEMO_USER = saved.DEMO_USER;
    await new Promise(r => server.close(r)); await pool.end();
  }
});
