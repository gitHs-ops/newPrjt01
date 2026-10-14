// UI transport check using a memory test double; not a MySQL execution test.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {serverFor} from './http.mjs';
import {seed} from '../demo-store.mjs';
import {dispatch} from '../domain.mjs';
import {Conflict} from './store.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
let data=seed();
const password='browser-test-only-123456';
const server=serverFor({user:'tester',password,assetRoot:new URL('../',import.meta.url),store:{
  read:async()=>data,audit:async()=>[],mutate:async(command,actor,reset)=>{
    if(command.revision!==data.revision)throw new Conflict('stale');
    data={...(reset?seed():dispatch(data.state,command,actor)),revision:data.revision+1};return data;
  }
}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const errors=[];
  const context=await browser.newContext({httpCredentials:{username:'tester',password}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const url='http://127.0.0.1:'+server.address().port;
  await page.goto(url);await page.getByRole('heading',{name:'ダッシュボード',exact:true}).waitFor();
  assert.match(await page.locator('#save-status').textContent(),/MySQL/);
  await page.locator('a.nav-link[href="#masters"]').click();await page.locator('[data-action=master]').first().click();
  await page.locator('[name=code]').fill('SHARED1');await page.locator('[name=name]').fill('Shared browser test');
  await page.locator('button[type=submit]').click();await page.locator('#dialog').waitFor({state:'hidden'});
  const second=await browser.newContext({httpCredentials:{username:'tester',password}});const other=await second.newPage();
  await other.goto(url+'/#masters');await other.getByText('Shared browser test',{exact:true}).waitFor();
  await page.reload();await page.getByText('Shared browser test',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('aplink-web-preview-v1')),null);
  assert.equal(await page.locator('#logout').isVisible(),false);
  await page.locator('a.nav-link[href="#migration"]').click();assert.ok(!(await page.locator('main').textContent()).includes('ブラウザーだけに保存'));
  assert.deepEqual(errors,[]);console.log('Server-mode UI passed: HTTP auth, save, independent browser read, reload, no localStorage, reset hidden. Store is a test double.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
