// 外部システム gsLink（public/gs-link.html）のデータ（2026-11-05 ユーザー指示：画面のメモリ保持 → 本システムの DB へ移行）
// テーブル名は gs-link の DB のキー。本システムに同じ名前のテーブルがあれば先頭に gs_ を付ける（user は PostgreSQL の予約語で、users（利用者）と同じ意味のため gs_user）。
// 各テーブル：id が主キー、sort_no は一覧の並び（新規は先頭＝最小値−1）。
import { rows, one, audit } from './db.mjs';
import { check } from './domain.mjs';

const S = n => ['s', n], N = ['n'], D = ['d'];
export const GS = {
  shukka: { table: 'shukka', cols: { id: S(20), date: D, cust: S(60), item: S(60), qty: N, unit: S(10), veh: S(20), driver: S(40), dest: S(100), status: S(10) } },
  uriage: { table: 'uriage', cols: { id: S(20), date: D, cust: S(60), item: S(60), qty: N, price: N, amount: N, tax: N, staff: S(40) } },
  seikyu: { table: 'seikyu', cols: { id: S(20), month: S(7), cust: S(60), amount: N, tax: N, total: N, due: D, status: S(10) } },
  cust: { table: 'cust', cols: { id: S(20), name: S(60), tel: S(20), mgr: S(40), addr: S(100), close: S(10), site: S(10), use: S(10) } },
  item: { table: 'item', cols: { id: S(20), name: S(60), cat: S(20), unit: S(10), price: N, cost: N, stock: N } },
  veh: { table: 'veh', cols: { id: S(20), no: S(30), type: S(30), driver: S(40), insp: D, use: S(10) } },
  user: { table: 'gs_user', cols: { id: S(40), name: S(40), dept: S(20), role: S(20), last: D, use: S(10) } },
  dump: { table: 'dump', cols: { id: S(20), date: D, veh: S(20), driver: S(40), from: S(60), to: S(60), trips: N, ton: N, fee: N } },
  renkei: { table: 'renkei', cols: { id: S(20), time: S(16), kind: S(20), file: S(100), cnt: N, result: S(10), msg: S(200) } },
};
const q = k => `"${k}"`;
const ddl = ([t, n]) => (t === 's' ? `varchar(${n}) COLLATE "C" NOT NULL DEFAULT ''` : t === 'n' ? 'numeric(14,2) NOT NULL DEFAULT 0' : 'date');

