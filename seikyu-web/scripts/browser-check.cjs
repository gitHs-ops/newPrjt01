// Browser walk-through: login, every menu, console errors, screenshots, optional write flow.
// Usage: BASE_URL=... LOGIN_ID=... LOGIN_PASSWORD=... [WRITE=1] [OUT_DIR=...] PLAYWRIGHT_MODULE=<path to playwright-core> node scripts/browser-check.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL, out = process.env.OUT_DIR || '.';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [], errors = [];
  for (const mobile of [false, true]) {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', m => m.type() === 'error' && errors.push(`${mobile ? 'mobile' : 'desktop'} console: ${m.text()}`));
    page.on('pageerror', e => errors.push(`${mobile ? 'mobile' : 'desktop'} pageerror: ${e.message}`));
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    if (!page.url().includes('/login')) throw Error('anonymous user was not redirected to /login');
    await page.fill('input[name=loginId]', process.env.LOGIN_ID); await page.fill('input[name=password]', process.env.LOGIN_PASSWORD);
    await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
    await page.waitForSelector('#content[data-view] .page', { timeout: 60000 });
    const menus = await page.$$eval('[data-nav]', a => a.map(x => x.dataset.nav));
    for (const m of menus) {
      await page.evaluate(h => (location.hash = h), m);
      await page.waitForFunction(h => document.querySelector('#content').dataset.view === h && !document.querySelector('#content.busy'), m, { timeout: 60000 });
      await page.waitForTimeout(300);
      const err = await page.$eval('#content', el => el.querySelector('.check-ng')?.closest('.card')?.querySelector('h2')?.textContent === '読み込みエラー' ? el.innerText : '');
      results.push({ view: m, mobile, ok: !err }); if (err) errors.push(`${m}: ${err}`);
      if (!mobile) await page.screenshot({ path: `${out}/web-${m}.png`, fullPage: true });
    }
    if (mobile) await page.screenshot({ path: `${out}/web-mobile-dashboard.png` });
    if (!mobile && process.env.WRITE === '1') {
      // shipment create → edit modal open → cancel, exercising modal X and bottom buttons
      await page.evaluate(() => (location.hash = 'shipments')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'shipments' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      await page.click('[data-act=new]'); await page.waitForSelector('dialog[open]');
      await page.click('#modal-x'); if (await page.$('dialog[open]')) errors.push('modal X did not close');
      await page.click('[data-act=new]'); await page.waitForSelector('dialog[open]');
      const cust = await page.$eval('select[name=customer]', s => s.value);
      await page.selectOption('select[name=site]', { index: 1 }); await page.selectOption('select[name=item]', { index: 1 });
      await page.waitForFunction(() => document.querySelector('input[name=price]').value !== '', null, { timeout: 30000 }); await page.fill('input[name=quantity]', '1.25'); await page.fill('input[name=remarks]', 'ブラウザ検証');
      await page.click('#modal-submit');
      await page.waitForFunction(() => !document.querySelector('#dialog').open || document.querySelector('#form-error')?.textContent, null, { timeout: 30000 });
      const fe = await page.$eval('#dialog', d => d.open ? d.querySelector('#form-error').textContent : ''); if (fe) { errors.push('shipment form: ' + fe); await page.click('#modal-cancel'); }
      await page.waitForTimeout(800);
      const row = await page.$$eval('tbody tr', rs => rs.map(r => r.innerText).find(t => t.includes('1.25')) || '');
      results.push({ view: 'shipment.create', ok: !!row, detail: cust + ' ' + row.slice(0, 80) });
      const id = row.split('\t')[0];
      await page.waitForLoadState('networkidle');
      if (id) { await page.click(`[data-act=del][data-id="${id}"]`); await page.waitForSelector('#modal-submit:has-text("取消する")'); await page.click('#modal-submit'); await page.waitForTimeout(1500); await page.waitForLoadState('networkidle');
        const still = !(await page.waitForFunction(i => ![...document.querySelectorAll('tbody tr')].some(r => r.innerText.trim().startsWith(i)), id.trim(), { timeout: 30000 }).then(() => true, () => false)); results.push({ view: 'shipment.delete', ok: !still }); }
      // print preview of the latest issued invoice (no actual print dialog in headless)
      await page.evaluate(() => (location.hash = 'invoices')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'invoices' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      await page.waitForSelector('[data-act=detail]', { timeout: 30000 }); await page.click('[data-act=detail]'); await page.waitForSelector('dialog[open]');
      await page.screenshot({ path: `${out}/web-invoice-detail.png` });
      await page.click('#modal-cancel');
      // NO12 report viewer, NO17 receipt form, NO11 correction form (open, screenshot, cancel; no data written)
      await page.click('[data-act=report][data-kind=list]'); await page.waitForSelector('dialog[open] #rep-body', { timeout: 60000 });
      await page.screenshot({ path: `${out}/web-billing-list.png` }); results.push({ view: 'report.list', ok: !!(await page.$('#rep-body table, #rep-body .empty')) }); await page.click('#modal-x');
      await page.click('[data-act=report][data-kind=confirm]'); await page.waitForSelector('dialog[open] #rep-body', { timeout: 60000 }); await page.screenshot({ path: `${out}/web-billing-confirm.png` }); await page.click('#modal-cancel');
      await page.evaluate(() => (location.hash = 'receipts')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'receipts' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      await page.click('[data-act=new]'); await page.waitForSelector('dialog[open]'); await page.selectOption('dialog select[name=customer]', { index: 2 });
      await page.waitForSelector('#rc-open table, #rc-open .empty', { timeout: 60000 }); await page.screenshot({ path: `${out}/web-receipt-form.png` }); results.push({ view: 'receipt.form', ok: true }); await page.click('#modal-cancel');
      await page.evaluate(() => (location.hash = 'shipments')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'shipments' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      // ② 自動仕訳リスト 7種
      for (const list of ['A01', 'B01', 'C01', 'D01', 'E01', 'F01', 'BANK']) {
        const from = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
        await page.evaluate(h => (location.hash = h), `journals?tab=lists&list=${list}&from=${from}&to=${to}`);
        await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'journals' && !document.querySelector('#content.busy') && document.querySelector('#jl-body'), null, { timeout: 60000 });
        const ok = await page.$eval('#content', el => !el.innerText.includes('読み込みエラー') && !!el.querySelector('#jl-body table, #jl-body .empty'));
        results.push({ view: 'list.' + list, ok }); if (list === 'B01' || list === 'BANK') await page.screenshot({ path: `${out}/web-list-${list}.png`, fullPage: true });
      }
      // ③ 支払帳票・全銀データ（表示のみ）
      await page.evaluate(() => (location.hash = 'payments')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'payments' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      for (const kind of ['vendor-payments', 'transfer-request', 'carryover', 'notices']) {
        await page.click(`[data-act=prep][data-kind=${kind}]`); await page.waitForSelector('dialog[open] #pr-body', { timeout: 60000 });
        results.push({ view: 'pay.' + kind, ok: !!(await page.$('#pr-body table, #pr-body .empty, #pr-body .notice-doc')) }); if (kind === 'notices') await page.screenshot({ path: `${out}/web-pay-${kind}.png` }); await page.click('#modal-x');
      }
      await page.click('[data-act=zengin]'); await page.waitForSelector('dialog[open] .zengin-pre', { timeout: 60000 }); await page.screenshot({ path: `${out}/web-zengin.png` }); results.push({ view: 'pay.zengin', ok: true }); await page.click('#modal-x');
      // ④ 出荷集計・材料受払表・配合計算・JV帳票
      const goView = async v => { await page.evaluate(h => (location.hash = h), v); await page.waitForFunction(h => document.querySelector('#content').dataset.view === h && !document.querySelector('#content.busy'), v, { timeout: 60000 }); };
      const openMisc = async (sel, name) => {
        await page.evaluate(() => { const t = document.querySelector('#toast'); t.textContent = ''; t.className = ''; });
        await page.click(sel);
        await page.waitForFunction(() => document.querySelector('#dialog').open || document.querySelector('#toast.error')?.textContent, null, { timeout: 60000 });
        const open = await page.$eval('#dialog', x => x.open), msg = open ? '' : await page.$eval('#toast', x => x.textContent);
        results.push({ view: 'misc.' + name, ok: open || /JV構成員/.test(msg), detail: msg }); if (open) { await page.screenshot({ path: `${out}/web-misc-${name}.png` }); await page.click('#modal-x'); }
      };
      await goView('shipments');
      for (const k of ['shipment-summary', 'customer-items', 'cash-sales']) await openMisc(`[data-act=misc][data-kind=${k}]`, k);
      await goView('inventory');
      await openMisc('[data-act=misc][data-kind=material-ledger]', 'material-ledger'); await openMisc('[data-act=mix]', 'mix');
      await goView('reports');
      for (const k of ['jv-expenses', 'jv-receipts']) await openMisc(`[data-act=misc][data-kind=${k}]`, k);
      // 推定完成分（NO3/9/30/33/40/44）
      await goView('shipments'); await openMisc('[data-act=misc][data-kind=sales-register]', 'sales-register');
      await goView('receipts'); await openMisc('[data-act=misc][data-kind=receipt-schedule]', 'receipt-schedule');
      await goView('payables'); await openMisc('[data-act=misc][data-kind=payable-input]', 'payable-input');
      await goView('cash'); await openMisc('[data-act=misc][data-kind=petty-book]', 'petty-book');
      await page.evaluate(() => (location.hash = 'invoices?view=balance'));
      await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'invoices' && !document.querySelector('#content.busy') && document.querySelector('.tabs button.active')?.dataset.view === 'balance', null, { timeout: 60000 });
      results.push({ view: 'invoices.balance', ok: !!(await page.$('#content table, #content .empty')) }); await page.screenshot({ path: `${out}/web-invoices-balance.png` });
      await page.evaluate(() => (location.hash = 'masters?kind=customers&search=C00'));
      await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'masters' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      results.push({ view: 'masters.search', ok: await page.$eval('#content', el => el.innerText.includes('検索結果')) });
      const acct = await page.evaluate(async () => { const d = new Date(); const from = new Date(d - 90 * 864e5).toISOString().slice(0, 10), to = d.toISOString().slice(0, 10); const r = await fetch('/api/accounting/export?from=' + from + '&to=' + to + '&format=yayoi'); return r.status; });
      results.push({ view: 'accounting.export', ok: acct === 200 });
      await page.evaluate(() => (location.hash = 'shipments')); await page.waitForFunction(() => document.querySelector('#content').dataset.view === 'shipments' && !document.querySelector('#content.busy'), null, { timeout: 60000 });
      const corr = await page.$('[data-act=correct]'); if (corr) { await corr.click(); await page.waitForSelector('dialog[open] input[name=quantity]'); await page.screenshot({ path: `${out}/web-correction.png` }); results.push({ view: 'correction.form', ok: true }); await page.click('#modal-x'); }
    }
    await page.click('#logout').catch(() => {}); await page.waitForURL(u => u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => errors.push('logout did not return to /login'));
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({ results, errors }, null, 1));
  process.exitCode = errors.length || results.some(r => !r.ok) ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
