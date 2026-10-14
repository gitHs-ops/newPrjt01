import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MysqlStore,Conflict} from './store.mjs';
const mysql=createRequire(import.meta.url)(process.env.MYSQL2_MODULE||'mysql2/promise');
test('MySQL master tables: migration, CRUD, references, atomic import, concurrency, restart', {skip:!process.env.MYSQL_TEST_URL},async()=>{
 const pool=mysql.createPool(process.env.MYSQL_TEST_URL);
 try{
  const store=new MysqlStore(pool);await store.initialize();let data=await store.read();
  const customer=data.state.customers[0];
  const [[raw]]=await pool.query('SELECT state_json FROM preview_workspace WHERE id=1');
  const persisted=typeof raw.state_json==='string'?JSON.parse(raw.state_json):raw.state_json;
  assert.equal(persisted.customers,undefined);assert.equal(persisted.masterStorage,'tables-v1');
  assert.ok(persisted.shipments.some(r=>r.customerId===customer.id));
  const [[row]]=await pool.execute('SELECT customers_name FROM client_m WHERE customers_cd=?',[customer.code]);assert.equal(row.customers_name,customer.name);
  async function save(kind,payload){data=await store.mutate({revision:data.revision,action:'master.save',payload:{kind,...payload}},'integration');return data.result.id;}
  await save('customers',{...customer,name:'試験変更（架空）'});
  assert.equal((await pool.execute('SELECT customers_name FROM client_m WHERE customers_cd=?',[customer.code]))[0][0].customers_name,'試験変更（架空）');
  await save('sites',{code:'F001',suffix:'001',name:'試験現場',customerId:customer.id});
  await save('accounts',{code:'QA100',name:'試験科目'});
  await save('subaccounts',{code:'101',accountCode:'QA100',name:'試験内訳'});
  await save('banks',{code:'QB1',name:'試験銀行内訳'});
  const vendorId=await save('vendors',{code:'QV1',name:'試験業者',bank:'9999',branch:'999',account:'0000001',kana:'TEST',accountType:'1'});
  await save('vendors',{...data.state.vendors.find(x=>x.id===vendorId),active:false});
  const [[vendor]]=await pool.query("SELECT v.active,b.account_number FROM vendor v JOIN bank_account b ON b.bank_account_id=v.bank_account_id WHERE vendor_code='QV1'");
  assert.equal(vendor.active,0);assert.equal(vendor.account_number,'0000001');
  const [[sub]]=await pool.query("SELECT COUNT(*) n FROM account_subsubject WHERE sub_code='101'");assert.equal(sub.n,2);
  const [[site]]=await pool.query("SELECT customers_cd FROM field_name_m WHERE field_cd='F001'");assert.equal(site.customers_cd,customer.code);
  // A valid first CSV row followed by an overlength name must roll back both SQL and revision.
  const revision=data.revision;
  await assert.rejects(store.mutate({revision,action:'master.import',payload:{kind:'customers',rows:[{code:'QA1',name:'Valid'},{code:'QA2',name:'x'.repeat(43)}]}},'integration'));
  assert.equal((await store.read()).revision,revision);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM client_m WHERE customers_cd='QA1'"))[0][0].n,0);
  await assert.rejects(store.mutate({revision,action:'master.save',payload:{kind:'sites',code:'BAD',name:'Bad',customerId:'missing'}},'integration'));
  const a={revision,action:'master.save',payload:{kind:'banks',code:'QC1',name:'Race'}};
  const outcomes=await Promise.allSettled([store.mutate(a,'one'),store.mutate(a,'two')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.ok(outcomes.find(x=>x.status==='rejected').reason instanceof Conflict);
  const again=new MysqlStore(pool);await again.initialize();data=await again.read();
  assert.equal(data.state.customers.find(r=>r.id===customer.id).name,'試験変更（架空）');
  await pool.execute('UPDATE client_m SET customers_name=? WHERE customers_cd=?',['DB directly',customer.code]);
  assert.equal((await again.read()).state.customers.find(r=>r.id===customer.id).name,'DB directly');
  await assert.rejects(again.mutate({revision:data.revision},'test',true));
 }finally{await pool.end();}
});
