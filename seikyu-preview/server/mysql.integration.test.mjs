// Dedicated empty test DB only. Does not connect unless MYSQL_TEST_URL is provided.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const mysql=createRequire(import.meta.url)('mysql2/promise');
import {MysqlStore,Conflict} from './store.mjs';
test('real MySQL: restart persistence, competing writes, invalid-command rollback, audit', {skip:!process.env.MYSQL_TEST_URL},async()=>{
  const pool=mysql.createPool(process.env.MYSQL_TEST_URL);
  try{
    const store=new MysqlStore(pool);await store.initialize();const start=await store.read();
    const key='QA'+Date.now();
    const command={revision:start.revision,action:'master.save',payload:{kind:'customers',code:key,name:'Integration test'}};
    const outcomes=await Promise.allSettled([store.mutate(command,'test'),store.mutate(command,'test')]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.ok(outcomes.find(r=>r.status==='rejected').reason instanceof Conflict);
    const saved=await new MysqlStore(pool).read();assert.equal(saved.revision,start.revision+1);
    assert.ok(saved.state.customers.some(c=>c.code===key));
    await assert.rejects(store.mutate({...command,revision:saved.revision},'test'));
    assert.deepEqual(await store.read(),saved);
    const audit=await store.audit();assert.equal(Number(audit[0].revision),saved.revision);
  }finally{await pool.end();}
});
