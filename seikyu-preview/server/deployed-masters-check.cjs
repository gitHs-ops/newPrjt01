// Run against an explicitly selected review deployment. Adds labelled fictional
// master records and disables them at the end; never deletes user records.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const url=process.env.PREVIEW_URL;
 if(!url||!process.env.DEMO_USER||!process.env.DEMO_PASSWORD)throw Error('Review URL and credentials required');
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const credentials={username:process.env.DEMO_USER,password:process.env.DEMO_PASSWORD};
  const ctx=await browser.newContext({httpCredentials:credentials,viewport:{width:1440,height:1000}});
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/#masters');await page.getByRole('heading',{name:'マスタ管理',exact:true}).waitFor();
  const get=()=>page.evaluate(async()=>{const r=await fetch('/api/workspace');if(!r.ok)throw Error('Workspace request failed');return r.json();});
  const suffix=Date.now().toString(36).slice(-4).toUpperCase(),created=[];
  const open=async kind=>page.locator('[data-action=master-tab][data-id='+kind+']').click();
  const submit=async()=>{await page.locator('#entry-form button[type=submit]').click();await page.locator('#dialog').waitFor({state:'hidden'});};
  const fill=async(k,v)=>page.locator('[name='+k+']').fill(v);
  async function add(kind,code,extra=async()=>{}){
   await open(kind);await page.locator('[data-action=master]').first().click();await fill('code',code);await fill('name','QA '+suffix+' '+kind);await extra();await submit();
   const data=await get(),record=data.state[kind].find(x=>x.code===code&&x.name==='QA '+suffix+' '+kind);assert.ok(record);created.push({kind,id:record.id,code});return record;
  }
  const customer=await add('customers','C'+suffix);
  await add('items','I'+suffix,async()=>{await fill('price','1234');});
  await add('banks','B'+suffix);
  await add('vendors','V'+suffix,async()=>{await fill('bank','9999');await fill('branch','999');await fill('account',Date.now().toString());await fill('kana','QA SAMPLE');});
  const account=await add('accounts','A'+suffix);
  await add('subaccounts','001',async()=>{await page.locator('[name=accountCode]').selectOption(account.code);});
  await add('sites','F'+suffix,async()=>{await page.locator('[name=customerId]').selectOption(customer.id);await fill('suffix','001');});
  const second=await browser.newContext({httpCredentials:credentials});const other=await second.newPage();
  await other.goto(url+'/#masters');await other.getByText('QA '+suffix+' customers',{exact:true}).waitFor();await second.close();
  // Update and disable children before their parents.
  for(const rec of [...created].reverse()){
   await open(rec.kind);await page.locator('[data-action=master][data-id="'+rec.id+'"]').click();await fill('name','QA '+suffix+' checked');await page.locator('[name=active]').selectOption('false');await submit();
  }
  await page.reload();await page.getByRole('heading',{name:'マスタ管理',exact:true}).waitFor();
  const final=await get();for(const rec of created){const row=final.state[rec.kind].find(r=>r.id===rec.id);assert.equal(row.active,false);assert.equal(row.name,'QA '+suffix+' checked');}
  assert.equal(await page.locator('#logout').isVisible(),false);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  const result={passed:true,url,created,allDisabled:true,checks:['7 master creates','SQL-backed reload','independent browser','7 edits/deactivations','reset disabled','mobile no overflow','no page errors']};
  if(process.env.QA_REPORT)fs.writeFileSync(process.env.QA_REPORT,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
