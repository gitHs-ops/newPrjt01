// Read-only deployment check. Credentials come from environment, never output.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const url=process.env.PREVIEW_URL;
 if(!url||!process.env.DEMO_USER||!process.env.DEMO_PASSWORD)throw Error('URL and credentials required');
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext();const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/#masters');await page.locator('#login-form').waitFor();
  await page.locator('[name=user]').fill(process.env.DEMO_USER);
  await page.locator('[name=password]').fill(process.env.DEMO_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.getByRole('heading',{name:'マスタ管理',exact:true}).waitFor();
  const cookie=(await context.cookies()).find(c=>c.name==='aplink_session');
  assert.ok(cookie?.httpOnly&&cookie.secure&&cookie.sameSite==='Strict');
  await page.reload();await page.getByRole('heading',{name:'マスタ管理',exact:true}).waitFor();
  assert.equal(await page.evaluate(async()=>(await fetch('/api/workspace')).status),200);
  await page.locator('#signout').click();await page.locator('#login-form').waitFor();
  assert.equal(await page.evaluate(async()=>(await fetch('/api/workspace')).status),401);
  assert.deepEqual(errors,[]);
  console.log('PASS: deployed form login, secure HttpOnly cookie, master page, reload, logout, anonymous data blocked; no data mutations.');
 }finally{await browser.close();}
})().catch(()=>{console.error('Deployment login verification failed');process.exitCode=1;});
