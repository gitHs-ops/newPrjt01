import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Conflict} from './store.mjs';
import {DomainError} from '../domain.mjs';
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/domain.mjs':'domain.mjs','/demo-store.mjs':'demo-store.mjs','/requirements.json':'requirements.json'};
const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json; charset=utf-8'};
export function serverFor({store,user,password,assetRoot}){
  if(!user||!password||password.length<16||user.includes(':'))throw Error('Set DEMO_USER and DEMO_PASSWORD (at least 16 characters)');
  return createServer(async(req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'&&req.method==='GET'){
        try{await store.read();reply(200,{ok:true});}catch{reply(503,{ok:false});}return;
      }
      const credential=req.headers.authorization||'';
      if(!credential.startsWith('Basic ')||!equal(Buffer.from(credential.slice(6),'base64').toString(),user+':'+password)){
        res.setHeader('WWW-Authenticate','Basic realm="APLink MySQL Preview", charset="UTF-8"');reply(401,{error:'認証が必要です'});return;
      }
      // Only same-origin JSON requests with a custom header can mutate shared data.
      if(req.method==='POST'){
        if(req.headers['sec-fetch-site']==='cross-site'||req.headers['x-demo-request']!=='1'||!req.headers['content-type']?.startsWith('application/json')){reply(403,{error:'不正なリクエストです'});return;}
        let size=0,parts=[];
        for await(const chunk of req){size+=chunk.length;if(size>1024*1024){reply(413,{error:'データが大きすぎます'});return;}parts.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(parts).toString());}catch{reply(400,{error:'JSON形式が不正です'});return;}
        if(!body||typeof body!=='object'||Array.isArray(body)){reply(400,{error:'リクエストが不正です'});return;}
        if(url.pathname==='/api/workspace'||url.pathname==='/api/reset'){
          if(url.pathname==='/api/workspace'&&(typeof body.action!=='string'||!body.payload||typeof body.payload!=='object')){reply(400,{error:'操作内容が不正です'});return;}
          reply(200,await store.mutate(body,user,url.pathname==='/api/reset'));return;
        }
        reply(404,{error:'Not found'});return;
      }
      if(req.method!=='GET'){reply(405,{error:'Method not allowed'});return;}
      if(url.pathname==='/runtime.json'){reply(200,{storage:'mysql'});return;}
      if(url.pathname==='/api/session'){reply(200,{user,canWrite:true,header:'X-Demo-Request',csrf:'1',storage:'mysql'});return;}
      if(url.pathname==='/api/workspace'){reply(200,await store.read());return;}
      if(url.pathname==='/api/audit'){reply(200,await store.audit());return;}
      if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      const file=assets[url.pathname];
      if(!file){reply(404,{error:'Not found'});return;}
      const bytes=await readFile(new URL(file,assetRoot));res.writeHead(200,{'Content-Type':mime[file.split('.').at(-1)]});res.end(bytes);
    }catch(error){
      if(error instanceof Conflict)reply(409,{error:error.message});
      else if(error instanceof DomainError)reply(400,{error:error.message});
      else {console.error('Preview request failed:',error.code||error.name);reply(503,{error:'保存サーバーに接続できません。再読込で保存状況を確認してください。'});}
    }
  });
}
