import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DomainError, Conflict, Forbidden, RATES, METHODS, csv, today } from './domain.mjs';
import { tx, mapSqlError, audit } from './db.mjs';
import * as M from './masters.mjs';
import * as S from './sales.mjs';
import * as PL from './plans.mjs';
import * as P from './payables.mjs';
import * as L from './ledger.mjs';
import * as U from './users.mjs';
import * as X from './reports.mjs';
import * as J from './journal-lists.mjs';
import * as PR from './payment-reports.mjs';
import * as MR from './misc-reports.mjs';
import * as XR from './extra-reports.mjs';
import { invoiceBook } from './invoice-book.mjs';
import { accountingExport } from './accounting-export.mjs';
import * as KB from './kb.mjs';
import { NEW_REPORTS, genericBook } from './new-reports.mjs';
import { bugyoSettings, saveBugyoSettings, BUGYO_ITEMS } from './bugyo.mjs';

const COOKIE = 'aplink_sid';
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://cdn.jsdelivr.net https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function createApp({ pool, publicDir, secureCookies = process.env.NODE_ENV === 'production', version = 'dev' }) {
  const files = new Set(await readdir(publicDir));
  const routes = [];
  const route = (method, path, perm, fn) => routes.push({ method, perm, fn, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
  const db = fn => tx(pool, fn);
  const failures = new Map();

  // ----- read -----
  route('GET', '/api/meta', 'read', () => ({ journalLists: { ...Object.fromEntries(Object.entries(J.LISTS).map(([k, v]) => [k, { title: v.title, ref: v.ref }])), BANK: { title: J.BANK_LIST.title, ref: J.BANK_LIST.ref } }, receiptParts: S.RECEIPT_PARTS, masters: M.meta(), rates: RATES, methods: METHODS, taxCodes: P.TAX_CODES, purchaseKinds: P.PURCHASE_KINDS, shipKinds: S.SHIP_KB, patterns: L.PATTERNS, roles: U.ROLES, today: today(), version }));
  route('GET', '/api/masters', 'read', () => db(c => M.allMasters(c)));
  route('GET', '/api/masters/:kind', 'read', x => db(c => M.list(c, x.params.kind)));
  route('GET', '/api/price', 'read', x => db(c => S.priceFor(c, x.q)));
  route('GET', '/api/business-date', 'read', () => db(async c => ({ date: await S.businessDate(c) })));
  route('GET', '/api/shipments', 'read', x => db(c => S.listShipments(c, x.q)));
  route('GET', '/api/plans', 'read', x => db(c => PL.listPlans(c, x.q)));
  route('GET', '/api/shipments/preview', 'read', x => db(c => S.cumulativePreview(c, x.q)));
  route('GET', '/api/billing/preview', 'read', x => db(c => S.billingPreview(c, x.q)));
  route('GET', '/api/invoices', 'read', x => db(c => S.listInvoices(c, x.q)));
  route('GET', '/api/accounting/export', 'read', x => db(c => accountingExport(c, x, x.q)));
  route('GET', '/api/invoices/book', 'read', x => db(c => invoiceBook(c, x.q)).then(b => ({ file: b })));
  route('GET', '/api/invoices/:id', 'read', x => db(c => S.invoiceDetail(c, x.params.id)));
  route('GET', '/api/invoices/:id/document', 'read', x => db(c => S.issuedDocument(c, x.params.id)));
  route('GET', '/api/open-invoices', 'read', x => db(c => S.openInvoices(c, x.q.customer)));
  route('GET', '/api/reports/journal-list', 'read', x => x.q.format === 'xlsx' ? db(c => J.journalListBook(c, x.q)).then(b => ({ file: b })) : db(c => J.journalList(c, x.q)));
  route('GET', '/api/reports/bank-payments', 'read', x => x.q.format === 'xlsx' ? db(c => J.bankPaymentBook(c, x.q)).then(b => ({ file: b })) : db(c => J.bankPaymentList(c, x.q)));
  route('GET', '/api/reports/zengin', 'read', x => { if (x.q.format === 'file' && !U.WRITE_ROLES.includes(x.user.role)) throw new Forbidden('参照者は支払データを作成できません'); return db(c => PR.zenginData(c, x.q, x)); });
  route('GET', '/api/reports/payments/:kind', 'read', x => {
    const fn = { 'vendor-payments': PR.vendorPayments, 'transfer-request': PR.transferRequest, carryover: PR.payableCarryover, notices: PR.paymentNotices }[x.params.kind];
    if (!fn) throw new DomainError('帳票の種類が不正です');
    return x.q.format === 'xlsx' ? db(c => PR.paymentBook(c, x.params.kind, x.q)).then(b => ({ file: b })) : db(c => fn(c, x.q));
  });
  route('GET', '/api/reports/misc/:kind', 'read', x => {
    const k = x.params.kind, fn = MR.MISC[k] || XR.EXTRA[k] || NEW_REPORTS[k]; if (!fn) throw new DomainError('帳票の種類が不正です');
    return x.q.format === 'xlsx' ? db(c => (NEW_REPORTS[k] ? genericBook : XR.EXTRA[k] ? XR.extraBook : MR.miscBook)(c, k, x.q)).then(b => ({ file: b })) : db(c => fn(c, x.q));
  });
  route('GET', '/api/ar-ledger', 'read', x => db(c => S.arLedger(c, x.q)));
  route('GET', '/api/receipt-plan', 'read', x => db(c => S.receiptPlan(c, x.q)));
  route('GET', '/api/receipt-context', 'read', x => db(c => S.receiptContext(c, x.q.customer)));
  route('GET', '/api/reports/billing-list', 'read', x => x.q.format === 'xlsx' ? db(c => X.billingListBook(c, x.q)).then(b => ({ file: b })) : db(c => S.billingList(c, x.q)));
  route('GET', '/api/reports/billing-confirm', 'read', x => x.q.format === 'xlsx' ? db(c => X.billingConfirmBook(c, x.q)).then(b => ({ file: b })) : db(c => S.billingConfirm(c, x.q)));
  route('GET', '/api/receipts', 'read', x => db(c => S.listReceipts(c, x.q)));
  route('GET', '/api/purchases', 'read', x => db(c => P.listPurchases(c, x.q)));
  route('GET', '/api/inventory', 'read', x => db(c => P.listInventory(c, x.q)));
  route('GET', '/api/expenses', 'read', x => db(c => P.listExpenses(c, { ...x.q, open: x.q.open === '1' })));
  route('GET', '/api/payments', 'read', x => db(c => P.listPayments(c, x.q)));
  route('GET', '/api/journals', 'read', x => db(c => L.listJournals(c, x.q)));
  route('GET', '/api/trial-balance', 'read', x => db(c => L.trialBalance(c, x.q.month)));
  route('GET', '/api/periods', 'read', () => db(c => L.periods(c)));
  route('GET', '/api/periods/check', 'read', x => db(c => L.closeCheck(c, x.q.month)));
  route('GET', '/api/dashboard', 'read', () => db(c => L.dashboard(c)));
  route('GET', '/api/reports/ar', 'read', () => db(c => L.arReport(c)));
  route('GET', '/api/reports/ap', 'read', () => db(c => L.apReport(c)));
  route('GET', '/api/audit', 'read', x => db(c => L.auditLog(c, x.q)));
  route('GET', '/api/coverage', 'read', () => db(c => L.coverage(c)));
  route('GET', '/api/export/:kind', 'read', async x => ({ csv: csv(await db(c => L.exportCsv(c, x.params.kind, x.q))), name: `${x.params.kind}${x.q.month ? '-' + x.q.month : ''}-${today()}.csv` }));
  route('GET', '/api/users', 'admin', () => db(c => U.listUsers(c)));
  // ----- write -----
  const w = (path, fn, perm = 'write') => route('POST', path, perm, x => db(c => fn(c, x, x.body)));
  w('/api/masters/:kind', (c, x, b) => M.save(c, x, x.params.kind, b.record, b.mode === 'create' ? 'create' : 'update'));
  w('/api/masters/:kind/import', (c, x, b) => M.importCsv(c, x, x.params.kind, b.csv));
  w('/api/masters/:kind/delete', (c, x, b) => M.remove(c, x, x.params.kind, b.record));
  w('/api/shipments', (c, x, b) => S.saveShipment(c, x, b));
  w('/api/shipments/delete', (c, x, b) => S.deleteShipment(c, x, b));
  w('/api/plans', (c, x, b) => PL.savePlan(c, x, b));
  w('/api/plans/delete', (c, x, b) => PL.deletePlan(c, x, b));
  w('/api/delivery-notes', (c, x, b) => PL.deliveryNotes(c, x, b));
  route('GET', '/api/petty/settings', 'read', () => db(c => P.pettySettings(c)));
  w('/api/petty/fund', (c, x, b) => P.savePettyFund(c, x, b));
  w('/api/petty/refill', (c, x, b) => P.pettyRefill(c, x, b));
  w('/api/mix/save', (c, x, b) => MR.saveMix(c, x, b));
  w('/api/shipments/correct', (c, x, b) => S.correctShipment(c, x, b));
  w('/api/business-date', (c, x, b) => S.setBusinessDate(c, x, b));
  w('/api/billing/run', (c, x, b) => S.runBilling(c, x, b));
  w('/api/invoices/issue', (c, x, b) => S.issueInvoices(c, x, b));
  w('/api/invoices/cancel', (c, x, b) => S.cancelInvoice(c, x, b));
  w('/api/receipts', (c, x, b) => S.createReceipt(c, x, b));
  w('/api/receipts/reverse', (c, x, b) => S.reverseReceipt(c, x, b));
  w('/api/purchases', (c, x, b) => P.createPurchase(c, x, b));
  w('/api/purchases/delete', (c, x, b) => P.deletePurchase(c, x, b));
  w('/api/inventory', (c, x, b) => P.saveInventory(c, x, b));
  w('/api/inventory/delete', (c, x, b) => P.deleteInventory(c, x, b));
  w('/api/expenses', (c, x, b) => P.createExpense(c, x, b));
  w('/api/expenses/reverse', (c, x, b) => P.reverseExpense(c, x, b));
  w('/api/payments', (c, x, b) => P.createPayment(c, x, b));
  w('/api/payments/reverse', (c, x, b) => P.reversePayment(c, x, b));
  w('/api/periods/close', (c, x, b) => L.closeMonth(c, x, b), 'admin');
  w('/api/periods/reopen', (c, x, b) => L.reopenMonth(c, x, b), 'admin');
  // ----- 財務会計（勘定奉行相当） -----
  const kbRead = (path, fn, book) => route('GET', '/api/kb/' + path, 'read', x => x.q.format === 'xlsx' && book ? db(c => KB.book(c, book, x.q)).then(b => ({ file: b })) : db(c => fn(c, x.q, x)));
  kbRead('meta', c => KB.kbMeta(c));
  kbRead('trial', KB.trialBalance, 'trial');
  kbRead('fs', KB.trialBalance, 'fs');
  kbRead('monthly', KB.monthly, 'monthly');
  kbRead('ledger', KB.ledger, 'ledger');
  kbRead('sub-balances', KB.subBalances);
  kbRead('tax', KB.taxSummary, 'tax');
  kbRead('journal', KB.journal, 'journal');
  kbRead('journal-csv', (c, q, x) => KB.exportJournalCsv(c, x, q));
  kbRead('slips/:id', (c, q, x) => KB.slipDetail(c, x.params.id));
  kbRead('imports', c => KB.listImports(c));
  kbRead('opening', c => KB.opening(c));
  kbRead('bugyo', async c => ({ items: BUGYO_ITEMS, ...(await bugyoSettings(c)) }));
  w('/api/kb/slips', (c, x, b) => KB.saveSlip(c, x, b));
  w('/api/kb/slips/delete', (c, x, b) => KB.deleteSlip(c, x, b));
  w('/api/kb/import/seikyu', (c, x, b) => KB.importSeikyu(c, x, b));
  w('/api/kb/import/csv', (c, x, b) => KB.importCsv(c, x, b));
  w('/api/kb/import/cancel', (c, x, b) => KB.cancelImport(c, x, b));
  w('/api/kb/accounts', (c, x, b) => KB.saveAccount(c, x, b));
  w('/api/kb/opening', (c, x, b) => KB.saveOpening(c, x, b));
  w('/api/kb/settings', (c, x, b) => KB.saveSettings(c, x, b), 'admin');
  w('/api/kb/bugyo', (c, x, b) => saveBugyoSettings(c, x, b), 'admin');
  w('/api/users', (c, x, b) => U.saveUser(c, x, b), 'admin');
  w('/api/password', (c, x, b) => U.changeOwnPassword(c, x, b), 'read');

  const cookie = (v, age) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status, body, type = MIME.json, extra = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(type === MIME.json && !Buffer.isBuffer(body) && typeof body !== 'string' ? JSON.stringify(body) : body); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', CSP);
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://local'), path = url.pathname;
      if (path === '/health') { try { await pool.query('SELECT 1'); send(200, { ok: true, version }); } catch { send(503, { ok: false }); } return; }
      const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
      let body = null;
      if (req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site' || !String(req.headers['content-type'] || '').startsWith('application/json')) return send(403, { error: '不正なリクエストです' });
        let size = 0; const parts = [];
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) return send(413, { error: 'データが大きすぎます' }); parts.push(chunk); }
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return send(400, { error: 'JSON形式が不正です' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'リクエストが不正です' });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
        for (const [k, v] of failures) if (v.until < now) failures.delete(k);
        const keys = [`ip:${ip}`, `id:${String(body.loginId).slice(0, 64)}`];
        if (keys.some(k => (failures.get(k)?.count || 0) >= 10)) return send(429, { error: 'ログイン試行が多すぎます。1分ほど待ってから再試行してください。' }, MIME.json, { 'Retry-After': '60' });
        const user = typeof body.loginId === 'string' && typeof body.password === 'string' && body.password.length <= 200 ? await db(c => U.authenticate(c, body.loginId, body.password)) : null;
        if (!user) { for (const k of keys) { const f = failures.get(k); failures.set(k, { count: (f?.count || 0) + 1, until: f?.until || now + 60000 }); } return send(401, { error: 'ログインIDまたはパスワードが違います' }); }
        if (token) await db(c => U.destroySession(c, token));
        const fresh = await db(c => U.createSession(c, user));
        await db(c => audit(c, { user, requestId }, 'users', user.user_id, 'user.login', {}));
        return send(200, { ok: true }, MIME.json, { 'Set-Cookie': cookie(fresh, U.SESSION_HOURS * 3600) });
      }
      const user = token ? await db(c => U.sessionUser(c, token)) : null;
      if (path === '/api/logout' && req.method === 'POST') { if (token) await db(c => U.destroySession(c, token)); return send(200, { ok: true }, MIME.json, { 'Set-Cookie': cookie('', 0) }); }
      if (path.startsWith('/api/')) {
        if (!user) return send(401, { error: 'ログインしてください' });
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== user.csrf) return send(403, { error: 'セッションが更新されました。再読込してください' });
        if (path === '/api/session' && req.method === 'GET') return send(200, { user: { id: user.user_id, loginId: user.login_id, name: user.name, role: user.role, roleName: user.roleName }, csrf: user.csrf, menus: await db(c => U.menusFor(c, user.role)) });
        for (const r of routes) {
          const m = r.method === req.method && path.match(r.re); if (!m) continue;
          if (r.perm === 'write' && !U.WRITE_ROLES.includes(user.role)) throw new Forbidden('参照者は登録・変更できません');
          if (r.perm === 'admin' && user.role !== 1) throw new Forbidden('管理者のみ実行できます');
          const result = await r.fn({ params: Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])), q: Object.fromEntries(url.searchParams), body, user, requestId });
          if (result?.file) return send(200, result.file.body, result.file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': `attachment; filename="${result.file.name.endsWith('.txt') ? 'zengin.txt' : result.file.name.endsWith('.csv') ? 'export.csv' : 'report.xlsx'}"; filename*=UTF-8''${encodeURIComponent(result.file.name)}` });
          if (result && typeof result.csv === 'string') return send(200, result.csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${result.name.replace(/[^\w.\-]/g, '_')}"` });
          return send(200, result ?? { ok: true });
        }
        return send(404, { error: 'Not found' });
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
      if (path === '/login') return send(200, await readFile(new URL('login.html', publicDir)), MIME.html);
      if (path === '/' || path === '/index.html') {
        if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
        return send(200, await readFile(new URL('index.html', publicDir)), MIME.html);
      }
      const name = path.slice(1);
      if (/^[\w.\-]+$/.test(name) && files.has(name) && !name.endsWith('.html')) return send(200, await readFile(new URL(name, publicDir)), MIME[name.split('.').pop()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
      return send(404, 'Not found', 'text/plain; charset=utf-8');
    } catch (e) {
      const d = mapSqlError(e);
      if (d) return send(e?.code === 'ER_ROW_IS_REFERENCED_2' || e?.code === 'ER_DUP_ENTRY' ? 409 : 400, { error: d.message });
      if (e instanceof Conflict) return send(409, { error: e.message });
      if (e instanceof Forbidden) return send(403, { error: e.message });
      if (e instanceof DomainError) return send(400, { error: e.message });
      console.error(`[${requestId}] request failed:`, e?.code || e?.name, e?.message);
      return send(500, { error: 'サーバー処理に失敗しました。時間をおいて再試行してください。（ID: ' + requestId.slice(0, 8) + '）' });
    }
  });
}
