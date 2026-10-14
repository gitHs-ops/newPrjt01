import { check, isoMonth, period, today, addMonths, fromNum, toNum, METHODS } from './domain.mjs';
import { rows, one, audit } from './db.mjs';
import { listShipments, listInvoices, listReceipts } from './sales.mjs';
import { listPayments, listExpenses, listPurchases, listInventory } from './payables.mjs';
import { MASTERS, list as listMaster, exportRows } from './masters.mjs';

export const PATTERNS = { A01: '売掛金計上（請求）', B01: '入金消込', C01: '在庫計上', D01: '定時請求（買掛金）', E01: '小口現金', F01: '支払', G03: '小口現金補充' };
const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

export async function listJournals(c, q = {}) {
  const w = [], args = [];
  if (q.month) { isoMonth(q.month); w.push('e.journal_date BETWEEN ? AND ?'); args.push(q.month + '-01', monthEnd(q.month)); }
  if (q.pattern) { w.push('e.pattern_code=?'); args.push(q.pattern); }
  const es = await rows(c, `SELECT e.* FROM journal_entry e ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.journal_date DESC, e.journal_id DESC LIMIT 2000`, args);
  const ls = es.length ? await rows(c, `SELECT l.*, a.account_name, s.sub_name, cu.customers_name, v.vendor_name FROM journal_line l LEFT JOIN account_subject a ON a.account_code=l.account_code
    LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code LEFT JOIN client_m cu ON cu.customers_cd=l.customers_cd LEFT JOIN vendor v ON v.vendor_id=l.vendor_id
    WHERE l.journal_id IN (${es.map(() => '?').join(',')}) ORDER BY l.journal_id, l.line_no`, es.map(e => e.journal_id)) : [];
  return es.map(e => {
    const lines = ls.filter(l => l.journal_id === e.journal_id).map(l => ({ no: l.line_no, side: l.side, account: l.account_code, accountName: l.account_name, sub: l.sub_code || '', subName: l.sub_name || '', dept: l.department_code || '', tax: l.source_tax_code || '', amount: Number(l.amount), partner: l.customers_name || l.vendor_name || '' }));
    return { id: e.journal_id, date: e.journal_date, pattern: e.pattern_code, patternName: PATTERNS[e.pattern_code] || '', source: e.source_type, sourceId: e.source_id, revision: e.posting_revision, reversalOf: e.reversal_of, status: e.status,
      total: lines.filter(l => l.side === 'D').reduce((n, l) => n + l.amount, 0), lines };
  });
}
export async function trialBalance(c, month) {
  isoMonth(month);
  const rs = await rows(c, `SELECT l.account_code, a.account_name, SUM(CASE WHEN l.side='D' THEN l.amount ELSE 0 END) dr, SUM(CASE WHEN l.side='C' THEN l.amount ELSE 0 END) cr
    FROM journal_line l JOIN journal_entry e ON e.journal_id=l.journal_id LEFT JOIN account_subject a ON a.account_code=l.account_code WHERE e.journal_date BETWEEN ? AND ? GROUP BY l.account_code, a.account_name ORDER BY l.account_code`, [month + '-01', monthEnd(month)]);
  return rs.map(r => ({ account: r.account_code, name: r.account_name, debit: Number(r.dr), credit: Number(r.cr) }));
}

