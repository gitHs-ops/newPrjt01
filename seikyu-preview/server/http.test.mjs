import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {serverFor} from './http.mjs';
import {seed} from '../demo-store.mjs';
import {dispatch} from '../domain.mjs';
import {Conflict} from './store.mjs';
let server,base,data=seed(),calls=0;
const password='test-only-password-12345';
const authorization='Basic '+Buffer.from('tester:'+password).toString('base64');
const headers={authorization,'Content-Type':'application/json','X-Demo-Request':'1'};
before(async()=>{
  server=serverFor({user:'tester',password,assetRoot:new URL('../',import.meta.url),store:{
    read:async()=>data,audit:async()=>[],mutate:async(command,actor,reset)=>{
      calls++;if(command.revision!==data.revision)throw new Conflict('stale revision');
      const next=reset?seed():dispatch(data.state,command,actor);data={...next,revision:data.revision+1};return data;
    }
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
after(()=>new Promise(r=>server.close(r)));
test('anonymous requests cannot access data or application',async()=>{
  for(const path of ['/api/workspace','/runtime.json'])assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(base+'/health')).status,200);
});
test('same-origin app receives MySQL mode; source files outside allowlist blocked',async()=>{
  const r=await fetch(base+'/runtime.json',{headers});assert.deepEqual(await r.json(),{storage:'mysql'});
  assert.equal((await fetch(base+'/server/main.mjs',{headers})).status,404);
  assert.equal((await fetch(base+'/.env',{headers})).status,404);
});
test('CSRF and malformed requests never call store',async()=>{
  const before=calls;
  assert.equal((await fetch(base+'/api/reset',{method:'POST',headers:{authorization},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/reset',{method:'POST',headers:{...headers,'Sec-Fetch-Site':'cross-site'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/reset',{method:'POST',headers,body:'null'})).status,400);
  assert.equal(calls,before);
});
test('mutation uses server calculations, rejects invalid business command and stale reset',async()=>{
  let r=await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({revision:data.revision,action:'master.save',payload:{kind:'customers',code:'HTTP1',name:'Test'}})});
  assert.equal(r.status,200);const saved=await r.json();assert.ok(saved.state.customers.some(c=>c.code==='HTTP1'));
  r=await fetch(base+'/api/reset',{method:'POST',headers,body:JSON.stringify({revision:saved.revision-1})});assert.equal(r.status,409);
  r=await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({revision:saved.revision,action:'master.save',payload:{kind:'customers',code:'HTTP1',name:'Duplicate'}})});assert.equal(r.status,400);
  assert.equal(data.revision,saved.revision);
});

test('form login issues protected session and logout revokes it without browser challenge',async()=>{
 const anon=await fetch(base+'/',{redirect:'manual'});assert.equal(anon.status,302);assert.equal(anon.headers.get('www-authenticate'),null);
 assert.equal((await fetch(base+'/login')).status,200);
 const loginHeaders={'Content-Type':'application/json','X-Demo-Request':'1'};
 const login=async(p)=>fetch(base+'/api/login',{method:'POST',headers:loginHeaders,body:JSON.stringify({user:'tester',password:p})});
 assert.equal((await login('wrong')).status,401);
 assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const good=await login(password);assert.equal(good.status,200);const set=good.headers.get('set-cookie');assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);
 const cookie=set.split(';')[0];assert.equal((await fetch(base+'/api/workspace',{headers:{cookie}})).status,200);
 assert.equal((await fetch(base+'/api/workspace',{headers:{cookie:cookie+'x'}})).status,401);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{...loginHeaders,cookie},body:'{}'})).status,200);
 assert.equal((await fetch(base+'/api/workspace',{headers:{cookie}})).status,401);
});
