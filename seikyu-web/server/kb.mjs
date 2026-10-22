// 財務会計（勘定奉行相当）: 仕訳伝票入力・仕訳帳・総勘定元帳/補助元帳・合計残高試算表・月次推移表・決算書・消費税集計表・仕訳受入/書出。
// 科目コード・名称は account_subject（請求システムと共通）、会計属性（区分・貸借・補助区分・既定税区分）は kb_account に持つ。
// 金額は整数円。集計の内部値は「借方プラス」の符号付きで持ち、表示時に科目の正残高側へ符号を合わせる。
import { check, Conflict, text, bool, yen, isoDate, today, csv, parseCsv } from './domain.mjs';
import { rows, one, audit } from './db.mjs';
import { xlsx } from './xlsx.mjs';
import { PATTERNS } from './ledger.mjs';
import { SYSTEM_ACCOUNTS } from './masters.mjs';
import { decode, taxOf, CATALOG, TAX_KIND, TAX_RATE } from './taxcode.mjs';
import { bugyoSettings, bugyoFile } from './bugyo.mjs';
import { getsudo } from './period.mjs';

// [区分コード, 名称, 区分(BS-A 資産 / BS-L 負債 / BS-E 純資産 / PL), 正残高]
export const GROUPS = [
  ['A1', '当座資産', 'BS-A', 'D'], ['A2', '棚卸資産', 'BS-A', 'D'], ['A3', 'その他流動資産', 'BS-A', 'D'], ['A4', '有形固定資産', 'BS-A', 'D'], ['A5', '無形固定資産', 'BS-A', 'D'],
  ['A6', '投資その他の資産', 'BS-A', 'D'], ['A7', '繰延資産', 'BS-A', 'D'], ['L1', '流動負債', 'BS-L', 'C'], ['L2', '固定負債', 'BS-L', 'C'],
  ['E1', '資本金', 'BS-E', 'C'], ['E2', '法定準備金', 'BS-E', 'C'], ['E3', '剰余金', 'BS-E', 'C'],
  ['P1', '売上高', 'PL', 'C'], ['P2', '売上原価（製造原価）', 'PL', 'D'], ['P3', '販売費及び一般管理費', 'PL', 'D'], ['P4', '営業外収益', 'PL', 'C'], ['P5', '営業外費用', 'PL', 'D'],
  ['P6', '特別利益', 'PL', 'C'], ['P7', '特別損失', 'PL', 'D'], ['P8', '法人税等', 'PL', 'D'],
].map(([code, name, section, side]) => ({ code, name, section, side }));
const GROUP = Object.fromEntries(GROUPS.map(g => [g.code, g]));
export const SECTIONS = { 'BS-A': '資産の部', 'BS-L': '負債の部', 'BS-E': '純資産の部', PL: '損益の部' };

// 税区分は現行の処税率（3桁, taxcode.mjs）をそのまま使う。請求システムの仕訳・CSV の処税率と同じコード体系。
export const TAXES = CATALOG;
export const SUB_KINDS = { '': 'なし', CUST: '得意先', VEND: '業者', SUB: '内訳科目' };
export const SOURCES = { MANUAL: '手入力', SEIKYU: '請求システム', CSV: 'CSV受入' };
const RETAINED = '7350'; // 前期繰越利益（前期までの損益を累積する科目）
const VAT_ACCOUNTS = { 4415: 'S', 1465: 'P' }; // 仮受消費税・仮払消費税

// 顧客（エーシートヨアケ）の勘定科目マスター一覧（2026-06-26, analysis/ocr/06）から転記。[コード, 名称, 区分, 補助, 既定税区分]
const CHART = [
  ['1111', '現金', 'A1'], ['1112', '当座預金', 'A1', 'SUB'], ['1113', '普通預金', 'A1', 'SUB'], ['1120', '受取手形', 'A1', 'CUST'], ['1122', '受取手形（工事分）', 'A1', 'CUST'], ['1125', '手形出資', 'A1', 'VEND'],
  ['1130', '完成工事未収入金', 'A1', 'CUST'], ['1131', '売掛金', 'A1', 'CUST'], ['1360', '材料及び貯蔵品', 'A2', 'SUB'],
  ['1420', '前払費用', 'A3'], ['1431', '業者立替金', 'A3', 'VEND'], ['1433', 'その他立替金', 'A3'], ['1440', '短期保証金', 'A3', 'VEND'], ['1450', '未収入金', 'A3', 'VEND'], ['1465', '仮払消費税', 'A3'],
  ['1470', '仮払金', 'A3', 'SUB'], ['1480', '構成員分配金', 'A3', 'VEND'], ['2310', '電話施設利用権', 'A5'], ['3160', '開発費', 'A7'],
  ['4110', '支払手形', 'L1', 'VEND'], ['4121', '買掛金', 'L1', 'VEND'], ['4140', '未払金', 'L1', 'VEND'], ['4150', '未払費用', 'L1', 'VEND'], ['4170', '預り金', 'L1', 'CUST'], ['4171', '預り金（安全協力費等）', 'L1', 'SUB'],
  ['4180', '未払法人税等', 'L1'], ['4199', '構成員出資金', 'L1', 'VEND'], ['4410', '仮受金', 'L1', 'CUST'], ['4415', '仮受消費税', 'L1'],
  ['7110', '資本金', 'E1'], ['7260', '利益準備金', 'E2'], ['7320', '別途積立金', 'E3'], ['7321', '出資・分配差額', 'E3'], ['7322', '消費税差額', 'E3'], ['7350', '前期繰越利益', 'E3'],
  ['8110', '完成工事高', 'P1', 'CUST', '111'], ['8130', '合材売上', 'P1', 'CUST', '111'],
  ['8230', '期首棚卸高', 'P2'], ['8231', '仕入', 'P2', '', '141'], ['82316', '期末棚卸高', 'P2'], ['8232', '労務費', 'P2', '', '141'], ['8233', '外注費', 'P2', '', '141'], ['8241', '仮設費', 'P2', '', '141'],
  ['8242', '動力用水光熱費', 'P2', 'SUB', '141'], ['8243', '運賃', 'P2', 'SUB', '141'], ['8244', '機械等経費', 'P2', 'SUB', '141'], ['8250', '保険料', 'P2'], ['8251', '従業員給与手当', 'P2'], ['8252', '法定福利費', 'P2'],
  ['8253', '福利厚生費', 'P2', '', '141'], ['8254', '事務用品費', 'P2', '', '141'], ['8255', '旅費交通費', 'P2', '', '141'], ['8256', '車輌維持費', 'P2', '', '141'], ['8257', '通信費', 'P2', '', '141'],
  ['8258', '交際費', 'P2', '', '141'], ['8259', '補償費', 'P2', '', '141'], ['8260', '雑費', 'P2', 'SUB', '141'],
  ['8312', '従業員給与', 'P3'], ['8314', '法定福利費', 'P3'], ['8315', '福利厚生費', 'P3', 'SUB', '141'], ['8316', '修繕維持費', 'P3', 'SUB', '141'], ['8317', '事務用品費', 'P3', 'SUB', '141'],
  ['8318', '旅費交通費', 'P3', 'SUB', '141'], ['83181', '車輌維持費', 'P3', 'SUB', '141'], ['8319', '通信費', 'P3', 'SUB', '141'], ['8320', '用水光熱費', 'P3', 'SUB', '141'], ['8321', '調査研究費', 'P3', '', '141'],
  ['8322', '広告宣伝費', 'P3', '', '141'], ['8323', '交際費', 'P3', 'SUB', '141'], ['8324', '寄付金', 'P3'], ['8325', '地代家賃', 'P3', '', '141'], ['8326', '減価償却費', 'P3'], ['8327', '租税公課', 'P3'],
  ['8328', '賦課金及会費', 'P3', '', '041'], ['8329', '保険料', 'P3', 'SUB', '070'], ['8330', '雑費', 'P3', 'SUB', '141'], ['8331', '会議費', 'P3', '', '141'], ['8332', '購読料', 'P3', 'SUB', '148'],
  ['8610', '受取利息', 'P4', 'SUB'], ['8630', '受取地代家賃', 'P4', 'SUB', '111'], ['8650', '材料売却収入', 'P4', '', '111'], ['8790', '雑収入', 'P4', 'SUB'],
  ['8810', '支払利息割引料', 'P5', 'SUB'], ['8850', '雑損失', 'P5', '', '141'], ['9150', '前期損益修正益', 'P6'], ['9217', '前期損益修正損', 'P7'], ['9410', '法人税等', 'P8'],
];
// 区分未設定の科目（請求システムのマスタで追加された科目など）はコード体系から推定する
const guessGroup = code => { const s = String(code); if (s.startsWith('1')) return 'A3'; if (s.startsWith('2')) return 'A4'; if (s.startsWith('3')) return 'A7'; if (s.startsWith('4')) return 'L1';
  if (/^[56]/.test(s)) return 'L2'; if (s.startsWith('7')) return 'E3'; if (s.startsWith('81')) return 'P1'; if (s.startsWith('82')) return 'P2'; if (/^8[67]/.test(s)) return 'P4'; if (s.startsWith('88')) return 'P5';
  if (s.startsWith('91')) return 'P6'; if (s.startsWith('92')) return 'P7'; if (s.startsWith('94')) return 'P8'; return 'P3'; };