// ---------- 月次確定 ----------
export async function periods(c) {
  const closed = await rows(c, 'SELECT * FROM app_period_close ORDER BY period DESC');
  const now = today().slice(0, 7), list = [];
  for (let i = -6; i <= 0; i++) { const m = addMonths(now, i); const r = closed.find(x => x.period === m); list.push({ month: m, closed: !!r, closedAt: r?.closed_at || '', closedBy: r?.closed_by || '' }); }
  return { months: list.reverse(), closed: closed.map(r => r.period) };
}
export async function closeCheck(c, month) {
  isoMonth(month); const end = monthEnd(month), issues = [];
  const custs = await rows(c, "SELECT customers_cd, customers_name, deadline FROM client_m WHERE delete_f<>'1'");
  for (const cu of custs) {
    const { end: cl } = period(month, Number(cu.deadline) || 31), limit = cl < end ? cl : end;
    const r = await one(c, "SELECT COUNT(*) n FROM sales_trn WHERE customers_cd=? AND process_status='0' AND payment_method_cd=1 AND sales_date BETWEEN ? AND ?", [cu.customers_cd, toNum(month + '-01'), toNum(limit)]);
    if (Number(r.n)) issues.push(`${cu.customers_name}: ${limit}締の未請求出荷 ${r.n}件`);
  }
  const draft = await one(c, "SELECT COUNT(*) n FROM billing_head h WHERE h.closing_date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM invoice_issue i WHERE i.invoice_id=h.invoice_id)", [toNum(month + '-01'), toNum(end)]);
  if (Number(draft.n)) issues.push(`未発行の請求書 ${draft.n}件`);
  return issues;
}
export async function closeMonth(c, ctx, { month }) {
  isoMonth(month, '確定月'); check(month <= today().slice(0, 7), '未来の月は確定できません');
  check(!(await one(c, 'SELECT 1 x FROM app_period_close WHERE period=? FOR UPDATE', [month])), 'すでに確定済みです');
  const prev = addMonths(month, -1), anyClosed = await one(c, 'SELECT COUNT(*) n FROM app_period_close');
  if (Number(anyClosed.n)) check(await one(c, 'SELECT 1 x FROM app_period_close WHERE period=?', [prev]), `前月 ${prev} を先に確定してください`);
  const issues = await closeCheck(c, month); check(!issues.length, '確定できません: ' + issues.join(' / '));
  await c.query('INSERT INTO app_period_close (period, closed_at, closed_by) VALUES (?, UTC_TIMESTAMP(6), ?)', [month, ctx.user.login_id]);
  await audit(c, ctx, 'app_period_close', month, 'period.close', {});
  return { month };
}
export async function reopenMonth(c, ctx, { month }) {
  isoMonth(month);
  check(await one(c, 'SELECT 1 x FROM app_period_close WHERE period=? FOR UPDATE', [month]), '確定されていない月です');
  check(!(await one(c, 'SELECT 1 x FROM app_period_close WHERE period>? LIMIT 1', [month])), '後の確定月から順に解除してください');
  await c.query('DELETE FROM app_period_close WHERE period=?', [month]);
  await audit(c, ctx, 'app_period_close', month, 'period.reopen', {});
  return { month };
}

