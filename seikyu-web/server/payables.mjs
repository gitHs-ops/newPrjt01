import { check, Conflict, yen, qty, lineAmount, isoDate, isoMonth, text, dueDate } from './domain.mjs';
import { rows, one, nextNo, assertOpen, audit, postJournal, reverseJournal, line } from './db.mjs';
import { mustDecode, taxOf, CATALOG } from './taxcode.mjs';

const monthWhere = (col, q, w, args) => { if (q.month) { isoMonth(q.month); w.push(`to_char(${col},'YYYY-MM')=?`); args.push(q.month); } };
async function vendorOf(c, code) { const v = await one(c, 'SELECT * FROM vendor WHERE vendor_code=?', [String(code || '')]); check(v && v.active, '有効な業者を選択してください'); return v; }

// ---------- 商品仕入 (purchase) ----------
// 10/19 打合せ・帳票⑭（HAR011）：1伝票＝複数明細。区分 1=仕入（直接購入）/ 2=他社納入。運賃行は商品コード＋金額のみ（マイナス可）。
// 単価・単位は商品マスタから表示。処税率は現行の 241（1桁目 2 の意味は確認待ち Q01）を既定とする。
export const PURCHASE_KINDS = { 1: '仕入', 2: '他社納入' };
export const TAX_CODES = CATALOG.map(t => ({ code: t.code, name: t.name }));
export async function listPurchases(c, q = {}) {
  const w = [], args = []; monthWhere('p.purchase_date', q, w, args);
  if (q.from) { w.push('p.purchase_date>=?'); args.push(isoDate(q.from, '開始日')); }
  if (q.to) { w.push('p.purchase_date<=?'); args.push(isoDate(q.to, '終了日')); }
  if (q.vendor) { w.push('v.vendor_code=?'); args.push(q.vendor); }
  const rs = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, i.item_nam, unit_name(i.unit) unit FROM purchase p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN item_m i ON i.item_cd=p.item_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.purchase_date DESC, p.source_document_no DESC, p.line_no LIMIT 3000`, args);
  return rs.map(r => ({ id: r.purchase_id, no: r.source_document_no, line: Number(r.line_no), date: r.purchase_date, vendor: r.vendor_code, vendorName: r.vendor_name, kind: r.purchase_kb || '1', kindName: PURCHASE_KINDS[r.purchase_kb || '1'],
    lineKind: r.line_kind || '1', item: r.item_cd, itemName: r.item_nam, unit: r.unit, quantity: Number(r.quantity), price: Number(r.unit_price), net: Number(r.net_amount), taxCode: r.source_tax_code, memo: r.memo }));
}
export async function createPurchase(c, ctx, p) {
  const date = isoDate(p.date, '仕入日'); await assertOpen(c, date);
  const v = await vendorOf(c, p.vendor), kind = String(p.kind || '1'); check(PURCHASE_KINDS[kind], '区分が不正です');
  const input = Array.isArray(p.lines) ? p.lines : [p];
  const out = [];
  for (const [i, l] of input.entries()) {
    const label = `${i + 1}行目`, freight = String(l.lineKind || '1') === '2';
    if (!l.item && !l.quantity && !l.amount && !l.price) continue;
    const it = await one(c, 'SELECT * FROM item_m WHERE item_cd=?', [String(l.item || '')]); check(it && it.delete_f !== '1', `${label}: 有効な商品を選択してください`);
    const tax = mustDecode(l.taxCode || '241', `${label}の処税率`).code;
    if (freight) {
      const amount = yen(l.amount, `${label}の運賃`, { negative: true }); check(amount !== 0, `${label}: 運賃を入力してください`);
      out.push({ item: it.item_cd, qty: '0.00', price: 0, net: amount, tax, lineKind: '2', memo: text(l.memo, `${label}の摘要`, 500, { required: false }) || '運賃' });
    } else {
      const q = qty(l.quantity, `${label}の数量`, { max: 9999999, positive: false, allowNegative: true });
      const price = l.price === '' || l.price === undefined ? Number(it.tanka) : yen(l.price, `${label}の単価`, { max: 99999999 });
      out.push({ item: it.item_cd, qty: q.text, price, net: lineAmount(q, price), tax, lineKind: '1', memo: text(l.memo, `${label}の摘要`, 500, { required: false }) });
    }
  }
  check(out.length, '明細を入力してください'); check(out.length <= 99, '明細は99行以内です');
  const no = await nextNo(c, 'purchase'), memo = text(p.memo, '摘要', 500, { required: false });
  for (const [i, l] of out.entries())
    await c.query('INSERT INTO purchase (source_document_no,line_no,vendor_id,purchase_date,item_cd,quantity,unit_price,net_amount,source_tax_code,memo,purchase_kb,line_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [no, i + 1, v.vendor_id, date, l.item, l.qty, l.price, l.net, l.tax, l.memo || memo, kind, l.lineKind]);
  const total = out.reduce((n, l) => n + l.net, 0);
  await audit(c, ctx, 'purchase', no, 'purchase.create', { no, vendor: v.vendor_code, kind, lines: out.length, net: total });
  return { no, lines: out.length, net: total };
}
// 伝票単位で取消（明細のどれを指定しても伝票全体）
export async function deletePurchase(c, ctx, { id }) {
  const r = await one(c, 'SELECT * FROM purchase WHERE purchase_id=? FOR UPDATE', [Number(id)]); if (!r) throw new Conflict('仕入が見つかりません');
  await assertOpen(c, r.purchase_date);
  const [d] = await c.query('DELETE FROM purchase WHERE source_document_no=?', [r.source_document_no]);
  await audit(c, ctx, 'purchase', r.source_document_no, 'purchase.delete', { no: r.source_document_no, lines: d.affectedRows });
  return { no: r.source_document_no, lines: d.affectedRows };
}

// ---------- 在庫計上 (inventory_count, monthly valuation, journal C01) ----------
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
export async function listInventory(c, q = {}) {
  const w = [], args = [];
  if (q.month) { isoMonth(q.month); w.push('n.period_start=?'); args.push(q.month + '-01'); }
  const rs = await rows(c, `SELECT n.*, i.item_nam, unit_name(i.unit) unit FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.period_start DESC, n.item_cd LIMIT 1000`, args);
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
    line('D', '82316', previous, { dept: '063', tax: '9' }), line('C', '1360', previous, { tax: '9' }), line('D', '1360', value, { tax: '9' }), line('C', '82316', value, { dept: '063', tax: '9' })] });
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
  const rs = await rows(c, `SELECT d.*, v.vendor_code, v.vendor_name, l.account_code, l.sub_code, l.department_code, l.source_tax_code, l.memo line_memo, a.account_name, ${PAID} paid
    FROM expense_document d LEFT JOIN vendor v ON v.vendor_id=d.vendor_id LEFT JOIN expense_line l ON l.expense_id=d.expense_id AND l.line_no=1 LEFT JOIN account_subject a ON a.account_code=l.account_code
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY d.booked_on DESC, d.expense_id DESC LIMIT 1000`, args);
  const ls = rs.length ? await rows(c, `SELECT l.*, a.account_name, s.sub_name FROM expense_line l LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code
    WHERE l.expense_id IN (${rs.map(() => '?').join(',')}) ORDER BY l.expense_id, l.line_no`, rs.map(r => r.expense_id)) : [];
  return rs.map(r => ({ id: r.expense_id, no: r.document_no, billNo: r.bill_no || '', kind: r.expense_kind, date: r.booked_on, due: r.due_on || '', vendor: r.vendor_code || '', vendorName: r.vendor_name || '', payee: r.vendor_name || (r.line_memo && r.line_memo !== r.memo ? r.line_memo : ''), account: r.account_code, accountName: r.account_name, sub: r.sub_code || '',
    dept: r.department_code, taxCode: r.source_tax_code, amount: Number(r.gross_amount), paid: Number(r.paid), balance: r.status === 'POSTED' ? Number(r.gross_amount) - Number(r.paid) : 0, memo: r.memo, status: r.status,
    lines: ls.filter(l => l.expense_id === r.expense_id).map(l => ({ no: Number(l.line_no), account: l.account_code, accountName: l.account_name || '', sub: l.sub_code || '', subName: l.sub_name || '', dept: l.department_code, taxCode: l.source_tax_code,
      amount: Number(l.gross_amount), tax: Number(l.tax_amount || 0), memoCode: l.memo_code || '', memo: l.memo || '' })) }));
}
// 支払予定日：業者マスタの支払繰延区分（code_m VPAY：○か月後・日、31=月末）。未設定は締切日の翌月末。
export async function vendorDue(c, vendorCode, date) {
  const t = await one(c, "SELECT category1 m, category2 d FROM code_m WHERE code_key='VPAY' AND code_dtl=?", [vendorCode]);
  if (!t || (t.m === '' && t.d === '')) return dueDate(date);
  const [y, mo] = date.split('-').map(Number), months = t.m === '' ? 1 : Number(t.m), day = t.d === '' ? 31 : Number(t.d);
  const last = new Date(Date.UTC(y, mo - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo - 1 + months, Math.min(day, last))).toISOString().slice(0, 10);
}
// 10/19 打合せ：定時請求・小口現金は 1伝票＝複数明細（科目・内訳・処税率・金額・摘要コード7桁・摘要名）、合計は明細から自動集計。
// 定時請求の請求No は業者ごとの4桁連番。
export async function createExpense(c, ctx, p) {
  const kind = String(p.kind); check(['PAYABLE', 'PETTY_CASH'].includes(kind), '区分が不正です');
  const date = isoDate(p.date, kind === 'PAYABLE' ? '締切日' : '支払日'); await assertOpen(c, date);
  const v = kind === 'PAYABLE' || p.vendor ? await vendorOf(c, p.vendor) : null;
  const payee = kind === 'PETTY_CASH' ? text(p.payee, '支払先', 100, { required: false }) : '';
  const due = kind === 'PAYABLE' ? (p.due ? isoDate(p.due, '支払予定日') : await vendorDue(c, v.vendor_code, date)) : null;
  const dept = text(p.dept || '063', '組織（部門）', 20);
  const input = Array.isArray(p.lines) ? p.lines : [{ account: p.account, sub: p.sub, taxCode: p.taxCode, amount: p.amount, memo: p.memo }];
  const ls = [];
  for (const [i, l] of input.entries()) {
    const label = `${i + 1}行目`;
    if (!l.account && !l.amount) continue;
    const acc = await one(c, 'SELECT * FROM account_subject WHERE account_code=?', [String(l.account || '')]); check(acc?.active, `${label}: 有効な勘定科目を選択してください`);
    const sub = String(l.sub || '') || null;
    if (sub) check(await one(c, 'SELECT 1 x FROM account_subsubject WHERE account_code=? AND sub_code=? AND active', [acc.account_code, sub]), `${label}: 内訳科目が上位科目に登録されていません`);
    const amount = yen(l.amount, `${label}の金額`); check(amount > 0, `${label}: 金額を入力してください`);
    const tax = mustDecode(l.taxCode || '141', `${label}の処税率`).code, taxAmt = taxOf(amount, tax);
    ls.push({ account: acc.account_code, sub, tax, amount, taxAmt, memoCode: text(l.memoCode, `${label}の摘要コード`, 7, { required: false, pattern: /^\d{1,7}$/ }), memo: text(l.memo, `${label}の摘要名`, 500, { required: false }) });
  }
  check(ls.length, '明細を入力してください'); check(ls.length <= 99, '明細は99行以内です');
  const amount = ls.reduce((n, l) => n + l.amount, 0), memo = text(p.memo || ls[0].memo || (kind === 'PAYABLE' ? '定時請求' : '小口現金'), '摘要', 500), no = await nextNo(c, 'expense');
  let billNo = null;
  if (kind === 'PAYABLE') {
    const m = await one(c, "SELECT MAX(CAST(bill_no AS INTEGER)) n FROM expense_document WHERE vendor_id=? AND bill_no ~ '^[0-9]+$'", [v.vendor_id]);
    billNo = String((Number(m?.n || 0) % 9999) + 1).padStart(4, '0');
  }
  const [r] = await c.query("INSERT INTO expense_document (document_no,expense_kind,vendor_id,booked_on,due_on,gross_amount,memo,status,bill_no) VALUES (?,?,?,?,?,?,?,'POSTED',?)", [no, kind, v?.vendor_id || null, date, due, amount, memo, billNo]);
  for (const [i, l] of ls.entries())
    await c.query('INSERT INTO expense_line (expense_id,line_no,account_code,sub_code,department_code,source_tax_code,net_amount,tax_amount,gross_amount,memo,memo_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [r.insertId, i + 1, l.account, l.sub, dept, l.tax, l.amount - l.taxAmt, l.taxAmt, l.amount, payee && i === 0 ? payee : l.memo || memo, l.memoCode || null]);
  await postJournal(c, { date, pattern: kind === 'PAYABLE' ? 'D01' : 'E01', sourceType: 'expense_document', sourceId: r.insertId, lines: [
    ...ls.map(l => line('D', l.account, l.amount, { sub: l.sub, dept, tax: l.tax })), kind === 'PAYABLE' ? line('C', '4121', amount, { vendor: v.vendor_id, tax: '9' }) : line('C', '1111', amount, { tax: '9' })] });
  await audit(c, ctx, 'expense_document', r.insertId, kind === 'PAYABLE' ? 'payable.create' : 'pettycash.create', { no, billNo, vendor: v?.vendor_code, lines: ls.length, amount });
  return { id: r.insertId, no, billNo, due };
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
  // 仕訳パターン分析 F-02（先方負担手数料差引：雑収入8790-001＋仮受消費税）・F-03（相殺：業者立替金1431）に準拠（推定、Q03）
  const fee = yen(p.fee || 0, '振込手数料（先方負担）'), offset = yen(p.offset || 0, '相殺額'), safety = yen(p.safety || 0, '安全協力費');
  if (offset) {
    const adv = await one(c, "SELECT COALESCE(SUM(amount),0) n FROM opening_balance WHERE vendor_id=? AND balance_kind='ADVANCE'", [v.vendor_id]);
    const used = await one(c, "SELECT COALESCE(SUM(offset_amount),0) n FROM payment WHERE vendor_id=? AND status='POSTED'", [v.vendor_id]);
    check(offset <= Number(adv.n) - Number(used.n), `相殺額が業者立替金の残高（${(Number(adv.n) - Number(used.n)).toLocaleString('ja-JP')}円）を超えています`);
  }
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
  const total = allocs.reduce((n, a) => n + a.amount, 0), bank = total - fee - offset - safety;
  check(bank >= 0, '手数料・相殺額が支払額を超えています');
  const no = await nextNo(c, 'payment');
  const [r] = await c.query("INSERT INTO payment (payment_no,vendor_id,paid_on,bank_account_id,bank_amount,fee_amount,offset_amount,status,idempotency_key) VALUES (?,?,?,?,?,?,?,'POSTED',?)", [no, v.vendor_id, date, v.bank_account_id, bank, fee, offset, idem]);
  for (const a of allocs) await c.query('INSERT INTO payment_allocation (payment_id,expense_id,amount) VALUES (?,?,?)', [r.insertId, a.id, a.amount]);
  await postJournal(c, { date, pattern: 'F01', sourceType: 'payment', sourceId: r.insertId, lines: [line('D', '4121', total, { vendor: v.vendor_id, tax: '9' }), line('C', '1112', bank, { sub: bankCode, tax: '9' }),
    line('C', '8790', fee - Math.floor(fee * 10 / 110), { sub: '001', dept: '063', tax: '11' }), line('C', '4415', Math.floor(fee * 10 / 110), { tax: '9' }), line('C', '1431', offset, { vendor: v.vendor_id, tax: '9' }), line('C', '4171', safety, { vendor: v.vendor_id, tax: '9' })] });
  await audit(c, ctx, 'payment', r.insertId, 'payment.create', { no, vendor: v.vendor_code, amount: total, bank, fee, offset, safety, documents: allocs.map(a => a.id) });
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

// ---------- 小口現金の定額資金設定と現金補充（仕訳パターン G-03 相当：現金／当座預金） ----------
export async function pettySettings(c) {
  const r = await one(c, "SELECT code_dtl_abr v FROM code_m WHERE code_key='SET' AND code_dtl='PETTYFUND'");
  const refills = await rows(c, "SELECT e.journal_id id, e.journal_date date, e.status, l.amount, (SELECT sub_code FROM journal_line x WHERE x.journal_id=e.journal_id AND x.account_code='1112' LIMIT 1) bank FROM journal_entry e JOIN journal_line l ON l.journal_id=e.journal_id AND l.account_code='1111' AND l.side='D' WHERE e.source_type='petty_refill' AND e.reversal_of IS NULL ORDER BY e.journal_date DESC LIMIT 50");
  return { fund: Number(r?.v || 100000), fundSet: !!r, refills: refills.map(x => ({ ...x, amount: Number(x.amount) })) };
}
export async function savePettyFund(c, ctx, p) {
  const fund = yen(p.fund, '定額資金', { max: 99999999 });
  await c.query("DELETE FROM code_m WHERE code_key='SET' AND code_dtl='PETTYFUND'");
  await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('SET','設定','PETTYFUND','小口現金 定額資金',?,'','','')", [String(fund)]);
  await audit(c, ctx, 'code_m', 'PETTYFUND', 'petty.fund', { fund });
  return { fund };
}
export async function pettyRefill(c, ctx, p) {
  const date = isoDate(p.date, '補充日'); await assertOpen(c, date);
  const amount = yen(p.amount, '補充額'); check(amount > 0, '補充額を入力してください');
  const bankCode = String(p.bankCode || ''); const b = await one(c, "SELECT category1 FROM code_m WHERE code_key='BANK' AND code_dtl=?", [bankCode]); check(b && b.category1 !== '0', '引出口座（銀行）を選択してください');
  const id = 'PR' + date.replaceAll('-', '') + '-' + Date.now().toString(36);
  const jid = await postJournal(c, { date, pattern: 'G03', sourceType: 'petty_refill', sourceId: id, lines: [line('D', '1111', amount, { tax: '9' }), line('C', '1112', amount, { sub: bankCode, tax: '9' })] });
  await audit(c, ctx, 'journal_entry', jid, 'petty.refill', { date, amount, bank: bankCode });
  return { id: jid };
}