export async function prepareKb(pool) {
  const C = 'COLLATE "C"';
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_account (account_code varchar(20) ${C} PRIMARY KEY, grp varchar(4) ${C} NOT NULL, side char(1) ${C} NOT NULL, sub_kind varchar(8) ${C} NOT NULL DEFAULT '',
    tax_code varchar(4) ${C} NOT NULL DEFAULT '090', sort_no integer NOT NULL DEFAULT 0, guessed boolean NOT NULL DEFAULT FALSE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_setting (k varchar(32) ${C} PRIMARY KEY, v varchar(200) ${C} NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_opening (account_code varchar(20) ${C} NOT NULL, sub_code varchar(20) ${C} NOT NULL DEFAULT '', amount bigint NOT NULL, PRIMARY KEY (account_code, sub_code))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_import (import_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, source varchar(8) ${C} NOT NULL, label varchar(200) ${C} NOT NULL,
    slips integer NOT NULL, amount bigint NOT NULL, status varchar(10) ${C} NOT NULL, imported_by varchar(256) ${C} NOT NULL, imported_at timestamp(6) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_slip (slip_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, slip_no integer NOT NULL, slip_date date NOT NULL, memo varchar(100) ${C} NOT NULL DEFAULT '',
    source varchar(8) ${C} NOT NULL, source_ref varchar(40) ${C}, import_id bigint REFERENCES kb_import (import_id), version integer NOT NULL DEFAULT 1,
    created_by varchar(256) ${C} NOT NULL, created_at timestamp(6) NOT NULL, updated_by varchar(256) ${C} NOT NULL, updated_at timestamp(6) NOT NULL)`);
  await pool.query('CREATE INDEX IF NOT EXISTS ix_kb_slip_date ON kb_slip (slip_date, slip_no)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_slip_source ON kb_slip (source, source_ref) WHERE source_ref IS NOT NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_line (slip_id bigint NOT NULL REFERENCES kb_slip (slip_id) ON DELETE CASCADE, row_no integer NOT NULL, side char(1) ${C} NOT NULL CHECK (side IN ('D','C')),
    account_code varchar(20) ${C} NOT NULL, sub_code varchar(20) ${C} NOT NULL DEFAULT '', dept_code varchar(12) ${C} NOT NULL DEFAULT '', tax_code varchar(4) ${C} NOT NULL DEFAULT '090',
    amount bigint NOT NULL CHECK (amount > 0), tax_amount bigint NOT NULL DEFAULT 0, tax_excl boolean NOT NULL DEFAULT FALSE, memo varchar(100) ${C} NOT NULL DEFAULT '', PRIMARY KEY (slip_id, row_no, side))`);
  await pool.query('CREATE INDEX IF NOT EXISTS ix_kb_line_account ON kb_line (account_code, sub_code)');
  for (const [i, [code, name, grp, sub = '', tax = '090']] of CHART.entries()) {
    await pool.query('INSERT IGNORE INTO account_subject (account_code,account_name,active) VALUES (?,?,TRUE)', [code, name]);
    await pool.query('INSERT IGNORE INTO kb_account (account_code,grp,side,sub_kind,tax_code,sort_no) VALUES (?,?,?,?,?,?)', [code, grp, GROUP[grp].side, sub, tax, (i + 1) * 10]);
  }
  // 2026-10-21: 独自の税区分（00/10/11/12/20/21/22）から処税率へ切替（消費税区分.xlsx）。一度だけ実行。
  const [[scheme]] = await pool.query("SELECT v FROM kb_setting WHERE k='tax_scheme'");
  if (!scheme) {
    await pool.query(`UPDATE kb_line SET tax_code=CASE tax_code WHEN '00' THEN '090' WHEN '10' THEN (CASE WHEN tax_excl THEN '011' ELSE '111' END) WHEN '11' THEN (CASE WHEN tax_excl THEN '018' ELSE '118' END)
      WHEN '12' THEN '020' WHEN '20' THEN (CASE WHEN tax_excl THEN '241' ELSE '141' END) WHEN '21' THEN (CASE WHEN tax_excl THEN '248' ELSE '148' END) WHEN '22' THEN '070' ELSE tax_code END`);
    await pool.query("UPDATE kb_account SET tax_code=CASE tax_code WHEN '00' THEN '090' WHEN '10' THEN '111' WHEN '11' THEN '118' WHEN '12' THEN '020' WHEN '20' THEN '141' WHEN '21' THEN '148' WHEN '22' THEN '070' ELSE tax_code END");
    await pool.query("INSERT INTO kb_setting (k,v) VALUES ('tax_scheme','shozeiritsu')");
  }
  // 2026-10-21 ハーツ＆ソウル仕訳帳の実績から科目の既定処税率を補正（一度だけ）
  const [[acctTax]] = await pool.query("SELECT 1 x FROM kb_setting WHERE k='acct_tax_hs'");
  if (!acctTax) {
    for (const [code, tax] of ACCOUNT_TAX_HS) await pool.query('UPDATE kb_account SET tax_code=? WHERE account_code=?', [tax, code]);
    await pool.query("INSERT INTO kb_setting (k,v) VALUES ('acct_tax_hs','1')");
  }
}
const ACCOUNT_TAX_HS = [['8329', '070'], ['8328', '041'], ['8332', '148'], ['8251', '090'], ['8312', '090']];
// 2026-10-21 ハーツ＆ソウル仕訳帳：会計月度 21日〜20日・決算 10月20日へ一度だけ切替（初期値 3月末のままの会社のみ）。導入年度は従来の期首・最古伝票を含む年度に読み替える。
export async function getsudoMigration(pool) {
  const [[done]] = await pool.query("SELECT 1 x FROM kb_setting WHERE k='getsudo'");
  if (done) return;
  const [[ci]] = await pool.query('SELECT closing_m, closing_d FROM company_info_m WHERE company_info_id=1');
  if (ci && Number(ci.closing_m) === 3 && Number(ci.closing_d) === 31) {
    const [[s]] = await pool.query("SELECT v FROM kb_setting WHERE k='start_fy'"), [[m]] = await pool.query('SELECT MIN(slip_date) d FROM kb_slip');
    await pool.query('UPDATE company_info_m SET closing_m=10, closing_d=20 WHERE company_info_id=1');
    const G = getsudo({ closingMonth: 10, closingDay: 20 }), t = today(), oldFy = s ? Number(s.v) : (+t.slice(5, 7) >= 4 ? +t.slice(0, 4) : +t.slice(0, 4) - 1);
    const dates = [`${oldFy}-04-01`, m?.d ? String(m.d).slice(0, 10) : ''].filter(Boolean).sort();
    await pool.query('INSERT INTO kb_setting (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', ['start_fy', String(G.fyOf(dates[0]))]);
  }
  await pool.query("INSERT INTO kb_setting (k,v) VALUES ('getsudo','10/20')");
}

// ---------- 共通 ----------
// 会計年度・月度は自社情報の決算月・締日（現行 仕訳帳 AC2205：月度 21日〜20日、期首 10月21日）
async function fiscal(c) {
  const ci = await one(c, 'SELECT closing_m, closing_d FROM company_info_m WHERE company_info_id=1');
  const G = getsudo({ closingMonth: ci?.closing_m, closingDay: ci?.closing_d }), closingMonth = G.closingMonth, startMonth = closingMonth % 12 + 1;
  const s = Object.fromEntries((await rows(c, 'SELECT k, v FROM kb_setting')).map(r => [r.k, r.v]));
  const fyOf = G.fyOf, range = G.fyRange;
  const startFy = Number(s.start_fy) || fyOf(today());
  return { closingMonth, startMonth, closingDay: G.closingDay, labelOf: G.labelOf, monthRange: G.monthRange, months: G.months, fyOf, range, startFy, startDate: range(startFy).from, lockDate: s.lock_date || '', currentFy: fyOf(today()) };
}
const fyLabel = (F, fy) => { const r = F.range(fy); return `${fy}年度（${r.from}〜${r.to}）`; };

// 区分未設定の科目に推定区分を付ける（請求システム側で追加された科目）
async function ensureAttrs(c) {
  const miss = await rows(c, 'SELECT a.account_code FROM account_subject a LEFT JOIN kb_account k ON k.account_code=a.account_code WHERE k.account_code IS NULL');
  for (const r of miss) { const g = guessGroup(r.account_code); await c.query('INSERT IGNORE INTO kb_account (account_code,grp,side,sub_kind,tax_code,sort_no,guessed) VALUES (?,?,?,?,?,?,TRUE)', [r.account_code, g, GROUP[g].side, '', '090', 99999]); }
}
async function accountMap(c) {
  await ensureAttrs(c);
  const rs = await rows(c, 'SELECT a.account_code, a.account_name, a.active, k.grp, k.side, k.sub_kind, k.tax_code, k.sort_no, k.guessed FROM account_subject a JOIN kb_account k ON k.account_code=a.account_code');
  const order = Object.fromEntries(GROUPS.map((g, i) => [g.code, i]));
  return new Map(rs.sort((a, b) => order[a.grp] - order[b.grp] || a.sort_no - b.sort_no || a.account_code.localeCompare(b.account_code))
    .map(r => [r.account_code, { code: r.account_code, name: r.account_name, active: !!r.active, grp: r.grp, side: r.side, sub: r.sub_kind, tax: r.tax_code, sort: r.sort_no, guessed: !!r.guessed, section: GROUP[r.grp]?.section || 'PL' }]));
}
async function subNamer(c) {
  const m = new Map();
  for (const r of await rows(c, 'SELECT account_code, sub_code, sub_name FROM account_subsubject')) m.set(`S|${r.account_code}|${r.sub_code}`, r.sub_name);
  for (const r of await rows(c, 'SELECT customers_cd, customers_name FROM client_m')) m.set(`C|${r.customers_cd}`, r.customers_name);
  for (const r of await rows(c, 'SELECT vendor_code, vendor_name FROM vendor')) m.set(`V|${r.vendor_code}`, r.vendor_name);
  return (acc, sub) => !sub ? '' : acc?.sub === 'CUST' ? m.get(`C|${sub}`) || '' : acc?.sub === 'VEND' ? m.get(`V|${sub}`) || '' : m.get(`S|${acc?.code}|${sub}`) || '';
}
async function deptNames(c) { return new Map((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='DEPT'")).map(r => [r.code_dtl, r.code_dtl_nam])); }
const sign = acc => (acc.side === 'D' ? 1 : -1);
function period(F, q, { sameFy = true } = {}) {
  const cur = F.monthRange(F.labelOf(today())), from = q.from ? isoDate(q.from, '開始日') : cur.from, to = q.to ? isoDate(q.to, '終了日') : cur.to;
  check(from <= to, '期間が不正です');
  check(to >= F.startDate, `期間は導入年度の期首 ${F.startDate} 以降で指定してください`);
  const f = from < F.startDate ? F.startDate : from;
  if (sameFy) check(F.fyOf(f) === F.fyOf(to), '期間は同一会計年度内で指定してください');
  return { from: f, to, fy: F.fyOf(f), fyStart: F.range(F.fyOf(f)).from };
}

export async function kbMeta(c) {
  const F = await fiscal(c), A = await accountMap(c);
  const fys = []; for (let y = F.startFy; y <= Math.max(F.currentFy, F.startFy) + 1; y++) fys.push({ fy: y, label: fyLabel(F, y), ...F.range(y) });
  return { groups: GROUPS, sections: SECTIONS, taxes: TAXES, taxKinds: TAX_KIND, taxRates: TAX_RATE, subKinds: SUB_KINDS, sources: SOURCES,
    fiscal: { startFy: F.startFy, startDate: F.startDate, lockDate: F.lockDate, closingMonth: F.closingMonth, closingDay: F.closingDay, startMonth: F.startMonth, currentFy: F.currentFy, currentMonth: F.labelOf(today()), years: fys },
    accounts: [...A.values()] };
}

// ---------- 集計 ----------
// 科目（×補助）ごとに 期間前残高・期間借方・期間貸方・期間後残高（借方プラス）を返す。PL 科目の期間前残高は期首から、BS 科目は導入期首から＋期首残高。
async function balances(c, F, A, { from, to, fyStart, dept, account, bySub = false }) {
  const w = ['s.slip_date BETWEEN ? AND ?'], args = [from, fyStart, from, from, from, F.startDate, to];
  if (dept) { w.push('l.dept_code=?'); args.push(dept); }
  if (account) { w.push('l.account_code=?'); args.push(account); }
  const sub = bySub ? 'l.sub_code' : "''";
  const rs = await rows(c, `SELECT l.account_code a, ${sub} sub,
      SUM(CASE WHEN s.slip_date < ? THEN (CASE WHEN l.side='D' THEN l.amount ELSE -l.amount END) ELSE 0 END) pre_all,
      SUM(CASE WHEN s.slip_date >= ? AND s.slip_date < ? THEN (CASE WHEN l.side='D' THEN l.amount ELSE -l.amount END) ELSE 0 END) pre_fy,
      SUM(CASE WHEN s.slip_date >= ? AND l.side='D' THEN l.amount ELSE 0 END) dr,
      SUM(CASE WHEN s.slip_date >= ? AND l.side='C' THEN l.amount ELSE 0 END) cr
    FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id WHERE ${w.join(' AND ')} GROUP BY l.account_code${bySub ? ', l.sub_code' : ''}`, args);
  const out = new Map(), key = (a, s) => `${a}|${s}`;
  const get = (a, s) => { const k = key(a, s); if (!out.has(k)) out.set(k, { account: a, sub: s, opening: 0, dr: 0, cr: 0 }); return out.get(k); };
  for (const r of rs) {
    const acc = A.get(r.a), pl = !acc || acc.section === 'PL', b = get(r.a, r.sub);
    b.opening += pl ? Number(r.pre_fy) : Number(r.pre_all); b.dr += Number(r.dr); b.cr += Number(r.cr);
  }
  if (!dept) {
    for (const o of await rows(c, `SELECT account_code, sub_code, amount FROM kb_opening${account ? ' WHERE account_code=?' : ''}`, account ? [account] : [])) get(o.account_code, bySub ? o.sub_code : '').opening += Number(o.amount);
    // 導入期首〜当期首前日の損益は前期繰越利益へ繰り越す
    if (!account || account === RETAINED) {
      let prior = 0;
      for (const r of await rows(c, "SELECT l.account_code a, SUM(CASE WHEN l.side='D' THEN l.amount ELSE -l.amount END) v FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id WHERE s.slip_date >= ? AND s.slip_date < ? GROUP BY l.account_code", [F.startDate, fyStart]))
        if ((A.get(r.a)?.section || 'PL') === 'PL') prior += Number(r.v);
      if (prior) get(RETAINED, '').opening += prior;
    }
  }
  for (const b of out.values()) b.closing = b.opening + b.dr - b.cr;
  return out;
}
// 段階利益（正残高符号の区分合計から）
function profits(g) {
  const v = k => g[k] || 0, gross = v('P1') - v('P2'), op = gross - v('P3'), ord = op + v('P4') - v('P5'), pre = ord + v('P6') - v('P7');
  return { gross, op, ord, pre, net: pre - v('P8') };
}
const PROFIT_AFTER = { P2: [['gross', '売上総利益']], P3: [['op', '営業利益']], P5: [['ord', '経常利益']], P7: [['pre', '税引前当期純利益']], P8: [['net', '当期純利益']] };

// 合計残高試算表（貸借対照表・損益計算書）。行: type acct / group（区分計）/ section（部計）/ calc（段階利益）
export async function trialBalance(c, q = {}) {
  const F = await fiscal(c), A = await accountMap(c), p = period(F, q);
  const B = await balances(c, F, A, { ...p, dept: q.dept || '' });
  const val = (b, acc, k) => b[k] * (k === 'dr' || k === 'cr' ? 1 : sign(acc));
  const groupSum = {}, rowsOut = { BS: [], PL: [] }, gsum = { opening: {}, closing: {} };
  let totDr = 0, totCr = 0;
  for (const g of GROUPS) {
    const accs = [...A.values()].filter(a => a.grp === g.code), lines = [];
    const sum = { opening: 0, dr: 0, cr: 0, closing: 0 };
    for (const acc of accs) {
      const b = B.get(`${acc.code}|`) || { opening: 0, dr: 0, cr: 0, closing: 0 };
      if (!acc.active && !b.opening && !b.dr && !b.cr) continue;
      const r = { type: 'acct', sec: g.section, code: acc.code, label: acc.name, opening: val(b, acc, 'opening'), dr: b.dr, cr: b.cr, closing: val(b, acc, 'closing'), guessed: acc.guessed };
      for (const k of Object.keys(sum)) sum[k] += r[k];
      totDr += b.dr; totCr += b.cr;
      if (q.all === '1' || r.opening || r.dr || r.cr || r.closing) lines.push(r);
    }
    gsum.opening[g.code] = sum.opening; gsum.closing[g.code] = sum.closing;
    const target = g.section === 'PL' ? rowsOut.PL : rowsOut.BS;
    // 取引も残高もない区分は見出しごと省略（全科目表示時と、段階利益の直前区分は残す）
    if (!lines.length && q.all !== '1' && !PROFIT_AFTER[g.code]) { groupSum[g.code] = sum; continue; }
    target.push({ type: 'group', sec: g.section, code: g.code, label: g.name }, ...lines, { type: 'total', sec: g.section, code: g.code, label: `${g.name}合計`, ...sum });
    groupSum[g.code] = sum;
  }
  const pOpen = profits(gsum.opening), pClose = profits(gsum.closing);
  // 損益：区分の後に段階利益を差し込む
  const PL = [];
  for (const r of rowsOut.PL) { PL.push(r); if (r.type === 'total' && PROFIT_AFTER[r.code]) for (const [k, label] of PROFIT_AFTER[r.code]) PL.push({ type: 'calc', label, opening: pOpen[k], closing: pClose[k] }); }
  // 貸借：部計と当期純利益
  const secSum = (sec, k) => GROUPS.filter(g => g.section === sec).reduce((n, g) => n + groupSum[g.code][k], 0);
  const BS = [];
  for (const sec of ['BS-A', 'BS-L', 'BS-E']) {
    BS.push({ type: 'section', label: SECTIONS[sec] });
    BS.push(...rowsOut.BS.filter(r => r.sec === sec));
    if (sec === 'BS-E') BS.push({ type: 'calc', label: '当期純利益（損益計算書より）', opening: pOpen.net, closing: pClose.net });
    const s = { opening: secSum(sec, 'opening'), dr: secSum(sec, 'dr'), cr: secSum(sec, 'cr'), closing: secSum(sec, 'closing') };
    if (sec === 'BS-E') { s.opening += pOpen.net; s.closing += pClose.net; }
    BS.push({ type: 'grand', label: `${SECTIONS[sec].replace('の部', '')}合計`, ...s, key: sec });
  }
  const asset = secSum('BS-A', 'closing'), liabEq = secSum('BS-L', 'closing') + secSum('BS-E', 'closing') + pClose.net;
  BS.push({ type: 'grand', label: '負債・純資産合計', opening: secSum('BS-L', 'opening') + secSum('BS-E', 'opening') + pOpen.net, closing: liabEq });
  const opening = await one(c, 'SELECT COALESCE(SUM(amount),0) n FROM kb_opening');
  return { from: p.from, to: p.to, fy: p.fy, fyLabel: fyLabel(F, p.fy), dept: q.dept || '', BS, PL, profit: pClose,
    check: { dr: totDr, cr: totCr, balanced: totDr === totCr, assets: asset, liabEq, bsBalanced: asset === liabEq, openingDiff: q.dept ? 0 : Number(opening.n) },
    guessed: [...A.values()].filter(a => a.guessed).map(a => a.code) };
}

// 月次推移表：BS は月末残高、PL は月別発生額（kind=bs|pl）
export async function monthly(c, q = {}) {
  const F = await fiscal(c), A = await accountMap(c), fy = Number(q.fy) || F.currentFy;
  check(fy >= F.startFy && fy <= F.currentFy + 1, '会計年度が範囲外です');
  const { from, to } = F.range(fy), months = F.months(fy), kind = q.kind === 'bs' ? 'bs' : 'pl';
  const args = [F.startDate, to]; let dw = '';
  if (q.dept) { dw = ' AND l.dept_code=?'; args.push(q.dept); }
  // 月度（締日基準）で集計：日付ごとに合計してから月度ラベルへ寄せる
  const rs = (await rows(c, `SELECT l.account_code a, s.slip_date d, SUM(CASE WHEN l.side='D' THEN l.amount ELSE -l.amount END) v
    FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id WHERE s.slip_date BETWEEN ? AND ?${dw} GROUP BY l.account_code, s.slip_date`, args)).map(r => ({ a: r.a, m: F.labelOf(String(r.d).slice(0, 10)), v: r.v }));
  const mv = new Map(); // account -> {before: v, m: [12]}
  for (const r of rs) {
    if (!mv.has(r.a)) mv.set(r.a, { before: 0, prior: 0, m: Array(12).fill(0) });
    const x = mv.get(r.a), i = months.indexOf(r.m);
    if (i >= 0) x.m[i] += Number(r.v); else if (r.m < months[0]) { x.before += Number(r.v); }
  }
  // 前期繰越利益に前期までの損益を寄せる
  let prior = 0;
  for (const [a, x] of mv) { const acc = A.get(a); if (!acc || acc.section === 'PL') { prior += x.before; x.before = 0; } }
  if (!q.dept) {
    for (const o of await rows(c, 'SELECT account_code, SUM(amount) amount FROM kb_opening GROUP BY account_code')) { if (!mv.has(o.account_code)) mv.set(o.account_code, { before: 0, m: Array(12).fill(0) }); mv.get(o.account_code).before += Number(o.amount); }
    if (prior) { if (!mv.has(RETAINED)) mv.set(RETAINED, { before: 0, m: Array(12).fill(0) }); mv.get(RETAINED).before += prior; }
  }
  const out = [], gm = {};
  for (const g of GROUPS.filter(g => (kind === 'pl') === (g.section === 'PL'))) {
    const sum = Array(12).fill(0); let sumOpen = 0; const lines = [];
    for (const acc of [...A.values()].filter(a => a.grp === g.code)) {
      const x = mv.get(acc.code); if (!x) continue;
      const s = sign(acc);
      let vals;
      if (kind === 'pl') vals = x.m.map(v => v * s);
      else { let run = x.before; vals = x.m.map(v => (run += v) * s); }
      const opening = kind === 'bs' ? x.before * s : 0;
      if (!vals.some(Boolean) && !opening) continue;
      lines.push({ type: 'acct', code: acc.code, label: acc.name, opening, values: vals, total: kind === 'pl' ? vals.reduce((n, v) => n + v, 0) : vals[11] });
      vals.forEach((v, i) => (sum[i] += v)); sumOpen += opening;
    }
    gm[g.code] = sum;
    out.push({ type: 'group', label: g.name }, ...lines, { type: 'total', code: g.code, label: `${g.name}合計`, opening: sumOpen, values: sum, total: kind === 'pl' ? sum.reduce((n, v) => n + v, 0) : sum[11] });
    if (kind === 'pl' && PROFIT_AFTER[g.code]) for (const [k, label] of PROFIT_AFTER[g.code]) {
      const vals = months.map((_, i) => profits(Object.fromEntries(Object.entries(gm).map(([gc, arr]) => [gc, arr[i]])))[k]);
      out.push({ type: 'calc', label, values: vals, total: vals.reduce((n, v) => n + v, 0) });
    }
  }
  return { fy, fyLabel: fyLabel(F, fy), kind, months, rows: out };
}

// 総勘定元帳・補助元帳（sub 指定時）
export async function ledger(c, q = {}) {
  const F = await fiscal(c), A = await accountMap(c), p = period(F, q, { sameFy: false });
  const acc = A.get(String(q.account || '')); check(acc, '勘定科目を選択してください');
  const subOnly = q.sub !== undefined && q.sub !== '' ? String(q.sub) : null, dept = q.dept || '';
  // 期間前残高：期首を跨ぐ指定も扱えるよう、開始日の会計年度で計算
  const fyStart = F.range(F.fyOf(p.from)).from;
  const B = await balances(c, F, A, { from: p.from, to: p.to, fyStart, dept, account: acc.code, bySub: subOnly !== null });
  const ob = subOnly !== null ? B.get(`${acc.code}|${subOnly}`) : B.get(`${acc.code}|`);
  const opening = ob?.opening || 0;
  const w = ['l.account_code=?', 's.slip_date BETWEEN ? AND ?'], args = [acc.code, p.from, p.to];
  if (subOnly !== null) { w.push('l.sub_code=?'); args.push(subOnly); }
  if (dept) { w.push('l.dept_code=?'); args.push(dept); }
  const ls = await rows(c, `SELECT s.slip_id, s.slip_no, s.slip_date, s.memo smemo, s.source, l.* FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id WHERE ${w.join(' AND ')} ORDER BY s.slip_date, s.slip_no, l.row_no, l.side DESC LIMIT 5000`, args);
  const ids = [...new Set(ls.map(l => l.slip_id))];
  const all = ids.length ? await rows(c, `SELECT slip_id, row_no, side, account_code FROM kb_line WHERE slip_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  const name = await subNamer(c), s = sign(acc);
  let run = opening * s, fyCur = F.fyOf(p.from);
  const lines = [], months = new Map();
  for (const l of ls) {
    // 期間が会計年度を跨ぐ場合、損益科目は新年度の期首で 0 から
    if (acc.section === 'PL' && F.fyOf(l.slip_date) !== fyCur) { fyCur = F.fyOf(l.slip_date); run = 0; }
    const other = all.filter(o => o.slip_id === l.slip_id && o.side !== l.side), pair = other.find(o => o.row_no === l.row_no);
    const counter = pair && other.length === 1 ? pair.account_code : new Set(other.map(o => o.account_code)).size === 1 ? other[0].account_code : '';
    const dr = l.side === 'D' ? Number(l.amount) : 0, cr = l.side === 'C' ? Number(l.amount) : 0;
    run += (dr - cr) * s;
    const m = F.labelOf(String(l.slip_date).slice(0, 10)); if (!months.has(m)) months.set(m, { month: m, dr: 0, cr: 0 }); months.get(m).dr += dr; months.get(m).cr += cr;
    lines.push({ slipId: l.slip_id, no: l.slip_no, date: l.slip_date, month: m, counter: counter ? `${counter} ${A.get(counter)?.name || ''}` : '諸口', sub: l.sub_code, subName: name(acc, l.sub_code), dept: l.dept_code,
      tax: l.tax_code, memo: l.memo || l.smemo, dr, cr, taxAmount: Number(l.tax_amount), balance: run, source: l.source });
  }
  return { account: acc.code, accountName: acc.name, side: acc.side, sub: subOnly, subName: subOnly !== null ? name(acc, subOnly) : '', from: p.from, to: p.to, dept,
    opening: opening * s, lines, months: [...months.values()], dr: lines.reduce((n, l) => n + l.dr, 0), cr: lines.reduce((n, l) => n + l.cr, 0), closing: run, truncated: ls.length >= 5000 };
}
// 補助残高一覧表
export async function subBalances(c, q = {}) {
  const F = await fiscal(c), A = await accountMap(c), p = period(F, q);
  const acc = A.get(String(q.account || '')); check(acc, '勘定科目を選択してください');
  const B = await balances(c, F, A, { ...p, account: acc.code, bySub: true }), name = await subNamer(c), s = sign(acc);
  const list = [...B.values()].map(b => ({ sub: b.sub, name: b.sub ? name(acc, b.sub) : '（補助なし）', opening: b.opening * s, dr: b.dr, cr: b.cr, closing: b.closing * s }))
    .filter(r => r.opening || r.dr || r.cr || r.closing).sort((a, b) => a.sub.localeCompare(b.sub));
  return { account: acc.code, accountName: acc.name, subKind: acc.sub, from: p.from, to: p.to, rows: list };
}

// 消費税集計表
export async function taxSummary(c, q = {}) {
  const F = await fiscal(c), p = period(F, q, { sameFy: false });
  const rs = await rows(c, `SELECT l.tax_code, l.side, l.tax_excl, SUM(l.amount) amt, SUM(l.tax_amount) tax, COUNT(*) n FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id
    WHERE s.slip_date BETWEEN ? AND ? GROUP BY l.tax_code, l.side, l.tax_excl`, [p.from, p.to]);
  const by = new Map();
  for (const r of rs) {
    const t = decode(r.tax_code) || { code: r.tax_code, display: r.tax_code, name: '不明な処税率', rate: 0, side: '', taxable: false };
    if (!by.has(t.code)) by.set(t.code, { code: t.code, display: t.display, name: t.name, rate: t.rate, side: t.side, taxable: t.taxable, gross: 0, net: 0, tax: 0, count: 0 });
    const x = by.get(t.code), dir = t.side === 'S' ? (r.side === 'C' ? 1 : -1) : (r.side === 'D' ? 1 : -1), amt = Number(r.amt), tax = Number(r.tax);
    x.gross += dir * (r.tax_excl ? amt + tax : amt); x.net += dir * (r.tax_excl ? amt : amt - tax); x.tax += dir * tax; x.count += Number(r.n);
  }
  const list = [...by.values()].sort((a, b) => a.code.localeCompare(b.code));
  const sales = list.filter(t => t.side === 'S' && t.taxable).reduce((n, t) => n + t.tax, 0), purchase = list.filter(t => t.side === 'P' && t.taxable).reduce((n, t) => n + t.tax, 0);
  const vat = async code => Number((await one(c, `SELECT COALESCE(SUM(CASE WHEN l.side='C' THEN l.amount ELSE -l.amount END),0) v FROM kb_line l JOIN kb_slip s ON s.slip_id=l.slip_id WHERE l.account_code=? AND s.slip_date BETWEEN ? AND ?`, [code, p.from, p.to])).v);
  return { from: p.from, to: p.to, rows: list, salesTax: sales, purchaseTax: purchase, payable: sales - purchase, received: await vat('4415'), paid: -(await vat('1465')) };
}

// ---------- 仕訳帳・伝票 ----------
async function slipsWithLines(c, where, args, limit = 1000) {
  const ss = await rows(c, `SELECT s.* FROM kb_slip s ${where} ORDER BY s.slip_date, s.slip_no LIMIT ${limit + 1}`, args);
  const truncated = ss.length > limit; if (truncated) ss.pop();
  const ls = ss.length ? await rows(c, `SELECT * FROM kb_line WHERE slip_id IN (${ss.map(() => '?').join(',')}) ORDER BY slip_id, row_no, side DESC`, ss.map(s => s.slip_id)) : [];
  const A = await accountMap(c), name = await subNamer(c), D = await deptNames(c);
  const side = l => l && { account: l.account_code, accountName: A.get(l.account_code)?.name || '', sub: l.sub_code, subName: name(A.get(l.account_code), l.sub_code), dept: l.dept_code, deptName: D.get(l.dept_code) || '',
    tax: l.tax_code, taxName: decode(l.tax_code)?.name || l.tax_code, amount: Number(l.amount), taxAmount: Number(l.tax_amount), taxExcl: !!l.tax_excl };
  const slips = ss.map(s => {
    const mine = ls.filter(l => l.slip_id === s.slip_id), n = Math.max(0, ...mine.map(l => l.row_no));
    const rowsOut = [];
    for (let i = 1; i <= n; i++) { const d = mine.find(l => l.row_no === i && l.side === 'D'), cr = mine.find(l => l.row_no === i && l.side === 'C'); if (d || cr) rowsOut.push({ dr: side(d), cr: side(cr), memo: (d || cr).memo }); }
    return { id: s.slip_id, no: s.slip_no, date: s.slip_date, memo: s.memo, source: s.source, sourceName: SOURCES[s.source] || s.source, sourceRef: s.source_ref || '', importId: s.import_id, version: s.version,
      updatedBy: s.updated_by, updatedAt: s.updated_at, rows: rowsOut, total: mine.filter(l => l.side === 'D').reduce((t, l) => t + Number(l.amount), 0) };
  });
  return { slips, truncated };
}
export async function journal(c, q = {}) {
  const F = await fiscal(c), p = period(F, q, { sameFy: false });
  const w = ['s.slip_date BETWEEN ? AND ?'], args = [p.from, p.to];
  if (q.account) { w.push('EXISTS (SELECT 1 FROM kb_line x WHERE x.slip_id=s.slip_id AND x.account_code=?)'); args.push(q.account); }
  if (q.source) { w.push('s.source=?'); args.push(q.source); }
  if (q.text) { w.push("(s.memo LIKE ? OR EXISTS (SELECT 1 FROM kb_line x WHERE x.slip_id=s.slip_id AND x.memo LIKE ?))"); args.push(`%${q.text}%`, `%${q.text}%`); }
  if (q.amount) { w.push('EXISTS (SELECT 1 FROM kb_line x WHERE x.slip_id=s.slip_id AND x.amount=?)'); args.push(yen(q.amount, '金額')); }
  const r = await slipsWithLines(c, 'WHERE ' + w.join(' AND '), args);
  return { from: p.from, to: p.to, ...r, total: r.slips.reduce((n, s) => n + s.total, 0), lockDate: F.lockDate };
}
export async function slipDetail(c, id) {
  const r = await slipsWithLines(c, 'WHERE s.slip_id=?', [Number(id)]);
  check(r.slips.length, '伝票が見つかりません'); return r.slips[0];
}

// 1 行（片側）の検証。税額は税込金額からの内税計算（円未満切捨て）が既定。
async function checkSide(c, A, x, label) {
  const acc = A.get(String(x.account || '')); check(acc, `${label}: 勘定科目を選択してください`); check(acc.active, `${label}: 科目 ${acc.code} は無効です`);
  const amount = yen(x.amount, `${label}の金額`); check(amount > 0, `${label}の金額は1円以上で入力してください`);
  const sub = text(x.sub, `${label}の補助`, 20, { required: false }), dept = text(x.dept, `${label}の部門`, 12, { required: false });
  if (sub) {
    const ok = acc.sub === 'CUST' ? await one(c, 'SELECT 1 x FROM client_m WHERE customers_cd=?', [sub]) : acc.sub === 'VEND' ? await one(c, 'SELECT 1 x FROM vendor WHERE vendor_code=?', [sub])
      : await one(c, 'SELECT 1 x FROM account_subsubject WHERE account_code=? AND sub_code=?', [acc.code, sub]);
    check(ok, `${label}: 補助「${sub}」は科目 ${acc.code} に登録されていません`);
  }
  if (dept) check(await one(c, "SELECT 1 x FROM code_m WHERE code_key='DEPT' AND code_dtl=?", [dept]), `${label}: 部門「${dept}」が登録されていません`);
  const t = decode(x.tax || acc.tax || '090'); check(t, `${label}: 処税率「${x.tax}」が不正です`);
  const tax = t.code, rate = t.taxable ? t.rate : 0, auto = taxOf(amount, tax);
  const taxAmount = x.taxAmount === undefined || x.taxAmount === '' || x.taxAmount === null ? auto : yen(x.taxAmount, `${label}の消費税額`);
  check(taxAmount <= amount, `${label}: 消費税額が金額を超えています`); if (!rate) check(taxAmount === 0, `${label}: 対象外・非課税・不課税の消費税額は0です`);
  return { account: acc.code, sub, dept, tax, amount, taxAmount, taxExcl: t.excl };
}
async function nextSlipNos(c, F) {
  await c.query('LOCK TABLE kb_slip IN SHARE ROW EXCLUSIVE MODE');
  const cache = new Map();
  return async date => {
    const fy = F.fyOf(date);
    if (!cache.has(fy)) { const r = F.range(fy); cache.set(fy, Number((await one(c, 'SELECT COALESCE(MAX(slip_no),0) n FROM kb_slip WHERE slip_date BETWEEN ? AND ?', [r.from, r.to])).n)); }
    cache.set(fy, cache.get(fy) + 1); return cache.get(fy);
  };
}
async function insertLines(c, id, rowsIn) {
  let i = 0;
  for (const r of rowsIn) {
    i++;
    for (const [side, x] of [['D', r.dr], ['C', r.cr]]) if (x) await c.query('INSERT INTO kb_line (slip_id,row_no,side,account_code,sub_code,dept_code,tax_code,amount,tax_amount,tax_excl,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, i, side, x.account, x.sub || '', x.dept || '', x.tax, x.amount, x.taxAmount, !!x.taxExcl, String(r.memo || '').slice(0, 100)]);
  }
}
const checkDate = (F, date, label = '伝票日付') => {
  check(date >= F.startDate, `${label}は導入年度の期首 ${F.startDate} 以降で入力してください`);
  if (F.lockDate) check(date > F.lockDate, `${F.lockDate} 以前は入力制限中のため登録・変更できません（会計設定）`);
};
export async function saveSlip(c, ctx, p) {
  const F = await fiscal(c), A = await accountMap(c), date = isoDate(p.date, '伝票日付'); checkDate(F, date);
  const memo = text(p.memo, '伝票摘要', 100, { required: false });
  check(Array.isArray(p.rows) && p.rows.length <= 99, '明細は99行以内です');
  const rowsIn = [];
  for (const [i, r] of p.rows.entries()) {
    const has = s => s && (s.account || s.amount);
    if (!has(r.dr) && !has(r.cr)) continue;
    rowsIn.push({ dr: has(r.dr) ? await checkSide(c, A, r.dr, `${i + 1}行目 借方`) : null, cr: has(r.cr) ? await checkSide(c, A, r.cr, `${i + 1}行目 貸方`) : null, memo: text(r.memo, `${i + 1}行目 摘要`, 100, { required: false }) });
  }
  check(rowsIn.length, '明細を入力してください');
  const dr = rowsIn.reduce((n, r) => n + (r.dr?.amount || 0), 0), cr = rowsIn.reduce((n, r) => n + (r.cr?.amount || 0), 0);
  check(dr === cr, `貸借が一致しません（借方 ${dr.toLocaleString()} / 貸方 ${cr.toLocaleString()}）`);
  const user = ctx.user.login_id;
  if (p.id) {
    const old = await one(c, 'SELECT * FROM kb_slip WHERE slip_id=? FOR UPDATE', [Number(p.id)]);
    if (!old) throw new Conflict('伝票が見つかりません。再読込してください');
    if (Number(old.version) !== Number(p.version)) throw new Conflict('他の利用者が更新しました。再読込してからやり直してください');
    checkDate(F, old.slip_date, '修正前の伝票日付');
    let no = old.slip_no;
    if (F.fyOf(old.slip_date) !== F.fyOf(date)) no = await (await nextSlipNos(c, F))(date);
    await c.query('UPDATE kb_slip SET slip_date=?, slip_no=?, memo=?, version=version+1, updated_by=?, updated_at=UTC_TIMESTAMP(6) WHERE slip_id=?', [date, no, memo, user, old.slip_id]);
    await c.query('DELETE FROM kb_line WHERE slip_id=?', [old.slip_id]);
    await insertLines(c, old.slip_id, rowsIn);
    await audit(c, ctx, 'kb_slip', old.slip_id, 'kb.slip.update', { no, date, amount: dr, rows: rowsIn.length });
    return { id: old.slip_id, no };
  }
  const no = await (await nextSlipNos(c, F))(date);
  const [r] = await c.query("INSERT INTO kb_slip (slip_no,slip_date,memo,source,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'MANUAL',?,UTC_TIMESTAMP(6),?,UTC_TIMESTAMP(6))", [no, date, memo, user, user]);
  await insertLines(c, r.insertId, rowsIn);
  await audit(c, ctx, 'kb_slip', r.insertId, 'kb.slip.create', { no, date, amount: dr, rows: rowsIn.length });
  return { id: r.insertId, no };
}
export async function deleteSlip(c, ctx, { id, version }) {
  const F = await fiscal(c), old = await one(c, 'SELECT * FROM kb_slip WHERE slip_id=? FOR UPDATE', [Number(id)]);
  if (!old) throw new Conflict('伝票が見つかりません。再読込してください');
  if (Number(old.version) !== Number(version)) throw new Conflict('他の利用者が更新しました。再読込してからやり直してください');
  checkDate(F, old.slip_date);
  await c.query('DELETE FROM kb_slip WHERE slip_id=?', [old.slip_id]);
  await audit(c, ctx, 'kb_slip', old.slip_id, 'kb.slip.delete', { no: old.slip_no, date: old.slip_date, source: old.source, ref: old.source_ref });
  return { ok: true };
}

// ---------- 仕訳受入 ----------
// 課税売上（仕入）行と同じ側に仮受（仮払）消費税行がある伝票は、その税額を課税行へ按分して「外税」として持つ。それ以外は内税計算。
function applyVat(sides) {
  for (const v of sides.filter(x => VAT_ACCOUNTS[x.account])) {
    const kind = VAT_ACCOUNTS[v.account], targets = sides.filter(x => { const t = decode(x.tax); return x.side === v.side && t?.side === kind && t.taxable && t.excl; });
    const base = targets.reduce((n, x) => n + x.amount, 0); if (!base) continue;
    let rest = v.amount;
    targets.forEach((x, i) => { x.taxExcl = true; x.vatDone = true; x.taxAmount = i === targets.length - 1 ? rest : Math.floor(v.amount * x.amount / base); rest -= x.taxAmount; });
  }
  for (const x of sides) if (!x.vatDone) { x.taxExcl = !!decode(x.tax)?.excl; x.taxAmount = taxOf(x.amount, x.tax); }
}
const toRows = sides => {
  const d = sides.filter(x => x.side === 'D'), cr = sides.filter(x => x.side === 'C'), out = [];
  for (let i = 0; i < Math.max(d.length, cr.length); i++) out.push({ dr: d[i] || null, cr: cr[i] || null, memo: (d[i] || cr[i]).memo || '' });
  return out;
};
async function storeImport(c, ctx, F, source, label, slips) {
  const total = slips.reduce((n, s) => n + s.rows.reduce((t, r) => t + (r.dr?.amount || 0), 0), 0), user = ctx.user.login_id;
  const [imp] = await c.query("INSERT INTO kb_import (source,label,slips,amount,status,imported_by,imported_at) VALUES (?,?,?,?,'ACTIVE',?,UTC_TIMESTAMP(6))", [source, label.slice(0, 200), slips.length, total, user]);
  const next = await nextSlipNos(c, F);
  for (const s of slips) {
    const [r] = await c.query('INSERT INTO kb_slip (slip_no,slip_date,memo,source,source_ref,import_id,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(6),?,UTC_TIMESTAMP(6))',
      [await next(s.date), s.date, s.memo.slice(0, 100), source, s.ref || null, imp.insertId, user, user]);
    await insertLines(c, r.insertId, s.rows);
  }
  await audit(c, ctx, 'kb_import', imp.insertId, 'kb.import', { source, label, slips: slips.length, amount: total });
  return { importId: imp.insertId, slips: slips.length, amount: total };
}
// 請求システムの自動仕訳（journal_entry / journal_line）を伝票として受け入れる。1仕訳＝1伝票、受入済み（source_ref=仕訳ID）は対象外。
export async function importSeikyu(c, ctx, p) {
  const F = await fiscal(c), A = await accountMap(c), from = isoDate(p.from, '開始日'), to = isoDate(p.to, '終了日'); check(from <= to, '期間が不正です');
  const es = await rows(c, `SELECT e.*, n.slip_no FROM journal_entry e LEFT JOIN app_slip_no n ON n.journal_id=e.journal_id WHERE e.journal_date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM kb_slip k WHERE k.source='SEIKYU' AND k.source_ref=CAST(e.journal_id AS CHAR)) ORDER BY e.journal_date, e.journal_id`, [from, to]);
  const ls = es.length ? await rows(c, `SELECT l.*, v.vendor_code, cu.customers_name, v.vendor_name FROM journal_line l LEFT JOIN vendor v ON v.vendor_id=l.vendor_id LEFT JOIN client_m cu ON cu.customers_cd=l.customers_cd
    WHERE l.journal_id IN (${es.map(() => '?').join(',')}) ORDER BY l.journal_id, l.line_no`, es.map(e => e.journal_id)) : [];
  const errors = [], slips = [];
  for (const e of es) {
    const date = String(e.journal_date).slice(0, 10);
    if (date < F.startDate) { errors.push(`仕訳#${e.journal_id}（${date}）: 導入期首 ${F.startDate} より前`); continue; }
    if (F.lockDate && date <= F.lockDate) { errors.push(`仕訳#${e.journal_id}（${date}）: 入力制限日 ${F.lockDate} 以前`); continue; }
    const sides = [];
    for (const l of ls.filter(x => x.journal_id === e.journal_id)) {
      const acc = A.get(l.account_code); if (!acc) { errors.push(`仕訳#${e.journal_id}: 科目 ${l.account_code} が未登録`); continue; }
      const sub = l.sub_code || (acc.sub === 'CUST' ? l.customers_cd : acc.sub === 'VEND' ? l.vendor_code : '') || '';
      const t = l.source_tax_code ? decode(l.source_tax_code) : decode(acc.tax);
      if (!t) { errors.push(`仕訳#${e.journal_id}: 処税率「${l.source_tax_code}」を解釈できません`); continue; }
      const tax = t.code;
      sides.push({ side: l.side, account: acc.code, sub, dept: l.department_code || '', tax, amount: Number(l.amount), taxAmount: 0, taxExcl: false, memo: (l.customers_name || l.vendor_name || '').slice(0, 100) });
    }
    if (!sides.length) continue;
    applyVat(sides);
    const memo = `${e.slip_no ? e.slip_no + ' ' : ''}${PATTERNS[e.pattern_code] || e.pattern_code} ${e.source_type}:${e.source_id}${e.reversal_of ? ` 取消(#${e.reversal_of})` : ''}`;
    slips.push({ date, ref: String(e.journal_id), memo, rows: toRows(sides), pattern: e.pattern_code });
  }
  const summary = { candidates: es.length, slips: slips.length, amount: slips.reduce((n, s) => n + s.rows.reduce((t, r) => t + (r.dr?.amount || 0), 0), 0), errors,
    patterns: Object.entries(slips.reduce((m, s) => ((m[s.pattern] = (m[s.pattern] || 0) + 1), m), {})).map(([code, n]) => ({ code, name: PATTERNS[code] || code, n })) };
  if (p.dry) return { ...summary, sample: slips.slice(0, 30).map(s => ({ date: s.date, memo: s.memo, ref: s.ref, rows: s.rows.map(r => ({ dr: r.dr && { account: r.dr.account, accountName: A.get(r.dr.account)?.name, amount: r.dr.amount, tax: r.dr.tax, taxAmount: r.dr.taxAmount }, cr: r.cr && { account: r.cr.account, accountName: A.get(r.cr.account)?.name, amount: r.cr.amount, tax: r.cr.tax, taxAmount: r.cr.taxAmount }, memo: r.memo })) })) };
  check(!errors.length, '受け入れできない仕訳があります: ' + errors.slice(0, 5).join(' / '));
  check(slips.length, '受入対象の仕訳がありません（受入済みを除く）');
  return { ...summary, ...(await storeImport(c, ctx, F, 'SEIKYU', `請求システム ${from}〜${to}`, slips)) };
}
// 汎用 CSV（借貸併記）。請求システム「会計連携（汎用）」・本画面の「仕訳データ書出」と同じ見出し。伝票日付＋伝票番号で 1 伝票。
// 借方外税・貸方外税（1=税額を金額の外に持つ）・税額は省略可（省略時は仮受/仮払消費税行からの按分、なければ内税計算）。
export const CSV_HEAD = ['伝票日付', '伝票番号', '行', '借方部門', '借方科目CD', '借方科目名', '借方補助CD', '借方補助名', '借方税区分', '借方金額', '借方税額', '借方外税',
  '貸方部門', '貸方科目CD', '貸方科目名', '貸方補助CD', '貸方補助名', '貸方税区分', '貸方金額', '貸方税額', '貸方外税', '摘要1', '摘要2'];
export async function importCsv(c, ctx, p) {
  const F = await fiscal(c), A = await accountMap(c), table = parseCsv(String(p.csv || ''));
  check(table.length >= 2 && table.length <= 20001, '取込はヘッダー行＋1〜20000行です');
  const head = table[0].map(h => h.trim()), col = n => head.indexOf(n);
  for (const n of ['伝票日付', '伝票番号', '借方科目CD', '借方金額', '貸方科目CD', '貸方金額']) check(col(n) >= 0, `必須列「${n}」がありません`);
  const get = (r, n) => (col(n) >= 0 ? String(r[col(n)] ?? '').trim() : '');
  const errors = [], groups = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i], date = get(r, '伝票日付').replaceAll('/', '-'), no = get(r, '伝票番号'), key = `${date}|${no}`;
    let g = groups[groups.length - 1]; if (!g || g.key !== key) { g = { key, date, no, line: i + 1, sides: [], memo2: get(r, '摘要2') }; groups.push(g); }
    for (const [side, pre] of [['D', '借方'], ['C', '貸方']]) {
      const code = get(r, pre + '科目CD'), amt = get(r, pre + '金額'); if (!code && !amt) continue;
      const rawTax = get(r, pre + '税区分'), tax = rawTax ? decode(rawTax)?.code : A.get(code)?.tax || '090';
      if (!tax) { errors.push(`${i + 1}行目: ${pre}税区分「${rawTax}」は処税率として解釈できません`); continue; }
      const taxAmt = get(r, pre + '税額'), neg = /^-/.test(amt.replace(/[,\s]/g, '')), unsign = v => v.replace(/^(\s*)-/, '$1'); // マイナス金額は反対側へ（現行CSVの戻し行）
      g.sides.push({ side: neg ? (side === 'D' ? 'C' : 'D') : side, row: i + 1, raw: { account: code, sub: get(r, pre + '補助CD'), dept: get(r, pre + '部門'), tax, amount: neg ? unsign(amt) : amt, taxAmount: taxAmt === '' ? undefined : neg ? unsign(taxAmt) : taxAmt, taxExcl: get(r, pre + '外税') === '1' }, memo: get(r, '摘要1') });
    }
  }
  const slips = [];
  for (const g of groups) {
    try {
      const date = isoDate(g.date, '伝票日付'); checkDate(F, date);
      const sides = [];
      for (const s of g.sides) { const x = await checkSide(c, A, s.raw, `${s.row}行目 ${s.side === 'D' ? '借方' : '貸方'}`); sides.push({ ...x, side: s.side, memo: s.memo, explicit: s.raw.taxAmount !== undefined }); }
      const dr = sides.filter(x => x.side === 'D').reduce((n, x) => n + x.amount, 0), cr = sides.filter(x => x.side === 'C').reduce((n, x) => n + x.amount, 0);
      check(dr === cr && dr > 0, `貸借が一致しません（借方 ${dr} / 貸方 ${cr}）`);
      if (!sides.some(x => x.explicit)) applyVat(sides);
      slips.push({ date, memo: g.memo2 || `CSV 伝票番号 ${g.no}`, rows: toRows(sides) });
    } catch (e) { errors.push(`${g.line}行目〜（伝票 ${g.no}）: ${e.message}`); }
  }
  const summary = { slips: slips.length, amount: slips.reduce((n, s) => n + s.rows.reduce((t, r) => t + (r.dr?.amount || 0), 0), 0), errors };
  if (p.dry) return summary;
  check(!errors.length, '取り込めない行があります（全件取消）: ' + errors.slice(0, 5).join(' / '));
  check(slips.length, '取込対象の伝票がありません');
  return { ...summary, ...(await storeImport(c, ctx, F, 'CSV', `CSV ${text(p.name, 'ファイル名', 150, { required: false }) || ''}`.trim(), slips)) };
}
export async function listImports(c) {
  return (await rows(c, 'SELECT i.*, (SELECT COUNT(*) FROM kb_slip s WHERE s.import_id=i.import_id) live FROM kb_import i ORDER BY i.import_id DESC LIMIT 100'))
    .map(r => ({ id: r.import_id, source: r.source, sourceName: SOURCES[r.source], label: r.label, slips: r.slips, live: Number(r.live), amount: Number(r.amount), status: r.status, by: r.imported_by, at: r.imported_at }));
}
export async function cancelImport(c, ctx, { id }) {
  const F = await fiscal(c), imp = await one(c, "SELECT * FROM kb_import WHERE import_id=? AND status='ACTIVE' FOR UPDATE", [Number(id)]); check(imp, '取消できる受入がありません');
  const min = await one(c, 'SELECT MIN(slip_date) d FROM kb_slip WHERE import_id=?', [imp.import_id]);
  if (min.d) checkDate(F, String(min.d).slice(0, 10));
  const del = await c.query('DELETE FROM kb_slip WHERE import_id=?', [imp.import_id]);
  await c.query("UPDATE kb_import SET status='CANCELLED' WHERE import_id=?", [imp.import_id]);
  await audit(c, ctx, 'kb_import', imp.import_id, 'kb.import.cancel', { slips: del[0].affectedRows });
  return { slips: del[0].affectedRows };
}

// ---------- マスタ・設定 ----------
export async function saveAccount(c, ctx, p) {
  const code = text(p.code, '科目コード', 20, { pattern: /^[0-9A-Za-z\-]+$/ }), name = text(p.name, '科目名', 100);
  const grp = String(p.grp || ''); check(GROUP[grp], '区分を選択してください');
  const side = p.side === 'C' ? 'C' : p.side === 'D' ? 'D' : GROUP[grp].side, sub = String(p.sub || ''); check(sub in SUB_KINDS, '補助区分が不正です');
  const tax = decode(p.tax || '090')?.code; check(tax, '処税率が不正です');
  const active = bool(p.active ?? true), sort = p.sort === '' || p.sort === undefined ? null : yen(p.sort, '表示順');
  const old = await one(c, 'SELECT * FROM account_subject WHERE account_code=? FOR UPDATE', [code]);
  if (p.mode === 'create') check(!old, `科目「${code}」は登録済みです`); else check(old, '科目が見つかりません');
  if (!active) check(!SYSTEM_ACCOUNTS.some(a => a[0] === code), '請求システムの自動仕訳で使用する科目は無効化できません');
  if (!old) await c.query('INSERT INTO account_subject (account_code,account_name,active) VALUES (?,?,?)', [code, name, active]);
  else await c.query('UPDATE account_subject SET account_name=?, active=? WHERE account_code=?', [name, active, code]);
  const cur = await one(c, 'SELECT sort_no FROM kb_account WHERE account_code=?', [code]);
  await c.query('INSERT INTO kb_account (account_code,grp,side,sub_kind,tax_code,sort_no,guessed) VALUES (?,?,?,?,?,?,FALSE) ON DUPLICATE KEY UPDATE grp=VALUES(grp),side=VALUES(side),sub_kind=VALUES(sub_kind),tax_code=VALUES(tax_code),sort_no=VALUES(sort_no),guessed=FALSE',
    [code, grp, side, sub, tax, sort ?? cur?.sort_no ?? 99000]);
  await audit(c, ctx, 'kb_account', code, 'kb.account.save', { grp, side, sub, tax, active });
  return { code };
}
export async function opening(c) {
  const F = await fiscal(c), A = await accountMap(c), name = await subNamer(c);
  const list = (await rows(c, 'SELECT * FROM kb_opening ORDER BY account_code, sub_code')).map(r => { const acc = A.get(r.account_code); return { account: r.account_code, accountName: acc?.name || '', sub: r.sub_code, subName: name(acc, r.sub_code), side: acc?.side || 'D', amount: Number(r.amount) * (acc ? sign(acc) : 1) }; });
  const dr = list.reduce((n, r) => n + (r.side === 'D' ? r.amount : 0), 0), cr = list.reduce((n, r) => n + (r.side === 'C' ? r.amount : 0), 0);
  return { startDate: F.startDate, startFy: F.startFy, rows: list, dr, cr, diff: dr - cr };
}
// 期首残高は BS 科目のみ。金額は科目の正残高側でプラス入力。
export async function saveOpening(c, ctx, p) {
  const F = await fiscal(c), A = await accountMap(c); check(Array.isArray(p.rows) && p.rows.length <= 2000, '明細が不正です');
  if (F.lockDate) check(F.startDate > F.lockDate, '導入期首が入力制限日以前のため期首残高は変更できません');
  const seen = new Set(), list = [];
  for (const [i, r] of p.rows.entries()) {
    if (!r.account && !r.amount) continue;
    const acc = A.get(String(r.account || '')); check(acc, `${i + 1}行目: 勘定科目を選択してください`); check(acc.section !== 'PL', `${i + 1}行目: 損益科目には期首残高を設定できません`);
    const sub = text(r.sub, `${i + 1}行目 補助`, 20, { required: false }), amount = yen(r.amount, `${i + 1}行目 金額`, { negative: true });
    const k = `${acc.code}|${sub}`; check(!seen.has(k), `${i + 1}行目: 科目・補助が重複しています`); seen.add(k);
    if (amount) list.push([acc.code, sub, amount * sign(acc)]);
  }
  await c.query('DELETE FROM kb_opening');
  for (const r of list) await c.query('INSERT INTO kb_opening (account_code,sub_code,amount) VALUES (?,?,?)', r);
  await audit(c, ctx, 'kb_opening', F.startDate, 'kb.opening.save', { rows: list.length });
  return opening(c);
}
export async function saveSettings(c, ctx, p) {
  const F = await fiscal(c), fy = yen(p.startFy, '導入年度'); check(fy >= 2000 && fy <= 2099, '導入年度が範囲外です');
  const start = F.range(fy).from, lock = p.lockDate ? isoDate(p.lockDate, '入力制限日') : '';
  const min = await one(c, 'SELECT MIN(slip_date) d FROM kb_slip');
  if (min?.d) check(String(min.d).slice(0, 10) >= start, `導入期首 ${start} より前の伝票があるため変更できません`);
  for (const [k, v] of [['start_fy', String(fy)], ['lock_date', lock]]) await c.query('INSERT INTO kb_setting (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, v]);
  await audit(c, ctx, 'kb_setting', 'kb', 'kb.setting.save', { startFy: fy, lockDate: lock });
  return { startFy: fy, lockDate: lock };
}

// ---------- 出力（CSV・Excel） ----------
export async function exportJournalCsv(c, ctx, q) {
  const d = await journal(c, q);
  if (q.format === 'bugyo') {
    await audit(c, ctx, 'kb_slip', `${d.from}..${d.to}`, 'kb.export', { slips: d.slips.length, format: 'bugyo' });
    return { file: bugyoFile(d.slips.map(s => ({ date: s.date, slipNo: String(s.no), memo: s.memo, pairs: s.rows })), await bugyoSettings(c), `仕訳データ_勘定奉行_${d.from}_${d.to}.csv`) };
  }
  const out = [CSV_HEAD];
  const cells = x => (x ? [x.dept, x.account, x.accountName, x.sub, x.subName, x.tax, x.amount, x.taxAmount, x.taxExcl ? '1' : ''] : Array(9).fill(''));
  for (const s of d.slips) s.rows.forEach((r, i) => out.push([s.date, s.no, i + 1, ...cells(r.dr), ...cells(r.cr), r.memo, s.memo]));
  await audit(c, ctx, 'kb_slip', `${d.from}..${d.to}`, 'kb.export', { slips: d.slips.length });
  return { file: { name: `仕訳データ_${d.from}_${d.to}.csv`, body: Buffer.from(csv(out), 'utf8'), type: 'text/csv; charset=utf-8' } };
}
const T = v => ({ v, s: 'title' }), H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' });
export async function book(c, kind, q) {
  if (kind === 'trial' || kind === 'fs') {
    const F = await fiscal(c), d = await trialBalance(c, kind === 'fs' ? { ...q, from: F.range(F.fyOf(isoDate(q.to || today(), '基準日'))).from } : q);
    const sheet = (title, list) => ({ name: title, widths: [10, 30, 15, 15, 15, 15], rows: [[T(title)], [`${d.fyLabel}　${d.from} 〜 ${d.to}${d.dept ? '　部門 ' + d.dept : ''}　出力日 ${today()}`], [],
      [H('コード'), H('勘定科目'), H('前期繰越'), H('借方'), H('貸方'), H('残高')],
      ...list.map(r => r.type === 'acct' ? [r.code, r.label, r.opening, r.dr, r.cr, r.closing] : r.type === 'group' || r.type === 'section' ? [H(r.label)]
        : r.type === 'calc' ? ['', H(r.label), S(r.opening), '', '', S(r.closing)] : ['', H(r.label), S(r.opening), S(r.dr ?? 0), S(r.cr ?? 0), S(r.closing)])] });
    return { name: `${kind === 'fs' ? '決算書' : '合計残高試算表'}_${d.from}_${d.to}.xlsx`, body: xlsx([sheet('貸借対照表', d.BS), sheet('損益計算書', d.PL)]) };
  }
  if (kind === 'monthly') {
    const d = await monthly(c, q);
    return { name: `月次推移表_${d.kind.toUpperCase()}_${d.fy}.xlsx`, body: xlsx([{ name: d.kind === 'bs' ? '月次推移(貸借)' : '月次推移(損益)', widths: [10, 26, ...Array(13).fill(13)],
      rows: [[T(`月次推移表（${d.kind === 'bs' ? '貸借対照表・月末残高' : '損益計算書・月別発生額'}）`)], [`${d.fyLabel}　出力日 ${today()}`], [], [H('コード'), H('勘定科目'), ...d.months.map(m => H(m)), H(d.kind === 'bs' ? '期末' : '合計')],
        ...d.rows.map(r => r.type === 'group' ? [H(r.label)] : r.type === 'acct' ? [r.code, r.label, ...r.values, r.total] : ['', H(r.label), ...r.values.map(S), S(r.total)])] }]) };
  }
  if (kind === 'ledger') {
    const d = await ledger(c, q);
    return { name: `${d.sub !== null ? '補助元帳' : '総勘定元帳'}_${d.account}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.sub !== null ? '補助元帳' : '総勘定元帳', widths: [11, 7, 24, 22, 8, 30, 14, 14, 15],
      rows: [[T(`${d.sub !== null ? '補助元帳' : '総勘定元帳'}　${d.account} ${d.accountName}${d.sub !== null ? `／${d.sub} ${d.subName}` : ''}`)], [`${d.from} 〜 ${d.to}　出力日 ${today()}`], [],
        [H('日付'), H('伝票No'), H('相手科目'), H('補助'), H('税区分'), H('摘要'), H('借方'), H('貸方'), H('残高')], ['', '', '', '', '', '前期より繰越', '', '', d.opening],
        ...d.lines.map(l => [l.date, l.no, l.counter, l.subName || l.sub, decode(l.tax)?.name || l.tax, l.memo, l.dr || '', l.cr || '', l.balance]), ['', '', '', '', '', S('合計'), S(d.dr), S(d.cr), S(d.closing)]] }]) };
  }
  if (kind === 'journal') {
    const d = await journal(c, q), out = [[T('仕訳帳')], [`${d.from} 〜 ${d.to}　出力日 ${today()}`], [], [H('日付'), H('伝票No'), H('借方科目'), H('借方補助'), H('借方金額'), H('貸方科目'), H('貸方補助'), H('貸方金額'), H('摘要'), H('区分')]];
    for (const s of d.slips) { s.rows.forEach((r, i) => out.push([i ? '' : s.date, i ? '' : s.no, r.dr ? `${r.dr.account} ${r.dr.accountName}` : '', r.dr?.subName || r.dr?.sub || '', r.dr?.amount ?? '', r.cr ? `${r.cr.account} ${r.cr.accountName}` : '', r.cr?.subName || r.cr?.sub || '', r.cr?.amount ?? '', r.memo || (i ? '' : s.memo), i ? '' : s.sourceName])); out.push(['', '', '', S('伝票計'), S(s.total), '', '', S(s.total)]); }
    out.push(['', '', '', S('総合計'), S(d.total), '', '', S(d.total)]);
    return { name: `仕訳帳_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '仕訳帳', widths: [11, 7, 22, 18, 13, 22, 18, 13, 30, 10], rows: out }]) };
  }
  if (kind === 'tax') {
    const d = await taxSummary(c, q);
    return { name: `消費税集計表_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: '消費税集計表', widths: [8, 22, 8, 16, 16, 14, 8], rows: [[T('消費税集計表')], [`${d.from} 〜 ${d.to}　出力日 ${today()}`], [],
      [H('処税率'), H('名称'), H('税率'), H('税込金額'), H('税抜金額'), H('消費税額'), H('件数')], ...d.rows.map(r => [r.display, r.name, r.rate ? r.rate + '%' : '', r.gross, r.net, r.tax, r.count]), [],
      ['', H('売上に係る消費税額'), '', '', '', S(d.salesTax)], ['', H('仕入に係る消費税額'), '', '', '', S(d.purchaseTax)], ['', H('差引税額（概算）'), '', '', '', S(d.payable)]] }]) };
  }
  check(false, '帳票の種類が不正です');
}
