// End-to-end API test against a disposable PostgreSQL database. Never point PG_TEST_URL at production (seikyu_web).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../server/pg.mjs';
import { isHoliday, nextBusinessDay } from '../server/domain.mjs';
import { prepare } from '../server/schema.mjs';
import { createApp } from '../server/http.mjs';

const url = process.env.PG_TEST_URL;
const skip = !url ? 'PG_TEST_URL not set' : /\/seikyu_web(\?|$)/.test(url) ? 'refusing to run against the production database' : false;
test('workflow against PostgreSQL business tables', { skip, timeout: 900000 }, async t => {
  const pool = createPool(url, { max: 6, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
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
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: C, code: 'T' + tag, suffix: '000', name: '試験現場2', active: true } }));
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'I' + tag, name: '試験商品', unit: '01', price: 1000, active: true } }));
      ok(await a.call('/api/masters/vendors', { mode: 'create', record: { code: 'V' + tag, name: '試験業者', bank: '0001', branch: '001', accountType: '1', account: '1234567', holder: 'ｼｹﾝ', active: true } }));
      ok(await a.call('/api/masters/banks', { mode: 'create', record: { code: 'B' + tag, name: '試験銀行', active: true } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'create', record: { code: C, name: 'dup', closing: 31 } })).status, 400);
      assert.equal((await a.call('/api/masters/customers', { mode: 'create', record: { code: 'Z' + tag, name: '締日不正', closing: 23 } })).status, 400, '締日は 5・10・15・20・末日のみ');
      const cust = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      ok(await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: '結合試験(更新)' } }));
      assert.equal((await a.call('/api/masters/customers', { mode: 'update', record: { ...cust, name: 'stale' } })).status, 409);
      const bad = await a.call(`/api/masters/items/import`, { csv: `code,name,unit,price\nJ${tag},ok,01,10\nK${tag},${'x'.repeat(30)},01,10\n` });
      assert.equal(bad.status, 400); assert.match(bad.data.error, /3行目/);
      assert.ok(!(await a.call('/api/masters/items')).data.some(x => x.code === 'J' + tag), 'CSV import rolled back');
    });

    let invoiceId;
    await t.test('shipment → billing → issue → receipt with journals', async () => {
      const s1 = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '10.5', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 });
      assert.equal(s1.status, 200, JSON.stringify(s1.data));
      await a.call('/api/shipments', { date: sd, customer: C, site: `T${tag}|000`, item: 'I' + tag, quantity: '3', price: 999, taxRate: 8, operator: '1', deliveryKbn: '1', method: 2 });
      // NO11 赤黒（10/14）：赤＝元の全量マイナス、黒＝訂正後。同じ伝票の二重訂正は不可
      const corr = await a.call('/api/shipments/correct', { orderNo: s1.data.orderNo, date: sd, quantity: '10' });
      assert.equal(corr.status, 200, JSON.stringify(corr.data)); assert.equal(corr.data.net, -500); assert.ok(corr.data.red && corr.data.black);
      assert.equal((await a.call('/api/shipments/correct', { orderNo: s1.data.orderNo, date: sd, quantity: '9' })).status, 400, 'already corrected');
      const cash = await a.call('/api/shipments', { date: sd, customer: C, site: `S${tag}|000`, item: 'I' + tag, quantity: '1', price: 500, taxRate: 10, operator: '1', deliveryKbn: '1', method: 1 });
      const run = await a.call('/api/billing/run', { month, closing: 31, customers: [C] });
      assert.equal(run.status, 200, JSON.stringify(run.data)); assert.equal(run.data.created, 1); invoiceId = run.data.ids[0];
      const inv = (await a.call('/api/invoices/' + invoiceId)).data;
      // NO6: one head per customer covering both sites and the correction
      assert.equal(inv.net, 10500 - 500 + 2997); assert.equal(inv.tax, 1299); // 税率は出荷日で消費税率マスタ（A0007）から自動＝10% assert.equal(inv.lines.length, 4); assert.equal(new Set(inv.lines.map(l => l.site)).size, 2);
      const list = await a.call(`/api/reports/billing-list?month=${month}&closing=31`); assert.equal(list.status, 200);
      const row = list.data.rows.find(r => r.customer === C); assert.equal(row.current, inv.total); assert.equal(row.total, row.carried + inv.total); assert.equal(row.state, 'draft');
      const book = await fetch(base + `/api/reports/billing-list?month=${month}&closing=31&format=xlsx`, { headers: { cookie: a.cookie } });
      assert.equal(book.status, 200); assert.equal(Buffer.from(await book.arrayBuffer()).subarray(0, 2).toString(), 'PK', 'xlsx is a zip');
      assert.equal((await a.call('/api/billing/run', { month, closing: 31, customers: [C] })).status, 400, 'no double billing');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: s1.data.orderNo })).status, 400, 'billed shipment locked');
      assert.equal((await a.call('/api/shipments/delete', { orderNo: cash.data.orderNo })).status, 200);
      // 2026-10-23：未発行でも残高があれば消込対象（状態は draft＝未発行）
      const ctx0 = (await a.call('/api/receipt-context?customer=' + C)).data.invoices.find(i => i.id === invoiceId); assert.equal(ctx0?.status, 'draft', 'unissued invoice is a receipt target');
      // 2026-10-27 現場別発行：選んだ現場だけ発行し、発行状況・控えは現場ごと
      const sitesOf = async () => Object.fromEntries((await a.call(`/api/invoices?month=${month}&customer=${C}`)).data.find(i => i.id === invoiceId).sites.map(x => [x.siteName, x.issues]));
      const names = Object.keys(await sitesOf()); assert.equal(names.length, 2);
      const part = await a.call('/api/invoices/issue', { ids: [invoiceId], sites: { [invoiceId]: [names[1]] } }); assert.equal(part.status, 200, JSON.stringify(part.data));
      assert.deepEqual(part.data.documents[0].sites, [names[1]]);
      assert.deepEqual(await sitesOf(), { [names[0]]: 0, [names[1]]: 1 });
      // HAR431：現場別発行した得意先は現場ごとの行（2026-11-03）
      const split = (await a.call(`/api/reports/billing-list?month=${month}&closing=31`)).data.rows.find(r => r.customer === C);
      assert.equal(split.bookRows.length, 2); assert.deepEqual(split.bookRows.map(r => r.siteName).sort(), [...names].sort());
      assert.equal((await a.call(`/api/invoices/${invoiceId}/document?site=${encodeURIComponent(names[0])}`)).status, 400, 'unissued site has no copy');
      assert.equal((await a.call('/api/invoices/issue', { ids: [invoiceId], sites: { [invoiceId]: ['存在しない現場'] } })).status, 400);
      const issued = await a.call('/api/invoices/issue', { ids: [invoiceId] }); assert.equal(issued.status, 200);
      assert.deepEqual(await sitesOf(), { [names[0]]: 1, [names[1]]: 2 });
      const copy0 = (await a.call(`/api/invoices/${invoiceId}/document?site=${encodeURIComponent(names[0])}`)).data; assert.equal(copy0.siteIssueNo[names[0]], 1); assert.deepEqual(copy0.sites, [names[0]]);
      const conf = await a.call(`/api/reports/billing-confirm?month=${month}&closing=31`); assert.equal(conf.data.rows.find(r => r.customer === C).lines.length, 4);
      assert.equal(issued.data.documents[0].total, inv.total);
      // Two concurrent receipts that together exceed the balance: exactly one succeeds.
      const half = inv.total - 1000;
      const [r1, r2] = await Promise.all([1, 2].map(n => a.call('/api/receipts', { idempotencyKey: `c${n}-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] })));
      assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
      assert.match([r1, r2].find(r => r.status === 200).data.no, /^N\d{9}$/, '入金No＝N＋年度4桁＋5桁（2026-11-03）');
      const again = await a.call('/api/receipts', { idempotencyKey: r1.status === 200 ? `c1-${tag}` : `c2-${tag}`, date: d, customer: C, bank: half, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: half }] });
      assert.equal(again.data.duplicate, true);
      // NO17: deposit applied up to its balance, cooperation fee deducted
      const cu = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      assert.equal((await a.call('/api/masters/customers', { mode: 'update', record: { ...cu, deposit: 300 } })).status, 200);
      assert.equal((await a.call('/api/receipts', { idempotencyKey: 'd' + tag, date: d, customer: C, deposit: 400, bank: 600, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] })).status, 400, 'deposit over balance');
      const fin = await a.call('/api/receipts', { idempotencyKey: 'f' + tag, date: d, customer: C, bank: 540, fee: 60, coop: 100, deposit: 300, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] });
      assert.equal((await a.call('/api/receipt-context?customer=' + C)).data.deposit, 0);
      assert.equal(fin.status, 200, JSON.stringify(fin.data));
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.status, 'paid');
      const rev = await a.call('/api/receipts/reverse', { id: fin.data.id }); assert.equal(rev.status, 200);
      assert.equal((await a.call('/api/invoices/' + invoiceId)).data.balance, 1000);
      const js = [...(await a.call('/api/journals?month=' + month)).data, ...(await a.call('/api/journals?month=' + d.slice(0, 7))).data].filter(j => ['billing_head', 'receipt'].includes(j.source));
      for (const j of js) assert.equal(j.lines.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), j.lines.filter(l => l.side === 'C').reduce((n, l) => n + l.amount, 0));
      assert.ok(js.some(j => j.reversalOf), 'reversal journal recorded');
    });

    await t.test('payables, payment and roles', async () => {
      // 繰延最低限度額（2026-11-01 決定）：定時請求 1 件の合計が限度額以上は締切日の翌々月末、未満は支払繰延区分（翌月15日）。休日は翌営業日
      const ven = (await a.call('/api/masters/vendors')).data.find(x => x.code === 'V' + tag);
      assert.equal((await a.call('/api/masters/vendors', { mode: 'update', record: { ...ven, payMonths: '1', payDay: '15', deferMin: '30000' } })).status, 200);
      const ymd = (m, day) => { const [y, mo] = d.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + m, day)).toISOString().slice(0, 10); };
      const near = (due, raw) => assert.ok(due >= raw && (Date.parse(due) - Date.parse(raw)) / 864e5 <= 3, `${due} ~ ${raw}`);
      const under = await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '090', amount: 29999, memo: '限度額未満' });
      const over = await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '090', amount: 30000, memo: '限度額以上' });
      near(under.data.due, ymd(1, 15)); near(over.data.due, ymd(3, 0));
      for (const x of [under, over]) assert.equal((await a.call('/api/expenses/reverse', { id: x.data.id })).status, 200);
      // 小口現金の取消は逆仕訳を作らず、伝票と自動仕訳を削除する（2026-11-03）
      const pd = await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ payee: '削除テスト', account: '8231', taxCode: '141', amount: 100, memo: 'x' }] }); assert.equal(pd.status, 200, JSON.stringify(pd.data));
      const pr = await a.call('/api/expenses/reverse', { id: pd.data.id }); assert.equal(pr.status, 200); assert.equal(pr.data.deleted, true);
      assert.ok(!(await a.call('/api/expenses?' + new URLSearchParams({ kind: 'PETTY_CASH', month: d.slice(0, 7) }))).data.some(r => r.id === pd.data.id));
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM journal_entry WHERE source_type='expense_document' AND source_id=?", [String(pd.data.id)]))[0][0].n, 0);
      const ven2 = (await a.call('/api/masters/vendors')).data.find(x => x.code === 'V' + tag);
      assert.equal(ven2.deferMin, '30000');
      assert.equal((await a.call('/api/masters/vendors', { mode: 'update', record: { ...ven2, payMonths: ven.payMonths, payDay: ven.payDay, deferMin: '' } })).status, 200);
      const doc = await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '10%', amount: 50000, memo: '試験' });
      assert.equal(doc.status, 200, JSON.stringify(doc.data)); assert.match(doc.data.no, /^T\d{9}$/, '定時請求No＝T＋年度4桁＋5桁');
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 60000 }] })).status, 400);
      const pay = await a.call('/api/payments', { idempotencyKey: 'p' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, allocations: [{ expenseId: doc.data.id, amount: 50000 }] });
      assert.equal(pay.status, 200); assert.match(pay.data.no, /^Z\d{9}$/, '支払No＝Z＋年度4桁＋5桁');
      assert.equal((await a.call('/api/expenses/reverse', { id: doc.data.id })).status, 400, 'paid document locked');
      const u = await a.call('/api/users', { loginId: 'viewer' + tag, name: '参照者', role: 5, password: 'viewer-password-01', enabled: true }); assert.equal(u.status, 200);
      const v = client(); assert.equal((await v.login('viewer' + tag, 'viewer-password-01')).status, 200);
      assert.equal((await v.call('/api/dashboard')).status, 200);
      assert.equal((await v.call('/api/shipments', { date: d })).status, 403);
      assert.equal((await v.call('/api/users')).status, 403);
      // 仕訳受入の「内容を確認・チェック」（dry）は参照者も可、受入は不可（2026-10-28）
      assert.equal((await v.call('/api/kb/import/seikyu', { from: d, to: d, dry: true })).status, 200);
      assert.equal((await v.call('/api/kb/import/csv', { csv: '伝票日付,伝票番号,借方科目CD,借方金額,貸方科目CD,貸方金額\n', dry: true })).status, 400, 'dry は権限エラーにならない（入力チェックの 400）');
      assert.equal((await v.call('/api/kb/import/seikyu', { from: d, to: d })).status, 403);
      await a.call('/api/users', { id: u.data.id, name: '参照者', role: 5, enabled: false });
      assert.equal((await v.call('/api/dashboard')).status, 401, 'disabled user session revoked');
    });
    await t.test('② journal lists and bank payment list', async () => {
      const span = { from: pm + '-01', to: d };
      for (const pattern of ['A01', 'B01', 'C01', 'D01', 'E01', 'F01']) {
        const r = await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern, ...span }));
        assert.equal(r.status, 200, pattern + JSON.stringify(r.data));
        for (const sl of r.data.slips) {
          const dr = sl.pairs.reduce((n, p) => n + (p.dr?.amount || 0), 0), cr = sl.pairs.reduce((n, p) => n + (p.cr?.amount || 0), 0);
          assert.equal(dr, cr, pattern + ' slip balanced'); assert.equal(dr, sl.total);
        }
        assert.equal(r.data.total, r.data.dates.reduce((n, x) => n + x.total, 0));
      }
      const b = (await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'B01', ...span }))).data;
      const memos = b.slips.flatMap(sl => sl.pairs.flatMap(p => [p.dr?.memo2, p.cr?.memo2]));
      assert.ok(memos.includes('手数料') && memos.includes('協力費') && memos.includes('預り金充当'), 'B01 deduction memos');
      const bank = await a.call('/api/reports/bank-payments?' + new URLSearchParams(span));
      assert.ok(bank.data.days.some(x => x.rows.some(r => r.vendor === 'V' + tag && r.vendorTotal === 50000)));
      const x = await fetch(base + '/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', ...span, format: 'xlsx' }), { headers: { cookie: a.cookie } });
      const xb = Buffer.from(await x.arrayBuffer()); assert.equal(xb.subarray(0, 2).toString(), 'PK');
      // 現行帳票と同じ2段レイアウト（見出し2行・破線・各ページに見出しを繰り返す）。ZIP は無圧縮なので XML を直接確認できる
      const xt = xb.toString('utf8'); assert.ok(xt.includes('摘　要　1　（借　方）') && xt.includes('摘　要　1　（貸　方）') && xt.includes('style="dashed"') && xt.includes('_xlnm.Print_Titles'));
      assert.equal((await a.call('/api/reports/journal-list?pattern=ZZ&from=2026-01-01&to=2026-01-31')).status, 400);
    });
    await t.test('③ zengin transfer data and payment reports', async () => {
      const bk = (await a.call('/api/masters/banks')).data.find(x => x.code === 'B' + tag);
      assert.equal((await a.call('/api/masters/banks', { mode: 'update', record: { ...bk, zgBank: '0001', zgBranch: '100', zgType: '2', zgAccount: '7777777', zgCode: '1234567890', zgName: '山田' } })).status, 400, 'kanji requester name rejected');
      assert.equal((await a.call('/api/masters/banks', { mode: 'update', record: { ...bk, zgBank: '0001', zgBranch: '100', zgType: '2', zgAccount: '7777777', zgCode: '1234567890', zgName: 'さんぷるけんざい' } })).status, 200);
      const z = await a.call('/api/reports/zengin?' + new URLSearchParams({ date: d, bank: 'B' + tag }));
      // 振込指定日が休日（土日）なら作成しない。試験日（当日）が土日のときはその確認になる
      const wk = isHoliday(d, new Set()), holidayMsg = `振込指定日 ${d} は休日です（翌営業日は ${nextBusinessDay(d, new Set())}）`;
      assert.equal(z.status, 200); assert.deepEqual(z.data.errors, wk ? [holidayMsg] : []); assert.equal(z.data.count, 1); assert.equal(z.data.total, 50000);
      assert.ok(z.data.records.every(r => r.length === 120)); assert.ok(z.data.records[0].includes('ｻﾝﾌﾟﾙｹﾝｻﾞｲ'));
      const file = await fetch(base + '/api/reports/zengin?' + new URLSearchParams({ date: d, bank: 'B' + tag, format: 'file' }), { headers: { cookie: a.cookie } });
      const bytes = Buffer.from(await file.arrayBuffer());
      if (wk) assert.equal(file.status, 400); else { assert.equal(file.status, 200); assert.equal(bytes.length, 4 * 122); assert.equal(bytes[0], 0x31); }
      // カレンダーマスタに登録した休日も同じく作成しない
      if (!wk) {
        assert.equal((await a.call('/api/masters/holidays', { mode: 'create', record: { code: d, name: '試験休日', active: true } })).status, 200);
        const zh = await a.call('/api/reports/zengin?' + new URLSearchParams({ date: d, bank: 'B' + tag }));
        assert.ok(zh.data.errors.some(e => e.startsWith(`振込指定日 ${d} は休日です`)));
        const hol = (await a.call('/api/masters/holidays')).data.find(x => x.code === d);
        assert.equal((await a.call('/api/masters/holidays/delete', { record: hol })).status, 200);
      }
      const vp = await a.call('/api/reports/payments/vendor-payments?' + new URLSearchParams({ from: pm + '-01', to: d }));
      assert.ok(vp.data.vendors.some(v => v.vendor === 'V' + tag && v.total === 50000));
      const tr = await a.call('/api/reports/payments/transfer-request?date=' + d); assert.ok(tr.data.groups.some(g => g.rows.some(r => r.vendor === 'V' + tag)));
      assert.equal((await a.call('/api/reports/payments/carryover?date=' + d)).status, 200);
      const nt = await a.call('/api/reports/payments/notices?date=' + d); const n = nt.data.notices.find(x => x.vendor === 'V' + tag);
      assert.equal(n.total, 50000); assert.equal(n.docs[0].paid, 50000); assert.equal(n.carry.total, 0);
      for (const k of ['vendor-payments', 'transfer-request', 'carryover', 'notices']) {
        const x = await fetch(base + '/api/reports/payments/' + k + '?' + new URLSearchParams({ date: d, from: pm + '-01', to: d, format: 'xlsx' }), { headers: { cookie: a.cookie } });
        assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK', k);
      }
    });
    await t.test('④ shipment totals, material ledger, mix and JV allocation', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      const span = new URLSearchParams({ from: pm + '-01', to: d });
      const sd = (await a.call('/api/reports/misc/shipment-summary?' + span)).data, ss = sd.sections.flatMap(sc => sc.groups.flatMap(g => g.items)).find(x => x.item === 'I' + tag);
      // 現行 HAR031：商品／製品の区分ごとの計、合計＝各区分の計の和、総合計＝各表の合計の和
      for (const sc of sd.sections) assert.equal(sc.net, sc.groups.reduce((n, g) => n + g.net, 0)); assert.equal(sd.total, sd.sections.reduce((n, sc) => n + sc.net, 0));
      assert.ok(sd.sections.every(sc => sc.groups.every(g => ['商品', '製品'].includes(g.label))));
      assert.equal(ss.qty, 13); assert.equal(ss.net, 12997);
      const cd = (await a.call('/api/reports/misc/customer-items?' + span)).data, ci = cd.sections[0].customers.find(x => x.customer === C); assert.equal(ci.net, 12997);
      // 現行 HAR536：得意先計の数量は製品だけ、総合計＝得意先計の和、値引の行がある
      for (const sc of cd.sections) { assert.equal(sc.net, sc.customers.reduce((n, x) => n + x.net, 0)); assert.ok(sc.discount && typeof sc.discount.net === 'number'); }
      ok(await a.call('/api/reports/misc/cash-sales?' + span));
      // 現行 HAR551：得意先計は金額だけ（行の金額の和）、総合計なし
      for (const cu of (await a.call('/api/reports/misc/cash-sales?' + span)).data.customers) assert.equal(cu.net, cu.rows.reduce((n, r) => n + r.net, 0));
      // material: mark item as 材料, buy 10 @1000 this month, define a product recipe at 60%
      const it = (await a.call('/api/masters/items')).data.find(x => x.code === 'I' + tag);
      ok(await a.call('/api/masters/items', { mode: 'update', record: { ...it, kind: '1' } })); // 1=材料（現行 Java）
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'G' + tag, name: '試験合材', unit: '01', price: 9000, kind: '2', active: true } })); // 2=製品
      ok(await a.call('/api/purchases', { date: d, vendor: 'V' + tag, item: 'I' + tag, quantity: '10', unit: '1', price: 1000, taxCode: '10%' }));
      // 商品仕入登録リスト：現行 HAR011 の項目名、伝票No.＝P＋年度4桁＋5桁連番＋行番号2桁
      const prr = await a.call('/api/reports/misc/purchase-register?' + new URLSearchParams({ from: d, to: d })); ok(prr); const pr = prr.data;
      assert.deepEqual(pr.columns.map(x => x.label), ['仕入日', '区分', '伝票No.', '商品名', '仕入数量', '', '仕入単価', '仕入金額', '科目ｺｰﾄﾞ', '内訳名', '処税率']);
      assert.match(pr.groups.find(g => g.code === 'V' + tag).rows[0].no, /^P\d{9}-01$/);
      // 単位は 1（t）・2（袋）・3 のみ入力でき、リストには単位名が出る（2026-11-03）
      assert.equal(pr.groups.find(g => g.code === 'V' + tag).rows[0].unit, 't');
      for (const unit of ['', '4', 'x']) { const r = await a.call('/api/purchases', { date: d, vendor: 'V' + tag, item: 'I' + tag, quantity: '1', unit, price: 1000, taxCode: '10%' }); assert.equal(r.status, 400); assert.match(r.data.error, /単位は 1/); }
      // 運賃は商品コードなし・数量 0 で金額だけ入力でき、商品名は「運賃」（2026-11-03）
      const fz = await a.call('/api/purchases', { date: d, vendor: 'V' + tag, lines: [{ item: '', quantity: '0', amount: '3300', lineKind: '2', taxCode: '241' }] }); ok(fz);
      const fl = (await a.call('/api/purchases?' + new URLSearchParams({ month: d.slice(0, 7), vendor: 'V' + tag }))).data.find(x => x.no === fz.data.no);
      assert.deepEqual([fl.item, fl.itemName, fl.lineKind, fl.net], ['', '運賃', '2', 3300]);
      assert.equal((await a.call('/api/reports/misc/purchase-register?' + new URLSearchParams({ from: d, to: d }))).data.groups.flatMap(g => g.rows).find(x => x.no.startsWith(fz.data.no)).item, '運賃');
      const fe = await a.call('/api/purchases', { date: d, vendor: 'V' + tag, lines: [{ item: '', quantity: '2', amount: '100', taxCode: '241' }] }); assert.equal(fe.status, 400); assert.match(fe.data.error, /商品コードを入力/);
      ok(await a.call('/api/purchases/delete', { id: fl.id }));
      // 年度の最初の仕入が同時に来ても番号は重複せず、P＋年度＋連番で振られる
      const pus = await Promise.all([1, 2, 3, 4].map(() => a.call('/api/purchases', { date: '2031-01-10', vendor: 'V' + tag, item: 'I' + tag, quantity: '1', unit: '1', price: 1000, taxCode: '10%' })));
      pus.forEach(ok); assert.deepEqual(pus.map(x => x.data.no).sort(), ['P203000001', 'P203000002', 'P203000003', 'P203000004']);
      const ml = (await a.call('/api/reports/misc/material-ledger?closing=31&month=' + d.slice(0, 7))).data.items.find(x => x.item === 'I' + tag);
      assert.equal(ml.purchase.qty, 10); assert.equal(ml.purchase.value, 10000);
      // 金額のない在庫（実在庫登録のみ）は商品マスタの単価で評価（2026-11-02）
      ok(await a.call('/api/masters/items', { mode: 'create', record: { code: 'M' + tag, name: '試験材料', unit: '01', price: 500, kind: '1', active: true } }));
      const c1 = await a.call('/api/inventory/counts', { date: '2032-03-05', lines: [{ item: 'M' + tag, quantity: '120' }] }); ok(c1);
      const c2 = await a.call('/api/inventory/counts', { date: '2032-04-05', lines: [{ item: 'M' + tag, quantity: '100' }] }); ok(c2);
      // 実在庫の伝票No＝V＋年度4桁＋5桁、月度ごとに1つ（修正しても同じ番号。2026-11-03）
      assert.match(c1.data.no, /^V\d{9}$/); assert.notEqual(c1.data.no, c2.data.no);
      assert.equal((await a.call('/api/inventory/counts', { date: '2032-04-05', lines: [{ item: 'M' + tag, quantity: '100' }] })).data.no, c2.data.no);
      assert.equal((await a.call('/api/inventory/counts?date=2032-04-05')).data.no, c2.data.no);
      const mm = async () => (await a.call('/api/reports/misc/material-ledger?month=' + c2.data.month)).data.items.find(x => x.item === 'M' + tag);
      let mt = await mm(); assert.deepEqual([mt.prev.value, mt.end.value, mt.used.qty, mt.used.value, mt.price], [60000, 50000, 20, 10000, 500]);
      // 在庫登録リスト：コード・商品・製品名・在庫数量・単位だけ（評価は出さない。2026-11-03）
      const ir = (await a.call('/api/reports/misc/inventory-register?month=' + c1.data.month)).data;
      assert.deepEqual(ir.columns.map(x => x.label), ['コード', '商品・製品名', '在庫数量', '単位']);
      assert.deepEqual([ir.groups.length, ir.groups[0].title, ir.groups[0].totals, ir.totals], [1, undefined, undefined, undefined]); // 区分見出し・小計・総合計は保留（2026-11-03）
      const irow = ir.groups.flatMap(g => g.rows).find(x => x.code === 'M' + tag); assert.deepEqual([irow.name, irow.qty, 'price' in irow], ['試験材料', 120, false]);
      ok(await a.call('/api/inventory/post', { month: c1.data.month }));
      mt = await mm(); assert.deepEqual([mt.prev.value, mt.end.value, mt.price], [60000, 50000, 500]);
      ok(await a.call('/api/inventory/unpost', { month: c1.data.month }));
      ok(await a.call('/api/masters/mixes', { mode: 'create', record: { product: 'G' + tag, material: 'I' + tag, ratio: '60', active: true } }));
      const mx = (await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data.products.find(x => x.item === 'G' + tag);
      assert.equal(mx.haigo, 600);
      ok(await a.call('/api/mix/save', { closing: '31', month: d.slice(0, 7), denki: '10', touyu: '20', seizou: '5.5', ippann: '4.5' }));
      assert.equal((await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data.products.find(x => x.item === 'G' + tag).saved.total, 640);
      // JV members (deactivate leftovers first; this is a disposable test DB)
      for (const m of (await a.call('/api/masters/jv')).data.filter(x => x.active)) ok(await a.call('/api/masters/jv', { mode: 'update', record: { ...m, active: false } }));
      assert.equal((await a.call('/api/reports/misc/jv-expenses?' + span)).status, 400, 'no members');
      assert.equal((await a.call('/api/reports/misc/petty-book?' + span)).status, 400, '⑪ も構成員なしはエラー（列を黙って消さない。2026-11-04）');
      // 構成員＝業者マスタ（HMW110）
      for (const [k, r] of [['A', '47.5'], ['B', '47.5'], ['C', '5']]) { ok(await a.call('/api/masters/vendors', { mode: 'create', record: { code: 'J' + k + tag, name: 'JV' + k, active: true } })); ok(await a.call('/api/masters/jv', { mode: 'create', record: { code: 'J' + k + tag, name: 'JV' + k, ratio: r, seq: k.charCodeAt(0), active: true } })); }
      const je = (await a.call('/api/reports/misc/jv-expenses?' + span)).data;
      const row = je.accounts.flatMap(x => x.rows).find(r => r.gross === 50000 && r.vendor === '試験業者');
      assert.deepEqual(row.parts, [23750, 23750, 2500]); assert.equal(row.tax, 4545);
      assert.equal(row.rate, '10%', '⑫ の税率は処税率コードでなく 10%（現行 HJR011。2026-11-04）');
      // 適用開始月度（履歴）：先の月度の変更は今の帳票に効かない。月度ごとに合計100%を確認
      ok(await a.call('/api/masters/jv', { mode: 'create', record: { code: 'JA' + tag, start: '2099-01', ratio: '50', seq: 65, active: true } }));
      assert.deepEqual((await a.call('/api/reports/misc/jv-expenses?' + span)).data.accounts.flatMap(x => x.rows).find(r => r.gross === 50000 && r.vendor === '試験業者').parts, [23750, 23750, 2500]);
      const fut = 'from=2099-01-01&to=2099-01-20';
      assert.equal((await a.call('/api/reports/misc/jv-expenses?' + fut)).status, 400, 'sum 102.5%');
      ok(await a.call('/api/masters/jv', { mode: 'create', record: { code: 'JB' + tag, start: '2099-01', ratio: '50', seq: 66, active: true } }));
      ok(await a.call('/api/masters/jv', { mode: 'create', record: { code: 'JC' + tag, start: '2099-01', ratio: '', seq: 67, active: false } }));
      assert.deepEqual((await a.call('/api/reports/misc/jv-expenses?' + fut)).data.members.map(m => m.ratio), [50, 50]);
      const jr = (await a.call('/api/reports/misc/jv-receipts?' + span)).data;
      for (const l of jr.lines) assert.equal(l.parts.reduce((x, y) => x + y, 0), l.amount);
      // 現行 HJR031：配分する（当座預金・現金売上）＋配分しない（雑費・雑損失）＝入金額合計
      assert.equal(jr.alloc.amount + jr.noAlloc.amount, jr.totals.amount); jr.members.forEach((_, k) => assert.equal(jr.alloc.parts[k] + jr.noAlloc.parts[k], jr.totals.parts[k]));
      assert.ok(jr.lines.every(l => ['当座預金', '雑　費', '雑損失', ''].includes(l.account)), JSON.stringify(jr.lines.map(l => l.account)));
      for (const k of ['shipment-summary', 'customer-items', 'cash-sales', 'material-ledger', 'mix', 'jv-expenses', 'jv-receipts']) {
        const x = await fetch(base + '/api/reports/misc/' + k + '?' + new URLSearchParams({ from: pm + '-01', to: d, month: d.slice(0, 7), format: 'xlsx' }), { headers: { cookie: a.cookie } });
        assert.equal(Buffer.from(await x.arrayBuffer()).subarray(0, 2).toString(), 'PK', k);
      }
      // 出資金請求明細表：現行と同じ見出し（2026-11-02）
      const jvx = Buffer.from(await (await fetch(base + '/api/reports/misc/jv-expenses?' + span + '&format=xlsx', { headers: { cookie: a.cookie } })).arrayBuffer()).toString();
      for (const w of ['税率', '支払金額', '支払額本体', '支払消費税', '出資金額']) assert.ok(jvx.includes(w), w);
      for (const w of ['出資本体', '出資消費税', '出資金請求合計表']) assert.ok(jvx.includes(w), '明細表の後ろに合計表: ' + w); // 2026-11-03
      for (const w of ['＊科目計＊', '＊支払日計＊', '＊合　計＊', '科目名']) assert.ok(jvx.includes(w), '現行 HJR011 の並び: ' + w); assert.ok(!jvx.includes('伝票No'), '伝票No は出さない'); // 2026-11-04
      const jvs = await a.call('/api/reports/misc/jv-expenses?' + span + '&layout=summary'); ok(jvs);
      for (const x of [...jvs.data.accounts, jvs.data.totals, ...jvs.data.rates]) x.parts.forEach((v, k) => assert.equal(x.netParts[k] + x.taxParts[k], v));
      // ⑫ 合計表＝明細の科目計（再按分しない）、出資消費税＝明細ごとの出資金額の内税逆算の合計、税率別の行（現行 HJR011。2026-11-04）
      for (const a of jvs.data.accounts) assert.deepEqual(a.parts, je.accounts.find(x => x.due === a.due && x.account === a.account).parts);
      const ja = jvs.data.accounts.find(x => x.account === je.accounts.find(y => y.rows.includes(row)).account && x.due === row.date);
      assert.ok(ja.taxParts[2] >= 227, '50000 の行の第3構成員 2500 → 227');
      assert.ok(jvs.data.rates.some(g => g.rate === '10%'));
      assert.deepEqual(jvs.data.rates.reduce((s, g) => s.map((v, k) => v + g.parts[k]), [0, 0, 0]), jvs.data.totals.parts);
      const jvsx = Buffer.from(await (await fetch(base + '/api/reports/misc/jv-expenses?' + span + '&layout=summary&format=xlsx', { headers: { cookie: a.cookie } })).arrayBuffer()).toString();
      for (const w of ['科目名', '支払本体', '支払消費税', '出資金額', '出資本体', '出資消費税']) assert.ok(jvsx.includes(w), w);
      const jvrx = Buffer.from(await (await fetch(base + '/api/reports/misc/jv-receipts?' + span + '&format=xlsx', { headers: { cookie: a.cookie } })).arrayBuffer()).toString();
      for (const w of ['入金日', '入金科目', '入金先', '入金額', '配分額']) assert.ok(jvrx.includes(w), w);
      for (const w of ['＊配分する入金額＊', '＊配分しない入金額＊', '＊入金額　合計＊']) assert.ok(jvrx.includes(w), w);
      // 材料受払表：現行 HAR491 の様式（表題・2段見出し）
      const mlx = Buffer.from(await (await fetch(base + '/api/reports/misc/material-ledger?' + new URLSearchParams({ month: d.slice(0, 7), format: 'xlsx' }), { headers: { cookie: a.cookie } })).arrayBuffer()).toString();
      for (const w of ['HAR491', '材　料　受　払　表', '期　首　残　高', '当　月　末　在　庫', '【合計】']) assert.ok(mlx.includes(w), w);
      // 売掛金残高一覧・未払残高一覧の Excel（2026-11-02）
      for (const [k, w] of [['ar', '売掛金残高一覧'], ['ap', '未払残高一覧']]) { const r = await fetch(base + `/api/reports/${k}?format=xlsx`, { headers: { cookie: a.cookie } }); assert.equal(r.status, 200, k); assert.ok(Buffer.from(await r.arrayBuffer()).toString().includes(w), w); }
      assert.ok(!mlx.includes('材料CD'), '現行の見出しに材料CDの列名はない');
      // JV 構成員は残す：⑪ 小口現金出納簿も構成員が必要（2026-11-04）。次回の実行では冒頭で無効化する
    });
    await t.test('△ items completed by estimation (NO3/9/10/20/25/30/33/40/44)', async () => {
      const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
      const raw2 = async p => { const r = await fetch(base + p, { headers: { cookie: a.cookie } }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
      // NO3 full customer fields
      const cu = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      ok(await a.call('/api/masters/customers', { mode: 'update', record: { ...cu, abbr: '結合', section: '工務部', postcode: '460-0001', pref: '愛知県', address2: '2F', fax: '052-000-0000', customerPic: '先方', pic: '自社', creditStart: '2026-04-01', remarks: 'テスト' } }));
      const cu2 = (await a.call('/api/masters/customers')).data.find(x => x.code === C);
      assert.equal(cu2.postcode, '4600001'); assert.equal(cu2.creditStart, '2026-04-01'); assert.equal(cu2.section, '工務部');
      // NO9 statement view data is the billing list (already covered); NO10 bulk workbook
      assert.equal((await raw2('/api/invoices/book?ids=' + invoiceId)).bytes.subarray(0, 2).toString(), 'PK');
      const draft = (await a.call('/api/invoices?status=draft')).data[0];
      if (draft) assert.equal((await raw2('/api/invoices/book?ids=' + draft.id)).status, 400, 'unissued invoices are rejected');
      // NO20 accounting export
      const span = new URLSearchParams({ from: pm + '-01', to: d });
      const g = await raw2('/api/accounting/export?' + span + '&format=generic'); assert.equal(g.status, 200); assert.deepEqual([...g.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const y = await raw2('/api/accounting/export?' + span + '&format=yayoi'); assert.equal(y.status, 200);
      const { default: iconv } = await import('iconv-lite');
      const ylines = iconv.decode(y.bytes, 'Shift_JIS').trim().split('\r\n');
      assert.ok(ylines.length > 3); for (const l of ylines) assert.ok(/^(2000|2110|2100|2101),/.test(l), l);
      assert.ok(ylines.some(l => l.includes('売掛金')), 'account names in yayoi format');
      // 補助科目は内訳科目だけ、得意先は取引先コード（変換表があれば会計の取引先コード）で連携（2026-11-03）
      ok(await a.call('/api/masters/partnerCodes', { mode: 'create', record: { kind: 'C', code: C, partner: 'X' + tag, active: true } }));
      assert.equal((await a.call('/api/masters/partnerCodes', { mode: 'create', record: { kind: 'C', code: 'ZZZZZ', partner: 'X1', active: true } })).status, 400, '未登録の得意先は変換表に登録できない');
      assert.equal((await a.call('/api/masters/partnerCodes', { mode: 'create', record: { kind: 'V', code: 'V1', partner: 'ｱ1', active: true } })).status, 400, '取引先コードは半角英数');
      const bg = await raw2('/api/accounting/export?' + span + '&format=bugyo');
      if (bg.status === 200) {
        const bl = iconv.decode(bg.bytes, 'Shift_JIS').trim().split('\r\n').map(l => l.split(',').map(x => x.replace(/^"|"$/g, '')));
        const hi = 6; // 伝票日付・伝票番号・行番号・借方部門・借方勘定科目・借方補助科目・借方取引先（見出しは会計設定の受入記号で変わる）
        const ar = bl.filter(r => r[4] === '1131' && r[hi] === 'X' + tag); assert.ok(ar.length, '売掛金の借方取引先コードは変換後のコード'); for (const r of ar) assert.equal(r[hi - 1], '', '売掛金の補助科目は空');
      } else assert.fail('bugyo ' + bg.bytes.toString());
      const gl = g.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')[0]; assert.match(gl, /借方補助名","借方取引先CD","借方取引先名"/);
      // NO25 estimate fields
      const mx = (await a.call('/api/reports/misc/mix?closing=31&month=' + d.slice(0, 7))).data;
      assert.ok(mx.suggest && typeof mx.suggest.tons === 'number' && Array.isArray(mx.usage));
      // NO30 / NO33 / NO40 / NO44
      // 10/21：業者コードはブランクなら出力しない、To に 9999999 で全業者
      const pi = (await a.call('/api/reports/misc/payable-input?closing=31&vendorTo=9999999&month=' + d.slice(0, 7))).data;
      assert.ok(pi.depts.some(dp => dp.vendors.some(v => v.vendor === 'V' + tag)));
      assert.equal((await a.call('/api/reports/misc/payable-input?closing=31&month=' + d.slice(0, 7))).data.depts.length, 0, 'blank vendor code outputs nothing');
      const pc = (await a.call('/api/reports/misc/petty-book?' + span)).data; assert.equal(pc.closing, pc.opening + pc.received - pc.spent);
      const sr = (await a.call('/api/reports/misc/sales-register?' + span)).data.customers.find(x => x.customer === C); assert.equal(sr.rows.length, 4); // 元・赤・黒＋別現場 assert.equal(sr.net, 12997);
      // 現行 HAR021 の並び：小計なし、売上日・区分は前の行と同じなら空白、赤黒は 元伝票No-01／-02／-03、処税率 211、運送区分は 1 現場／2 先方
      assert.ok(!('net' in sr)); assert.equal(sr.rows[0].showDate, true); assert.ok(sr.rows.slice(1).some(r => !r.showDate)); assert.ok(sr.rows.some(r => /-0[123]$/.test(r.no)));
      assert.ok(sr.rows.every(r => r.tax === '211' && ['1 現場', '2 先方'].includes(r.carry) && ['売上', '訂正'].includes(r.kind)), JSON.stringify(sr.rows));
      const rs = (await a.call('/api/reports/misc/receipt-schedule')).data.customers.find(x => x.customer === C);
      assert.equal(rs.due, 1000); assert.equal(rs.rows.length, 2, 'split by site (工事)');
      for (const k of ['payable-input', 'petty-book', 'sales-register', 'receipt-schedule'])
        assert.equal((await raw2('/api/reports/misc/' + k + '?' + new URLSearchParams({ from: pm + '-01', to: d, month: d.slice(0, 7), format: 'xlsx' }))).bytes.subarray(0, 2).toString(), 'PK', k);
    });
    await t.test('re-audit fixes: late entries, credit invoices, append, site due date, fee/offset, overpay, petty refill, bank directory', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      // 締日は 5・10・15・20・末日（当月の締日が到来済みのものを使う。1〜4日に実行すると当月分の請求は作れない）
      const cl = [20, 15, 10, 5].find(x => x <= Number(d.slice(8))) || 5, K = 'K' + tag, curMonth = d.slice(0, 7);
      ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: K, name: '締日試験', closing: cl, siteMonths: '2', siteDay: '10', payMethod: '2', payBank: 'B' + tag, active: true } }));
      ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: K, code: 'K' + tag, suffix: '000', name: 'K現場', active: true } }));
      const s1 = ok(await a.call('/api/shipments', { date: pm + '-01', customer: K, site: 'K' + tag + '|000', item: 'I' + tag, quantity: '2', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      const h1 = ok(await a.call('/api/billing/run', { month: pm, closing: cl, customers: [K] })); assert.equal(h1.created, 1);
      const inv1 = ok(await a.call('/api/invoices/' + h1.ids[0]));
      const [yy, mm] = pm.split('-').map(Number); const exp = new Date(Date.UTC(yy, mm - 1 + 2, Math.min(10, new Date(Date.UTC(yy, mm + 2, 0)).getUTCDate()))).toISOString().slice(0, 10);
      assert.equal(inv1.due, exp, 'due date from customer site (2 months later, day 10)');
      ok(await a.call('/api/invoices/issue', { ids: [h1.ids[0]] }));
      // late correction dated in the already-billed period
      ok(await a.call('/api/shipments/correct', { orderNo: s1.orderNo, date: pm + '-01', quantity: '0' })); // 赤のみ＝取消
      const again = await a.call('/api/billing/run', { month: pm, closing: cl, customers: [K] });
      assert.equal(again.status, 400); assert.match(again.data.error, /次回締め/);
      // next closing picks it up as a credit invoice
      const h2 = ok(await a.call('/api/billing/run', { month: curMonth, closing: cl, customers: [K] }));
      const inv2 = ok(await a.call('/api/invoices/' + h2.ids[0])); assert.equal(inv2.total, -2200); assert.equal(inv2.status, 'credit');
      // unissued invoice: additional sale is appended to the same invoice
      ok(await a.call('/api/shipments', { date: pm + '-02', customer: K, site: 'K' + tag + '|000', item: 'I' + tag, quantity: '5', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      const h3 = ok(await a.call('/api/billing/run', { month: curMonth, closing: cl, customers: [K] })); assert.equal(h3.appended, 1);
      const inv3 = ok(await a.call('/api/invoices/' + h2.ids[0])); assert.equal(inv3.total, 3300); assert.equal(inv3.lines.length, 2);
      const jl = ok(await a.call('/api/journals?month=' + curMonth)).filter(j => j.source === 'billing_head' && j.sourceId === String(h2.ids[0]));
      assert.equal(jl.filter(j => j.status === 'POSTED' && !j.reversalOf).length, 1, 'one live journal after append');
      // payment with 先方負担手数料 and 相殺
      const ven = ok(await a.call('/api/masters/vendors')).find(x => x.code === 'V' + tag);
      ok(await a.call('/api/masters/vendors', { mode: 'update', record: { ...ven, advance: 3000 } }));
      const doc = ok(await a.call('/api/expenses', { kind: 'PAYABLE', date: d, vendor: 'V' + tag, account: '8231', taxCode: '10%', amount: 10000, memo: '手数料相殺試験' }));
      assert.equal((await a.call('/api/payments', { idempotencyKey: 'po' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, fee: 0, offset: 5000, allocations: [{ expenseId: doc.id, amount: 10000 }] })).status, 400, 'offset above advance');
      const pay = ok(await a.call('/api/payments', { idempotencyKey: 'pf' + tag, date: d, vendor: 'V' + tag, bankCode: 'B' + tag, fee: 770, offset: 2000, safety: 500, allocations: [{ expenseId: doc.id, amount: 10000 }] }));
      const pj = ok(await a.call('/api/journals?month=' + curMonth)).find(j => j.source === 'payment' && j.sourceId === String(pay.id));
      const amt = (side, acc) => pj.lines.filter(l => l.side === side && l.account === acc).reduce((n, l) => n + l.amount, 0);
      assert.equal(amt('D', '4121'), 10000); assert.equal(amt('C', '1112'), 6730); assert.equal(amt('C', '4171'), 500); assert.equal(amt('C', '8790'), 770); assert.equal(amt('C', '4415'), 0); assert.equal(amt('C', '1431'), 2000); // 現行：手数料差引は 8790-001 処税率9 の全額
      const co = ok(await a.call('/api/reports/payments/carryover?date=' + d)).vendors.find(v => v.vendor === 'V' + tag);
      if (co) assert.equal(co.offset, 1000, 'remaining 業者立替金 = 3000 - 2000');
      const vp = ok(await a.call('/api/reports/payments/vendor-payments?' + new URLSearchParams({ from: d, to: d }))).vendors.find(v => v.vendor === 'V' + tag);
      assert.ok(vp.rows.some(r => r.fee === 770 && r.offset === 2000 && r.safety === 500 && r.bank === 6730 && r.paid === 10000));
      // overpayment is taken as 預り金
      const before = ok(await a.call('/api/receipt-context?customer=' + C)).deposit;
      assert.equal((await a.call('/api/receipts', { idempotencyKey: 'ov1' + tag, date: d, customer: C, bank: 1500, bankCode: 'B' + tag, allocations: [{ invoiceId, amount: 1000 }] })).status, 400);
      ok(await a.call('/api/receipts', { idempotencyKey: 'ov2' + tag, date: d, customer: C, bank: 1500, bankCode: 'B' + tag, overpayToDeposit: true, allocations: [{ invoiceId, amount: 1000 }] }));
      assert.equal(ok(await a.call('/api/receipt-context?customer=' + C)).deposit, before + 500);
      // petty cash fund and refill
      ok(await a.call('/api/petty/fund', { fund: '30000' }));
      ok(await a.call('/api/petty/refill', { date: d, amount: '5000', bankCode: 'B' + tag }));
      const pb = ok(await a.call('/api/reports/misc/petty-book?' + new URLSearchParams({ from: d, to: d })));
      assert.ok(pb.rows.some(r => r.received === 5000)); assert.equal(pb.closing, pb.opening + pb.received - pb.spent);
      // 小口現金：1支払日＝1伝票、明細の行ごとに支払先（業者コード）。行の摘要名は支払先で上書きしない。業者マスタにない支払先は支払先名の手入力（2026-11-03）
      const pcm = ok(await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, dept: '063', lines: [
        { vendor: 'V' + tag, account: '8231', taxCode: '141', amount: 1100, memo: 'ボールペン' }, { vendor: 'V' + tag, account: '8231', taxCode: '141', amount: 2200, memo: '部品' }, { vendor: '', account: '', amount: '' }] }));
      const pcl = ok(await a.call('/api/expenses?' + new URLSearchParams({ kind: 'PETTY_CASH', month: d.slice(0, 7) }))).filter(r => r.id === pcm.id);
      assert.equal(pcl.length, 1); assert.equal(pcl[0].amount, 3300); assert.equal(pcl[0].taxRate, 10); assert.deepEqual(pcl[0].lines.map(l => [l.vendor, l.memo]), [['V' + tag, 'ボールペン'], ['V' + tag, '部品']]);
      const pb2 = ok(await a.call('/api/reports/misc/petty-book?' + new URLSearchParams({ from: d, to: d })));
      assert.ok(pb2.rows.some(r => r.amount === 1100 && r.payee));
      // 小口現金の支払額は税込：外税の処税率（241）でも上乗せせず、1,100 円から消費税 100 円を抜き出す（2026-11-04）
      const pex = ok(await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ payee: '外税テスト', account: '8231', taxCode: '241', amount: 1100, memo: '外税' }] }));
      const pexl = ok(await a.call('/api/expenses?' + new URLSearchParams({ kind: 'PETTY_CASH', month: d.slice(0, 7) }))).find(r => r.id === pex.id);
      assert.equal(pexl.amount, 1100);
      // 業者マスタにない支払先は支払先名の手入力（2026-11-03）。コードも名称も無い行・マスタにないコードはエラー
      const pcf = ok(await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ payee: '文具店', account: '8231', taxCode: '141', amount: 100, memo: 'のり' }] }));
      const pcfl = ok(await a.call('/api/expenses?' + new URLSearchParams({ kind: 'PETTY_CASH', month: d.slice(0, 7) }))).find(r => r.id === pcf.id);
      assert.deepEqual(pcfl.lines.map(l => [l.vendor, l.payee, l.memo]), [['', '文具店', 'のり']]);
      assert.ok(ok(await a.call('/api/reports/misc/petty-book?' + new URLSearchParams({ from: d, to: d }))).rows.some(r => r.no === pcf.no && r.payee === '文具店'));
      assert.equal((await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ account: '8231', amount: 100 }] })).status, 400);
      assert.equal((await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ vendor: 'NOSUCH', payee: '文具店', account: '8231', amount: 100 }] })).status, 400);
      assert.equal((await a.call('/api/expenses', { kind: 'PETTY_CASH', date: d, lines: [{ vendor: 'V' + tag, account: '8231', amount: 100 }, { vendor: 'V' + tag, account: '0000', amount: 100 }] })).status, 400);
      // 金融機関 master names in transfer request / payment notice
      await a.call('/api/masters/bankdir', { mode: 'create', record: { bank: '0001', name: '試験銀行本体', kana: 'ｼｹﾝ', active: true } });
      await a.call('/api/masters/bankdir', { mode: 'create', record: { bank: '0001', branch: '001', name: '試験支店', kana: 'ｼﾃﾝ', active: true } });
      const tr = ok(await a.call('/api/reports/payments/transfer-request?date=' + d)).groups.flatMap(g => g.rows).find(r => r.vendor === 'V' + tag);
      assert.equal(tr.payee.bankName, '試験銀行本体'); assert.equal(tr.payee.branchName, '試験支店');
      ok(await a.call('/api/masters/depts', { mode: 'create', record: { code: 'D' + tag, name: '試験部門', active: true } }));
      // 自社情報：登録番号・振込先口座が請求書スナップショットに入る（現行請求書③の項目）
      const comp = ok(await a.call('/api/masters/company')).find(x => x.id === '1');
      assert.equal((await a.call('/api/masters/company', { mode: 'update', record: { ...comp, invoiceNo: 'X123' } })).status, 400, 'invalid registration number');
      ok(await a.call('/api/masters/company', { mode: 'update', record: { ...comp, invoiceNo: 'T4180001002429', invoiceBank: 'B' + tag } }));
      const docs = ok(await a.call('/api/invoices/issue', { ids: [h2.ids[0]] })).documents;
      assert.equal(docs[0].company.invoiceNo, 'T4180001002429'); assert.ok(docs[0].company.bankText.includes('7777777'), docs[0].company.bankText); assert.equal(docs[0].lines[0].unit, 't');
      const lst = ok(await a.call('/api/reports/billing-list?' + new URLSearchParams({ month: curMonth, closing: cl }))).rows.find(r => r.customer === K);
      assert.equal(lst.sites.length, 1); assert.equal(lst.sites[0].total, 3300);
      // HAR431：現場別発行していない請求は得意先 1 行・現場名は空欄（2026-11-03）
      assert.equal(lst.bookRows.length, 1); assert.equal(lst.bookRows[0].siteName, ''); assert.equal(lst.bookRows[0].total, 3300);
      // NO8 grouping: A01 list slips are per closing date
      const a01 = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: pm + '-01', to: d })));
      for (const sl of a01.slips) { const dr = sl.pairs.reduce((n, p) => n + (p.dr?.amount || 0), 0), cr = sl.pairs.reduce((n, p) => n + (p.cr?.amount || 0), 0); assert.equal(dr, cr); }
    });
    await t.test('shipment entry: 伝票区分 5 訂正 with 元伝票No creates a linked red slip', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const base = { date: pm + '-03', customer: C, site: `S${tag}|000`, item: 'I' + tag, price: 1000, operator: '1', deliveryKbn: '1', method: 2 };
      const o = ok(await a.call('/api/shipments', { ...base, quantity: '3' }));
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', quantity: '-3' })).status, 400, 'originalNo required');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '3' })).status, 400, 'red must be negative');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-4' })).status, 400, 'within original quantity');
      const red = ok(await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-3' }));
      const [r0] = ok(await a.call('/api/shipments?orderNo=' + red.orderNo)), [o0] = ok(await a.call('/api/shipments?orderNo=' + o.orderNo));
      assert.equal(r0.shipKb, 5); assert.equal(r0.originalNo, o.orderNo); assert.match(r0.remarks, /^\d{1,2}\/\d{1,2} 分削除$/); assert.equal(r0.slipNo, o.orderNo + '-02', '赤は 元伝票No-02'); assert.equal(o0.slipNo, o.orderNo + '-01', '赤黒のある元伝票は 元伝票No-01'); assert.ok(o0.corrected, 'original marked corrected');
      assert.equal((await a.call('/api/shipments', { ...base, shipKb: '5', originalNo: o.orderNo, quantity: '-3' })).status, 400, 'no double correction');
      ok(await a.call('/api/shipments/delete', { orderNo: red.orderNo })); ok(await a.call('/api/shipments/delete', { orderNo: o.orderNo }));
      // 赤黒訂正（赤＋黒）：黒を取消すと赤も組で取消され、元伝票を取消できる
      const o2 = ok(await a.call('/api/shipments', { ...base, quantity: '3' }));
      const rb = ok(await a.call('/api/shipments/correct', { orderNo: o2.orderNo, date: pm + '-03', quantity: '2' })); assert.ok(rb.red && rb.black);
      assert.deepEqual(ok(await a.call('/api/shipments/delete', { orderNo: rb.black })).slips.sort(), [rb.red, rb.black].sort(), 'red and black deleted as a pair');
      ok(await a.call('/api/shipments/delete', { orderNo: o2.orderNo }));
    });
    await t.test('Q08: one closing run puts its customers on one A01 slip number', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const cs = ['M' + tag, 'N' + tag, 'P' + tag];
      for (const k of cs) {
        ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: k, name: '分割試験', closing: 15, active: true } }));
        ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: k, code: k, suffix: '000', name: '分割現場', active: true } }));
        ok(await a.call('/api/shipments', { date: pm + '-01', customer: k, site: k + '|000', item: 'I' + tag, quantity: '1', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      }
      const run = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: cs.slice(0, 2) })); assert.equal(run.created, 2); assert.match(run.slip, /^R\d{4}\d{5}$/);
      // 画面は得意先ごとに呼び出す：受け取った伝票番号を渡すと同じ伝票に続けて載る
      const run2 = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: [cs[2]], slip: run.slip })); assert.equal(run2.slip, run.slip); run.ids.push(...run2.ids);
      const end = pm + '-15', l = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: end, to: end })));
      // 元伝票は請求書番号（C＋年度4桁＋5桁。2026-11-03 に K＋締切年月＋請求ID から変更）
      const [cnos] = await pool.query("SELECT ref, doc_no FROM app_doc_no WHERE kind='invoice'"), kmap = new Map(cnos.map(r => [Number(r.ref), r.doc_no]));
      const kno = id => kmap.get(Number(id)); for (const id of run.ids) assert.match(kno(id) || '', /^C\d{9}$/);
      const mine = l.slips.filter(sl => run.ids.some(id => sl.sourceNo.includes(kno(id))));
      assert.equal(mine.length, 1, 'both invoices on one slip'); assert.match(mine[0].sourceNo, /（3件）/); assert.equal(mine[0].pairs.length, 6);
      const each = ok(await a.call('/api/reports/journal-list?' + new URLSearchParams({ pattern: 'A01', from: end, to: end, group: 'none' }))).slips.filter(sl => run.ids.some(id => sl.sourceNo === kno(id)));
      assert.equal(each.length, 3); assert.equal(new Set(each.map(x => x.slipNo)).size, 1);
      ok(await a.call('/api/kb/settings', { startFy: 2024 }));
      const kb = ok(await a.call('/api/kb/import/seikyu', { from: end, to: end, dry: true })), ks = kb.sample.filter(x => x.memo.startsWith(each[0].slipNo + ' '));
      assert.equal(ks.length, 1, '会計の仕訳受入も伝票番号単位で1伝票'); assert.match(ks[0].memo, /（3件）/); assert.equal(ks[0].ref, each[0].slipNo); assert.equal(ks[0].rows.length, 6);
    });
    await t.test('請求取消 by site: cancels only that site and recomputes the invoice (2026-10-28)', async () => {
      const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const S = 'S' + tag;
      ok(await a.call('/api/masters/customers', { mode: 'create', record: { code: S, name: '現場取消試験', closing: 15, active: true } }));
      for (const x of ['A', 'B']) ok(await a.call('/api/masters/sites', { mode: 'create', record: { customer: S, code: S + x, suffix: '000', name: '現場' + x, active: true } }));
      ok(await a.call('/api/shipments', { date: pm + '-01', customer: S, site: S + 'A|000', item: 'I' + tag, quantity: '2', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      ok(await a.call('/api/shipments', { date: pm + '-02', customer: S, site: S + 'B|000', item: 'I' + tag, quantity: '3', price: 1000, taxRate: 10, operator: '1', deliveryKbn: '1', method: 2 }));
      const run = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: [S] })), id = run.ids[0];
      const inv = ok(await a.call('/api/invoices/' + id)); assert.equal(inv.total, 5500);
      const la = inv.lines.find(l => l.site === S + 'A|000'), lb = inv.lines.find(l => l.site === S + 'B|000');
      const x = ok(await a.call('/api/invoices/cancel', { id, site: la.site, siteName: la.siteName }));
      assert.equal(x.orders, 1); assert.equal(x.net + x.tax, 3300);
      const inv2 = ok(await a.call('/api/invoices/' + id)); assert.equal(inv2.total, 3300); assert.deepEqual(inv2.lines.map(l => l.site), [lb.site]);
      const jl = ok(await a.call('/api/journals?month=' + pm)).filter(j => j.source === 'billing_head' && j.sourceId === String(id));
      assert.equal(jl.filter(j => j.status === 'POSTED' && !j.reversalOf).length, 1, 'one live AR journal after the site cancel');
      // 取消した現場の売上は未請求に戻り、同じ締日の再作成で同じ請求に追加される
      const again = ok(await a.call('/api/billing/run', { month: pm, closing: 15, customers: [S] })); assert.equal(again.appended, 1);
      assert.equal(ok(await a.call('/api/invoices/' + id)).total, 5500);
      // 最後の現場を取消すと請求ごと取消
      ok(await a.call('/api/invoices/cancel', { id, site: la.site, siteName: la.siteName }));
      ok(await a.call('/api/invoices/cancel', { id, site: lb.site, siteName: lb.siteName }));
      assert.notEqual((await a.call('/api/invoices/' + id)).status, 200, 'invoice removed after its last site');
    });
    // 奉行の受入記号は 200 字を超えても欠けずに保存される（2026-10-28）
    const meta = (await a.call('/api/kb/bugyo')).data, symbols = Object.fromEntries(meta.items.map(([k]) => [k, 'OBC_' + k.padEnd(30, 'X')]));
    assert.ok(JSON.stringify(symbols).length > 200);
    assert.deepEqual((await a.call('/api/kb/bugyo', { symbols, taxMap: {}, encoding: 'shift_jis' })).data.symbols, symbols);
    const tb = await fetch(base + '/api/export/trial-balance?month=' + month, { headers: { cookie: a.cookie } });
    const tbText = await tb.text(); assert.equal(tb.status, 200); assert.match(tbText, /"科目","科目名","借方","貸方"/);
    assert.ok(!/"'-\d/.test(tbText), 'マイナスの金額に \' を付けない'); assert.match(tbText, /"-\d+"/);
    const raw = await fetch(base + '/api/export/journals?month=' + month, { headers: { cookie: a.cookie } }); const bytes = new Uint8Array(await raw.arrayBuffer());
    assert.equal(raw.status, 200); assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV has UTF-8 BOM for Excel');
  } finally {
    process.env.DEMO_USER = saved.DEMO_USER;
    await new Promise(r => server.close(r)); await pool.end();
  }
});
