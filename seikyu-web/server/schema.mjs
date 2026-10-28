import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rows, one, NUMBERING } from './db.mjs';
import { SYSTEM_ACCOUNTS } from './masters.mjs';
import { TABLES } from './ledger.mjs';
import { hashPassword, verifyPassword, ROLES } from './users.mjs';
import { prepareKb, getsudoMigration } from './kb.mjs';
import { SLIP_SERIES, SLIP_SEED, formatSlipNo } from './db.mjs';
import { CUMULATIVE_SQL } from './sales.mjs';

export const MENUS = [
  [1, 'ダッシュボード', '#dashboard', '▦', 'OVERVIEW'], [2, '出荷・売上', '#shipments', '▤', '販売・請求'], [3, '請求締め・発行', '#invoices', '▧', '販売・請求'], [4, '入金・消込', '#receipts', '↙', '販売・請求'],
  [5, '商品仕入', '#purchases', '◇', '購買・支払'], [6, '在庫計上', '#inventory', '▥', '購買・支払'], [7, '定時請求', '#payables', '▣', '購買・支払'], [8, '小口現金', '#cash', '◈', '購買・支払'], [9, '支払', '#payments', '↗', '購買・支払'],
  [10, '仕訳・会計連携', '#journals', '≡', '会計・管理'], [11, '帳票・データ出力', '#reports', '▱', '会計・管理'], [12, '月次確定', '#periods', '◉', '会計・管理'], [13, 'マスタ管理', '#masters', '⚙', '会計・管理'],
  [14, '移行・確認事項', '#migration', '⊞', '会計・管理'], [15, '操作履歴', '#audit', '◷', '会計・管理'], [16, '利用者管理', '#users', '☺', '会計・管理'],
  [17, '仕訳入力', '#kb-entry', '✎', '財務会計'], [18, '仕訳帳・伝票検索', '#kb-journal', '☰', '財務会計'], [19, '元帳', '#kb-ledger', '▤', '財務会計'], [20, '残高試算表', '#kb-trial', '⊟', '財務会計'],
  [21, '決算書・消費税', '#kb-fs', '▣', '財務会計'], [22, '仕訳受入・書出', '#kb-import', '⇅', '財務会計'], [23, '会計設定', '#kb-setup', '⚙', '財務会計'],
];

