import {DomainError} from '../domain.mjs';
export const kinds=['customers','accounts','items','banks','vendors','subaccounts','sites'];
const fail=m=>{throw new DomainError(m)};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const key=r=>JSON.stringify(r);
const del=r=>r.active?'0':'1';
const active=r=>r.delete_f!=='1';
const quote=k=>'`'+k+'`';
const configs={
 customers:{table:'client_m',keys:['customers_cd'],select:'SELECT * FROM client_m',
  encode:r=>({customers_cd:r.code,customers_name:r.name,deadline:String(r.closing),delete_f:del(r)}),
  defaults:{customers_kana:'',customers_abr:'',customers_sec:'',postcode:'',tel_no:'',fax_no:'',pref:'',addr1:'',addr2:'',customers_pic:'',pic:'',remarks:'',card_member_id:''},
  decode:r=>({code:r.customers_cd,name:r.customers_name,closing:Number(r.deadline),active:active(r)}),extras:r=>({opening:r.opening??0})},
 accounts:{table:'account_subject',keys:['account_code'],select:'SELECT * FROM account_subject',encode:r=>({account_code:r.code,account_name:r.name,active:r.active}),decode:r=>({code:r.account_code,name:r.account_name,active:!!r.active})},
 items:{table:'item_m',keys:['item_cd'],select:'SELECT * FROM item_m',
  encode:r=>({item_cd:r.code,item_nam:r.name,unit:r.unit,tanka:r.price,delete_f:del(r)}),
  defaults:{item_abr:'',item_kana:'',item_bunrui_cd:'',freight:0,base_temp:0,vary_temp:0,credit_discount_rate:0,item_product_kb:''},
  decode:r=>({code:r.item_cd,name:r.item_nam,unit:r.unit,price:Number(r.tanka),active:active(r)}),extras:r=>({taxRate:r.taxRate??10})},
 banks:{table:'code_m',keys:['code_key','code_dtl'],select:"SELECT * FROM code_m WHERE code_key='BANK'",
  encode:r=>({code_key:'BANK',code_key_nam:'銀行内訳',code_dtl:r.code,code_dtl_nam:r.name,category1:r.active?'1':'0'}),defaults:{code_dtl_abr:'',category2:'',category3:''},
  decode:r=>({code:r.code_dtl,name:r.code_dtl_nam,active:r.category1!=='0'})},
 vendors:{table:'vendor',keys:['vendor_code'],select:'SELECT v.*, b.bank_code, b.branch_code, b.account_number, b.holder_name, b.account_type_code FROM vendor v LEFT JOIN bank_account b ON b.bank_account_id=v.bank_account_id',
  encode:r=>({vendor_code:r.code,vendor_name:r.name,active:r.active}),
  decode:r=>({code:r.vendor_code,name:r.vendor_name,active:!!r.active,bank:r.bank_code||'',branch:r.branch_code||'',account:r.account_number||'',kana:r.holder_name||'',accountType:r.account_type_code||'1'})},
 subaccounts:{table:'account_subsubject',keys:['account_code','sub_code'],select:'SELECT * FROM account_subsubject',
  encode:r=>({account_code:r.accountCode,sub_code:r.code,sub_name:r.name,active:r.active}),decode:r=>({code:r.sub_code,name:r.sub_name,accountCode:r.account_code,active:!!r.active})},
 sites:{table:'field_name_m',keys:['customers_cd','field_cd','field_suffix'],select:'SELECT * FROM field_name_m',
  encode:(r,s)=>({customers_cd:s.customers.find(c=>c.id===r.customerId)?.code,field_cd:r.code,field_suffix:r.suffix,field_name1:r.name,field_name2:r.name2||'',delete_f:del(r)}),
  decode:(r,s)=>({code:r.field_cd,suffix:r.field_suffix,name:r.field_name1,name2:r.field_name2,customerId:s.customers.find(c=>c.code===r.customers_cd)?.id,active:active(r)})}
};
export async function ensureMasterLinks(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS preview_master_link (
  kind VARCHAR(20) NOT NULL, record_id VARCHAR(180) NOT NULL,
  db_key VARCHAR(255) NOT NULL, extras JSON NOT NULL,
  PRIMARY KEY(kind,record_id), UNIQUE KEY uq_master_key(kind,db_key)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`);
}
export async function hydrate(c,state){
 const [links]=await c.query('SELECT kind,record_id,db_key,extras FROM preview_master_link');
 for(const kind of kinds){
  const cfg=configs[kind], [rows]=await c.query(cfg.select);
  state[kind]=rows.map(row=>{
   const dbKey=key(cfg.keys.map(k=>String(row[k]))),link=links.find(l=>l.kind===kind&&l.db_key===dbKey);
   const defaults=kind==='customers'?{opening:0}:kind==='items'?{taxRate:10}:{};
   return {...defaults,...(link?parse(link.extras):{}),...cfg.decode(row,state),id:link?.record_id||'db_'+kind+'_'+Buffer.from(dbKey).toString('base64url')};
  });
 }
 return state;
}
function validate(kind,r,s){
 const limits={customers:[5,42],items:[5,22],banks:[12,40],vendors:[20,200],accounts:[20,100],subaccounts:[20,100],sites:[7,40]}[kind];
 if([...r.code].length>limits[0]||[...r.name].length>limits[1])fail(`コードは${limits[0]}文字、名称は${limits[1]}文字以内です`);
 if(kind==='items'&&([...r.unit].length>2||r.price>9999999))fail('単位は2文字、単価は9,999,999円以内です');
 if(kind==='subaccounts'&&!s.accounts.some(a=>a.code===r.accountCode&&a.active))fail('有効な上位勘定科目を選択してください');
 if(kind==='sites'&&(!s.customers.some(a=>a.id===r.customerId&&a.active)||!r.suffix||r.suffix.length>3||(r.name2||'').length>20))fail('現場の得意先・枝番(3文字以内)・名称2(20文字以内)を確認してください');
 if(kind==='vendors'&&[r.bank,r.branch,r.account,r.kana].some(Boolean)){
   if(!/^\d{4}$/.test(r.bank)||!/^\d{3}$/.test(r.branch)||!/^\d{1,16}$/.test(r.account)||!r.kana||r.kana.length>200||!['1','2','4'].includes(r.accountType))fail('銀行4桁・支店3桁・口座番号・受取人・口座種別をすべて入力してください');
 }
}
async function save(c,kind,r,s,old){
 validate(kind,r,s);const cfg=configs[kind],fields=cfg.encode(r,s);
 const dbKey=key(cfg.keys.map(k=>String(fields[k])));
 if(old){const prev=cfg.encode(old,s);if(key(cfg.keys.map(k=>String(prev[k])))!==dbKey)fail('登録済みのコード・所属は変更できません。新規登録して旧マスタを無効化してください');}
 if(kind==='vendors'){
  fields.bank_account_id=null;
  if(r.bank){
   const [found]=await c.execute('SELECT bank_account_id,holder_name FROM bank_account WHERE bank_code=? AND branch_code=? AND account_type_code=? AND account_number=?',[r.bank,r.branch,r.accountType,r.account]);
   if(found.length){if(found[0].holder_name!==r.kana)fail('同じ口座の受取人が一致しません');fields.bank_account_id=found[0].bank_account_id;}
   else {const [insert]=await c.execute('INSERT INTO bank_account (bank_code,branch_code,account_type_code,account_number,holder_name) VALUES (?,?,?,?,?)',[r.bank,r.branch,r.accountType,r.account,r.kana]);fields.bank_account_id=insert.insertId;}
  }
 }
 if(old){
  const columns=Object.keys(fields).filter(k=>!cfg.keys.includes(k));
  await c.execute(`UPDATE ${quote(cfg.table)} SET ${columns.map(k=>quote(k)+'=?').join(',')} WHERE ${cfg.keys.map(k=>quote(k)+'=?').join(' AND ')}`,[...columns.map(k=>fields[k]),...cfg.keys.map(k=>fields[k])]);
 }else{
  const values={...cfg.defaults,...fields},cols=Object.keys(values);
  await c.execute(`INSERT INTO ${quote(cfg.table)} (${cols.map(quote).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,cols.map(k=>values[k]));
 }
 await c.execute('INSERT INTO preview_master_link (kind,record_id,db_key,extras) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE extras=VALUES(extras)',[kind,r.id,dbKey,JSON.stringify(cfg.extras?.(r)||{})]);
}
export async function persistMasters(c,before,next){
 for(const kind of kinds)for(const r of next[kind]||[]){const old=(before[kind]||[]).find(x=>x.id===r.id);if(!old||JSON.stringify(old)!==JSON.stringify(r))await save(c,kind,r,next,old);}
}
export function withoutMasters(state){const s=structuredClone(state);for(const k of kinds)delete s[k];s.masterStorage='tables-v1';return s;}
export async function migrateMasters(c,state){
 if(state.masterStorage==='tables-v1')return;
 for(const kind of kinds){const [rows]=await c.query(configs[kind].select);if(rows.length)fail('既存マスタの照合が必要です。自動上書きは行いません: '+kind);}
 state.sites??=[];
 // Only the shipped demo fee code has a documented unambiguous parent.
 for(const r of state.subaccounts||[])if(!r.accountCode){if(r.code==='101'&&r.name==='振込手数料'&&state.accounts.some(a=>a.code==='8330'))r.accountCode='8330';else fail('内訳科目の上位科目が未設定です: '+r.code);}
 for(const r of state.vendors||[])r.accountType??='1';
 await persistMasters(c,{},state);
}