// 初期データ（gs-link.html にあったサンプル。日付はテーブルを作った日からの相対）
const SEED = d => ({
  shukka: [
    ['SH-1001', d(-2), 'ポハン商事', '鋼材パイプ 50A', 120, '本', '5t-01', '李 大韓', '浦項市 南区', '出荷済'], ['SH-1002', d(-1), '東海物産', 'セメント 25kg', 400, '袋', '11t-02', '朴 民秀', '盈徳郡', '出荷済'],
    ['SH-1003', d(0), '永徳建設', '砕石 40mm', 28, 'm3', 'ダンプ-03', '崔 英浩', '盈徳郡 江口面', '出荷待'], ['SH-1004', d(0), 'ポハン商事', 'H形鋼 200x100', 36, '本', '11t-02', '朴 民秀', '慶州市', '出荷待'],
    ['SH-1005', d(1), '大邱鋼業', '鉄筋 D13', 900, '本', '5t-01', '李 大韓', '大邱市 達城郡', '予定'], ['SH-1006', d(-3), '東海物産', '合板 12mm', 250, '枚', '4t-04', '鄭 昌植', '浦項市 北区', '納品完了'],
    ['SH-1007', d(-4), '永徳建設', '生コン 18-8-25', 16, 'm3', 'ミキサ-05', '韓 志成', '盈徳郡 丑山面', '納品完了'], ['SH-1008', d(-5), '大邱鋼業', '鋼材パイプ 50A', 60, '本', '5t-01', '李 大韓', '亀尾市', 'キャンセル']],
  uriage: [
    ['UA-2001', d(-5), '大邱鋼業', '鋼材パイプ 50A', 60, 8500, 510000, 51000, '金 賢秀'], ['UA-2002', d(-4), '永徳建設', '生コン 18-8-25', 16, 92000, 1472000, 147200, '金 賢秀'],
    ['UA-2003', d(-3), '東海物産', '合板 12mm', 250, 3200, 800000, 80000, '尹 相赫'], ['UA-2004', d(-2), 'ポハン商事', '鋼材パイプ 50A', 120, 8500, 1020000, 102000, '尹 相赫'],
    ['UA-2005', d(-1), '東海物産', 'セメント 25kg', 400, 7800, 3120000, 312000, '金 賢秀']],
  seikyu: [
    ['IV-3001', '2026-09', 'ポハン商事', 4820000, 482000, 5302000, d(-6), '入金済'], ['IV-3002', '2026-09', '東海物産', 3920000, 392000, 4312000, d(-6), '入金済'],
    ['IV-3003', '2026-10', 'ポハン商事', 5160000, 516000, 5676000, d(9), '請求済'], ['IV-3004', '2026-10', '永徳建設', 2980000, 298000, 3278000, d(9), '請求済'],
    ['IV-3005', '2026-10', '大邱鋼業', 1510000, 151000, 1661000, d(9), '未請求']],
  cust: [
    ['C-001', 'ポハン商事', '054-123-4567', '呉 成民', '慶北 浦項市 南区 大島路 12', '末日', '30日', '使用'], ['C-002', '東海物産', '054-222-8890', '申 美来', '慶北 浦項市 北区 竹島路 88', '20日', '45日', '使用'],
    ['C-003', '永徳建設', '054-733-1120', '車 俊成', '慶北 盈徳郡 盈徳邑 中央路 5', '末日', '30日', '使用'], ['C-004', '大邱鋼業', '053-555-7712', '林 宰赫', '大邱市 達城郡 論工邑 工団路 44', '10日', '60日', '使用'],
    ['C-005', '慶州資材', '054-771-3300', '黄 多恵', '慶北 慶州市 川北面', '末日', '30日', '停止']],
  item: [
    ['P-101', '鋼材パイプ 50A', '鋼材', '本', 8500, 6900, 380], ['P-102', 'H形鋼 200x100', '鋼材', '本', 24500, 20100, 92], ['P-103', '鉄筋 D13', '鋼材', '本', 4100, 3350, 1540],
    ['P-201', 'セメント 25kg', '資材', '袋', 7800, 6200, 860], ['P-202', '合板 12mm', '資材', '枚', 3200, 2450, 430], ['P-301', '砕石 40mm', '骨材', 'm3', 31000, 24000, 210],
    ['P-302', '生コン 18-8-25', '骨材', 'm3', 92000, 78000, 0]],
  veh: [
    ['5t-01', '慶北 80나 1234', 'カーゴ 5t', '李 大韓', d(48), '稼働'], ['11t-02', '慶北 81다 5678', 'カーゴ 11t', '朴 民秀', d(120), '稼働'], ['ダンプ-03', '慶北 82라 9012', 'ダンプ 15t', '崔 英浩', d(15), '稼働'],
    ['4t-04', '慶北 80마 3456', 'カーゴ 4t', '鄭 昌植', d(-3), '整備中'], ['ミキサ-05', '慶北 83바 7890', 'ミキサ 6m3', '韓 志成', d(210), '稼働']],
  user: [
    ['admin', '金 現洙', '経営', '管理者', d(0), '有効'], ['kim.hs', '金 賢秀', '営業', '一般', d(0), '有効'], ['yoon.sh', '尹 相赫', '営業', '一般', d(-1), '有効'],
    ['lee.dh', '李 大韓', '運送', 'ドライバー', d(-2), '有効'], ['old.staff', '呉 旧員', '総務', '一般', d(-180), '無効']],
  dump: [
    ['DP-401', d(0), 'ダンプ-03', '崔 英浩', '浦項採石場', '盈徳現場A', 6, 84, 420000], ['DP-402', d(-1), 'ダンプ-03', '崔 英浩', '浦項採石場', '盈徳現場B', 5, 70, 350000],
    ['DP-403', d(-2), 'ダンプ-03', '崔 英浩', '慶州土取場', '浦項現場C', 4, 56, 300000], ['DP-404', d(-3), 'ダンプ-03', '崔 英浩', '浦項採石場', '盈徳現場A', 7, 98, 490000]],
  renkei: [
    ['LG-501', d(0) + ' 06:00', '受注取込', 'order_20261105.csv', 42, '成功', '-'], ['LG-502', d(0) + ' 06:05', '在庫連携', 'stock_sync.json', 310, '成功', '-'],
    ['LG-503', d(-1) + ' 06:00', '受注取込', 'order_20261104.csv', 38, '警告', '得意先コード未登録 2件'], ['LG-504', d(-2) + ' 06:00', '会計連携', 'ac_202610.txt', 0, '失敗', '接続タイムアウト']],
});

