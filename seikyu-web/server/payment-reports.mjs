// ③ 支払帳票: NO37 支払データ作成（全銀）、NO45 業者別支払内訳表、NO46 振込依頼書、NO47 支払繰越一覧表、NO48 支払案内書
import { check, isoDate, today, addMonths, isHoliday, nextBusinessDay } from './domain.mjs';
import { rows, one, audit } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { zenginFile } from './zengin.mjs';
import { holidaySet } from './payables.mjs';
import { companyProfile } from './sales.mjs';

const TYPES = { 1: '普通', 2: '当座', 4: '貯蓄' };
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
const num = v => Number(v || 0);
const FROM_BANK = "(SELECT jl.sub_code FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL AND jl.account_code='1112' LIMIT 1)";
async function payments(c, where, args) {
  await loadDir(c);
  const ps = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, b.holder_name, ${FROM_BANK} from_bank, (SELECT COALESCE(SUM(jl.amount),0) FROM journal_entry je JOIN journal_line jl ON jl.journal_id=je.journal_id AND jl.account_code='4171' AND jl.side='C' WHERE je.source_type='payment' AND je.source_id=CAST(p.payment_id AS CHAR) AND je.reversal_of IS NULL) safety
    FROM payment p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN bank_account b ON b.bank_account_id=COALESCE(p.bank_account_id, v.bank_account_id)
    WHERE p.status='POSTED' AND ${where} ORDER BY p.paid_on, v.vendor_code, p.payment_id`, args);
  const ids = ps.map(p => p.payment_id);
  const al = ids.length ? await rows(c, `SELECT a.payment_id, a.amount, d.expense_id, d.document_no, d.booked_on, d.memo, d.gross_amount FROM payment_allocation a JOIN expense_document d ON d.expense_id=a.expense_id WHERE a.payment_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.booked_on, d.document_no`, ids) : [];
  return ps.map(p => ({ ...p, bank: num(p.bank_amount), fee: num(p.fee_amount), offset: num(p.offset_amount), safety: num(p.safety), docs: al.filter(a => a.payment_id === p.payment_id) }));
}
// 支払元口座の銀行名・支店名（現行 HJR220 の見出し「名古屋　刈谷　御中」、HAR321 の銀行名・支店名）。2026-11-04
const fromBankOf = async c => { const z = Object.fromEntries((await rows(c, "SELECT code_dtl, category1 bk, category2 bt FROM code_m WHERE code_key='ZGN'")).map(r => [r.code_dtl, r])), b = await banksMap(c);
  return code => { const x = z[code], br = String(x?.bt || '').slice(0, 3); return { bankName: x ? DIR[x.bk]?.name || b[code] || '' : b[code] || '', branchName: x ? DIR[`${x.bk}-${br}`]?.name || '' : '' }; }; };
const banksMap = async c => Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
let DIR = {};
const loadDir = async c => { DIR = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam, code_dtl_abr FROM code_m WHERE code_key='BKDIR'")).map(r => [r.code_dtl, { name: r.code_dtl_nam, kana: r.code_dtl_abr }])); return DIR; };
const payee = p => (p.bank_code ? { bank: p.bank_code, branch: p.branch_code, bankName: DIR[p.bank_code]?.name || '', branchName: DIR[p.bank_code + '-' + p.branch_code]?.name || '', type: p.account_type_code, typeName: TYPES[p.account_type_code] || '', account: p.account_number, holder: p.holder_name } : null);

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
    if (!map.has(k)) map.set(k, { label: `${p.vendor_code} ${p.vendor_name}`, vendor: p.vendor_code, bank: p.bank_code, branch: p.branch_code, bankName: DIR[p.bank_code]?.kana || '', branchName: DIR[p.bank_code + '-' + p.branch_code]?.kana || '', type: p.account_type_code, account: p.account_number, holder: p.holder_name || '', amount: 0, nos: [], customer1: p.vendor_code });
    const t = map.get(k); t.amount += p.bank; t.nos.push(p.payment_no);
  }
  const transfers = [...map.values()];
  const payer = { requesterCode: z.zg_code, requesterName: z.zg_name, bank: z.zg_bank, branch: (z.zg_bt || '').slice(0, 3), type: (z.zg_bt || '').slice(3, 4) || '1', account: z.zg_account, bankName: DIR[z.zg_bank]?.kana || '', branchName: DIR[z.zg_bank + '-' + (z.zg_bt || '').slice(0, 3)]?.kana || '' };
  const f = zenginFile({ date, payer, transfers });
  if (!transfers.length) f.errors.push('この振込指定日・振込元口座の支払がありません');
  // 振込指定日が休日（土日・カレンダーマスタ）なら作成しない（2026-10-31。テキストエディタで日付を直さなくて済むように）
  const hs = await holidaySet(c);
  if (isHoliday(date, hs)) f.errors.push(`振込指定日 ${date} は休日です（翌営業日は ${nextBusinessDay(date, hs)}）`);
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
    v.rows.push({ date: p.paid_on, no: p.payment_no, method: '銀行振込', bank: p.bank, fee: p.fee, offset: p.offset, safety: p.safety, advance: 0, paid: p.bank + p.fee + p.offset + p.safety, fromBank: p.from_bank ? `${p.from_bank} ${banks[p.from_bank] || ''}` : '', docs: p.docs.map(d => d.document_no).join(' '), payee: payee(p) });
    v.total += p.bank + p.fee + p.offset + p.safety;
  }
  return { title: '業者別支払内訳表', ref: 'NO45 / 添付帳票㉒', from, to, vendors, total: vendors.reduce((n, v) => n + v.total, 0) };
}
// ---------- NO46 振込依頼書 ----------
export async function transferRequest(c, q) {
  const date = isoDate(q.date, '振込指定日'), banks = await banksMap(c);
  const ps = await payments(c, 'p.paid_on=?', [date]), fb = await fromBankOf(c);
  const groups = [];
  for (const p of ps) {
    const k = p.from_bank || ''; let g = groups.find(x => x.fromBank === k); if (!g) groups.push(g = { fromBank: k, fromBankName: banks[k] || '', ...fb(k), rows: [], total: 0 });
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
  const adv = Object.fromEntries((await rows(c, "SELECT v.vendor_code, COALESCE((SELECT SUM(amount) FROM opening_balance o WHERE o.vendor_id=v.vendor_id AND o.balance_kind='ADVANCE'),0) + COALESCE((SELECT SUM(CASE WHEN l.side='D' THEN l.amount ELSE -l.amount END) FROM journal_line l JOIN journal_entry e ON e.journal_id=l.journal_id WHERE l.account_code='1431' AND l.vendor_id=v.vendor_id AND e.journal_date<=?),0) bal FROM vendor v", [date])).map(r => [r.vendor_code, num(r.bal)]));
  for (const d of docs) {
    const bal = num(d.gross_amount) - num(d.paid); if (bal <= 0) continue;
    let v = out.find(x => x.vendor === d.vendor_code); if (!v) out.push(v = { vendor: d.vendor_code, name: d.vendor_name, m3: 0, m2: 0, m1: 0, m0: 0, total: 0, offset: 0, net: 0, docs: [] });
    const m = d.booked_on.slice(0, 7), age = m === base ? 'm0' : m === addMonths(base, -1) ? 'm1' : m === addMonths(base, -2) ? 'm2' : 'm3';
    v[age] += bal; v.total += bal; v.offset = adv[d.vendor_code] || 0; v.net = v.total - v.offset; v.docs.push({ no: d.document_no, date: d.booked_on, memo: d.memo, gross: num(d.gross_amount), balance: bal });
  }
  return out;
}
export async function payableCarryover(c, q) {
  const date = isoDate(q.date || today(), '基準日'), list = await carryRows(c, date);
  const sum = k => list.reduce((n, v) => n + v[k], 0);
  // 現行 HJR241 は 3 か月（例 8/15 現在 → 5月 6月 7月）。当月分は直近の月（前月）の列に入れる。相殺繰越額（立替金残高）も直近の月の列（2026-11-04）
  for (const v of list) { v.l1 = v.m1 + v.m0; v.o3 = 0; v.o2 = 0; v.o1 = v.offset; }
  return { title: '支払繰越一覧表', ref: 'NO47 / 添付帳票㉔', date, months: { m3: `${addMonths(date.slice(0, 7), -3)}以前`, m2: addMonths(date.slice(0, 7), -2), m1: addMonths(date.slice(0, 7), -1), m0: date.slice(0, 7) },
    vendors: list, totals: { m3: sum('m3'), m2: sum('m2'), m1: sum('m1'), m0: sum('m0'), l1: sum('l1'), total: sum('total'), offset: sum('offset'), net: sum('net') }, note: '相殺繰越額＝業者立替金残高（業者マスタの開始残高−相殺済額、F-03 推定）。差引繰越額＝支払繰越合計−相殺繰越額。' };
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
    n.bank += p.bank; n.fee += p.fee; n.offset += p.offset; n.safety = (n.safety || 0) + p.safety; n.total += p.bank + p.fee + p.offset + p.safety;
    n.docs.push(...p.docs.map(d => ({ no: d.document_no, date: d.booked_on, memo: d.memo, gross: num(d.gross_amount), paid: num(d.amount) })));
  }
  // 現行 支払案内書の繰越表：繰越額＝支払前（前日まで）の未払残高、今回支払＝そのうち今回支払った額。3 か月（当月分は直近の月）。2026-11-04
  const prev = new Date(Date.parse(date) - 864e5).toISOString().slice(0, 10), three = x => (x ? [x.m3, x.m2, x.m1 + x.m0] : [0, 0, 0]);
  for (const n of notices) {
    const after = (await carryRows(c, date, n.vendor))[0], before = (await carryRows(c, prev, n.vendor))[0];
    n.carry = after ? { m3: after.m3, m2: after.m2, m1: after.m1, m0: after.m0, total: after.total } : { m3: 0, m2: 0, m1: 0, m0: 0, total: 0 };
    const b = three(before), a = three(after); n.before = b; n.paidBy = b.map((x, i) => x - a[i]);
  }
  const cp = await companyProfile(c);
  return { title: '支払案内書', ref: 'NO48 / 添付帳票㉕', date, profile: cp, company: { name: [co?.company_name1, co?.company_name2].filter(Boolean).join(' '), address: [co?.postcode && '〒' + co.postcode, co?.pref, co?.addr1].filter(Boolean).join(' '), tel: co?.tel_no || '' },
    months: { m3: `${addMonths(date.slice(0, 7), -3)}以前`, m2: addMonths(date.slice(0, 7), -2), m1: addMonths(date.slice(0, 7), -1), m0: date.slice(0, 7) }, notices };
}

// ---------- Excel ----------
const head = (d, sub) => [[T(d.title)], [`${sub}　出力日 ${today()}`], []];
const acct = p => (p ? `${p.bank} ${p.bankName} ${p.branch} ${p.branchName} ${p.typeName} ${p.account}`.replace(/ +/g, ' ') : '振込先未登録');
export async function paymentBook(c, kind, q) {
  const yy = x => `${x.slice(2, 4)}/${x.slice(5, 7)}/${x.slice(8, 10)}`, ymdJ = x => `${x.slice(2, 4)} 年 ${x.slice(5, 7)} 月 ${x.slice(8, 10)} 日`, mon = m => `${Number(m.slice(5, 7))} 月`;
  if (kind === 'vendor-payments') {
    // 現行 HJR211 の並び（2026-11-04）：業者ごとに 2 段。1 段目 業者コード 業者名 支払額 前払金 現金 小切手、2 段目 立替金 手数料 振込 手形 支払日。
    // 立替金＝相殺額（安全協力費を含む）、振込＝振込額。前払金・現金・小切手・手形の支払は新システムに無いため 0
    const d = await vendorPayments(c, q), out = [[T(d.title), '', '', '', '', `${ymdJ(d.from)}${d.from === d.to ? '' : ' 〜 ' + ymdJ(d.to)}`], [`出力日 ${today()}`], []];
    out.push(['業者コード', '業　者　名', '支払額', '前払金', '', '現　金', '小切手', ''].map(H), ['', '', '', '立替金', '手数料', '振　込', '手　形', '支払日'].map(H));
    const t = { paid: 0, adv: 0, offset: 0, fee: 0, bank: 0 };
    for (const v of d.vendors) for (const r of v.rows) {
      const off = r.offset + r.safety; out.push([v.vendor, v.name, r.paid, 0, '', 0, 0, ''], ['', '', '', off, r.fee, r.bank, 0, yy(r.date)]);
      t.paid += r.paid; t.offset += off; t.fee += r.fee; t.bank += r.bank;
    }
    out.push(['', S('合　　計'), S(t.paid), S(0), '', S(0), S(0), ''], ['', '', '', S(t.offset), S(t.fee), S(t.bank), S(0), '']);
    return { name: `業者別支払内訳表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '業者別支払内訳表', rows: out, widths: [11, 34, 13, 13, 10, 13, 11, 10] }]) };
  }
  if (kind === 'transfer-request') {
    // 現行 HJR220 の並び（2026-11-04）：支払元の「銀行　支店　御中」、振込指定日・依頼人。振込銀行名 支店名 種目 口座番号 受取人（上段カナ・下段名称） 金額 電信扱。支払元ごとに合計 件数・金額
    const d = await transferRequest(c, q), out = [[T(d.title)], [`出力日 ${today()}`], []];
    for (const g of d.groups) {
      out.push([H(g.bankName || g.fromBankName), H(g.branchName), H('御中'), '', '', `振込指定日 : ${ymdJ(d.date)}`], ['', '', '', '', '', `依頼人 : ${d.company}`]);
      out.push(['振込銀行名', '支店名', '種目', '口座番号', '受　取　人', '金　額', ''].map(H));
      for (const r of g.rows) out.push(['', '', '', '', r.payee?.holder || '', '', ''], [r.payee?.bankName || '未登録', r.payee?.branchName || '', r.payee?.typeName || '', r.payee?.account || '', r.name, r.amount, '電信扱']);
      out.push(['', '', '', '', S(`合　　計　　${g.rows.length} 件`), S(g.total), ''], []);
    }
    if (d.groups.length > 1) out.push(['', '', '', '', S(`総　合　計　　${d.groups.reduce((n, g) => n + g.rows.length, 0)} 件`), S(d.total), '']);
    if (!d.groups.length) out.push(['この振込指定日の振込はありません']);
    return { name: `振込依頼書_${d.date}.xlsx`, body: xlsx([{ name: '振込依頼書', rows: out, widths: [16, 14, 7, 11, 40, 13, 8] }]) };
  }
  if (kind === 'carryover') {
    // 現行 HJR241 の並び（2026-11-04）：業者CD 業者名 ／ 支払繰越額（3 か月・合計）／ 相殺繰越額（3 か月・合計）／ 差引繰越額。見出し 2 段
    const d = await payableCarryover(c, q), m = d.months, out = [[T(d.title), '', '', '', '', '', `${ymdJ(d.date)}現在`], [`出力日 ${today()}`], []];
    const ms = [mon(m.m3 + '-'), mon(m.m2), mon(m.m1)];
    out.push(['業者CD', '業　者　名', '支　払　繰　越　額', '', '', '', '相　殺　繰　越　額', '', '', '', ''].map(H), ['', '', ...ms, '合　計', ...ms, '合　計', '差引繰越額'].map(H));
    for (const v of d.vendors) out.push([v.vendor, v.name, v.m3, v.m2, v.l1, v.total, v.o3, v.o2, v.o1, v.offset, v.net]);
    const t = d.totals; out.push([], ['', S('合　　計'), S(t.m3), S(t.m2), S(t.l1), S(t.total), S(0), S(0), S(t.offset), S(t.offset), S(t.net)]);
    return { name: `支払繰越一覧表_${d.date}.xlsx`, body: xlsx([{ name: '支払繰越一覧表', rows: out, widths: [10, 34, 13, 13, 13, 14, 12, 12, 12, 12, 14] }]) };
  }
  if (kind === 'notices') {
    // 現行 支払案内書の並び（2026-11-04）：宛先（〒・住所・業者名 御中・（業者コード））と発行元（〒・住所・会社名・共同企業体・TEL・FAX・登録番号）、
    // 締切日・必着日の案内、支払合計／手形／振込／振込手数料（内消費税）と支払日・振込銀行・口座、繰越額・今回支払（3 か月）。業者の住所は業者マスタに無いため空欄
    const d = await paymentNotices(c, q), m = d.months, p = d.profile, ms = [mon(m.m3 + '-'), mon(m.m2), mon(m.m1)], out = [];
    const zip = z => (z ? `〒 ${String(z).replace(/^(\d{3})-?(\d{4})$/, '$1-$2')}` : ''), jd = x => `${x.slice(2, 4)} 年 ${Number(x.slice(5, 7))} 月 ${Number(x.slice(8, 10))} 日`;
    for (const n of d.notices) {
      out.push(['', '', T('支　払　案　内　書'), '', jd(today())], []);
      const left = ['', '', '', n.name, '', `（ ${n.vendor} ）`], right = [zip(p.postcode), [p.pref, p.addr1].filter(Boolean).join('') + (p.addr2 ? ' ' + p.addr2 : ''), p.name1, p.name2, `TEL : ${p.tel}`, p.fax ? `FAX : ${p.fax}` : '', p.invoiceNo ? `登録番号 ${p.invoiceNo}` : ''];
      for (let k = 0; k < Math.max(left.length, right.length); k++) out.push([left[k] || '', k === 3 ? '御中' : '', '', '', right[k] || '']);
      out.push([], ['毎月 20 日 ･･･ 締切日'], ['毎月 26 日 ･･･ 必着（ 26 日以降の請求については翌月へ繰越となります ）'], [], ['請求書には業者コードをお忘れなく'], []);
      const feeTax = Math.floor(n.fee * 10 / 110);
      out.push([H('支払合計'), n.total, '', `${jd(d.date)}支払`], ['', '', '', `振込銀行 : ${n.payee?.bankName || '未登録'}　${n.payee?.branchName || ''}`], ['手　形', 0, '', n.payee ? `${(n.payee.typeName || '').slice(0, 1)} ${n.payee.account}` : ''], ['振　込', n.bank], ['振込手数料', n.fee, `（ 内消費税　${feeTax}　税率 10% ）`], []);
      out.push(['', ...ms].map(H), ['繰越額', ...n.before], ['今回支払', ...n.paidBy], [], []);
    }
    if (!d.notices.length) out.push(['この支払日の支払はありません']);
    return { name: `支払案内書_${d.date}.xlsx`, body: xlsx([{ name: '支払案内書', rows: out, widths: [14, 14, 22, 30, 34], portrait: true }]) };
  }
  check(false, '帳票の種類が不正です');
}