// 2026-10-21 現行 Java（中部土木 出荷システム）とのコード互換。一度だけ実行（code_m SET/CMP1021）。
//  決済方法 A0001：1 現金 / 2 掛売 / 3 カード（旧本システムは 1 掛売 / 2 現金）→ 1 と 2 を入れ替え
//  伝票区分 A0009：2 は他社納入（旧本システムの訂正 2）→ 訂正は 5 に変更
//  商品の製品・材料区分：2 製品 / 1 材料（旧本システムは逆）／ delete_f：有効は空（旧 '0'）
//  ロール：参照者 3 → 5（3 は現行の manager）／ 採番：キー 1〜5 → 101〜105（1〜6 は現行が使用）／ payment_money は常に 金額＋税
async function slipNoBackfill(pool) {
  for (const [series, seed] of Object.entries(SLIP_SEED)) await pool.query('INSERT IGNORE INTO app_slip_series (series,last_no) VALUES (?,?)', [series, seed]);
  const pats = Object.keys(SLIP_SERIES);
  const [missing] = await pool.query(`SELECT journal_id, pattern_code FROM journal_entry e WHERE pattern_code IN (${pats.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM app_slip_no n WHERE n.journal_id=e.journal_id) ORDER BY journal_date, journal_id`, pats);
  if (!missing.length) return;
  const [cur] = await pool.query('SELECT series, last_no FROM app_slip_series'), last = Object.fromEntries(cur.map(r => [r.series, Number(r.last_no)]));
  for (const e of missing) { const s = SLIP_SERIES[e.pattern_code]; last[s] += 1; await pool.query('INSERT INTO app_slip_no (journal_id,slip_no) VALUES (?,?)', [e.journal_id, formatSlipNo(s, last[s])]); }
  for (const [s, n] of Object.entries(last)) await pool.query('UPDATE app_slip_series SET last_no=? WHERE series=?', [n, s]);
}
async function compatMigration(pool) {
  const [[done]] = await pool.query("SELECT 1 x FROM code_m WHERE code_key='SET' AND code_dtl='CMP1021'");
  if (done) return;
  const swap = 'CASE payment_method_cd WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE payment_method_cd END';
  for (const t of ['shipment_slip', 'sales_trn', 'billing_head', 'billing_detail']) await pool.query(`UPDATE ${t} SET payment_method_cd=${swap}`);
  await pool.query('UPDATE shipment_slip SET ship_kb=5 WHERE ship_kb=2');
  for (const t of ['sales_trn', 'billing_detail']) await pool.query(`UPDATE ${t} SET ship_kb='5' WHERE ship_kb='2'`);
  await pool.query('UPDATE shipment_slip SET payment_money=money+consumption_tax');
  await pool.query('UPDATE sales_trn SET payment_money=money+consumption_tax');
  await pool.query("UPDATE item_m SET item_product_kb=CASE item_product_kb WHEN '1' THEN '2' WHEN '2' THEN '1' ELSE item_product_kb END");
  for (const t of ['client_m', 'field_name_m', 'item_m', 'uriage_tanka_m', 'genka_m']) await pool.query(`UPDATE ${t} SET delete_f='' WHERE delete_f='0'`);
  await pool.query('UPDATE user_role_ts SET role_id=5 WHERE role_id=3');
  for (const [key] of Object.values(NUMBERING)) await pool.query("INSERT INTO numbering_m (numbering_key,numbering_pattern,present_value) SELECT ?, numbering_pattern, present_value FROM numbering_m WHERE numbering_key=? AND present_value ~ '^[0-9]+$' ON CONFLICT (numbering_key) DO UPDATE SET present_value=EXCLUDED.present_value", [key, key - 100]);
  // デモ用の自社情報は現行データと同じ端数処理（金額 3 四捨五入・税 2 切捨）にする
  await pool.query("UPDATE company_info_m SET proceed_round='3', tax_round='2' WHERE company_info_id=1 AND company_name1='サンプル建材株式会社'");
  await pool.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('SET','設定','CMP1021','現行Javaコード互換 移行済',?,'','','')", [new Date().toISOString().slice(0, 10)]);
}
// 現行 Java のコードマスタ初期値（code_m A0000 納入区分・A0003 単位・A0007 消費税率、テーブルデータ code_m より）と単位名の関数。
// 既存データは一度だけ変換（code_m SET/CMP1021B）：商品・出荷の単位を名称→コード、納入区分・担当者の未設定を既定値に、累計数量・台数を再計算。
const JAVA_CODES = [
  ['A0000', '納入区分', [['1', '大型現着', '1'], ['3', '小型現着', '1'], ['7', '引取', '2'], ['9', 'その他', '1']]],
  ['A0003', '単位', [['01', 't'], ['02', 'm3'], ['03', 'Kg'], ['04', 'KL'], ['05', 'L'], ['06', '本'], ['07', '缶'], ['08', '袋'], ['09', '日'], ['10', '時間'], ['11', '人'], ['12', '台'], ['13', '回'], ['14', '式'], ['15', '㎡'], ['16', '年'], ['17', '月'], ['18', '箱'], ['19', '名'], ['20', '円'], ['21', '枚'], ['22', 'm'], ['23', '点'], ['99', 'その他']]],
  ['A0007', '消費税率', [['20140401', '8%', '8'], ['20191001', '10%', '10']]],
  ['A0010', '天候', [['1', '晴れ'], ['2', '曇り'], ['3', '雨'], ['4', '雪']]], // 現行の値は資料になく推定（提案書の画面例「晴れ」）
];
async function javaCodes(pool, env) {
  for (const [key, keyName, list] of JAVA_CODES)
    for (const [code, name, cat1 = ' '] of list) await pool.query("INSERT IGNORE INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES (?,?,?,?,?,?,' ',' ')", [key, keyName, code, name, name, cat1]);
  await pool.query("CREATE OR REPLACE FUNCTION unit_name(c text) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT COALESCE((SELECT code_dtl_nam FROM code_m WHERE code_key='A0003' AND code_dtl=c LIMIT 1), c) $f$");
  const [[op]] = await pool.query('SELECT COUNT(*) n FROM operator_m');
  if (!Number(op.n)) {
    const [[u]] = await pool.query('SELECT user_id FROM users WHERE login_id=?', [env.DEMO_USER || '']);
    await pool.query("INSERT INTO operator_m (tanto_cd,tanto_nm,user_id,mailaddr,delete_f) VALUES (1,'デモ担当者',?,'','')", [u?.user_id || 0]);
  }
  const [[done]] = await pool.query("SELECT 1 x FROM code_m WHERE code_key='SET' AND code_dtl='CMP1021B'");
  if (done) return;
  await pool.query("UPDATE item_m i SET unit=u.code_dtl FROM code_m u WHERE u.code_key='A0003' AND u.code_dtl_nam=i.unit AND i.unit !~ '^[0-9]{2}$'");
  await pool.query("UPDATE shipment_slip s SET unit_cd=u.code_dtl FROM code_m u WHERE u.code_key='A0003' AND u.code_dtl_nam=s.unit_cd AND s.unit_cd !~ '^[0-9]{2}$'");
  await pool.query("UPDATE sales_trn t SET unit_cd=CAST(i.unit AS INTEGER) FROM item_m i WHERE i.item_cd=t.item_cd AND i.unit ~ '^[0-9]{2}$' AND t.unit_cd IS NULL");
  await pool.query('UPDATE shipment_slip SET delivery_kbn_cd=1 WHERE delivery_kbn_cd=0');
  await pool.query('UPDATE sales_trn s SET shipping_kb=1 WHERE shipping_kb IS NULL');
  await pool.query("UPDATE shipment_slip SET person_in_charge_cd=(SELECT LPAD(CAST(MIN(tanto_cd) AS TEXT),6,'0') FROM operator_m) WHERE person_in_charge_cd=''");
  await pool.query(CUMULATIVE_SQL.replace('%WHERE%', 'TRUE'));
  await pool.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('SET','設定','CMP1021B','単位コード・納入区分・担当者・累計 移行済',?,'','','')", [new Date().toISOString().slice(0, 10)]);
}
// Applies the reviewed DDL only when explicitly pointed at it (empty test databases). Production tables already exist.
async function applyDdl(pool, dir) {
  // PostgreSQL 版 DDL（test/schema/schema.sql：本番 DB のカタログから test/dump-schema.mjs で生成）
  const sql = (await readFile(join(dir, 'schema.sql'), 'utf8')).split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await pool.query(stmt);
}
export async function prepare(pool, env = process.env) {
  const have = new Set((await rows(pool, 'SELECT table_name n FROM information_schema.tables WHERE table_schema=current_schema()')).map(r => r.n));
  let missing = Object.keys(TABLES).filter(t => !have.has(t));
  if (missing.length && missing.length === Object.keys(TABLES).length && env.SCHEMA_SQL_DIR) { await applyDdl(pool, env.SCHEMA_SQL_DIR); missing = []; }
  if (missing.length) throw Error('Business tables are missing: ' + missing.join(','));

  await pool.query(`CREATE TABLE IF NOT EXISTS app_session (token_hash varchar(64) COLLATE "C" PRIMARY KEY, user_id integer NOT NULL, csrf_token varchar(48) COLLATE "C" NOT NULL,
    expires_at timestamp(6) NOT NULL, created_at timestamp(6) NOT NULL)`);
  await pool.query('CREATE INDEX IF NOT EXISTS ix_session_user ON app_session (user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS ix_session_expiry ON app_session (expires_at)');
  await pool.query(`CREATE TABLE IF NOT EXISTS app_period_close (period varchar(7) COLLATE "C" PRIMARY KEY, closed_at timestamp(6) NOT NULL, closed_by varchar(256) COLLATE "C" NOT NULL)`);
  // 伝票番号（現行の系列連番を引継ぎ）。既存仕訳には日付・ID順で一度だけ採番する。
  await pool.query(`CREATE TABLE IF NOT EXISTS app_slip_series (series varchar(4) COLLATE "C" PRIMARY KEY, last_no integer NOT NULL)`);
  await pool.query('ALTER TABLE app_slip_series ALTER COLUMN series TYPE varchar(10)'); // 伝票の種類＋年度（例 R2026）をキーにする（2026-10-28）
  await pool.query(`CREATE TABLE IF NOT EXISTS app_slip_no (journal_id bigint PRIMARY KEY, slip_no varchar(12) COLLATE "C" NOT NULL)`);
  // 入金額配賦登録（現行 HJW030）：NO36 入金明細及び配分表の行ごとに、構成員別の配分額を手で調整した値（parts＝{構成員コード: 金額} の JSON）
  // 請求データ（得意先×現場×出荷日×商品のまとめ、指摘 No.9）：請求データ作成のたびに請求ごとに作り直す。請求の取消で一緒に消える
  await pool.query(`CREATE TABLE IF NOT EXISTS app_billing_line (invoice_id bigint NOT NULL REFERENCES billing_head (invoice_id) ON DELETE CASCADE, line_no integer NOT NULL,
    site_key varchar(20) COLLATE "C" NOT NULL DEFAULT '', site_name varchar(80) NOT NULL DEFAULT '', sales_date date NOT NULL, slip_no varchar(40) COLLATE "C" NOT NULL, slip_count integer NOT NULL DEFAULT 1, order_nos text NOT NULL DEFAULT '',
    ship_kb integer NOT NULL DEFAULT 1, item_cd varchar(20) COLLATE "C" NOT NULL DEFAULT '', item_name varchar(60) NOT NULL DEFAULT '', unit varchar(10) NOT NULL DEFAULT '', quantity numeric(14,3) NOT NULL, unit_price numeric(14,2) NOT NULL,
    money numeric(14,0) NOT NULL, tax_rate integer NOT NULL, carry varchar(20) NOT NULL DEFAULT '', remarks varchar(80) NOT NULL DEFAULT '', PRIMARY KEY (invoice_id, line_no))`);
  // 伝票No の表示を 10/24 回答の形（赤黒のある元伝票 -01、赤 -02、黒 -03）に変えた（2026-10-27）。旧表示（-2・-3、元伝票に枝番なし）で保存したまとめは消す（起動後に作り直す。何度実行しても同じ）
  await pool.query(`DELETE FROM app_billing_line WHERE invoice_id IN (SELECT b.invoice_id FROM app_billing_line b WHERE b.slip_no ~ '-[0-9]$' OR EXISTS (SELECT 1 FROM sales_trn x WHERE x.sales_no=b.slip_no AND x.order_no<>b.slip_no))`);
  // 請求書の現場別発行（2026-10-27）：発行（invoice_issue の1回）ごとに、発行した現場名。行が無い発行（それ以前）は全現場を発行したものとみなす
  await pool.query(`CREATE TABLE IF NOT EXISTS app_invoice_issue_site (invoice_id bigint NOT NULL REFERENCES billing_head (invoice_id) ON DELETE CASCADE, issue_no integer NOT NULL,
    site_name varchar(80) NOT NULL, PRIMARY KEY (invoice_id, issue_no, site_name))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_jv_alloc (alloc_key varchar(40) COLLATE "C" PRIMARY KEY, parts text NOT NULL, updated_by varchar(256) COLLATE "C" NOT NULL, updated_at timestamp(6) NOT NULL)`);
  await slipNoBackfill(pool);
  // 赤黒訂正の黒伝票が区分 1 で登録されていた不具合（2026-10-23 修正）の補正：元伝票に結び付いた黒（sales_suffix 3）を区分 5 にそろえる（何度実行しても同じ）
  const BLACK = "s.sales_suffix=3 AND s.sales_no<>s.order_no AND EXISTS (SELECT 1 FROM sales_trn o WHERE o.order_no=s.sales_no)";
  await pool.query(`UPDATE shipment_slip sl SET ship_kb=5 FROM sales_trn s WHERE s.order_no=sl.order_no AND sl.ship_kb<>5 AND ${BLACK}`);
  await pool.query(`UPDATE sales_trn s SET ship_kb='5' WHERE s.ship_kb<>'5' AND ${BLACK}`);
  // 現行データ移行後（出荷 約10万件）でも一覧・訂正判定・帳票が遅くならないよう索引を追加（2026-10-21 Render で1か月の一覧に約25秒）
  for (const sql of ['CREATE INDEX IF NOT EXISTS ix_sales_trn_sales_no ON sales_trn (sales_no)', 'CREATE INDEX IF NOT EXISTS ix_sales_trn_date ON sales_trn (sales_date, customers_cd)',
    'CREATE INDEX IF NOT EXISTS ix_shipment_slip_work ON shipment_slip (shipment_dt, customers_cd, item_cd)', 'CREATE INDEX IF NOT EXISTS ix_shipment_plan_work ON shipment_plan (shipment_dt, customers_cd, item_cd)',
    'CREATE INDEX IF NOT EXISTS ix_billing_detail_head ON billing_detail (customers_cd, closing_yymm, claim_processing_period)', 'CREATE INDEX IF NOT EXISTS ix_billing_head_cust ON billing_head (customers_cd, closing_date)']) await pool.query(sql);
  // 2026-10-21 再構成：仕入の区分・運賃行、定時請求の請求No（業者ごと4桁）、明細の摘要コード（工事コード7桁）。44表設計への列追加。
  // 赤黒の訂正日（2026-10-27 大西さん回答 H：売上日は元伝票の売上日、訂正日は別に持つ）
  await pool.query('ALTER TABLE sales_trn ADD COLUMN IF NOT EXISTS correction_date numeric(8)');
  await pool.query(`ALTER TABLE purchase ADD COLUMN IF NOT EXISTS purchase_kb varchar(1) COLLATE "C" NOT NULL DEFAULT '1'`);
  await pool.query(`ALTER TABLE purchase ADD COLUMN IF NOT EXISTS line_kind varchar(1) COLLATE "C" NOT NULL DEFAULT '1'`);
  await pool.query(`ALTER TABLE expense_document ADD COLUMN IF NOT EXISTS bill_no varchar(4) COLLATE "C"`);
  await pool.query(`ALTER TABLE expense_line ADD COLUMN IF NOT EXISTS memo_code varchar(7) COLLATE "C"`);
  // 2026-10-22 請求No 未設定の定時請求（移行データ・追加前の登録分）に業者ごとの4桁連番を計上日順で振る（10/19：請求No は業者の伝票単位に4桁連番）
  await pool.query(`UPDATE expense_document d SET bill_no=LPAD(CAST(((x.base + x.rn - 1) % 9999) + 1 AS TEXT), 4, '0')
    FROM (SELECT e.expense_id, ROW_NUMBER() OVER (PARTITION BY e.vendor_id ORDER BY e.booked_on, e.document_no) rn,
      COALESCE((SELECT MAX(CAST(b.bill_no AS INTEGER)) FROM expense_document b WHERE b.vendor_id=e.vendor_id AND b.bill_no ~ '^[0-9]+$'), 0) base
      FROM expense_document e WHERE e.expense_kind='PAYABLE' AND e.bill_no IS NULL AND e.vendor_id IS NOT NULL) x WHERE d.expense_id=x.expense_id`);
  await prepareKb(pool);
  pool.resetMeta?.();

  for (const [key, prefix, label] of Object.values(NUMBERING)) await pool.query('INSERT IGNORE INTO numbering_m (numbering_key,numbering_pattern,present_value) VALUES (?,?,?)', [key, `${prefix}99999999 ${label}`.slice(0, 16), '0']);
  for (const [code, name] of SYSTEM_ACCOUNTS) await pool.query('INSERT IGNORE INTO account_subject (account_code,account_name,active) VALUES (?,?,TRUE)', [code, name]);
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES ('8330','101','振込手数料',TRUE)");
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES ('8330','107','その他雑品（協力会費等）',TRUE)");
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES ('8790','001','振込手数料',TRUE)");
  await pool.query("INSERT IGNORE INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('DEPT','部門','063','工場（部門063）','','1','','')");
  // NO6: billing is per customer. Older per-site heads that are the only head of their customer/closing become customer-level.
  await pool.query("UPDATE billing_head h SET field_cd='', field_suffix='' FROM (SELECT customers_cd, closing_yymm, closing_date FROM billing_head GROUP BY customers_cd, closing_yymm, closing_date HAVING COUNT(*)=1) o WHERE o.customers_cd=h.customers_cd AND o.closing_yymm=h.closing_yymm AND o.closing_date=h.closing_date AND h.field_cd<>''");
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) SELECT '1113', code_dtl, LEFT(code_dtl_nam,100), category1<>'0' FROM code_m WHERE code_key='BANK'");
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) SELECT '1112', code_dtl, LEFT(code_dtl_nam,100), category1<>'0' FROM code_m WHERE code_key='BANK'");
  await pool.query(`INSERT IGNORE INTO company_info_m (company_info_id,company_name1,company_name2,company_kana1,company_kana2,company_abr,plant_name,plant_kana,plant_mgr,postcode,pref,addr1,addr2,tel_no,fax_no,saisyuturyoku_word,closing_m,closing_d,tax_round,package_nam,package_ver,trading_day,claim_typ,proceed_round,n_pr_kind)
    VALUES (1,'サンプル建材株式会社','（架空・デモ用）','サンプルケンザイ','','サンプル建材','サンプル工場','','','0000000','東京都','架空区デモ町1-2-3','','00-0000-0000','00-0000-0001','再発行',10,20,'1','APLink請求入金',1.00,NULL,'1','1','1')`);
  await compatMigration(pool);
  await getsudoMigration(pool);
  await javaCodes(pool, env);
  for (const [id, name] of Object.entries(ROLES)) await pool.query('INSERT INTO roles (role_id,role_name) VALUES (?,?) ON DUPLICATE KEY UPDATE role_name=VALUES(role_name)', [Number(id), name]);
  for (const [id, title, url, icon, grp] of MENUS) {
    await pool.query('INSERT INTO menus (menu_id,menu_title,launch_url,parent_menu_id,display_seq,menu_class,group_title) VALUES (?,?,?,0,?,?,?) ON DUPLICATE KEY UPDATE menu_title=VALUES(menu_title),launch_url=VALUES(launch_url),display_seq=VALUES(display_seq),menu_class=VALUES(menu_class),group_title=VALUES(group_title)', [id, title, url, id * 10, icon, grp]);
    for (const role of id === 16 ? [1] : [1, 2, 3, 4, 5]) await pool.query('INSERT IGNORE INTO menu_role_ts (menu_id,role_id) VALUES (?,?)', [id, role]);
  }
  // Initial administrator: DEMO_USER / DEMO_PASSWORD stay authoritative for this one account.
  const login = env.DEMO_USER, pw = env.DEMO_PASSWORD;
  if (!login || !pw || pw.length < 12) throw Error('Set DEMO_USER and DEMO_PASSWORD (12+ characters)');
  const u = await one(pool, 'SELECT * FROM users WHERE login_id=?', [login]);
  if (!u) {
    const id = Number((await one(pool, 'SELECT COALESCE(MAX(user_id),0)+1 n FROM users')).n);
    await pool.query('INSERT INTO users (user_id,login_id,password_hash,login_name,start_menu_id,enabled) VALUES (?,?,?,?,1,TRUE)', [id, login, await hashPassword(pw), '管理者']);
    await pool.query('INSERT IGNORE INTO user_role_ts (user_id,role_id) VALUES (?,1)', [id]);
  } else {
    if (!(await verifyPassword(pw, u.password_hash))) { await pool.query('UPDATE users SET password_hash=? WHERE user_id=?', [await hashPassword(pw), u.user_id]); await pool.query('DELETE FROM app_session WHERE user_id=?', [u.user_id]); }
    await pool.query('UPDATE users SET enabled=TRUE WHERE user_id=?', [u.user_id]);
    await pool.query('INSERT IGNORE INTO user_role_ts (user_id,role_id) VALUES (?,1)', [u.user_id]);
  }
  // 初期の担当者（javaCodes で作成、空の DB では利用者作成前）を初期管理者に紐付ける
  await pool.query("UPDATE operator_m SET user_id=(SELECT user_id FROM users WHERE login_id=?) WHERE tanto_cd=1 AND tanto_nm='デモ担当者' AND user_id=0", [login]);
}
