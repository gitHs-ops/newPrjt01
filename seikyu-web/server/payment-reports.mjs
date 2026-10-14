// ③ 支払帳票: NO37 支払データ作成（全銀）、NO45 業者別支払内訳表、NO46 振込依頼書、NO47 支払繰越一覧表、NO48 支払案内書
import { check, isoDate, today, addMonths } from './domain.mjs';
import { rows, one, audit } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { zenginFile } from './zengin.mjs';

const TYPES = { 1: '普通', 2: '当座', 4: '貯蓄' };
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const num = v => Number(v || 0);
const FROM_BANK = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
async function payments(c, where, args) {
  const ps = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, b.holder_name, ${FROM_BANK} from_bank
    FROM payment p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN bank_account b ON b.bank_account_id=COALESCE(p.bank_account_id, v.bank_account_id)
    WHERE p.status='POSTED' AND ${where} ORDER BY p.paid_on, v.vendor_code, p.payment_id`, args);
  const ids = ps.map(p => p.payment_id);
  const al = ids.length ? await rows(c, `SELECT a.payment_id, a.amount, d.expense_id, d.document_no, d.booked_on, d.memo, d.gross_amount FROM payment_allocation a JOIN expense_document d ON d.expense_id=a.expense_id WHERE a.payment_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.booked_on, d.document_no`, ids) : [];
  return ps.map(p => ({ ...p, bank: num(p.bank_amount), fee: num(p.fee_amount), offset: num(p.offset_amount), docs: al.filter(a => a.payment_id === p.payment_id) }));
}
const banksMap = async c => Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
const payee = p => (p.bank_code ? { bank: p.bank_code, branch: p.branch_code, type: p.account_type_code, typeName: TYPES[p.account_type_code] || '', account: p.account_number, holder: p.holder_name } : null);

// ---------- NO37 支払データ作成（全銀・総合振込） ----------
export async function zenginData(c, q, ctx) {
  const date = isoDate(q.date, '振込指定日'), bankCode = String(q.bank || '');
  const z = await one(c, "SELECT b.code_dtl, b.code_dtl_nam, z.code_dtl_nam zg_name, z.code_dtl_abr zg_code, z.category1 zg_bank, z.category2 zg_bt, z.category3 zg_account FROM code_m b LEFT JOIN code_m z ON z.code_key='ZGN' AND z.code_dtl=b.code_dtl WHERE b.code_key='BANK' AND b.code_dtl=?", [bankCode]);
  check(z, '振込元口座（銀行）を選択してください');
  const ps = await payments(c, 'p.paid_on=? AND ' + FROM_BANK + '=?', [date, bankCode]);
  // One transfer per vendor account for the day.
  const map = new Map();
  for (const p of ps) {
    const k = p.vendor_code;
    if (!map.has(k)) map.set(k, { label: `${p.vendor_code} ${p.vendor_name}`, vendor: p.vendor_code, bank: p.bank_code, branch: p.branch_code, type: p.account_type_code, account: p.account_number, holder: p.holder_name || '', amount: 0, nos: [], customer1: p.vendor_code });
    const t = map.get(k); t.amount += p.bank; t.nos.push(p.payment_no);
  }
  const transfers = [...map.values()];
  const payer = { requesterCode: z.zg_code, requesterName: z.zg_name, bank: z.zg_bank, branch: (z.zg_bt || '').slice(0, 3), type: (z.zg_bt || '').slice(3, 4) || '1', account: z.zg_account, bankName: '', branchName: '' };
  const f = zenginFile({ date, payer, transfers });
  if (!transfers.length) f.errors.push('この振込指定日・振込元口座の支払がありません');
  if (q.format === 'file') {
    check(!f.errors.length, '全銀データを作成できません: ' + f.errors.join(' / '));
    await audit(c, ctx, 'payment', date, 'zengin.export', { bank: bankCode, count: f.count, total: f.total, payments: transfers.flatMap(t => t.nos) });
    return { file: { name: `ZENGIN_${date.replaceAll('-', '')}_${bankCode}.txt`, body: f.body, type: 'application/octet-stream' } };
  }
  return { date, bank: bankCode, bankName: z.code_dtl_nam, payerReady: !!z.zg_bank, count: f.count, total: f.total, errors: f.errors, records: f.records, transfers: transfers.map(t => ({ ...t, typeName: TYPES[t.type] || '' })) };
}

// ---------- NO45 業者別支払内訳表 ----------
export async function vendorPayments(c, q) {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です');
  const ps = await payments(c, 'p.paid_on BETWEEN ? AND ?', [from, to]), banks = await banksMap(c);
  const vendors = [];
  for (const p of ps) {
    let v = vendors.find(x => x.vendor === p.vendor_code); if (!v) vendors.push(v = { vendor: p.vendor_code, name: p.vendor_name, rows: [], total: 0 });
    v.rows.push({ date: p.paid_on, no: p.payment_no, method: '銀行振込', bank: p.bank, fee: p.fee, offset: p.offset, advance: 0, paid: p.bank + p.fee + p.offset, fromBank: p.from_bank ? `${p.from_bank} ${banks[p.from_bank] || ''}` : '', docs: p.docs.map(d => d.document_no).join(' '), payee: payee(p) });
    v.total += p.bank + p.fee + p.offset;
  }
  return { title: '業者別支払内訳表', ref: 'NO45 / 添付帳票㉒', from, to, vendors, total: vendors.reduce((n, v) => n + v.total, 0) };
}
// ---------- NO46 振込依頼書 ----------
export async function transferRequest(c, q) {
  const date = isoDate(q.date, '振込指定日'), banks = await banksMap(c);
  const ps = await payments(c, 'p.paid_on=?', [date]);
  const groups = [];
  for (const p of ps) {
    const k = p.from_bank || ''; let g = groups.find(x => x.fromBank === k); if (!g) groups.push(g = { fromBank: k, fromBankName: banks[k] || '', rows: [], total: 0 });
    g.rows.push({ vendor: p.vendor_code, name: p.vendor_name, no: p.payment_no, payee: payee(p), amount: p.bank }); g.total += p.bank;
  }
  const co = await one(c, 'SELECT * FROM company_info_m ORDER BY company_info_id LIMIT 1');
  return { title: '振込依頼書', ref: 'NO46 / 添付帳票㉓', date, company: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), groups, total: groups.reduce((n, g) => n + g.total, 0) };
}
// ---------- NO47 支払繰越一覧表（基準日時点の未払残高を計上月で年齢区分） ----------
async function carryRows(c, date, vendorCode) {
  const args = [date, date]; let w = '';
  if (vendorCode) { w = ' AND v.vendor_code=?'; args.push(vendorCode); }
  const docs = await rows(c, `SELECT d.expense_id, d.document_no, d.booked_on, d.gross_amount, d.memo, v.vendor_code, v.vendor_name,
      (SELECT COALESCE(SUM(a.amount),0) FROM payment_allocation a JOIN payment p ON p.payment_id=a.payment_id AND p.status='POSTED' AND p.paid_on<=? WHERE a.expense_id=d.expense_id) paid
    FROM expense_document d JOIN vendor v ON v.vendor_id=d.vendor_id WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on<=?${w} ORDER BY v.vendor_code, d.booked_on`, args);
  const base = date.slice(0, 7), out = [];
  for (const d of docs) {
    const bal = num(d.gross_amount) - num(d.paid); if (bal <= 0) continue;
    let v = out.find(x => x.vendor === d.vendor_code); if (!v) out.push(v = { vendor: d.vendor_code, name: d.vendor_name, m3: 0, m2: 0, m1: 0, m0: 0, total: 0, offset: 0, net: 0, docs: [] });
    const m = d.booked_on.slice(0, 7), age = m === base ? 'm0' : m === addMonths(base, -1) ? 'm1' : m === addMonths(base, -2) ? 'm2' : 'm3';
    v[age] += bal; v.total += bal; v.net += bal; v.docs.push({ no: d.document_no, date: d.booked_on, memo: d.memo, gross: num(d.gross_amount), balance: bal });
  }
  return out;
}
export async function payableCarryover(c, q) {
  const date = isoDate(q.date || today(), '基準日'), list = await carryRows(c, date);
  const sum = k => list.reduce((n, v) => n + v[k], 0);
  return { title: '支払繰越一覧表', ref: 'NO47 / 添付帳票㉔', date, months: { m3: `${addMonths(date.slice(0, 7), -3)}以前`, m2: addMonths(date.slice(0, 7), -2), m1: addMonths(date.slice(0, 7), -1), m0: date.slice(0, 7) },
    vendors: list, totals: { m3: sum('m3'), m2: sum('m2'), m1: sum('m1'), m0: sum('m0'), total: sum('total'), offset: 0, net: sum('net') } };
}
// ---------- NO48 支払案内書（支払日・業者ごと） ----------
export async function paymentNotices(c, q) {
  const date = isoDate(q.date, '支払日'), banks = await banksMap(c);
  const ps = await payments(c, 'p.paid_on=?' + (q.vendor ? ' AND v.vendor_code=?' : ''), q.vendor ? [date, q.vendor] : [date]);
  const co = await one(c, 'SELECT * FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const notices = [];
  for (const p of ps) {
    let n = notices.find(x => x.vendor === p.vendor_code);
    if (!n) notices.push(n = { vendor: p.vendor_code, name: p.vendor_name, payee: payee(p), bank: 0, fee: 0, offset: 0, total: 0, docs: [], fromBank: p.from_bank ? banks[p.from_bank] || p.from_bank : '' });
    n.bank += p.bank; n.fee += p.fee; n.offset += p.offset; n.total += p.bank + p.fee + p.offset;
    n.docs.push(...p.docs.map(d => ({ no: d.document_no, date: d.booked_on, memo: d.memo, gross: num(d.gross_amount), paid: num(d.amount) })));
  }
  for (const n of notices) {
    const carry = (await carryRows(c, date, n.vendor))[0];
    n.carry = carry ? { m3: carry.m3, m2: carry.m2, m1: carry.m1, m0: carry.m0, total: carry.total } : { m3: 0, m2: 0, m1: 0, m0: 0, total: 0 };
  }
  return { title: '支払案内書', ref: 'NO48 / 添付帳票㉕', date, company: { name: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), address: [co?.postcode && '〒' + co.postcode, co?.pref, co?.addr1].filter(Boolean).join(' '), tel: co?.tel_no || '' },
    months: { m3: `${addMonths(date.slice(0, 7), -3)}以前`, m2: addMonths(date.slice(0, 7), -2), m1: addMonths(date.slice(0, 7), -1), m0: date.slice(0, 7) }, notices };
}

// ---------- Excel ----------
const head = (d, sub) => [[T(d.title)], [`${d.ref}　${sub}　出力日 ${today()}`], []];
const acct = p => (p ? `${p.bank}-${p.branch} ${p.typeName} ${p.account}` : '振込先未登録');
export async function paymentBook(c, kind, q) {
  if (kind === 'vendor-payments') {
    const d = await vendorPayments(c, q), out = head(d, `期間 ${d.from} 〜 ${d.to}`);
    out.push(['業者CD', '業者名', '支払日', '支払No', '支払方法', '振込額', '手数料', '相殺額（前払金・立替金）', '支払額', '支払元口座', '振込先', '対象伝票'].map(H));
    for (const v of d.vendors) { for (const r of v.rows) out.push([v.vendor, v.name, r.date, r.no, r.method, r.bank, r.fee, r.offset, r.paid, r.fromBank, acct(r.payee), r.docs]); out.push(['', S(`${v.name} 計`), '', '', '', '', '', '', S(v.total)]); }
    out.push(['', S('総合計'), '', '', '', '', '', '', S(d.total)]);
    return { name: `業者別支払内訳表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '業者別支払内訳表', rows: out, widths: [10, 24, 11, 12, 10, 12, 9, 14, 12, 20, 26, 24] }]) };
  }
  if (kind === 'transfer-request') {
    const d = await transferRequest(c, q), out = head(d, `振込指定日 ${d.date}　依頼人 ${d.company}`);
    for (const g of d.groups) {
      out.push([H(`振込元口座 ${g.fromBank} ${g.fromBankName}`)], ['業者CD', '受取人（業者）', '振込先銀行', '支店', '種目', '口座番号', '受取人名（カナ）', '金額', '支払No'].map(H));
      for (const r of g.rows) out.push([r.vendor, r.name, r.payee?.bank || '未登録', r.payee?.branch || '', r.payee?.typeName || '', r.payee?.account || '', r.payee?.holder || '', r.amount, r.no]);
      out.push(['', S('件数 ' + g.rows.length), '', '', '', '', S('合計'), S(g.total)], []);
    }
    return { name: `振込依頼書_${d.date}.xlsx`, body: xlsx([{ name: '振込依頼書', rows: out, widths: [10, 24, 10, 8, 8, 12, 24, 13, 12] }]) };
  }
  if (kind === 'carryover') {
    const d = await payableCarryover(c, q), m = d.months, out = head(d, `基準日 ${d.date}`);
    out.push(['業者CD', '業者名', m.m3, m.m2, m.m1, m.m0, '支払繰越合計', '相殺繰越額', '差引繰越額'].map(H));
    for (const v of d.vendors) out.push([v.vendor, v.name, v.m3, v.m2, v.m1, v.m0, v.total, v.offset, v.net]);
    const t = d.totals; out.push([S('合計'), '', S(t.m3), S(t.m2), S(t.m1), S(t.m0), S(t.total), S(t.offset), S(t.net)]);
    return { name: `支払繰越一覧表_${d.date}.xlsx`, body: xlsx([{ name: '支払繰越一覧表', rows: out, widths: [10, 26, 13, 13, 13, 13, 14, 12, 14] }]) };
  }
  if (kind === 'notices') {
    const d = await paymentNotices(c, q), m = d.months, out = head(d, `支払日 ${d.date}　${d.company.name}`);
    for (const n of d.notices) {
      out.push([H(`${n.vendor} ${n.name} 御中`)], ['支払日', d.date, '支払合計額', n.total, '振込額', n.bank, '振込手数料', n.fee], ['振込先', acct(n.payee), '', '', '支払元', n.fromBank]);
      out.push(['伝票No', '計上日', '摘要', '請求額', '今回支払額'].map(H)); for (const x of n.docs) out.push([x.no, x.date, x.memo, x.gross, x.paid]);
      out.push(['支払繰越（支払後の未払残高）'], [m.m3, m.m2, m.m1, m.m0, '合計'].map(H), [n.carry.m3, n.carry.m2, n.carry.m1, n.carry.m0, n.carry.total], []);
    }
    if (!d.notices.length) out.push(['この支払日の支払はありません']);
    return { name: `支払案内書_${d.date}.xlsx`, body: xlsx([{ name: '支払案内書', rows: out, widths: [14, 14, 24, 14, 14, 14, 12, 12] }]) };
  }
  check(false, '帳票の種類が不正です');
}
