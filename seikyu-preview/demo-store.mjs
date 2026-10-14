import {fresh, dispatch, csv} from './domain.mjs';

export const storageKey = 'aplink-web-preview-v1';
let runtimePromise;
async function runtime(){
  if(!runtimePromise)runtimePromise=fetch('./runtime.json',{cache:'no-store'}).then(async r=>{
    if(!r.ok)throw Error('保存先設定を読み込めません');
    const config=await r.json();
    if(!['mysql','local'].includes(config.storage))throw Error('保存先設定が不正です');
    return config;
  });
  return runtimePromise;
}
async function api(url,options={}){
  const response=await fetch(url,{...options,cache:'no-store',headers:{...options.headers,'X-Demo-Request':'1'}});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'サーバー処理に失敗しました');
  return data;
}
const localDate = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo'}).format(new Date());

export function seed() {
  let state = fresh();
  state.settings.company = 'サンプル建材株式会社（架空）';
  const current = localDate();
  const day = (offset, d) => {
    const date = new Date(current.slice(0,7) + '-01T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + offset);
    return date.toISOString().slice(0,7) + '-' + String(d).padStart(2,'0');
  };
  const run = (action,payload) => {
    const r = dispatch(state,{action,payload},'サンプル生成', (payload.date || current) + 'T09:00:00+09:00');
    state = r.state; return r.result.id;
  };
  const master = (kind,code,name,extra={}) => run('master.save',{kind,code,name,...extra});
  const customers = ['青空建設（架空）','みなと道路（架空）','若葉工業（架空）'].map((n,i)=>master('customers','C00'+(i+1),n,{closing:10}));
  const pending = master('customers','C004','さくら土木（架空）',{closing:20});
  const vendors = ['サンプル資材（架空）','デモ運輸（架空）'].map((n,i)=>master('vendors','V00'+(i+1),n));
  const items = [['再生砕石 RC-40',3200],['粒度調整砕石 M-30',4800],['山砂',2600]].map(([n,p],i)=>master('items','P00'+(i+1),n,{unit:'t',price:p,taxRate:10}));
  master('banks','041','サンプル銀行（架空）');
  master('accounts','8230','材料仕入');master('accounts','8330','支払手数料');master('accounts','8310','消耗品費');
  master('subaccounts','101','振込手数料');
  for(let m=-5;m<=0;m++) {
    // On the first nine days, the current month's closing has not occurred yet.
    if(m===0 && Number(current.slice(8))<10) continue;
    for(let c=0;c<3;c++) {
      run('shipment.save',{date:day(m,5),customerId:customers[c],itemId:items[c],site:['北地区道路改良','河川護岸工事','工業団地造成'][c],quantity:80+(m+5)*17+c*23,price:[3200,4800,2600][c]});
    }
    run('billing.create',{month:day(m,1).slice(0,7),closing:10,customerIds:customers});
    const invoices=state.invoices.slice(-3);
    for(let c=0;c<3;c++) {
      const inv=invoices[c];
      if(m===0 && c===2) continue;
      run('invoice.issue',{ids:[inv.id]});
      if(m===0 && c===1) continue;
      const value=m===0?Math.floor(inv.total/2):inv.total;
      run('receipt.create',{date:day(m,10),customerId:inv.customerId,bank:value,allocations:[{invoiceId:inv.id,amount:value}]});
    }
  }
  for(let n=0;n<3;n++)run('shipment.save',{date:current,customerId:pending,itemId:items[n],site:'駅前整備工事（デモ）',quantity:25+n*12.5,price:[3200,4800,2600][n]});
  for(let n=0;n<2;n++) {
    run('purchase.create',{date:current,vendorId:vendors[n],itemId:items[n],quantity:120+n*40,price:1800+n*300,memo:'サンプル仕入'});
    const bill=run('payable.create',{date:current,vendorId:vendors[n],account:'8230',taxCode:'10%',amount:250000+n*110000,memo:'材料仕入（デモ）'});
    if(!n)run('payment.create',{date:current,payableId:bill,amount:100000});
  }
  run('cash.create',{date:current,account:'8310',taxCode:'10%',amount:4400,memo:'事務用品（デモ）'});
  items.forEach((itemId,n)=>run('inventory.save',{month:day(-1,1).slice(0,7),itemId,quantity:200+n*40,price:1800+n*300}));
  return {version:1,revision:1,state};
}

function read() {
  const raw=localStorage.getItem(storageKey);
  if(!raw){const data=seed();localStorage.setItem(storageKey,JSON.stringify(data));return data;}
  let data;try{data=JSON.parse(raw)}catch{throw Error('保存データを読めません。データ初期化ボタンでサンプルを復元できます。')}
  if(data.version!==1 || !data.state || !Array.isArray(data.state.invoices))throw Error('保存形式が異なります。データ初期化でサンプルを復元してください。');
  return data;
}
async function locked(fn) {
  if(navigator.locks)return navigator.locks.request(storageKey,fn);
  return fn(); // Synchronous localStorage read/write within one event-loop turn.
}
export async function resetDemo(revision){
  if((await runtime()).storage==='mysql')return api('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})});
  return locked(()=>{const data=seed();localStorage.setItem(storageKey,JSON.stringify(data));return data;});
}
export async function demoRequest(url,options) {
  if((await runtime()).storage==='mysql')return api(url,options);
  if(url==='/api/session')return {user:'デモ利用者',canWrite:true,header:'X-Demo',csrf:'local-only',storage:'local'};
  if(url==='/requirements.json'){const r=await fetch('./requirements.json');if(!r.ok)throw Error('確認事項を読み込めません');return r.json();}
  if(url==='/api/audit')return read().state.audit.slice(-200).reverse().map(r=>({revision:r.id,created_at:r.at,actor:r.actor,action:r.action}));
  if(url==='/api/workspace' && options?.method==='POST')return locked(()=>{
    const data=read(),command=JSON.parse(options.body);
    if(command.revision!==data.revision)throw Error('別タブで更新されました。右上の再読込後にやり直してください。');
    const result=dispatch(data.state,command,'デモ利用者');
    const next={version:1,revision:data.revision+1,state:result.state};
    localStorage.setItem(storageKey,JSON.stringify(next));
    return {...next,result:result.result};
  });
  if(url==='/api/workspace')return read();
  throw Error('対応していないデモ操作です');
}
export function downloadCsv(kind,state) {
  const records=kind==='journals'?state.journals.flatMap(j=>j.lines.map(l=>({id:j.id,date:j.date,pattern:j.pattern,source:j.source,...l}))):state[kind];
  if(!Array.isArray(records))throw Error('出力対象がありません');
  const keys=[...new Set(records.flatMap(r=>Object.keys(r)))];
  const rows=[keys,...records.map(r=>keys.map(k=>typeof r[k]==='object'?JSON.stringify(r[k]):r[k]))];
  const url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`demo-${kind}-${localDate()}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
