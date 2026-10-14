import { check, Conflict, yen, qty, lineAmount, isoDate, isoMonth, text, dueDate } from './domain.mjs';
import { rows, one, nextNo, assertOpen, audit, postJournal, reverseJournal, line } from './db.mjs';

export const TAX_CODES = ['10%', '8%', '非課税', '対象外'];
const monthWhere = (col, q, w, args) => { if (q.month) { isoMonth(q.month); w.push(`DATE_FORMAT(${col},'%Y-%m')=?`); args.push(q.month); } };
async function vendorOf(c, code) { const v = await one(c, 'SELECT * FROM vendor WHERE vendor_code=?', [String(code || '')]); check(v && v.active, '有効な業者を選択してください'); return v; }

// ---------- 商品仕入 (purchase) ----------
export async function listPurchases(c, q = {}) {
  const w = [], args = []; monthWhere('p.purchase_date', q, w, args);
  if (q.vendor) { w.push('v.vendor_code=?'); args.push(q.vendor); }
  const rs = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, i.item_nam, i.unit FROM purchase p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN item_m i ON i.item_cd=p.item_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.purchase_date DESC, p.purchase_id DESC LIMIT 1000`, args);
  return rs.map(r => ({ id: r.purchase_id, no: r.source_document_no, date: r.purchase_date, vendor: r.vendor_code, vendorName: r.vendor_name, item: r.item_cd, itemName: r.item_nam, unit: r.unit,
    quantity: Number(r.quantity), price: Number(r.unit_price), net: Number(r.net_amount), taxCode: r.source_tax_code, memo: r.memo }));
}
export async function createPurchase(c, ctx, p) {
  const date = isoDate(p.date, '仕入日'); await assertOpen(c, date);
  const v = await vendorOf(c, p.vendor), it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(p.item || '')]);
  check(it && it.delete_f !== '1', '有効な商品を選択してください');
  const q = qty(p.quantity, '数量', { max: 9999999 }), price = yen(p.price, '単価', { max: 99999999 }), net = lineAmount(q, price);
  const tax = String(p.taxCode || '10%'); check(TAX_CODES.includes(tax), '税区分が不正です');
  const no = await nextNo(c, 'purchase');
  const [r] = await c.query('INSERT INTO purchase (source_document_no,line_no,vendor_id,purchase_date,item_cd,quantity,unit_price,net_amount,source_tax_code,memo) VALUES (?,1,?,?,?,?,?,?,?,?)',
    [no, v.vendor_id, date, it.item_cd, q.text, price, net, tax, text(p.memo, '摘要', 500, { required: false })]);
  await audit(c, ctx, 'purchase', r.insertId, 'purchase.create', { no, vendor: v.vendor_code, item: it.item_cd, net });
  return { id: r.insertId, no };
}
export async function deletePurchase(c, ctx, { id }) {
  const r = await one(c, 'SELECT * FROM purchase WHERE purchase_id=? FOR UPDATE', [Number(id)]); if (!r) throw new Conflict('仕入が見つかりません');
  await assertOpen(c, r.purchase_date);
  await c.query('DELETE FROM purchase WHERE purchase_id=?', [r.purchase_id]);
  await audit(c, ctx, 'purchase', r.purchase_id, 'purchase.delete', { no: r.source_document_no, net: Number(r.net_amount) });
  return { id: r.purchase_id };
}

// ---------- 在庫計上 (inventory_count, monthly valuation, journal C01) ----------
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
export async function listInventory(c, q = {}) {
  const w = [], args = [];
  if (q.month) { isoMonth(q.month); w.push('n.period_start=?'); args.push(q.month + '-01'); }
  const rs = await rows(c, `SELECT n.*, i.item_nam, i.unit FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.period_start DESC, n.item_cd LIMIT 1000`, args);
  return rs.map(r => ({ id: r.inventory_id, month: r.period_start.slice(0, 7), item: r.item_cd, itemName: r.item_nam, unit: r.unit, location: r.location_code, countedOn: r.counted_on, quantity: Number(r.quantity), price: Number(r.valuation_price), value: Number(r.valuation_amount), status: r.status }));
}
export async function saveInventory(c, ctx, p) {
  const month = isoMonth(p.month, '計上月'), end = monthEnd(month); await assertOpen(c, end);
  const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(p.item || '')]); check(it, '商品を選択してください');
  const q = qty(p.quantity, '月末在庫数量', { max: 99999999, positive: false }), price = yen(p.price, '評価単価', { max: 99999999 }), value = lineAmount(q, price);
  check(!(await one(c, "SELECT 1 x FROM inventory_count WHERE item_cd=? AND location_code='MAIN' AND period_start>? LIMIT 1", [it.item_cd, month + '-01'])), '後の月の在庫が登録済みです');
  const prior = await one(c, "SELECT valuation_amount FROM inventory_count WHERE item_cd=? AND location_code='MAIN' AND period_start<? AND status='POSTED' ORDER BY period_start DESC LIMIT 1", [it.item_cd, month + '-01']);
  const previous = Number(prior?.valuation_amount || 0);
  const [r] = await c.query("INSERT INTO inventory_count (period_start,location_code,item_cd,counted_on,quantity,valuation_price,valuation_amount,status) VALUES (?,'MAIN',?,?,?,?,?,'POSTED')", [month + '-01', it.item_cd, end, q.text, price, value]);
  if (value || previous) await postJournal(c, { date: end, pattern: 'C01', sourceType: 'inventory_count', sourceId: r.insertId, lines: [
    line('D', '82316', previous, { dept: '063' }), line('C', '1360', previous), line('D', '1360', value), line('C', '82316', value, { dept: '063' })] });
  await audit(c, ctx, 'inventory_count', r.insertId, 'inventory.create', { month, item: it.item_cd, value, previous });
  return { id: r.insertId, value, previous };
}
export async function deleteInventory(c, ctx, { id }) {
  const r = await one(c, 'SELECT * FROM inventory_count WHERE inventory_id=? FOR UPDATE', [Number(id)]); if (!r) throw new Conflict('在庫が見つかりません');
  await assertOpen(c, r.counted_on);
  check(!(await one(c, 'SELECT 1 x FROM inventory_count WHERE item_cd=? AND location_code=? AND period_start>? LIMIT 1', [r.item_cd, r.location_code, r.period_start])), '後の月の在庫を先に取消してください');
  await reverseJournal(c, { sourceType: 'inventory_count', sourceId: r.inventory_id, date: r.counted_on });
  await c.query('DELETE FROM inventory_count WHERE inventory_id=?', [r.inventory_id]);
  await audit(c, ctx, 'inventory_count', r.inventory_id, 'inventory.delete', { month: r.period_start.slice(0, 7), item: r.item_cd });
  return { id: r.inventory_id };
}

// ---------- 定時請求 / 小口現金 (expense_document + expense_line, journal D01/E01) ----------
const PAID = "COALESCE((SELECT SUM(a.amount) FROM payment_allocation a JOIN payment p ON p.payment_id=a.payment_id AND p.status='POSTED' WHERE a.expense_id=d.expense_id),0)";
export async function listExpenses(c, q = {}) {
  const w = [], args = [];
  if (q.kind) { check(['PAYABLE', 'PETTY_CASH'].includes(q.kind), '区分が不正です'); w.push('d.expense_kind=?'); args.push(q.kind); }
  monthWhere('d.booked_on', q, w, args);
  if (q.vendor) { w.push('v.vendor_code=?'); args.push(q.vendor); }
  if (q.open) w.push(`d.status='POSTED' AND d.gross_amount>${PAID}`);
  const rs = await rows(c, `SELECT d.*, v.vendor_code, v.vendor_name, l.account_code, l.sub_code, l.department_code, l.source_tax_code, a.account_name, ${PAID} paid
    FROM expense_document d LEFT JOIN vendor v ON v.vendor_id=d.vendor_id LEFT JOIN expense_line l ON l.expense_id=d.expense_id AND l.line_no=1 LEFT JOIN account_subject a ON a.account_code=l.account_code
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY d.booked_on DESC, d.expense_id DESC LIMIT 1000`, args);
  return rs.map(r => ({ id: r.expense_id, no: r.document_no, kind: r.expense_kind, date: r.booked_on, due: r.due_on || '', vendor: r.vendor_code || '', vendorName: r.vendor_name || '', account: r.account_code, accountName: r.account_name, sub: r.sub_code || '',
    dept: r.department_code, taxCode: r.source_tax_code, amount: Number(r.gross_amount), paid: Number(r.paid), balance: r.status === 'POSTED' ? Number(r.gross_amount) - Number(r.paid) : 0, memo: r.memo, status: r.status }));
}
export async function createExpense(c, ctx, p) {
  const kind = String(p.kind); check(['PAYABLE', 'PETTY_CASH'].includes(kind), '区分が不正です');
  const date = isoDate(p.date, '計上日'); await assertOpen(c, date);
  const v = kind === 'PAYABLE' ? await vendorOf(c, p.vendor) : null;
  const due = kind === 'PAYABLE' ? (p.due ? isoDate(p.due, '支払予定日') : dueDate(date)) : null;
  const acc = await one(c, 'SELECT * FROM account_subject WHERE account_code=?', [String(p.account || '')]); check(acc?.active, '有効な勘定科目を選択してください');
  const sub = String(p.sub || '') || null;
  if (sub) check(await one(c, 'SELECT 1 x FROM account_subsubject WHERE account_code=? AND sub_code=? AND active', [acc.account_code, sub]), '内訳科目が上位科目に登録されていません');
  const amount = yen(p.amount, '金額'); check(amount > 0, '金額を入力してください');
  const tax = String(p.taxCode || '10%'); check(TAX_CODES.includes(tax), '税区分が不正です');
  const dept = text(p.dept || '063', '部門', 20), memo = text(p.memo, '摘要', 500), no = await nextNo(c, 'expense');
  const [r] = await c.query("INSERT INTO expense_document (document_no,expense_kind,vendor_id,booked_on,due_on,gross_amount,memo,status) VALUES (?,?,?,?,?,?,?,'POSTED')", [no, kind, v?.vendor_id || null, date, due, amount, memo]);
  await c.query('INSERT INTO expense_line (expense_id,line_no,account_code,sub_code,department_code,source_tax_code,net_amount,tax_amount,gross_amount,memo) VALUES (?,1,?,?,?,?,NULL,NULL,?,?)', [r.insertId, acc.account_code, sub, dept, tax, amount, memo]);
  await postJournal(c, { date, pattern: kind === 'PAYABLE' ? 'D01' : 'E01', sourceType: 'expense_document', sourceId: r.insertId, lines: [
    line('D', acc.account_code, amount, { sub, dept, tax }), kind === 'PAYABLE' ? line('C', '4121', amount, { vendor: v.vendor_id }) : line('C', '1111', amount)] });
  await audit(c, ctx, 'expense_document', r.insertId, kind === 'PAYABLE' ? 'payable.create' : 'pettycash.create', { no, vendor: v?.vendor_code, account: acc.account_code, amount });
  return { id: r.insertId, no };
}
export async function reverseExpense(c, ctx, { id }) {
  const d = await one(c, 'SELECT * FROM expense_document WHERE expense_id=? FOR UPDATE', [Number(id)]); check(d, '伝票が見つかりません');
  check(d.status === 'POSTED', '取消済みです'); await assertOpen(c, d.booked_on);
  check(!(await one(c, "SELECT 1 x FROM payment_allocation a JOIN payment p ON p.payment_id=a.payment_id AND p.status='POSTED' WHERE a.expense_id=? LIMIT 1", [d.expense_id])), '支払済みの伝票は取消できません（先に支払を取消してください）');
  await c.query("UPDATE expense_document SET status='REVERSED', row_version=row_version+1 WHERE expense_id=?", [d.expense_id]);
  await reverseJournal(c, { sourceType: 'expense_document', sourceId: d.expense_id, date: d.booked_on });
  await audit(c, ctx, 'expense_document', d.expense_id, 'expense.reverse', { no: d.document_no });
  return { id: d.expense_id };
}

// ---------- 支払 (payment + payment_allocation, journal F01) ----------
const PAY_BANK = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
export async function listPayments(c, q = {}) {
  const w = [], args = []; monthWhere('p.paid_on', q, w, args);
  const rs = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, b.holder_name, ${PAY_BANK} from_bank
    FROM payment p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN bank_account b ON b.bank_account_id=p.bank_account_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.paid_on DESC, p.payment_id DESC LIMIT 1000`, args);
  const al = rs.length ? await rows(c, `SELECT a.*, d.document_no FROM payment_allocation a JOIN expense_document d ON d.expense_id=a.expense_id WHERE a.payment_id IN (${rs.map(() => '?').join(',')})`, rs.map(r => r.payment_id)) : [];
  return rs.map(r => ({ id: r.payment_id, no: r.payment_no, date: r.paid_on, vendor: r.vendor_code, vendorName: r.vendor_name, amount: Number(r.bank_amount), fromBank: r.from_bank || '', status: r.status,
    payee: r.bank_code ? { bank: r.bank_code, branch: r.branch_code, type: r.account_type_code, account: r.account_number, holder: r.holder_name } : null,
    allocations: al.filter(a => a.payment_id === r.payment_id).map(a => ({ expenseId: a.expense_id, no: a.document_no, amount: Number(a.amount) })) }));
}
export async function createPayment(c, ctx, p) {
  const idem = text(p.idempotencyKey, '処理キー', 100);
  const dup = await one(c, 'SELECT payment_id, payment_no FROM payment WHERE idempotency_key=?', [idem]);
  if (dup) return { id: dup.payment_id, no: dup.payment_no, duplicate: true };
  const date = isoDate(p.date, '支払日'); await assertOpen(c, date);
  const v = await vendorOf(c, p.vendor);
  check(!Number(p.fee || 0) && !Number(p.offset || 0), '振込手数料・相殺の処理ルールは確認待ちです (Q03)');
  const bankCode = String(p.bankCode || ''); const b = await one(c, "SELECT category1 FROM code_m WHERE code_key='BANK' AND code_dtl=?", [bankCode]); check(b && b.category1 !== '0', '支払元口座（銀行）を選択してください');
  check(Array.isArray(p.allocations) && p.allocations.length, '支払対象の伝票を選択してください');
  const allocs = p.allocations.map(a => ({ id: Number(a.expenseId), amount: yen(a.amount, '支払額') })).filter(a => a.amount > 0).sort((a, b) => a.id - b.id);
  check(allocs.length && new Set(allocs.map(a => a.id)).size === allocs.length, '支払対象が不正です');
  for (const a of allocs) {
    const d = await one(c, 'SELECT d.* FROM expense_document d WHERE d.expense_id=? FOR UPDATE', [a.id]);
    if (d) d.paid = (await one(c, `SELECT ${PAID} paid FROM expense_document d WHERE d.expense_id=?`, [a.id])).paid;
    check(d && d.expense_kind === 'PAYABLE' && d.status === 'POSTED', '支払対象の定時請求が見つかりません');
    check(d.vendor_id === v.vendor_id, '異なる業者の伝票は同時に支払えません'); check(date >= d.booked_on, '支払日が計上日より前です');
    check(a.amount <= Number(d.gross_amount) - Number(d.paid), `伝票${d.document_no}の未払残高を超えています`);
  }
  const total = allocs.reduce((n, a) => n + a.amount, 0), no = await nextNo(c, 'payment');
  const [r] = await c.query("INSERT INTO payment (payment_no,vendor_id,paid_on,bank_account_id,bank_amount,fee_amount,offset_amount,status,idempotency_key) VALUES (?,?,?,?,?,0,0,'POSTED',?)", [no, v.vendor_id, date, v.bank_account_id, total, idem]);
  for (const a of allocs) await c.query('INSERT INTO payment_allocation (payment_id,expense_id,amount) VALUES (?,?,?)', [r.insertId, a.id, a.amount]);
  await postJournal(c, { date, pattern: 'F01', sourceType: 'payment', sourceId: r.insertId, lines: [line('D', '4121', total, { vendor: v.vendor_id }), line('C', '1112', total, { sub: bankCode })] });
  await audit(c, ctx, 'payment', r.insertId, 'payment.create', { no, vendor: v.vendor_code, amount: total, documents: allocs.map(a => a.id) });
  return { id: r.insertId, no };
}
export async function reversePayment(c, ctx, { id }) {
  const p = await one(c, 'SELECT * FROM payment WHERE payment_id=? FOR UPDATE', [Number(id)]); check(p, '支払が見つかりません');
  check(p.status === 'POSTED', '取消済みです'); await assertOpen(c, p.paid_on);
  await c.query("UPDATE payment SET status='REVERSED' WHERE payment_id=?", [p.payment_id]);
  await reverseJournal(c, { sourceType: 'payment', sourceId: p.payment_id, date: p.paid_on });
  await audit(c, ctx, 'payment', p.payment_id, 'payment.reverse', { no: p.payment_no });
  return { id: p.payment_id };
}