// ---------- ダッシュボード・残高 ----------
const AR_PAID = "(SELECT COALESCE(SUM(a.amount),0) FROM receipt_allocation a JOIN receipt r ON r.receipt_id=a.receipt_id AND r.status='POSTED' WHERE a.customers_cd=c.customers_cd)";
export async function arReport(c) {
  const rs = await rows(c, `SELECT c.customers_cd, c.customers_name, c.deadline, c.delete_f,
    (SELECT COALESCE(SUM(amount),0) FROM opening_balance o WHERE o.customers_cd=c.customers_cd AND o.balance_kind='AR') opening,
    (SELECT COALESCE(SUM(money+consumption_tax),0) FROM billing_head h WHERE h.customers_cd=c.customers_cd) billed, ${AR_PAID} received,
    (SELECT COALESCE(SUM(money),0) FROM sales_trn s WHERE s.customers_cd=c.customers_cd AND s.process_status='0' AND s.payment_method_cd=1) unbilled
    FROM client_m c ORDER BY c.customers_cd`);
  const inv = await listInvoices(c, { status: 'open' });
  return rs.map(r => ({ customer: r.customers_cd, name: r.customers_name, closing: Number(r.deadline), active: r.delete_f !== '1', opening: Number(r.opening), billed: Number(r.billed), received: Number(r.received), unbilled: Number(r.unbilled),
    balance: Number(r.opening) + Number(r.billed) - Number(r.received), overdue: inv.filter(i => i.customer === r.customers_cd && i.overdue).reduce((n, i) => n + i.balance, 0) }))
    .filter(r => r.active || r.balance || r.billed);
}
export async function apReport(c) {
  const rs = await rows(c, `SELECT v.vendor_id, v.vendor_code, v.vendor_name, v.active,
    (SELECT COALESCE(SUM(gross_amount),0) FROM expense_document d WHERE d.vendor_id=v.vendor_id AND d.expense_kind='PAYABLE' AND d.status='POSTED') billed,
    (SELECT COALESCE(SUM(a.amount),0) FROM payment_allocation a JOIN payment p ON p.payment_id=a.payment_id AND p.status='POSTED' WHERE p.vendor_id=v.vendor_id) paid
    FROM vendor v ORDER BY v.vendor_code`);
  return rs.map(r => ({ vendor: r.vendor_code, name: r.vendor_name, active: !!r.active, billed: Number(r.billed), paid: Number(r.paid), balance: Number(r.billed) - Number(r.paid) })).filter(r => r.active || r.balance);
}
export async function dashboard(c) {
  const now = today(), month = now.slice(0, 7), months = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5));
  const sum = async (sql, args) => Number(Object.values(await one(c, sql, args))[0] || 0);
  const salesMonth = await sum('SELECT COALESCE(SUM(money),0) FROM sales_trn WHERE sales_date BETWEEN ? AND ?', [toNum(month + '-01'), toNum(month + '-31')]);
  const unbilled = await one(c, "SELECT COUNT(*) n, COALESCE(SUM(money),0) v FROM sales_trn WHERE process_status='0' AND payment_method_cd=1");
  const receivedMonth = await sum("SELECT COALESCE(SUM(received_amount),0) FROM receipt WHERE status='POSTED' AND receipt_date BETWEEN ? AND ?", [month + '-01', monthEnd(month)]);
  const ar = await arReport(c), ap = await apReport(c), inv = await listInvoices(c, {});
  const trend = [];
  for (const m of months) trend.push({ month: m,
    sales: await sum('SELECT COALESCE(SUM(money+consumption_tax),0) FROM sales_trn WHERE sales_date BETWEEN ? AND ?', [toNum(m + '-01'), toNum(m + '-31')]),
    received: await sum("SELECT COALESCE(SUM(settlement_amount),0) FROM receipt WHERE status='POSTED' AND receipt_date BETWEEN ? AND ?", [m + '-01', monthEnd(m)]) });
  const dueSoon = (await listExpenses(c, { kind: 'PAYABLE', open: true })).filter(e => e.due && e.due <= addDays(now, 14)).sort((a, b) => a.due.localeCompare(b.due));
  const recent = await rows(c, 'SELECT occurred_at, actor_id, action, entity_type, entity_id FROM audit_event ORDER BY audit_id DESC LIMIT 8');
  return {
    month, kpi: { salesMonth, unbilledCount: Number(unbilled.n), unbilledAmount: Number(unbilled.v), arBalance: ar.reduce((n, r) => n + r.balance, 0), receivedMonth, apBalance: ap.reduce((n, r) => n + r.balance, 0) },
    trend, draftInvoices: inv.filter(i => i.status === 'draft').length, overdue: inv.filter(i => i.overdue).slice(0, 8), dueSoon: dueSoon.slice(0, 8), recent,
  };
}
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- 操作履歴・移行状況 ----------
export async function auditLog(c, q = {}) {
  const w = [], args = [];
  if (q.entity) { w.push('entity_type=?'); args.push(q.entity); }
  if (q.actor) { w.push('actor_id=?'); args.push(q.actor); }
  return (await rows(c, `SELECT audit_id id, occurred_at at, actor_id actor, entity_type entity, entity_id entityId, action, change_summary summary FROM audit_event ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY audit_id DESC LIMIT 300`, args));
}
export const TABLES = {
  billing_closing_inf: ['請求締状況', '使用'], billing_detail: ['請求明細', '使用'], billing_head: ['請求ヘッダ', '使用'], card_sales: ['カード売上', '未使用（Q16）'], card_sales_dtl: ['カード売上明細', '未使用（Q16）'],
  client_m: ['得意先', '使用'], code_m: ['コード（銀行内訳）', '使用'], company_info_m: ['自社情報', '使用'], delivery_m: ['納入先', '未使用'], field_name_m: ['現場', '使用'], genka_m: ['原価', '使用（NO25 暫定）'],
  item_bunrui_m: ['商品分類', '未使用'], item_m: ['商品', '使用'], menu_role_ts: ['メニュー権限', '使用'], menus: ['メニュー', '使用'], numbering_m: ['採番', '使用'], operator_m: ['担当者', '未使用'], roles: ['ロール', '使用'],
  sales_trn: ['売上', '使用'], shipment_edit: ['出荷編集', '未使用'], shipment_plan: ['出荷予定', '未使用'], shipment_slip: ['出荷伝票', '使用'], upload_work: ['取込作業', '未使用'], uriage_tanka_m: ['売上単価', '使用'],
  user_role_ts: ['利用者ロール', '使用'], users: ['利用者', '使用'],
  bank_account: ['振込口座', '使用'], vendor: ['業者', '使用'], account_subject: ['勘定科目', '使用'], account_subsubject: ['内訳科目', '使用'], invoice_issue: ['請求書発行履歴', '使用'], receipt: ['入金', '使用'],
  receipt_component: ['入金内訳', '使用'], receipt_allocation: ['入金消込', '使用'], purchase: ['仕入', '使用'], inventory_count: ['在庫計上', '使用'], expense_document: ['経費伝票', '使用'], expense_line: ['経費明細', '使用'],
  payment: ['支払', '使用'], payment_allocation: ['支払配分', '使用'], journal_entry: ['仕訳', '使用'], journal_line: ['仕訳明細', '使用'], opening_balance: ['開始残高', '使用'], audit_event: ['監査ログ', '使用'],
};
export async function coverage(c) {
  const out = [];
  for (const [t, [label, use]] of Object.entries(TABLES)) out.push({ table: t, label, use, origin: Object.keys(TABLES).indexOf(t) < 26 ? '既存定義' : '新規提案', rows: Number((await one(c, `SELECT COUNT(*) n FROM \`${t}\``)).n) });
  return out;
}

