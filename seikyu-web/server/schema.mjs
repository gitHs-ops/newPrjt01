import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rows, one, NUMBERING } from './db.mjs';
import { SYSTEM_ACCOUNTS } from './masters.mjs';
import { TABLES } from './ledger.mjs';
import { hashPassword, verifyPassword } from './users.mjs';
import { prepareKb } from './kb.mjs';

export const MENUS = [
  [1, 'ダッシュボード', '#dashboard', '▦', 'OVERVIEW'], [2, '出荷・売上', '#shipments', '▤', '販売・請求'], [3, '請求締め・発行', '#invoices', '▧', '販売・請求'], [4, '入金・消込', '#receipts', '↙', '販売・請求'],
  [5, '商品仕入', '#purchases', '◇', '購買・支払'], [6, '在庫計上', '#inventory', '▥', '購買・支払'], [7, '定時請求', '#payables', '▣', '購買・支払'], [8, '小口現金', '#cash', '◈', '購買・支払'], [9, '支払', '#payments', '↗', '購買・支払'],
  [10, '仕訳・会計連携', '#journals', '≡', '会計・管理'], [11, '帳票・データ出力', '#reports', '▱', '会計・管理'], [12, '月次確定', '#periods', '◉', '会計・管理'], [13, 'マスタ管理', '#masters', '⚙', '会計・管理'],
  [14, '移行・確認事項', '#migration', '⊞', '会計・管理'], [15, '操作履歴', '#audit', '◷', '会計・管理'], [16, '利用者管理', '#users', '☺', '会計・管理'],
  [17, '仕訳入力', '#kb-entry', '✎', '財務会計'], [18, '仕訳帳・伝票検索', '#kb-journal', '☰', '財務会計'], [19, '元帳', '#kb-ledger', '▤', '財務会計'], [20, '残高試算表', '#kb-trial', '⊟', '財務会計'],
  [21, '決算書・消費税', '#kb-fs', '▣', '財務会計'], [22, '仕訳受入・書出', '#kb-import', '⇅', '財務会計'], [23, '会計設定', '#kb-setup', '⚙', '財務会計'],
];

// Applies the reviewed DDL only when explicitly pointed at it (empty test databases). Production tables already exist.
async function applyDdl(pool, dir) {
  // PostgreSQL 版 DDL（MySQL 版から移行ツールで生成したもの。リポジトリには置かない）
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
  await pool.query("INSERT IGNORE INTO account_subsubject (account_code,sub_code,sub_name,active) SELECT '1112', code_dtl, LEFT(code_dtl_nam,100), category1<>'0' FROM code_m WHERE code_key='BANK'");
  await pool.query(`INSERT IGNORE INTO company_info_m (company_info_id,company_name1,company_name2,company_kana1,company_kana2,company_abr,plant_name,plant_kana,plant_mgr,postcode,pref,addr1,addr2,tel_no,fax_no,saisyuturyoku_word,closing_m,closing_d,tax_round,package_nam,package_ver,trading_day,claim_typ,proceed_round,n_pr_kind)
    VALUES (1,'サンプル建材株式会社','（架空・デモ用）','サンプルケンザイ','','サンプル建材','サンプル工場','','','0000000','東京都','架空区デモ町1-2-3','','00-0000-0000','00-0000-0001','再発行',3,31,'1','APLink請求入金',1.00,NULL,'1','1','1')`);
  for (const [id, name] of [[1, '管理者'], [2, '担当者'], [3, '参照者']]) await pool.query('INSERT IGNORE INTO roles (role_id,role_name) VALUES (?,?)', [id, name]);
  for (const [id, title, url, icon, grp] of MENUS) {
    await pool.query('INSERT INTO menus (menu_id,menu_title,launch_url,parent_menu_id,display_seq,menu_class,group_title) VALUES (?,?,?,0,?,?,?) ON DUPLICATE KEY UPDATE menu_title=VALUES(menu_title),launch_url=VALUES(launch_url),display_seq=VALUES(display_seq),menu_class=VALUES(menu_class),group_title=VALUES(group_title)', [id, title, url, id * 10, icon, grp]);
    for (const role of id === 16 ? [1] : [1, 2, 3]) await pool.query('INSERT IGNORE INTO menu_role_ts (menu_id,role_id) VALUES (?,?)', [id, role]);
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
}