// 起動時：無いテーブルだけ作り、作ったテーブルに初期データを入れる（既存のデータには触れない）
export async function gsMigration(pool) {
  const base = new Date(), d = o => { const t = new Date(base); t.setDate(t.getDate() + o); return t.toISOString().slice(0, 10); }, seed = SEED(d);
  for (const [key, { table, cols }] of Object.entries(GS)) {
    if ((await rows(pool, 'SELECT to_regclass(?::text) t', [table]))[0].t) continue;
    await pool.query(`CREATE TABLE ${table} (${Object.entries(cols).map(([k, t]) => `${q(k)} ${k === 'id' ? `varchar(${t[1]}) COLLATE "C" PRIMARY KEY` : ddl(t)}`).join(', ')}, sort_no integer NOT NULL DEFAULT 0)`);
    const ks = Object.keys(cols);
    for (const [i, r] of seed[key].entries()) await pool.query(`INSERT INTO ${table} (${ks.map(q).join(',')},sort_no) VALUES (${ks.map(() => '?').join(',')},?)`, [...r, i + 1]);
  }
}

const spec = key => { const s = Object.hasOwn(GS, key) && GS[key]; check(s, 'データの種類が不正です'); return s; };
const out = (cols, r) => Object.fromEntries(Object.entries(cols).map(([k, [t]]) => [k, t === 'n' ? Number(r[k]) : r[k] ?? '']));
const select = (table, cols) => `SELECT ${Object.entries(cols).map(([k, [t]]) => (t === 'd' ? `to_char(${q(k)},'YYYY-MM-DD') ${q(k)}` : q(k))).join(',')} FROM ${table}`;

export async function listAll(c) {
  const res = {};
  for (const [key, { table, cols }] of Object.entries(GS)) res[key] = (await rows(c, `${select(table, cols)} ORDER BY sort_no, id`)).map(r => out(cols, r));
  return res;
}

function values(cols, rec) {
  return Object.entries(cols).map(([k, [t, n]]) => {
    const v = rec?.[k];
    if (t === 'n') { const x = v === '' || v === undefined || v === null ? 0 : Number(v); check(Number.isFinite(x) && Math.abs(x) < 1e12, `${k} は数値で入力してください`); return Math.round(x * 100) / 100; }
    const s = String(v ?? '').trim();
    if (t === 'd') { check(!s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))), `${k} の日付が不正です`); return s || null; }
    check(s.length <= n, `${k} は ${n} 文字以内で入力してください`); return s;
  });
}

// 登録・修正：mode=create は新規（同じコードはエラー）、update は元のコード（orig）の行を置き換える
export async function save(c, ctx, b) {
  const { table, cols } = spec(b?.key), ks = Object.keys(cols), v = values(cols, b?.record), id = v[0];
  check(id, 'コードを入力してください');
  if (b.mode === 'update') {
    const orig = String(b.orig ?? '');
    check(await one(c, `SELECT 1 x FROM ${table} WHERE id=?`, [orig]), '対象のデータがありません（削除された可能性があります）');
    if (id !== orig) check(!(await one(c, `SELECT 1 x FROM ${table} WHERE id=?`, [id])), '同じコードが既に登録されています。');
    await c.query(`UPDATE ${table} SET ${ks.map(k => `${q(k)}=?`).join(',')} WHERE id=?`, [...v, orig]);
  } else {
    check(!(await one(c, `SELECT 1 x FROM ${table} WHERE id=?`, [id])), '同じコードが既に登録されています。');
    const top = await one(c, `SELECT COALESCE(MIN(sort_no),1) m FROM ${table}`);
    await c.query(`INSERT INTO ${table} (${ks.map(q).join(',')},sort_no) VALUES (${ks.map(() => '?').join(',')},?)`, [...v, Number(top.m) - 1]);
  }
  await audit(c, ctx, table, id, b.mode === 'update' ? 'update' : 'create');
  return out(cols, (await rows(c, `${select(table, cols)} WHERE id=?`, [id]))[0]);
}

export async function remove(c, ctx, b) {
  const { table } = spec(b?.key), id = String(b?.id ?? '');
  check(await one(c, `SELECT 1 x FROM ${table} WHERE id=?`, [id]), '対象のデータがありません（削除された可能性があります）');
  await c.query(`DELETE FROM ${table} WHERE id=?`, [id]);
  await audit(c, ctx, table, id, 'delete');
  return { ok: true };
}
