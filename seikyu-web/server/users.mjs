import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { check, Conflict, text, bool } from './domain.mjs';
import { rows, one, audit } from './db.mjs';

const scryptAsync = promisify(scrypt);
export const ROLES = { 1: '管理者', 2: '担当者', 3: '参照者' };
export const SESSION_HOURS = 8;
const sha = s => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = randomBytes(16), key = await scryptAsync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) { await scryptAsync('dummy', 'dummysaltdummysalt', 64); return false; }
  const want = Buffer.from(hash, 'base64'), got = await scryptAsync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(want, got);
}
export function checkPassword(pw) { check(typeof pw === 'string' && pw.length >= 12 && pw.length <= 200, 'パスワードは12文字以上で入力してください'); return pw; }

const USER_SQL = 'SELECT u.*, (SELECT MIN(role_id) FROM user_role_ts r WHERE r.user_id=u.user_id) role_id FROM users u';
export async function authenticate(c, loginId, password) {
  const u = await one(c, `${USER_SQL} WHERE u.login_id=?`, [String(loginId)]);
  const ok = await verifyPassword(password, u?.password_hash || 'x');
  return ok && u?.enabled && u.role_id ? u : null;
}
export async function createSession(c, user) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
  await c.query('DELETE FROM app_session WHERE expires_at < UTC_TIMESTAMP(6)');
  await c.query(`INSERT INTO app_session (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,LOCALTIMESTAMP + INTERVAL '${SESSION_HOURS} hours',LOCALTIMESTAMP)`, [sha(token), user.user_id, csrf]);
  return token;
}
export async function sessionUser(c, token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await one(c, `SELECT s.csrf_token, u.*, (SELECT MIN(role_id) FROM user_role_ts x WHERE x.user_id=u.user_id) role_id FROM app_session s JOIN users u ON u.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at > UTC_TIMESTAMP(6)`, [sha(token)]);
  return r && r.enabled && r.role_id ? { user_id: r.user_id, login_id: r.login_id, name: r.login_name, role: Number(r.role_id), roleName: ROLES[r.role_id], csrf: r.csrf_token } : null;
}
export const destroySession = (c, token) => c.query('DELETE FROM app_session WHERE token_hash=?', [sha(String(token || ''))]);

export async function menusFor(c, role) {
  return rows(c, 'SELECT m.menu_id id, m.menu_title title, m.launch_url url, m.display_seq seq, m.menu_class icon, m.group_title grp FROM menus m JOIN menu_role_ts t ON t.menu_id=m.menu_id AND t.role_id=? ORDER BY m.display_seq', [role]);
}
export async function listUsers(c) {
  return (await rows(c, `${USER_SQL} ORDER BY u.user_id`)).map(u => ({ id: u.user_id, loginId: u.login_id, name: u.login_name, role: Number(u.role_id || 0), roleName: ROLES[u.role_id] || '-', enabled: !!u.enabled }));
}
export async function saveUser(c, ctx, p) {
  const role = Number(p.role); check(ROLES[role], 'ロールを選択してください');
  const name = text(p.name, '氏名', 60), enabled = bool(p.enabled ?? true);
  if (!p.id) {
    const loginId = text(p.loginId, 'ログインID', 64, { pattern: /^[A-Za-z0-9._@\-]+$/ }), hash = await hashPassword(checkPassword(p.password));
    check(!(await one(c, 'SELECT 1 x FROM users WHERE login_id=?', [loginId])), 'ログインIDは使用済みです');
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const next = Number((await one(c, 'SELECT COALESCE(MAX(user_id),0)+1 n FROM users')).n);
    await c.query('INSERT INTO users (user_id,login_id,password_hash,login_name,start_menu_id,enabled) VALUES (?,?,?,?,1,?)', [next, loginId, hash, name, enabled]);
    await c.query('INSERT INTO user_role_ts (user_id,role_id) VALUES (?,?)', [next, role]);
    await audit(c, ctx, 'users', next, 'user.create', { loginId, role });
    return { id: next };
  }
  const u = await one(c, `${USER_SQL} WHERE u.user_id=? FOR UPDATE`, [Number(p.id)]); if (!u) throw new Conflict('利用者が見つかりません');
  if (u.user_id === ctx.user.user_id) check(enabled && role === 1, '自分自身の管理者権限・有効状態は変更できません');
  if (Number(u.role_id) === 1 && (role !== 1 || !enabled)) {
    const admins = await one(c, 'SELECT COUNT(*) n FROM users u JOIN user_role_ts r ON r.user_id=u.user_id AND r.role_id=1 WHERE u.enabled');
    check(Number(admins.n) > 1, '有効な管理者が1名以上必要です');
  }
  await c.query('UPDATE users SET login_name=?, enabled=? WHERE user_id=?', [name, enabled, u.user_id]);
  await c.query('DELETE FROM user_role_ts WHERE user_id=?', [u.user_id]);
  await c.query('INSERT INTO user_role_ts (user_id,role_id) VALUES (?,?)', [u.user_id, role]);
  if (p.password) { await c.query('UPDATE users SET password_hash=? WHERE user_id=?', [await hashPassword(checkPassword(p.password)), u.user_id]); await c.query('DELETE FROM app_session WHERE user_id=?', [u.user_id]); }
  if (!enabled) await c.query('DELETE FROM app_session WHERE user_id=?', [u.user_id]);
  await audit(c, ctx, 'users', u.user_id, 'user.update', { role, enabled, passwordReset: !!p.password });
  return { id: u.user_id };
}
export async function changeOwnPassword(c, ctx, { current, password }) {
  const u = await one(c, 'SELECT * FROM users WHERE user_id=? FOR UPDATE', [ctx.user.user_id]);
  check(u.login_id !== process.env.DEMO_USER, '初期管理者のパスワードはRailwayの環境変数 DEMO_PASSWORD で管理しています');
  check(await verifyPassword(String(current || ''), u.password_hash), '現在のパスワードが違います');
  await c.query('UPDATE users SET password_hash=? WHERE user_id=?', [await hashPassword(checkPassword(password)), u.user_id]);
  await audit(c, ctx, 'users', u.user_id, 'user.password', {});
  return { ok: true };
}
