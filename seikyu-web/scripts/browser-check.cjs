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
    }
    await page.click('#logout').catch(() => {}); await page.waitForURL(u => u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => errors.push('logout did not return to /login'));
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({ results, errors }, null, 1));
  process.exitCode = errors.length || results.some(r => !r.ok) ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
