import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seed} from './demo-store.mjs';
import {dispatch,amount,csv} from './domain.mjs';

test('sample journals balance and contain only fictional customers',()=>{
 const {state:s}=seed();
 assert.ok(s.customers.every(c=>c.name.includes('架空')));
 for(const j of s.journals)assert.equal(j.lines.filter(l=>l.side==='D').reduce((n,l)=>n+l.amount,0),j.lines.filter(l=>l.side==='C').reduce((n,l)=>n+l.amount,0));
 assert.equal(amount('2.5','1000'),2500);
 assert.equal(amount('0.29','100'),29);
});
test('overpayment fails atomically',()=>{
 const {state:s}=seed(),before=structuredClone(s),i=s.invoices.find(i=>i.issued);
 assert.throws(()=>dispatch(s,{action:'receipt.create',payload:{date:i.end,customerId:i.customerId,bank:i.total+1,allocations:[{invoiceId:i.id,amount:i.total+1}]}}));
 assert.deepEqual(s,before);
});
test('invoice names survive later master changes and string false deactivates',()=>{
 const {state:s}=seed(),i=s.invoices[0],c=s.customers.find(c=>c.id===i.customerId);
 const {state:next}=dispatch(s,{action:'master.save',payload:{...c,kind:'customers',name:'変更後（架空）',active:'false'}});
 assert.equal(next.customers.find(x=>x.id===c.id).active,false);
 assert.equal(next.invoices[0].customerName,c.name);
});
test('inventory and payment update amounts with balanced journals',()=>{
 let {state:s}=seed();const inv=s.inventory[0],date=new Date(inv.month+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);
 s=dispatch(s,{action:'inventory.save',payload:{month:date.toISOString().slice(0,7),itemId:inv.itemId,quantity:'15.5',price:2000}}).state;
 assert.equal(s.inventory.at(-1).value,31000);assert.equal(s.inventory.at(-1).previous,inv.value);
 const bill=s.payables[1];s=dispatch(s,{action:'payment.create',payload:{date:bill.date,payableId:bill.id,amount:1000}}).state;
 assert.equal(s.payables[1].paid,1000);
});
test('CSV quotes embedded newlines and neutralizes spreadsheet formulas',()=>{
 assert.equal(csv([['=1+1','a"b','line\nbreak']]),'\ufeff"\'=1+1","a""b","line\nbreak"');
});