// ---------- CSV 出力 ----------
const yn = b => (b ? '1' : '0');
export async function exportCsv(c, kind, q = {}) {
  const month = q.month ? isoMonth(q.month) : undefined;
  switch (kind) {
    case 'shipments': { const l = await listShipments(c, { month: month || today().slice(0, 7) }); return [['売上No', '区分', '訂正元', '出荷日', '得意先CD', '得意先', '現場', '商品CD', '商品', '数量', '単位', '単価', '金額', '税率', '消費税', '決済', '請求済', '車番', '備考'],
      ...l.map(r => [r.orderNo, r.shipKb === 2 ? '訂正' : '売上', r.originalNo, r.date, r.customer, r.customerName, r.siteName, r.item, r.itemName, r.quantity, r.unit, r.price, r.net, r.taxRate, r.tax, r.methodName, yn(r.billed), r.vehicle, r.remarks])]; }
    case 'invoices': { const l = await listInvoices(c, { month }); return [['請求ID', '請求年月', '締日', '支払期日', '得意先CD', '得意先', '現場', '税抜金額', '消費税', '請求額', '入金済', '残高', '発行回数', '状態'],
      ...l.map(r => [r.id, r.month, r.closing, r.due, r.customer, r.customerName, r.siteName, r.net, r.tax, r.total, r.paid, r.balance, r.issues, r.status])]; }
    case 'receipts': { const l = await listReceipts(c, { month }); return [['入金No', '入金日', '得意先CD', '得意先', '振込', '銀行内訳', '現金', '手形', '手数料', '協力会費等', '預り金充当', '値引', '受領額', '消込額', '状態', '消込請求ID'],
      ...l.map(r => [r.no, r.date, r.customer, r.customerName, r.bank, r.bankCode, r.cash, r.notes, r.fee, r.coop, r.deposit, r.discount, r.received, r.settlement, r.status, r.allocations.map(a => a.invoiceId).join(' ')])]; }
    case 'journals': { const l = await listJournals(c, { month }); return [['仕訳ID', '仕訳日', 'パターン', '元伝票種別', '元伝票ID', '版', '取消元仕訳', '状態', '行', '貸借', '科目', '科目名', '内訳', '部門', '税区分', '金額', '取引先'],
      ...l.flatMap(j => j.lines.map(x => [j.id, j.date, j.pattern, j.source, j.sourceId, j.revision, j.reversalOf || '', j.status, x.no, x.side === 'D' ? '借方' : '貸方', x.account, x.accountName, x.sub, x.dept, x.tax, x.amount, x.partner]))]; }
    case 'payments': { const l = await listPayments(c, { month }); return [['支払No', '支払日', '業者CD', '業者', '支払額', '支払元銀行内訳', '振込先銀行', '支店', '種別', '口座番号', '受取人', '状態'],
      ...l.map(r => [r.no, r.date, r.vendor, r.vendorName, r.amount, r.fromBank, r.payee?.bank, r.payee?.branch, r.payee?.type, r.payee?.account, r.payee?.holder, r.status])]; }
    case 'expenses': { const l = await listExpenses(c, { month }); return [['伝票No', '区分', '計上日', '支払予定日', '業者CD', '業者', '科目', '内訳', '部門', '税区分', '金額', '支払済', '残高', '摘要', '状態'],
      ...l.map(r => [r.no, r.kind === 'PAYABLE' ? '定時請求' : '小口現金', r.date, r.due, r.vendor, r.vendorName, r.account, r.sub, r.dept, r.taxCode, r.amount, r.paid, r.balance, r.memo, r.status])]; }
    case 'purchases': { const l = await listPurchases(c, { month }); return [['伝票No', '仕入日', '業者CD', '業者', '商品CD', '商品', '数量', '単価', '金額', '税区分', '摘要'], ...l.map(r => [r.no, r.date, r.vendor, r.vendorName, r.item, r.itemName, r.quantity, r.price, r.net, r.taxCode, r.memo])]; }
    case 'inventory': { const l = await listInventory(c, { month }); return [['計上月', '商品CD', '商品', '数量', '評価単価', '評価額', '状態'], ...l.map(r => [r.month, r.item, r.itemName, r.quantity, r.price, r.value, r.status])]; }
    case 'ar': { const l = await arReport(c); return [['得意先CD', '得意先', '締日', '開始残高', '請求累計', '入金累計', '売掛残高', '期日超過', '未請求(税抜)'], ...l.map(r => [r.customer, r.name, r.closing, r.opening, r.billed, r.received, r.balance, r.overdue, r.unbilled])]; }
    case 'ap': { const l = await apReport(c); return [['業者CD', '業者', '計上累計', '支払累計', '未払残高'], ...l.map(r => [r.vendor, r.name, r.billed, r.paid, r.balance])]; }
    default: {
      const m = kind.startsWith('master-') && MASTERS[kind.slice(7)]; check(m, '出力対象が不正です');
      return exportRows(m, await listMaster(c, kind.slice(7)));
    }
  }
}
export { METHODS, fromNum };
