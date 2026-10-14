import { createHash } from 'node:crypto';
import { check, Conflict, text, bool, yen, closingDay, isoDate, today, parseCsv } from './domain.mjs';
import { rows, one, audit, mapSqlError } from './db.mjs';
import { toZenginKana, zenginInvalid } from './zengin.mjs';

// Accounts referenced by automatic journal patterns. They cannot be deactivated.
export const SYSTEM_ACCOUNTS = [
  ['1111', '現金'], ['1112', '当座預金'], ['1120', '受取手形'], ['1131', '売掛金'], ['1360', '材料及び貯蔵品'],
  ['4121', '買掛金'], ['4170', '預り金'], ['4415', '仮受消費税'], ['8130', '合材売上'], ['8231', '仕入'], ['8330', '雑費'], ['8850', '雑損失'], ['82316', '期末棚卸高'],
];
const CODE = /^[0-9A-Za-z\-]+$/;
const del = active => (active ? '0' : '1');
const live = r => r.delete_f !== '1';
const hash = o => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const siteKey = (code, suffix) => `${code}|${suffix}`;

const F = (name, label, extra = {}) => ({ name, label, type: 'text', ...extra });
export const MASTERS = {
  customers: {
    label: '得意先', table: 'client_m',
    fields: [F('code', '得意先コード', { max: 5, key: true }), F('name', '得意先名', { max: 42 }), F('kana', 'カナ', { max: 25, optional: true }),
      F('closing', '締日', { type: 'int', hint: '1〜28、月末は31' }), F('tel', '電話番号', { max: 14, optional: true }), F('address', '住所', { max: 42, optional: true }),
      F('opening', '開始売掛残高', { type: 'int', optional: true, hint: '請求作成後は変更不可' }), F('deposit', '預り金残高（開始）', { type: 'int', optional: true, hint: '入金消込で充当できる額（B-06）' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT c.*, o.amount opening, d.amount deposit FROM client_m c LEFT JOIN opening_balance o ON o.source_reference=CONCAT('OPEN-AR-',c.customers_cd) LEFT JOIN opening_balance d ON d.source_reference=CONCAT('OPEN-ADV-',c.customers_cd)",
    where: 'c.customers_cd=?', keyOf: r => [r.code],
    decode: r => ({ code: r.customers_cd, name: r.customers_name, kana: r.customers_kana, closing: Number(r.deadline) || 31, tel: r.tel_no, address: r.addr1, opening: Number(r.opening || 0), deposit: Number(r.deposit || 0), active: live(r) }),
    validate: r => ({ code: text(r.code, '得意先コード', 5, { pattern: CODE }), name: text(r.name, '得意先名', 42), kana: text(r.kana, 'カナ', 25, { required: false }), closing: closingDay(r.closing ?? 31),
      tel: text(r.tel, '電話番号', 14, { required: false, pattern: /^[0-9\-]+$/ }), address: text(r.address, '住所', 42, { required: false }), opening: yen(r.opening || 0, '開始売掛残高', { negative: true }), deposit: yen(r.deposit || 0, '預り金残高'), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO client_m (customers_cd,customers_name,customers_kana,customers_abr,customers_sec,postcode,tel_no,fax_no,pref,addr1,addr2,customers_pic,pic,deadline,remarks,delete_f,card_member_id) VALUES (?,?,?,'','','',?,'','',?,'','','',?,'',?,'')",
        [r.code, r.name, r.kana, r.tel, r.address, String(r.closing), del(r.active)]);
      else await c.query('UPDATE client_m SET customers_name=?,customers_kana=?,deadline=?,tel_no=?,addr1=?,delete_f=? WHERE customers_cd=?', [r.name, r.kana, String(r.closing), r.tel, r.address, del(r.active), r.code]);
      if ((old?.opening || 0) !== r.opening) {
        const billed = await one(c, 'SELECT COUNT(*) n FROM billing_head WHERE customers_cd=?', [r.code]);
        check(!Number(billed.n), '請求作成後は開始売掛残高を変更できません');
        await c.query("DELETE FROM opening_balance WHERE source_reference=CONCAT('OPEN-AR-',?)", [r.code]);
        if (r.opening) await c.query("INSERT INTO opening_balance (cutover_on,balance_kind,customers_cd,amount,source_reference) VALUES (?,'AR',?,?,CONCAT('OPEN-AR-',?))", [today(), r.code, r.opening, r.code]);
      }
      if ((old?.deposit || 0) !== r.deposit) {
        const used = await one(c, "SELECT COALESCE(SUM(k.amount),0) v FROM receipt_component k JOIN receipt x ON x.receipt_id=k.receipt_id AND x.status='POSTED' WHERE x.customers_cd=? AND k.component_kind='DEPOSIT'", [r.code]);
        check(r.deposit >= Number(used.v), '充当済みの額より小さい預り金残高にはできません');
        await c.query("DELETE FROM opening_balance WHERE source_reference=CONCAT('OPEN-ADV-',?)", [r.code]);
        if (r.deposit) await c.query("INSERT INTO opening_balance (cutover_on,balance_kind,customers_cd,amount,source_reference) VALUES (?,'ADVANCE',?,?,CONCAT('OPEN-ADV-',?))", [today(), r.code, r.deposit, r.code]);
      }
    },
  },
  sites: {
    label: '現場', table: 'field_name_m',
    fields: [F('customer', '得意先', { type: 'ref', ref: 'customers', key: true }), F('code', '現場コード', { max: 7, key: true }), F('suffix', '枝番', { max: 3, key: true, hint: '例: 000' }),
      F('name', '現場名1', { max: 40 }), F('name2', '現場名2', { max: 20, optional: true }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM field_name_m', where: 'customers_cd=? AND field_cd=? AND field_suffix=?', keyOf: r => [r.customer, r.code, r.suffix],
    decode: r => ({ customer: r.customers_cd, code: r.field_cd, suffix: r.field_suffix, name: r.field_name1, name2: r.field_name2, active: live(r) }),
    validate: r => ({ customer: text(r.customer, '得意先', 5), code: text(r.code, '現場コード', 7, { pattern: CODE }), suffix: text(r.suffix || '000', '枝番', 3, { pattern: /^[0-9A-Za-z]+$/ }),
      name: text(r.name, '現場名1', 40), name2: text(r.name2, '現場名2', 20, { required: false }), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) {
        const cust = await one(c, 'SELECT delete_f FROM client_m WHERE customers_cd=?', [r.customer]);
        check(cust && cust.delete_f !== '1', '有効な得意先を選択してください');
        await c.query('INSERT INTO field_name_m (customers_cd,field_cd,field_suffix,field_name1,field_name2,delete_f) VALUES (?,?,?,?,?,?)', [r.customer, r.code, r.suffix, r.name, r.name2, del(r.active)]);
      } else await c.query('UPDATE field_name_m SET field_name1=?,field_name2=?,delete_f=? WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [r.name, r.name2, del(r.active), r.customer, r.code, r.suffix]);
    },
  },
  items: {
    label: '商品', table: 'item_m',
    fields: [F('code', '商品コード', { max: 5, key: true }), F('name', '商品名', { max: 22 }), F('unit', '単位', { max: 2 }), F('price', '標準単価', { type: 'int' }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM item_m', where: 'item_cd=?', keyOf: r => [r.code],
    decode: r => ({ code: r.item_cd, name: r.item_nam, unit: r.unit, price: Number(r.tanka), active: live(r) }),
    validate: r => ({ code: text(r.code, '商品コード', 5, { pattern: CODE }), name: text(r.name, '商品名', 22), unit: text(r.unit || 't', '単位', 2), price: yen(r.price ?? 0, '標準単価', { max: 9999999 }), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO item_m (item_cd,item_nam,item_abr,item_kana,item_bunrui_cd,tanka,freight,unit,base_temp,vary_temp,credit_discount_rate,delete_f,item_product_kb) VALUES (?,?,'','','',?,0,?,0,0,0,?,'')", [r.code, r.name, r.price, r.unit, del(r.active)]);
      else await c.query('UPDATE item_m SET item_nam=?,tanka=?,unit=?,delete_f=? WHERE item_cd=?', [r.name, r.price, r.unit, del(r.active), r.code]);
    },
  },
  prices: {
    label: '得意先別単価', table: 'uriage_tanka_m',
    fields: [F('item', '商品', { type: 'ref', ref: 'items', key: true }), F('customer', '得意先', { type: 'ref', ref: 'customers', key: true }),
      F('site', '現場', { type: 'site', key: true, optional: true, hint: '未指定は得意先共通' }), F('price', '単価', { type: 'int' }),
      F('start', '適用開始日', { type: 'date', optional: true }), F('end', '適用終了日', { type: 'date', optional: true }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM uriage_tanka_m', where: 'item_cd=? AND customers_cd=? AND field_cd=? AND field_suffix=?',
    keyOf: r => { const [code = '', suffix = ''] = (r.site || '').split('|'); return [r.item, r.customer, code, suffix]; },
    decode: r => ({ item: r.item_cd, customer: r.customers_cd, site: r.field_cd ? siteKey(r.field_cd, r.field_suffix) : '', price: Number(r.apply_tanka), start: r.apply_start || '', end: r.apply_end || '', active: live(r) }),
    validate: r => {
      const v = { item: text(r.item, '商品', 5), customer: text(r.customer, '得意先', 5), site: text(r.site, '現場', 11, { required: false }), price: yen(r.price, '単価', { max: 9999999 }),
        start: r.start ? isoDate(r.start, '適用開始日') : '', end: r.end ? isoDate(r.end, '適用終了日') : '', active: bool(r.active ?? true) };
      check(!v.start || !v.end || v.start <= v.end, '適用期間が不正です'); return v;
    },
    async write(c, r, old) {
      const [fc = '', fs = ''] = r.site ? r.site.split('|') : [];
      if (r.site) check(await one(c, 'SELECT 1 FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [r.customer, fc, fs]), '現場が得意先に登録されていません');
      if (!old) await c.query('INSERT INTO uriage_tanka_m (item_cd,customers_cd,field_cd,field_suffix,tanka,freight,apply_tanka,apply_freight,apply_start,apply_end,delete_f,update_daytime) VALUES (?,?,?,?,?,0,?,0,?,?,?,UTC_TIMESTAMP(6))',
        [r.item, r.customer, fc, fs, r.price, r.price, r.start || null, r.end || null, del(r.active)]);
      else await c.query('UPDATE uriage_tanka_m SET tanka=?,apply_tanka=?,apply_start=?,apply_end=?,delete_f=?,update_daytime=UTC_TIMESTAMP(6) WHERE item_cd=? AND customers_cd=? AND field_cd=? AND field_suffix=?',
        [r.price, r.price, r.start || null, r.end || null, del(r.active), r.item, r.customer, fc, fs]);
    },
  },
  banks: {
    label: '銀行（当座預金内訳）', table: 'code_m',
    fields: [F('code', '銀行内訳コード', { max: 12, key: true }), F('name', '銀行名', { max: 40 }),
      F('zgBank', '振込元 銀行番号(4桁)', { max: 4, optional: true, hint: '全銀データ作成用（NO37）' }), F('zgBranch', '振込元 支店番号(3桁)', { max: 3, optional: true }),
      F('zgType', '振込元 預金種目', { type: 'select', options: [['1', '普通'], ['2', '当座'], ['4', '貯蓄']], optional: true }), F('zgAccount', '振込元 口座番号(7桁以内)', { max: 7, optional: true }),
      F('zgCode', '振込依頼人コード(10桁)', { max: 10, optional: true, hint: '銀行から付与されるコード' }), F('zgName', '振込依頼人名（カナ）', { max: 40, optional: true, hint: '半角カナに自動変換' }),
      F('active', '有効', { type: 'bool' })],
    select: "SELECT b.*, z.code_dtl_nam zg_name, z.code_dtl_abr zg_code, z.category1 zg_bank, z.category2 zg_branch_type, z.category3 zg_account FROM code_m b LEFT JOIN code_m z ON z.code_key='ZGN' AND z.code_dtl=b.code_dtl WHERE b.code_key='BANK'",
    where: 'b.code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, zgBank: r.zg_bank || '', zgBranch: (r.zg_branch_type || '').slice(0, 3), zgType: (r.zg_branch_type || '').slice(3, 4) || '1', zgAccount: r.zg_account || '', zgCode: r.zg_code || '', zgName: r.zg_name || '', active: r.category1 !== '0' }),
    validate: r => {
      const v = { code: text(r.code, '銀行内訳コード', 12, { pattern: CODE }), name: text(r.name, '銀行名', 40), zgBank: String(r.zgBank || '').trim(), zgBranch: String(r.zgBranch || '').trim(), zgType: String(r.zgType || '1'),
        zgAccount: String(r.zgAccount || '').trim(), zgCode: String(r.zgCode || '').trim(), zgName: toZenginKana(String(r.zgName || '').trim()), active: bool(r.active ?? true) };
      if (v.zgBank || v.zgBranch || v.zgAccount || v.zgCode || v.zgName.trim()) {
        check(/^\d{4}$/.test(v.zgBank) && /^\d{3}$/.test(v.zgBranch) && /^\d{1,7}$/.test(v.zgAccount) && ['1', '2', '4'].includes(v.zgType), '振込元は銀行4桁・支店3桁・預金種目・口座番号（7桁以内）をすべて入力してください');
        check(/^\d{10}$/.test(v.zgCode), '振込依頼人コードは10桁の数字です');
        check(v.zgName.trim() && v.zgName.length <= 40 && !zenginInvalid(v.zgName).length, '振込依頼人名は全銀で使える文字（カナ・英大文字・数字）で40文字以内にしてください');
      }
      return v;
    },
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('BANK','銀行内訳',?,?,'',?,'','')", [r.code, r.name, r.active ? '1' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,category1=? WHERE code_key='BANK' AND code_dtl=?", [r.name, r.active ? '1' : '0', r.code]);
      // 全銀 payer settings live in code_m key ZGN (same code_dtl): name / requester code / bank / branch+type / account.
      await c.query("DELETE FROM code_m WHERE code_key='ZGN' AND code_dtl=?", [r.code]);
      if (r.zgBank) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('ZGN','全銀振込元',?,?,?,?,?,?)", [r.code, r.zgName, r.zgCode, r.zgBank, r.zgBranch + r.zgType, r.zgAccount]);
      // Bank codes are the sub-accounts of 1112 used in journal lines.
      await c.query("INSERT INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES ('1112',?,?,?) ON DUPLICATE KEY UPDATE sub_name=VALUES(sub_name),active=VALUES(active)", [r.code, r.name.slice(0, 100), r.active]);
    },
  },
  vendors: {
    label: '業者', table: 'vendor',
    fields: [F('code', '業者コード', { max: 20, key: true }), F('name', '業者名', { max: 200 }), F('bank', '振込先銀行(4桁)', { max: 4, optional: true }), F('branch', '支店(3桁)', { max: 3, optional: true }),
      F('accountType', '預金種別', { type: 'select', options: [['1', '普通'], ['2', '当座'], ['4', '貯蓄']], optional: true }), F('account', '口座番号', { max: 16, optional: true }),
      F('holder', '受取人名(カナ)', { max: 200, optional: true }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT v.*, b.bank_code, b.branch_code, b.account_number, b.holder_name, b.account_type_code FROM vendor v LEFT JOIN bank_account b ON b.bank_account_id=v.bank_account_id',
    where: 'v.vendor_code=?', keyOf: r => [r.code],
    decode: r => ({ id: r.vendor_id, code: r.vendor_code, name: r.vendor_name, bank: r.bank_code || '', branch: r.branch_code || '', accountType: r.account_type_code || '1', account: r.account_number || '', holder: r.holder_name || '', active: !!r.active }),
    validate: r => {
      const v = { code: text(r.code, '業者コード', 20, { pattern: CODE }), name: text(r.name, '業者名', 200), bank: String(r.bank || '').trim(), branch: String(r.branch || '').trim(),
        accountType: String(r.accountType || '1'), account: String(r.account || '').trim(), holder: toZenginKana(String(r.holder || '').trim()), active: bool(r.active ?? true) };
      if (v.bank || v.branch || v.account || v.holder) check(/^\d{4}$/.test(v.bank) && /^\d{3}$/.test(v.branch) && /^\d{1,16}$/.test(v.account) && v.holder && v.holder.length <= 200 && ['1', '2', '4'].includes(v.accountType), '振込先は銀行4桁・支店3桁・口座番号・受取人・預金種別をすべて入力してください');
      return v;
    },
    async write(c, r, old) {
      let accountId = null;
      if (r.bank) {
        const found = await one(c, 'SELECT bank_account_id,holder_name FROM bank_account WHERE bank_code=? AND branch_code=? AND account_type_code=? AND account_number=? FOR UPDATE', [r.bank, r.branch, r.accountType, r.account]);
        if (found) { check(found.holder_name === r.holder, '同じ口座の受取人名が一致しません'); accountId = found.bank_account_id; }
        else accountId = (await c.query('INSERT INTO bank_account (bank_code,branch_code,account_type_code,account_number,holder_name) VALUES (?,?,?,?,?)', [r.bank, r.branch, r.accountType, r.account, r.holder]))[0].insertId;
      }
      if (!old) await c.query('INSERT INTO vendor (vendor_code,vendor_name,bank_account_id,active) VALUES (?,?,?,?)', [r.code, r.name, accountId, r.active]);
      else await c.query('UPDATE vendor SET vendor_name=?,bank_account_id=?,active=? WHERE vendor_code=?', [r.name, accountId, r.active, r.code]);
    },
  },
  accounts: {
    label: '勘定科目', table: 'account_subject',
    fields: [F('code', '科目コード', { max: 20, key: true }), F('name', '科目名', { max: 100 }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM account_subject', where: 'account_code=?', keyOf: r => [r.code],
    decode: r => ({ code: r.account_code, name: r.account_name, active: !!r.active, system: SYSTEM_ACCOUNTS.some(a => a[0] === r.account_code) }),
    validate: r => ({ code: text(r.code, '科目コード', 20, { pattern: CODE }), name: text(r.name, '科目名', 100), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      check(r.active || !SYSTEM_ACCOUNTS.some(a => a[0] === r.code), '自動仕訳で使用する科目は無効化できません');
      if (!old) await c.query('INSERT INTO account_subject (account_code,account_name,active) VALUES (?,?,?)', [r.code, r.name, r.active]);
      else await c.query('UPDATE account_subject SET account_name=?,active=? WHERE account_code=?', [r.name, r.active, r.code]);
    },
  },
  subaccounts: {
    label: '内訳科目', table: 'account_subsubject',
    fields: [F('account', '上位勘定科目', { type: 'ref', ref: 'accounts', key: true }), F('code', '内訳コード', { max: 20, key: true }), F('name', '内訳名', { max: 100 }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM account_subsubject', where: 'account_code=? AND sub_code=?', keyOf: r => [r.account, r.code],
    decode: r => ({ account: r.account_code, code: r.sub_code, name: r.sub_name, active: !!r.active }),
    validate: r => ({ account: text(r.account, '上位勘定科目', 20), code: text(r.code, '内訳コード', 20, { pattern: CODE }), name: text(r.name, '内訳名', 100), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) {
        const a = await one(c, 'SELECT active FROM account_subject WHERE account_code=?', [r.account]);
        check(a?.active, '有効な上位勘定科目を選択してください');
        await c.query('INSERT INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES (?,?,?,?)', [r.account, r.code, r.name, r.active]);
      } else await c.query('UPDATE account_subsubject SET sub_name=?,active=? WHERE account_code=? AND sub_code=?', [r.name, r.active, r.account, r.code]);
    },
  },
};

const withVersion = (cfg, row) => { const r = cfg.decode(row); return { ...r, key: cfg.keyOf(r).join('|'), version: hash(r) }; };
export const meta = () => Object.fromEntries(Object.entries(MASTERS).map(([k, m]) => [k, { label: m.label, fields: m.fields.map(f => ({ ...f, pattern: undefined })) }]));
export async function list(c, kind) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です');
  return (await rows(c, cfg.select)).map(r => withVersion(cfg, r)).sort((a, b) => a.key.localeCompare(b.key));
}
export async function allMasters(c) { const out = {}; for (const k of Object.keys(MASTERS)) out[k] = await list(c, k); return out; }

async function current(c, cfg, key) {
  const r = await one(c, `${cfg.select} ${cfg.select.includes(' WHERE ') ? 'AND' : 'WHERE'} ${cfg.where} FOR UPDATE`, key);
  return r ? withVersion(cfg, r) : null;
}
// mode: 'create' requires the key to be absent; 'update' requires a matching version.
export async function save(c, ctx, kind, input, mode) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です');
  const r = cfg.validate(input || {}), key = cfg.keyOf(r);
  const old = await current(c, cfg, key);
  if (mode === 'create') check(!old, `${cfg.label}「${key.filter(Boolean).join('-')}」は登録済みです`);
  else {
    if (!old) throw new Conflict('対象のマスタが見つかりません。再読込してください');
    if (old.version !== input.version) throw new Conflict('他の利用者が更新しました。再読込してからやり直してください');
  }
  await cfg.write(c, r, old);
  const after = await current(c, cfg, key);
  await audit(c, ctx, cfg.table, key.join('|'), mode === 'create' ? 'master.create' : 'master.update', { kind, key: key.join('|'), fields: Object.keys(r).filter(k => !['account', 'holder'].includes(k) || kind !== 'vendors') });
  return after;
}
// CSV import: header row uses field names or labels. Whole file is rolled back on the first error.
export async function importCsv(c, ctx, kind, csvText) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です');
  const table = parseCsv(csvText); check(table.length >= 2 && table.length <= 2001, '取込はヘッダー行＋1〜2000行です');
  const head = table[0].map(h => h.trim()), fields = head.map(h => cfg.fields.find(f => f.name === h || f.label === h)?.name);
  check(cfg.fields.filter(f => !f.optional && f.type !== 'bool').every(f => fields.includes(f.name)), '必須列が不足しています: ' + cfg.fields.filter(f => !f.optional && f.type !== 'bool' && !fields.includes(f.name)).map(f => f.label).join('、'));
  let created = 0, updated = 0;
  for (let i = 1; i < table.length; i++) {
    const rec = {}; fields.forEach((f, j) => { if (f) rec[f] = table[i][j] ?? ''; });
    try {
      const v = cfg.validate(rec), old = await current(c, cfg, cfg.keyOf(v));
      await save(c, ctx, kind, { ...rec, version: old?.version }, old ? 'update' : 'create'); old ? updated++ : created++;
    } catch (e) { const d = mapSqlError(e) || e; d.message = `${i + 1}行目: ${d.message}`; throw d; }
  }
  return { created, updated };
}
export function exportRows(cfg, list) { return [cfg.fields.map(f => f.name), ...list.map(r => cfg.fields.map(f => f.type === 'bool' ? (r[f.name] ? '1' : '0') : r[f.name]))]; }
