import { createHash } from 'node:crypto';
import { check, Conflict, text, bool, yen, closingDay, isoDate, today, parseCsv, fromNum } from './domain.mjs';
import { rows, one, audit, mapSqlError } from './db.mjs';
import { toZenginKana, zenginInvalid } from './zengin.mjs';

// Accounts referenced by automatic journal patterns. They cannot be deactivated.
export const SYSTEM_ACCOUNTS = [
  ['1111', '現金'], ['1112', '当座預金'], ['1113', '普通預金'], ['1120', '受取手形'], ['1131', '売掛金'], ['1360', '材料及び貯蔵品'],
  ['1431', '業者立替金'], ['4121', '買掛金'], ['4170', '預り金'], ['4171', '預り金（安全協力費等）'], ['8790', '雑収入'], ['4415', '仮受消費税'], ['1465', '仮払消費税'], ['8130', '合材売上'], ['8231', '仕入'], ['8330', '雑費'], ['8850', '雑損失'], ['82316', '期末棚卸高'],
];
const CODE = /^[0-9A-Za-z\-ｦ-ﾟ]+$/; // 半角英数・ハイフン・半角カナ（現行の得意先・業者コードに半角カナあり）
const del = active => (active ? '' : '1'); // 現行 Java：有効は空、無効は '1'
const live = r => r.delete_f !== '1';
const hash = o => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const siteKey = (code, suffix) => `${code}|${suffix}`;

const F = (name, label, extra = {}) => ({ name, label, type: 'text', ...extra });
// 得意先の締日（2026-10-23 指定：5・10・15・20・末日）
const CLOSINGS = [5, 10, 15, 20, 31], CLOSING_OPTIONS = CLOSINGS.map(d => [String(d), d === 31 ? '末日' : `${d}日`]);
export const MASTERS = {
  customers: {
    label: '得意先', table: 'client_m',
    fields: [F('code', '得意先コード', { max: 5, key: true }), F('name', '得意先名', { max: 42 }), F('kana', 'カナ', { max: 25, optional: true }), F('abbr', '略称', { list: false, max: 26, optional: true }),
      F('section', '部署', { list: false, max: 26, optional: true }), F('closing', '締日', { type: 'select', options: CLOSING_OPTIONS, hint: '5日・10日・15日・20日・末日' }), F('postcode', '郵便番号', { list: false, max: 7, optional: true, hint: '数字7桁' }), F('pref', '都道府県', { list: false, max: 8, optional: true }),
      F('address', '住所1', { max: 42, optional: true }), F('address2', '住所2', { list: false, max: 42, optional: true }), F('tel', '電話番号', { max: 14, optional: true }), F('fax', 'FAX番号', { list: false, max: 14, optional: true }),
      F('customerPic', '先方担当者', { list: false, max: 26, optional: true }), F('pic', '自社担当者', { list: false, max: 26, optional: true }), F('creditStart', '取引開始日', { list: false, type: 'date', optional: true }),
      F('cardMemberId', 'カード会員ID', { list: false, max: 15, optional: true }), F('cardStatus', 'カード状態', { list: false, max: 2, optional: true }),
      F('siteMonths', '回収サイト（締め後○か月）', { list: false, type: 'int', optional: true, hint: '0〜12。未設定は翌月' }), F('siteDay', '回収日', { list: false, type: 'int', optional: true, hint: '1〜31（31=月末）' }),
      F('payMethod', '入金方法', { list: false, type: 'select', optional: true, options: [['', '（未設定）'], ['1', '振込'], ['2', '手形'], ['3', 'でんさい'], ['4', '現金']] }), F('payBank', '入金先口座', { list: false, type: 'ref', ref: 'banks', optional: true }), F('remarks', '備考', { list: false, max: 100, optional: true }),
      F('opening', '開始売掛残高', { type: 'int', optional: true, hint: '請求作成後は変更不可' }), F('deposit', '預り金残高（開始）', { list: false, type: 'int', optional: true, hint: '入金消込で充当できる額' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT c.*, o.amount opening, d.amount deposit, st.category1 site_m, st.category2 site_d, st.category3 pay_method, st.code_dtl_abr pay_bank FROM client_m c LEFT JOIN opening_balance o ON o.source_reference=CONCAT('OPEN-AR-',c.customers_cd) LEFT JOIN opening_balance d ON d.source_reference=CONCAT('OPEN-ADV-',c.customers_cd) LEFT JOIN code_m st ON st.code_key='CSITE' AND st.code_dtl=c.customers_cd",
    where: 'c.customers_cd=?', keyOf: r => [r.code],
    decode: r => ({ code: r.customers_cd, name: r.customers_name, kana: r.customers_kana, abbr: r.customers_abr, section: r.customers_sec, closing: Number(r.deadline) || 31, postcode: r.postcode, pref: r.pref, address: r.addr1, address2: r.addr2,
      tel: r.tel_no, fax: r.fax_no, customerPic: r.customers_pic, pic: r.pic, creditStart: r.credit_str || '', cardMemberId: r.card_member_id, cardStatus: r.card_status || '', siteMonths: r.site_m ?? '', siteDay: r.site_d ?? '', payMethod: r.pay_method || '', payBank: r.pay_bank || '', remarks: r.remarks, opening: Number(r.opening || 0), deposit: Number(r.deposit || 0), active: live(r) }),
    // 締日は 5・10・15・20・末日（31）から選ぶ。移行データの規定外の締日（25 等）は変えない限りそのまま保存できる
    check: (r, old) => check(CLOSINGS.includes(r.closing) || (old && Number(old.closing) === r.closing), '締日は 5日・10日・15日・20日・末日 から選択してください'),
    validate: r => ({ code: text(r.code, '得意先コード', 5, { pattern: CODE }), name: text(r.name, '得意先名', 42), kana: text(r.kana, 'カナ', 25, { required: false }), abbr: text(r.abbr, '略称', 26, { required: false }),
      section: text(r.section, '部署', 26, { required: false }), closing: closingDay(r.closing ?? 31), postcode: text(String(r.postcode || '').replace('-', ''), '郵便番号', 7, { required: false, pattern: /^\d{7}$/ }),
      pref: text(r.pref, '都道府県', 8, { required: false }), address: text(r.address, '住所1', 42, { required: false }), address2: text(r.address2, '住所2', 42, { required: false }),
      tel: text(r.tel, '電話番号', 14, { required: false, pattern: /^[0-9\-]+$/ }), fax: text(r.fax, 'FAX番号', 14, { required: false, pattern: /^[0-9\-]+$/ }),
      customerPic: text(r.customerPic, '先方担当者', 26, { required: false }), pic: text(r.pic, '自社担当者', 26, { required: false }), creditStart: r.creditStart ? isoDate(r.creditStart, '取引開始日') : '',
      cardMemberId: text(r.cardMemberId, 'カード会員ID', 15, { required: false }), cardStatus: text(r.cardStatus, 'カード状態', 2, { required: false }),
      siteMonths: r.siteMonths === '' || r.siteMonths == null ? '' : (() => { const v = yen(r.siteMonths, '回収サイト'); check(v <= 12, '回収サイトは0〜12か月です'); return v; })(),
      siteDay: r.siteDay === '' || r.siteDay == null ? '' : (() => { const v = yen(r.siteDay, '回収日'); check(v >= 1 && v <= 31, '回収日は1〜31です'); return v; })(),
      payMethod: ['1', '2', '3', '4'].includes(String(r.payMethod || '')) ? String(r.payMethod) : '', payBank: text(r.payBank, '入金先口座', 12, { required: false }), remarks: text(r.remarks, '備考', 100, { required: false }),
      opening: yen(r.opening || 0, '開始売掛残高', { negative: true }), deposit: yen(r.deposit || 0, '預り金残高'), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      const v = [r.name, r.kana, r.abbr, r.section, r.postcode, r.tel, r.fax, r.pref, r.address, r.address2, r.customerPic, r.pic, String(r.closing), r.creditStart || null, r.remarks, del(r.active), r.cardMemberId, r.cardStatus || null];
      if (!old) await c.query('INSERT INTO client_m (customers_name,customers_kana,customers_abr,customers_sec,postcode,tel_no,fax_no,pref,addr1,addr2,customers_pic,pic,deadline,credit_str,remarks,delete_f,card_member_id,card_status,customers_cd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...v, r.code]);
      else await c.query('UPDATE client_m SET customers_name=?,customers_kana=?,customers_abr=?,customers_sec=?,postcode=?,tel_no=?,fax_no=?,pref=?,addr1=?,addr2=?,customers_pic=?,pic=?,deadline=?,credit_str=?,remarks=?,delete_f=?,card_member_id=?,card_status=? WHERE customers_cd=?', [...v, r.code]);
      await c.query("DELETE FROM code_m WHERE code_key='CSITE' AND code_dtl=?", [r.code]);
      if (r.siteMonths !== '' || r.siteDay !== '' || r.payMethod || r.payBank) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('CSITE','回収条件',?,'',?,?,?,?)",
        [r.code, r.payBank || '', String(r.siteMonths === '' ? 1 : r.siteMonths), String(r.siteDay === '' ? 31 : r.siteDay), r.payMethod || '']);
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
    fields: [F('code', '商品コード', { max: 5, key: true }), F('name', '商品名', { max: 22 }), F('unit', '単位', { type: 'ref', ref: 'units' }), F('price', '標準単価', { type: 'int' }), F('kind', '製品・材料区分', { type: 'select', options: [['', '共通'], ['2', '製品（自社製品）'], ['1', '材料・仕入品']], optional: true, hint: '2=製品・1=材料' }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM item_m', where: 'item_cd=?', keyOf: r => [r.code],
    decode: r => ({ code: r.item_cd, name: r.item_nam, unit: r.unit, price: Number(r.tanka), kind: r.item_product_kb || '', active: live(r) }),
    validate: r => ({ code: text(r.code, '商品コード', 5, { pattern: CODE }), name: text(r.name, '商品名', 22), unit: text(r.unit || '01', '単位', 2, { pattern: /^\d{2}$/ }), price: yen(r.price ?? 0, '標準単価', { max: 9999999 }), kind: ['1', '2'].includes(String(r.kind || '')) ? String(r.kind) : '', active: bool(r.active ?? true) }),
    async write(c, r, old) {
      check(await one(c, "SELECT 1 x FROM code_m WHERE code_key='A0003' AND code_dtl=?", [r.unit]), '単位は単位マスタから選択してください');
      if (!old) await c.query("INSERT INTO item_m (item_cd,item_nam,item_abr,item_kana,item_bunrui_cd,tanka,freight,unit,base_temp,vary_temp,credit_discount_rate,delete_f,item_product_kb) VALUES (?,?,'','','',?,0,?,0,0,0,?,?)", [r.code, r.name, r.price, r.unit, del(r.active), r.kind]);
      else await c.query('UPDATE item_m SET item_nam=?,tanka=?,unit=?,item_product_kb=?,delete_f=? WHERE item_cd=?', [r.name, r.price, r.unit, r.kind, del(r.active), r.code]);
    },
  },
  // 売上単価（現行 Java MA034/MA1000 と同じ）：通常単価・運賃と、適用期間内だけ使う適用単価・適用運賃。期間は両方入力か両方空。
  prices: {
    label: '得意先別単価', table: 'uriage_tanka_m',
    fields: [F('item', '商品', { type: 'ref', ref: 'items', key: true }), F('customer', '得意先', { type: 'ref', ref: 'customers', key: true }),
      F('site', '現場', { type: 'site', key: true, optional: true, hint: '未指定は得意先共通' }), F('price', '単価', { type: 'int' }), F('freight', '運賃', { type: 'int', optional: true }),
      F('applyPrice', '適用単価', { type: 'int', optional: true, list: false, hint: '適用期間内の出荷に使う単価' }), F('applyFreight', '適用運賃', { type: 'int', optional: true, list: false }),
      F('start', '適用開始日', { type: 'date', optional: true }), F('end', '適用終了日', { type: 'date', optional: true }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM uriage_tanka_m', where: 'item_cd=? AND customers_cd=? AND field_cd=? AND field_suffix=?',
    keyOf: r => { const [code = '', suffix = ''] = (r.site || '').split('|'); return [r.item, r.customer, code, suffix]; },
    decode: r => ({ item: r.item_cd, customer: r.customers_cd, site: r.field_cd ? siteKey(r.field_cd, r.field_suffix) : '', price: Number(r.tanka), freight: Number(r.freight || 0), applyPrice: Number(r.apply_tanka || 0), applyFreight: Number(r.apply_freight || 0),
      start: r.apply_start || '', end: r.apply_end || '', active: live(r) }),
    validate: r => {
      const v = { item: text(r.item, '商品', 5), customer: text(r.customer, '得意先', 5), site: text(r.site, '現場', 11, { required: false }), price: yen(r.price, '単価', { max: 9999999 }), freight: yen(r.freight || 0, '運賃', { max: 9999999 }),
        applyPrice: yen(r.applyPrice || 0, '適用単価', { max: 9999999 }), applyFreight: yen(r.applyFreight || 0, '適用運賃', { max: 9999999 }),
        start: r.start ? isoDate(r.start, '適用開始日') : '', end: r.end ? isoDate(r.end, '適用終了日') : '', active: bool(r.active ?? true) };
      check(!v.start === !v.end, '適用開始日と適用終了日は両方入力するか両方空にしてください'); check(!v.start || v.start <= v.end, '適用期間が不正です');
      if (v.start) check(v.applyPrice > 0, '適用期間を入れた場合は適用単価を入力してください');
      return v;
    },
    async write(c, r, old) {
      const [fc = '', fs = ''] = r.site ? r.site.split('|') : [];
      if (r.site) check(await one(c, 'SELECT 1 FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?', [r.customer, fc, fs]), '現場が得意先に登録されていません');
      if (!old) await c.query('INSERT INTO uriage_tanka_m (item_cd,customers_cd,field_cd,field_suffix,tanka,freight,apply_tanka,apply_freight,apply_start,apply_end,delete_f,update_daytime) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',
        [r.item, r.customer, fc, fs, r.price, r.freight, r.applyPrice, r.applyFreight, r.start || null, r.end || null, del(r.active)]);
      else await c.query('UPDATE uriage_tanka_m SET tanka=?,freight=?,apply_tanka=?,apply_freight=?,apply_start=?,apply_end=?,delete_f=?,update_daytime=UTC_TIMESTAMP(6) WHERE item_cd=? AND customers_cd=? AND field_cd=? AND field_suffix=?',
        [r.price, r.freight, r.applyPrice, r.applyFreight, r.start || null, r.end || null, del(r.active), r.item, r.customer, fc, fs]);
    },
  },
  banks: {
    label: '銀行（当座預金内訳）', table: 'code_m',
    fields: [F('code', '共通コード（内訳）', { max: 12, key: true }), F('name', '銀行名', { max: 40 }), F('branchLabel', '銀行CD-支店CD 名称', { readonly: true, optional: true }),
      F('zgBank', '振込元 銀行番号(4桁)', { max: 4, optional: true, hint: '全銀データ作成用' }), F('zgBranch', '振込元 支店番号(3桁)', { list: false, max: 3, optional: true }),
      F('zgType', '振込元 預金種目', { list: false, type: 'select', options: [['1', '普通'], ['2', '当座'], ['4', '貯蓄']], optional: true }), F('zgAccount', '振込元 口座番号(7桁以内)', { list: false, max: 7, optional: true }),
      F('zgCode', '振込依頼人コード(10桁)', { max: 10, optional: true, hint: '銀行から付与されるコード' }), F('zgName', '振込依頼人名（カナ）', { list: false, max: 40, optional: true, hint: '半角カナに自動変換' }),
      F('active', '有効', { type: 'bool' })],
    select: "SELECT b.*, z.code_dtl_nam zg_name, z.code_dtl_abr zg_code, z.category1 zg_bank, z.category2 zg_branch_type, z.category3 zg_account, kb.code_dtl_nam zg_bank_name, kbb.code_dtl_nam zg_branch_name FROM code_m b LEFT JOIN code_m z ON z.code_key='ZGN' AND z.code_dtl=b.code_dtl LEFT JOIN code_m kb ON kb.code_key='BKDIR' AND kb.code_dtl=z.category1 LEFT JOIN code_m kbb ON kbb.code_key='BKDIR' AND kbb.code_dtl=CONCAT(z.category1,'-',LEFT(z.category2,3)) WHERE b.code_key='BANK'",
    where: 'b.code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, branchLabel: r.zg_bank ? `${r.zg_bank}-${(r.zg_branch_type || '').slice(0, 3)} ${r.zg_bank_name || ''} ${r.zg_branch_name || ''}`.trim() : '', zgBank: r.zg_bank || '', zgBranch: (r.zg_branch_type || '').slice(0, 3), zgType: (r.zg_branch_type || '').slice(3, 4) || '1', zgAccount: r.zg_account || '', zgCode: r.zg_code || '', zgName: r.zg_name || '', active: r.category1 !== '0' }),
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
      for (const acc of ['1112', '1113']) await c.query("INSERT INTO account_subsubject (account_code,sub_code,sub_name,active) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE sub_name=VALUES(sub_name),active=VALUES(active)", [acc, r.code, r.name.slice(0, 100), r.active]);
    },
  },
  vendors: {
    label: '業者', table: 'vendor',
    fields: [F('code', '業者コード', { max: 20, key: true }), F('name', '業者名', { max: 200 }), F('bank', '振込先銀行(4桁)', { max: 4, optional: true }), F('branch', '支店(3桁)', { max: 3, optional: true }),
      F('accountType', '預金種別', { type: 'select', options: [['1', '普通'], ['2', '当座'], ['4', '貯蓄']], optional: true }), F('account', '口座番号', { max: 16, optional: true }),
      F('advance', '業者立替金残高（開始）', { list: false, type: 'int', optional: true, hint: '支払時に相殺できる額' }), F('holder', '受取人名(カナ)', { list: false, max: 200, optional: true }),
      // 10/19 打合せ：支払繰延区分（「1 15」＝翌月15日、「3 31」＝3か月後の月末）・振込日・振込元銀行は業者マスタに持つ（code_m VPAY）
      F('payMonths', '支払繰延（○か月後）', { list: false, type: 'int', optional: true, hint: '0〜12。未設定は翌月末払い' }), F('payDay', '支払日', { list: false, type: 'int', optional: true, hint: '1〜31（31=月末）' }),
      F('payCycle', '振込サイクル', { list: false, type: 'select', optional: true, options: [['', '（未設定）'], ['15', '15日'], ['31', '月末']] }), F('payBank', '振込元口座', { list: false, type: 'ref', ref: 'banks', optional: true }),
      F('active', '有効', { type: 'bool' })],
    select: "SELECT v.*, b.bank_code, b.branch_code, b.account_number, b.holder_name, b.account_type_code, ob.amount advance, vp.category1 pay_m, vp.category2 pay_d, vp.category3 pay_cycle, vp.code_dtl_abr pay_bank FROM vendor v LEFT JOIN bank_account b ON b.bank_account_id=v.bank_account_id LEFT JOIN opening_balance ob ON ob.source_reference=CONCAT('OPEN-VADV-',v.vendor_code) LEFT JOIN code_m vp ON vp.code_key='VPAY' AND vp.code_dtl=v.vendor_code",
    where: 'v.vendor_code=?', keyOf: r => [r.code],
    decode: r => ({ id: r.vendor_id, code: r.vendor_code, name: r.vendor_name, bank: r.bank_code || '', branch: r.branch_code || '', accountType: r.account_type_code || '1', account: r.account_number || '', holder: r.holder_name || '', advance: Number(r.advance || 0),
      payMonths: r.pay_m ?? '', payDay: r.pay_d ?? '', payCycle: r.pay_cycle || '', payBank: r.pay_bank || '', active: !!r.active }),
    validate: r => {
      const v = { code: text(r.code, '業者コード', 20, { pattern: CODE }), name: text(r.name, '業者名', 200), bank: String(r.bank || '').trim(), branch: String(r.branch || '').trim(),
        accountType: String(r.accountType || '1'), account: String(r.account || '').trim(), holder: toZenginKana(String(r.holder || '').trim()), advance: yen(r.advance || 0, '業者立替金残高'), active: bool(r.active ?? true),
        payMonths: String(r.payMonths ?? '').trim(), payDay: String(r.payDay ?? '').trim(), payCycle: String(r.payCycle || ''), payBank: String(r.payBank || '').trim() };
      if (v.payMonths !== '') check(/^\d{1,2}$/.test(v.payMonths) && Number(v.payMonths) <= 12, '支払繰延は0〜12か月です');
      if (v.payDay !== '') check(/^\d{1,2}$/.test(v.payDay) && Number(v.payDay) >= 1 && Number(v.payDay) <= 31, '支払日は1〜31です');
      check(['', '15', '31'].includes(v.payCycle), '振込サイクルが不正です');
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
      await c.query("DELETE FROM code_m WHERE code_key='VPAY' AND code_dtl=?", [r.code]);
      if (r.payMonths !== '' || r.payDay !== '' || r.payCycle || r.payBank) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('VPAY','支払条件',?,'',?,?,?,?)",
        [r.code, r.payBank, r.payMonths, r.payDay, r.payCycle]);
      if ((old?.advance || 0) !== r.advance) {
        const v = await one(c, 'SELECT vendor_id FROM vendor WHERE vendor_code=?', [r.code]);
        const used = await one(c, "SELECT COALESCE(SUM(offset_amount),0) n FROM payment WHERE vendor_id=? AND status='POSTED'", [v.vendor_id]);
        check(r.advance >= Number(used.n), '相殺済みの額より小さい立替金残高にはできません');
        await c.query("DELETE FROM opening_balance WHERE source_reference=CONCAT('OPEN-VADV-',?)", [r.code]);
        if (r.advance) await c.query("INSERT INTO opening_balance (cutover_on,balance_kind,vendor_id,amount,source_reference) VALUES (?,'ADVANCE',?,?,CONCAT('OPEN-VADV-',?))", [today(), v.vendor_id, r.advance, r.code]);
      }
    },
  },
  company: {
    label: '自社情報・請求書設定', table: 'company_info_m',
    fields: [F('id', 'ID', { max: 1, key: true, hint: '1固定' }), F('name1', '会社名1', { max: 21 }), F('name2', '会社名2', { max: 30, optional: true }), F('postcode', '郵便番号', { max: 7, optional: true }),
      F('pref', '都道府県', { max: 8, optional: true }), F('addr1', '住所1', { max: 42, optional: true }), F('addr2', '住所2', { max: 42, optional: true }), F('tel', '電話番号', { max: 14, optional: true }), F('fax', 'FAX', { list: false, max: 14, optional: true }),
      F('plant', '工場名', { list: false, max: 26, optional: true }), F('closingMonth', '決算月', { type: 'int', max: 2, list: false, hint: '1〜12' }), F('closingDay', '月度締日', { type: 'int', max: 2, list: false, hint: '20＝21日〜20日、31＝暦月' }), F('tradingDay', '業務日付', { type: 'date', optional: true, list: false, hint: '出荷日の初期値。空欄は当日' }), F('invoiceNo', '適格請求書発行事業者登録番号', { max: 14, optional: true, hint: 'T＋13桁（例 T4180001002429）' }), F('invoiceBank2', '請求書の取引銀行2', { type: 'ref', ref: 'banks', optional: true, list: false }),
      F('invoiceLayout', '請求書様式', { type: 'select', optional: true, list: false, options: [['proposal', '前回残高・今回入金額・今回残高 形式'], ['legacy', '当月御買上額・当月御請求額 形式']] }),
      F('invoiceBank', '請求書の振込先口座', { type: 'ref', ref: 'banks', optional: true })],
    select: "SELECT c.*, n.code_dtl_abr inv_no, b.code_dtl_abr inv_bank, b2.code_dtl_abr inv_bank2, lay.code_dtl_abr inv_layout FROM company_info_m c LEFT JOIN code_m n ON n.code_key='SET' AND n.code_dtl='INVNO' LEFT JOIN code_m b ON b.code_key='SET' AND b.code_dtl='INVBANK' LEFT JOIN code_m b2 ON b2.code_key='SET' AND b2.code_dtl='INVBANK2' LEFT JOIN code_m lay ON lay.code_key='SET' AND lay.code_dtl='INVLAYOUT'",
    where: 'c.company_info_id=?', keyOf: r => [String(r.id || '1')],
    decode: r => ({ id: String(r.company_info_id), name1: r.company_name1, name2: r.company_name2, postcode: r.postcode, pref: r.pref, addr1: r.addr1, addr2: r.addr2, tel: r.tel_no, fax: r.fax_no, plant: r.plant_name, closingMonth: String(Number(r.closing_m) || 3), closingDay: String(Number(r.closing_d) || 31), tradingDay: r.trading_day ? String(r.trading_day).slice(0, 10) : '', invoiceNo: r.inv_no || '', invoiceBank: r.inv_bank || '', invoiceBank2: r.inv_bank2 || '', invoiceLayout: r.inv_layout || 'proposal' }),
    validate: r => ({ id: '1', name1: text(r.name1, '会社名1', 21), name2: text(r.name2, '会社名2', 30, { required: false }), postcode: text(String(r.postcode || '').replace('-', ''), '郵便番号', 7, { required: false, pattern: /^\d{7}$/ }),
      pref: text(r.pref, '都道府県', 8, { required: false }), addr1: text(r.addr1, '住所1', 42, { required: false }), addr2: text(r.addr2, '住所2', 42, { required: false }), tel: text(r.tel, '電話番号', 14, { required: false }), fax: text(r.fax, 'FAX', 14, { required: false }),
      plant: text(r.plant, '工場名', 26, { required: false }), closingMonth: ((n) => (check(Number.isInteger(n) && n >= 1 && n <= 12, '決算月は1〜12です'), n))(Number(r.closingMonth || 3)), closingDay: closingDay(r.closingDay || 31), tradingDay: r.tradingDay ? isoDate(r.tradingDay, '業務日付') : '', invoiceNo: text(String(r.invoiceNo || '').replace(/[\s-]/g, '').toUpperCase(), '登録番号', 14, { required: false, pattern: /^T\d{13}$/ }), invoiceBank: text(r.invoiceBank, '振込先口座', 12, { required: false }), invoiceBank2: text(r.invoiceBank2, '取引銀行2', 12, { required: false }), invoiceLayout: r.invoiceLayout === 'legacy' ? 'legacy' : 'proposal' }),
    async write(c, r, old) {
      check(old, '自社情報は1件のみです（新規登録はできません）');
      await c.query('UPDATE company_info_m SET company_name1=?,company_name2=?,postcode=?,pref=?,addr1=?,addr2=?,tel_no=?,fax_no=?,plant_name=?,trading_day=?,closing_m=?,closing_d=? WHERE company_info_id=1', [r.name1, r.name2, r.postcode, r.pref, r.addr1, r.addr2, r.tel, r.fax, r.plant, r.tradingDay || null, r.closingMonth, r.closingDay]);
      for (const [k, v, n] of [['INVNO', r.invoiceNo, '登録番号'], ['INVBANK', r.invoiceBank, '請求書振込先'], ['INVBANK2', r.invoiceBank2, '請求書取引銀行2'], ['INVLAYOUT', r.invoiceLayout, '請求書様式']]) {
        await c.query("DELETE FROM code_m WHERE code_key='SET' AND code_dtl=?", [k]);
        if (v) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('SET','設定',?,?,?,'','','')", [k, n, v]);
      }
    },
  },
  bankdir: {
    label: '金融機関（銀行・支店）', table: 'code_m',
    fields: [F('bank', '銀行番号(4桁)', { max: 4, key: true }), F('branch', '支店番号(3桁)', { max: 3, key: true, optional: true, hint: '空欄＝銀行そのもの' }), F('name', '名称', { max: 40 }), F('kana', 'カナ（全銀用）', { max: 15, optional: true, hint: '半角カナに自動変換' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='BKDIR'", where: 'code_dtl=?', keyOf: r => [r.branch ? r.bank + '-' + r.branch : r.bank],
    decode: r => ({ bank: r.category1, branch: r.category2 || '', name: r.code_dtl_nam, kana: r.code_dtl_abr, active: r.category3 !== '0' }),
    validate: r => {
      const v = { bank: text(r.bank, '銀行番号', 4, { pattern: /^\d{4}$/ }), branch: text(r.branch, '支店番号', 3, { required: false, pattern: /^\d{3}$/ }), name: text(r.name, '名称', 40), kana: toZenginKana(String(r.kana || '').trim()), active: bool(r.active ?? true) };
      check(v.kana.length <= 15 && !zenginInvalid(v.kana).length, 'カナは全銀で使える文字15文字以内にしてください'); return v;
    },
    async write(c, r, old) {
      const key = r.branch ? r.bank + '-' + r.branch : r.bank;
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('BKDIR','金融機関',?,?,?,?,?,?)", [key, r.name, r.kana, r.bank, r.branch, r.active ? '1' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category3=? WHERE code_key='BKDIR' AND code_dtl=?", [r.name, r.kana, r.active ? '1' : '0', key]);
    },
  },
  depts: {
    label: '部門', table: 'code_m',
    fields: [F('code', '部門コード', { max: 12, key: true }), F('name', '部門名', { max: 40 }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='DEPT'", where: 'code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, active: r.category1 !== '0' }),
    validate: r => ({ code: text(r.code, '部門コード', 12, { pattern: CODE }), name: text(r.name, '部門名', 40), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('DEPT','部門',?,?,'',?,'','')", [r.code, r.name, r.active ? '1' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,category1=? WHERE code_key='DEPT' AND code_dtl=?", [r.name, r.active ? '1' : '0', r.code]);
    },
  },
  jv: {
    label: 'JV構成員・出資比率', table: 'code_m',
    // 現行 HMW110「構成員 登録」（出資比率の変更.xlsx 2026-10-14）：構成員コード＝業者コード、最大7社、比率は小数2桁
    fields: [F('code', '構成員（業者）', { type: 'ref', ref: 'vendors', key: true, hint: '業者マスタのコード' }), F('name', '構成員名', { max: 40, optional: true, hint: '空欄は業者名' }), F('ratio', '出資比率(%)', { hint: '例: 47.5（有効な構成員の合計を100%に）' }), F('seq', '表示順', { type: 'int', optional: true }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='JV'", where: 'code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, ratio: Number(r.category1 || 0) / 100, seq: Number(r.category2 || 0), active: r.code_dtl_abr !== '0' }),
    validate: r => ({ code: text(r.code, '構成員コード', 12, { pattern: CODE }), name: text(r.name, '構成員名', 40, { required: false }), ratio: (() => { const t = String(r.ratio ?? '').trim(); check(/^\d{1,3}(\.\d{1,2})?$/.test(t) && Number(t) > 0 && Number(t) <= 100, '出資比率は0より大きく100以下（小数2桁まで）で入力してください'); return Number(t); })(), seq: yen(r.seq || 0, '表示順', { max: 9999 }), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) { const v = await one(c, 'SELECT vendor_name FROM vendor WHERE vendor_code=?', [r.code]); check(v, '構成員は業者マスタに登録された業者を選択してください'); r.name ||= v.vendor_name.slice(0, 40); }
      if (r.active) check(Number((await one(c, "SELECT COUNT(*) n FROM code_m WHERE code_key='JV' AND code_dtl_abr<>'0' AND code_dtl<>?", [r.code])).n) < 7, '有効な構成員は最大7社です（現行 HMW110）');
      check(r.name, '構成員名を入力してください');
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('JV','JV構成員',?,?,?,?,?,'')", [r.code, r.name, r.active ? '1' : '0', String(Math.round(r.ratio * 100)), String(r.seq)]);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category1=?,category2=? WHERE code_key='JV' AND code_dtl=?", [r.name, r.active ? '1' : '0', String(Math.round(r.ratio * 100)), String(r.seq), r.code]);
    },
  },
  mixes: {
    label: '配合（製品の材料構成）', table: 'code_m',
    fields: [F('product', '製品', { type: 'ref', ref: 'items', key: true }), F('material', '材料', { type: 'ref', ref: 'items', key: true }), F('ratio', '配合率(%)', { hint: '製品1単位あたりの材料構成比' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='MIX'", where: 'code_dtl=?', keyOf: r => [`${r.product}:${r.material}`],
    decode: r => ({ product: r.category1, material: r.category2, ratio: Number(r.category3 || 0) / 100, active: r.code_dtl_abr !== '0' }),
    validate: r => { const v = { product: text(r.product, '製品', 5), material: text(r.material, '材料', 5), ratio: (() => { const t = String(r.ratio ?? '').trim(); check(/^\d{1,3}(\.\d{1,2})?$/.test(t) && Number(t) > 0 && Number(t) <= 100, '配合率は0より大きく100以下（小数2桁まで）で入力してください'); return Number(t); })(), active: bool(r.active ?? true) }; check(v.product !== v.material, '製品と材料は別の商品を選択してください'); return v; },
    async write(c, r, old) {
      const key = `${r.product}:${r.material}`;
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('MIX','配合',?,'',?,?,?,?)", [key, r.active ? '1' : '0', r.product, r.material, String(Math.round(r.ratio * 100))]);
      else await c.query("UPDATE code_m SET code_dtl_abr=?,category3=? WHERE code_key='MIX' AND code_dtl=?", [r.active ? '1' : '0', String(Math.round(r.ratio * 100)), key]);
    },
  },
  // 材料単価（手入力）：NO25 配合計算で使う材料の月別単価。登録があれば移動平均（前月末在庫＋当月仕入）より優先（2026-10-22）
  // code_m 'MATPR'：code_dtl＝YYYYMM:材料コード（12桁以内）、code_dtl_nam＝単価、code_dtl_abr＝有効('1')/無効('0')
  matPrices: {
    label: '材料単価（配合計算用・手入力）', table: 'code_m',
    fields: [F('month', '年月', { type: 'month', key: true, hint: '配合計算の処理年月' }), F('material', '材料', { type: 'ref', ref: 'items', key: true }),
      F('price', '単価', { type: 'dec', hint: '材料1単位あたり（小数2桁まで）' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='MATPR'", where: 'code_dtl=?', keyOf: r => [`${String(r.month).replace('-', '')}:${r.material}`],
    sort: (a, b) => b.month.localeCompare(a.month) || a.material.localeCompare(b.material),
    decode: r => ({ month: `${r.category1.slice(0, 4)}-${r.category1.slice(4, 6)}`, material: r.category2, price: Number(r.code_dtl_nam || 0), active: r.code_dtl_abr !== '0' }),
    validate: r => {
      const month = String(r.month ?? '').trim(), price = String(r.price ?? '').trim().replace(/,/g, '');
      check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), '年月は YYYY-MM で入力してください');
      check(/^\d{1,9}(\.\d{1,2})?$/.test(price) && Number(price) > 0, '単価は0より大きい数値（小数2桁まで）で入力してください');
      return { month, material: text(r.material, '材料', 5), price: Number(price), active: bool(r.active ?? true) };
    },
    async write(c, r, old) {
      check(await one(c, 'SELECT 1 x FROM item_m WHERE item_cd=?', [r.material]), '材料は商品マスタから選択してください');
      const key = `${r.month.replace('-', '')}:${r.material}`;
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('MATPR','材料単価',?,?,?,?,?,'')", [key, String(r.price), r.active ? '1' : '0', r.month.replace('-', ''), r.material]);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=? WHERE code_key='MATPR' AND code_dtl=?", [String(r.price), r.active ? '1' : '0', key]);
    },
  },
  // 原価（現行 genka_m）：NO25 配合計算で保存した年月・製品ごとの原価。照会のみ（2026-10-22）
  genka: {
    label: '原価（配合計算の結果・照会のみ）', table: 'genka_m', readOnly: true,
    fields: [F('month', '年月', { key: true }), F('item', '製品', { type: 'ref', ref: 'items', key: true }), F('haigo', '配合単価', { type: 'dec' }), F('denki', '電気', { type: 'dec' }), F('touyu', '灯油', { type: 'dec' }),
      F('seizou', '製造', { type: 'dec' }), F('ippann', '一般管理', { type: 'dec' }), F('total', '原価計', { type: 'int' }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM genka_m', where: 'nengetsu=? AND item_cd=?', keyOf: r => [r.month, r.item],
    sort: (a, b) => b.month.localeCompare(a.month) || a.item.localeCompare(b.item),
    decode: r => ({ month: `${String(r.nengetsu).slice(0, 4)}-${String(r.nengetsu).slice(4, 6)}`, item: r.item_cd, haigo: Number(r.haigo_tanka || 0), denki: Number(r.denki || 0), touyu: Number(r.touyu || 0),
      seizou: Number(r.seizou || 0), ippann: Number(r.ippann || 0), total: Number(r.total || 0), active: live(r) }),
  },
  // 現行 Java のコードマスタ（code_m）：A0000 納入区分（category1 '2'＝引取＝運賃なし）、A0003 単位、A0007 消費税率（code_dtl＝適用開始日 YYYYMMDD）
  deliveryKinds: {
    label: '納入区分', table: 'code_m',
    fields: [F('code', '納入区分コード', { max: 2, key: true, hint: '数字2桁以内' }), F('name', '名称', { max: 40 }),
      F('pickup', '引取（運賃なし）', { type: 'bool', hint: '運賃は0のみ' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='A0000'", where: 'code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, pickup: r.category1 === '2', active: r.category3 !== '0' }),
    validate: r => ({ code: text(r.code, '納入区分コード', 2, { pattern: /^\d{1,2}$/ }), name: text(r.name, '名称', 40), pickup: bool(r.pickup ?? false), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('A0000','納入区分',?,?,?,?,' ',?)", [r.code, r.name, r.name.slice(0, 26), r.pickup ? '2' : '1', r.active ? ' ' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category1=?,category3=? WHERE code_key='A0000' AND code_dtl=?", [r.name, r.name.slice(0, 26), r.pickup ? '2' : '1', r.active ? ' ' : '0', r.code]);
    },
  },
  weathers: {
    label: '天候', table: 'code_m',
    // 現行 code_m A0010（出荷伝票の天候・納品書に印字）。初期値は推定
    fields: [F('code', '天候コード', { max: 2, key: true, hint: '数字2桁以内' }), F('name', '名称', { max: 20 }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='A0010'", where: 'code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, active: r.category3 !== '0' }),
    validate: r => ({ code: text(r.code, '天候コード', 2, { pattern: /^\d{1,2}$/ }), name: text(r.name, '名称', 20), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('A0010','天候',?,?,?,' ',' ',?)", [r.code, r.name, r.name, r.active ? ' ' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category3=? WHERE code_key='A0010' AND code_dtl=?", [r.name, r.name, r.active ? ' ' : '0', r.code]);
    },
  },
  units: {
    label: '単位', table: 'code_m',
    fields: [F('code', '単位コード', { max: 2, key: true, hint: '数字2桁' }), F('name', '単位名', { max: 40 }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='A0003'", where: 'code_dtl=?', keyOf: r => [r.code],
    decode: r => ({ code: r.code_dtl, name: r.code_dtl_nam, active: r.category3 !== '0' }),
    validate: r => ({ code: text(r.code, '単位コード', 2, { pattern: /^\d{2}$/ }), name: text(r.name, '単位名', 40), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('A0003','単位',?,?,?,' ',' ',?)", [r.code, r.name, r.name.slice(0, 26), r.active ? '' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category3=? WHERE code_key='A0003' AND code_dtl=?", [r.name, r.name.slice(0, 26), r.active ? '' : '0', r.code]);
    },
  },
  taxRates: {
    label: '消費税率', table: 'code_m',
    fields: [F('code', '適用開始日', { type: 'date', key: true, hint: 'この日以降の出荷に適用' }), F('rate', '税率(%)', { type: 'int' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='A0007'", where: 'code_dtl=?', keyOf: r => [String(r.code || '').replaceAll('-', '')],
    decode: r => ({ code: fromNum(r.code_dtl), rate: Number(r.category1), active: r.category3 !== '0' }),
    validate: r => { const v = { code: isoDate(r.code, '適用開始日'), rate: yen(r.rate, '税率', { max: 100 }), active: bool(r.active ?? true) }; return v; },
    async write(c, r, old) {
      const k = r.code.replaceAll('-', '');
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('A0007','消費税率',?,?,?,?,' ',?)", [k, r.rate + '%', r.rate + '%', String(r.rate), r.active ? ' ' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category1=?,category3=? WHERE code_key='A0007' AND code_dtl=?", [r.rate + '%', r.rate + '%', String(r.rate), r.active ? ' ' : '0', k]);
    },
  },
  // カレンダー（休日）：土日は自動で休日、祝日・銀行休業日・会社休日をここに登録する。支払予定日・全銀データの振込指定日が休日なら前営業日（2026-10-31 定時請求・支払データ作成の打合せ）
  holidays: {
    label: 'カレンダー（休日）', table: 'code_m',
    fields: [F('code', '日付', { type: 'date', key: true, hint: '土日は登録しなくても休日' }), F('name', '名称', { max: 40, hint: '祝日名・銀行休業日・会社休日など' }), F('active', '有効', { type: 'bool' })],
    select: "SELECT * FROM code_m WHERE code_key='HOL'", where: 'code_dtl=?', keyOf: r => [String(r.code || '').replaceAll('-', '')],
    decode: r => ({ code: fromNum(r.code_dtl), name: r.code_dtl_nam, active: r.category3 !== '0' }),
    validate: r => ({ code: isoDate(r.code, '日付'), name: text(r.name, '名称', 40), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      const k = r.code.replaceAll('-', '');
      if (!old) await c.query("INSERT INTO code_m (code_key,code_key_nam,code_dtl,code_dtl_nam,code_dtl_abr,category1,category2,category3) VALUES ('HOL','カレンダー（休日）',?,?,?,' ',' ',?)", [k, r.name, r.name.slice(0, 26), r.active ? ' ' : '0']);
      else await c.query("UPDATE code_m SET code_dtl_nam=?,code_dtl_abr=?,category3=? WHERE code_key='HOL' AND code_dtl=?", [r.name, r.name.slice(0, 26), r.active ? ' ' : '0', k]);
    },
  },
  // 担当者（現行 Java operator_m・MA003〜008）：出荷の担当者（必須）。利用者IDを紐付けるとその利用者の出荷登録の初期値になる
  operators: {
    label: '担当者', table: 'operator_m',
    fields: [F('code', '担当者コード', { max: 6, key: true, hint: '数字6桁以内' }), F('name', '担当者名', { max: 20 }), F('userId', '利用者ID（ログインと紐付け）', { type: 'int', optional: true, list: false, hint: '利用者管理のID' }),
      F('mail', 'メール', { max: 100, optional: true, list: false }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT * FROM operator_m', where: 'tanto_cd=?', keyOf: r => [Number(r.code)],
    decode: r => ({ code: String(r.tanto_cd).padStart(6, '0'), name: r.tanto_nm, userId: Number(r.user_id || 0) || '', mail: r.mailaddr || '', active: live(r) }),
    validate: r => ({ code: String(Number(text(r.code, '担当者コード', 6, { pattern: /^\d{1,6}$/ }))).padStart(6, '0'), name: text(r.name, '担当者名', 20), userId: yen(r.userId || 0, '利用者ID', { max: 999999 }), mail: text(r.mail, 'メール', 100, { required: false }), active: bool(r.active ?? true) }),
    async write(c, r, old) {
      if (!old) await c.query('INSERT INTO operator_m (tanto_cd,tanto_nm,user_id,mailaddr,delete_f) VALUES (?,?,?,?,?)', [Number(r.code), r.name, r.userId, r.mail, del(r.active)]);
      else await c.query('UPDATE operator_m SET tanto_nm=?,user_id=?,mailaddr=?,delete_f=? WHERE tanto_cd=?', [r.name, r.userId, r.mail, del(r.active), Number(r.code)]);
    },
  },
  accounts: {
    label: '勘定科目', table: 'account_subject',
    fields: [F('code', '科目コード', { max: 20, key: true }), F('name', '科目名', { max: 100 }), F('active', '有効', { type: 'bool' })],
    select: 'SELECT a.*, (SELECT k.tax_code FROM kb_account k WHERE k.account_code=a.account_code) kb_tax FROM account_subject a', where: 'a.account_code=?', keyOf: r => [r.code],
    decode: r => ({ code: r.account_code, name: r.account_name, active: !!r.active, system: SYSTEM_ACCOUNTS.some(a => a[0] === r.account_code), tax: r.kb_tax || '' }),
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
export const meta = () => Object.fromEntries(Object.entries(MASTERS).map(([k, m]) => [k, { label: m.label, readOnly: !!m.readOnly, fields: m.fields.map(f => ({ ...f, pattern: undefined })) }]));
export async function list(c, kind) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です');
  return (await rows(c, cfg.select)).map(r => withVersion(cfg, r)).sort(cfg.sort || ((a, b) => a.key.localeCompare(b.key)));
}
export async function allMasters(c) { const out = {}; for (const k of Object.keys(MASTERS)) out[k] = await list(c, k); return out; }

async function current(c, cfg, key) {
  const topWhere = / WHERE /.test(cfg.select.replace(/\([^()]*\)/g, '')); // 副問合せの WHERE は数えない（勘定科目の既定処税率）
  const r = await one(c, `${cfg.select} ${topWhere ? 'AND' : 'WHERE'} ${cfg.where} FOR UPDATE`, key);
  return r ? withVersion(cfg, r) : null;
}
// mode: 'create' requires the key to be absent; 'update' requires a matching version.
export async function save(c, ctx, kind, input, mode) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です'); check(!cfg.readOnly, `${cfg.label}は登録・変更できません`);
  const r = cfg.validate(input || {}), key = cfg.keyOf(r);
  const old = await current(c, cfg, key);
  if (cfg.check) cfg.check(r, old);
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
// ---------- 削除（物理削除） ----------
// 取引・他のマスタから使われているコードは削除せず、「有効」を外して無効化するよう案内する（現行 Java の論理削除 delete_f='1' と同じ扱い）。
// SQL の ? にはキー配列を先頭から順に繰り返し当てる。
const VID = '(SELECT vendor_id FROM vendor WHERE vendor_code=?)';
const REMOVE = {
  customers: { refs: [['出荷・売上', 'SELECT 1 x FROM sales_trn WHERE customers_cd=? LIMIT 1'], ['出荷伝票（他社得意先）', 'SELECT 1 x FROM shipment_slip WHERE other_company_customers_cd=? LIMIT 1'],
    ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE customers_cd=? LIMIT 1'], ['請求', 'SELECT 1 x FROM billing_head WHERE customers_cd=? LIMIT 1'], ['入金', 'SELECT 1 x FROM receipt WHERE customers_cd=? LIMIT 1'],
    ['仕訳', 'SELECT 1 x FROM journal_line WHERE customers_cd=? LIMIT 1'], ['期首残高', 'SELECT 1 x FROM opening_balance WHERE customers_cd=? LIMIT 1'],
    ['現場マスタ', 'SELECT 1 x FROM field_name_m WHERE customers_cd=? LIMIT 1'], ['得意先別単価', 'SELECT 1 x FROM uriage_tanka_m WHERE customers_cd=? LIMIT 1']],
    del: ['DELETE FROM client_m WHERE customers_cd=?'] },
  sites: { refs: [['出荷・売上', 'SELECT 1 x FROM sales_trn WHERE customers_cd=? AND field_cd=? AND field_suffix=? LIMIT 1'], ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE customers_cd=? AND field_cd=? AND field_suffix=? LIMIT 1'],
    ['請求', 'SELECT 1 x FROM billing_head WHERE customers_cd=? AND field_cd=? AND field_suffix=? LIMIT 1'], ['得意先別単価', 'SELECT 1 x FROM uriage_tanka_m WHERE customers_cd=? AND field_cd=? AND field_suffix=? LIMIT 1']],
    del: ['DELETE FROM field_name_m WHERE customers_cd=? AND field_cd=? AND field_suffix=?'] },
  items: { refs: [['出荷・売上', 'SELECT 1 x FROM sales_trn WHERE item_cd=? LIMIT 1'], ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE item_cd=? LIMIT 1'], ['得意先別単価', 'SELECT 1 x FROM uriage_tanka_m WHERE item_cd=? LIMIT 1'],
    ['商品仕入', 'SELECT 1 x FROM purchase WHERE item_cd=? LIMIT 1'], ['在庫', 'SELECT 1 x FROM inventory_count WHERE item_cd=? LIMIT 1'], ['配合', "SELECT 1 x FROM code_m WHERE code_key='MIX' AND (split_part(code_dtl,':',1)=? OR split_part(code_dtl,':',2)=?) LIMIT 1"]],
    del: ['DELETE FROM item_m WHERE item_cd=?'] },
  prices: { refs: [], del: ['DELETE FROM uriage_tanka_m WHERE item_cd=? AND customers_cd=? AND field_cd=? AND field_suffix=?'] },
  banks: { refs: [['仕訳', "SELECT 1 x FROM journal_line WHERE account_code IN ('1112','1113') AND sub_code=? LIMIT 1"], ['財務会計の伝票', "SELECT 1 x FROM kb_line WHERE account_code IN ('1112','1113') AND sub_code=? LIMIT 1"],
    ['業者の支払銀行', "SELECT 1 x FROM code_m WHERE code_key='VPAY' AND code_dtl_nam=? LIMIT 1"], ['請求書の振込先', "SELECT 1 x FROM code_m WHERE code_key='SET' AND code_dtl IN ('INVBANK','INVBANK2') AND code_dtl_abr=? LIMIT 1"]],
    del: ["DELETE FROM code_m WHERE code_key IN ('BANK','ZGN') AND code_dtl=?", "DELETE FROM account_subsubject WHERE account_code IN ('1112','1113') AND sub_code=?"] },
  vendors: { refs: [['商品仕入', `SELECT 1 x FROM purchase WHERE vendor_id=${VID} LIMIT 1`], ['定時請求・小口現金', `SELECT 1 x FROM expense_document WHERE vendor_id=${VID} LIMIT 1`], ['支払', `SELECT 1 x FROM payment WHERE vendor_id=${VID} LIMIT 1`],
    ['仕訳', `SELECT 1 x FROM journal_line WHERE vendor_id=${VID} LIMIT 1`], ['期首残高', `SELECT 1 x FROM opening_balance WHERE vendor_id=${VID} LIMIT 1`]],
    del: ["DELETE FROM code_m WHERE code_key='VPAY' AND code_dtl=?", 'DELETE FROM vendor WHERE vendor_code=?'] },
  bankdir: { refs: [['業者の振込先口座', "SELECT 1 x FROM bank_account WHERE bank_code=split_part(?,'-',1) AND (position('-' in ?)=0 OR branch_code=split_part(?,'-',2)) LIMIT 1"]],
    del: ["DELETE FROM code_m WHERE code_key='BKDIR' AND code_dtl=?"] },
  depts: { refs: [['仕訳', 'SELECT 1 x FROM journal_line WHERE department_code=? LIMIT 1'], ['定時請求・小口現金', 'SELECT 1 x FROM expense_line WHERE department_code=? LIMIT 1'], ['財務会計の伝票', 'SELECT 1 x FROM kb_line WHERE dept_code=? LIMIT 1']],
    del: ["DELETE FROM code_m WHERE code_key='DEPT' AND code_dtl=?"] },
  jv: { refs: [], del: ["DELETE FROM code_m WHERE code_key='JV' AND code_dtl=?"] },
  mixes: { refs: [], del: ["DELETE FROM code_m WHERE code_key='MIX' AND code_dtl=?"] },
  matPrices: { refs: [], del: ["DELETE FROM code_m WHERE code_key='MATPR' AND code_dtl=?"] },
  deliveryKinds: { refs: [['出荷伝票', 'SELECT 1 x FROM shipment_slip WHERE CAST(delivery_kbn_cd AS TEXT)=? LIMIT 1'], ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE CAST(delivery_kbn_cd AS TEXT)=? LIMIT 1']],
    del: ["DELETE FROM code_m WHERE code_key='A0000' AND code_dtl=?"] },
  weathers: { refs: [['出荷伝票', 'SELECT 1 x FROM shipment_slip WHERE CAST(weather_cd AS TEXT)=? LIMIT 1'], ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE CAST(weather_cd AS TEXT)=? LIMIT 1']],
    del: ["DELETE FROM code_m WHERE code_key='A0010' AND code_dtl=?"] },
  units: { refs: [['商品マスタ', 'SELECT 1 x FROM item_m WHERE unit=? LIMIT 1'], ['出荷伝票', 'SELECT 1 x FROM shipment_slip WHERE unit_cd=? LIMIT 1'], ['出荷予定', 'SELECT 1 x FROM shipment_plan WHERE unit_cd=? LIMIT 1']],
    del: ["DELETE FROM code_m WHERE code_key='A0003' AND code_dtl=?"] },
  holidays: { refs: [], del: ["DELETE FROM code_m WHERE code_key='HOL' AND code_dtl=?"] },
  taxRates: { refs: [['最後の1件', "SELECT 1 x FROM (SELECT COUNT(*) n FROM code_m WHERE code_key='A0007' AND code_dtl<>?) t WHERE t.n=0"],
    ['この税率期間の出荷・売上', "SELECT 1 x FROM sales_trn WHERE sales_date>=CAST(? AS INTEGER) AND sales_date<COALESCE((SELECT MIN(CAST(code_dtl AS INTEGER)) FROM code_m WHERE code_key='A0007' AND code_dtl>?),99999999) LIMIT 1"]], del: ["DELETE FROM code_m WHERE code_key='A0007' AND code_dtl=?"] },
  operators: { refs: [['出荷伝票', "SELECT 1 x FROM shipment_slip WHERE person_in_charge_cd=lpad(CAST(? AS TEXT),6,'0') LIMIT 1"], ['出荷予定', "SELECT 1 x FROM shipment_plan WHERE person_in_charge_cd=lpad(CAST(? AS TEXT),6,'0') LIMIT 1"]],
    del: ['DELETE FROM operator_m WHERE tanto_cd=?'] },
  accounts: { refs: [['仕訳', 'SELECT 1 x FROM journal_line WHERE account_code=? LIMIT 1'], ['財務会計の伝票', 'SELECT 1 x FROM kb_line WHERE account_code=? LIMIT 1'], ['期首残高（財務会計）', 'SELECT 1 x FROM kb_opening WHERE account_code=? LIMIT 1'],
    ['定時請求・小口現金', 'SELECT 1 x FROM expense_line WHERE account_code=? LIMIT 1'], ['内訳科目', 'SELECT 1 x FROM account_subsubject WHERE account_code=? LIMIT 1']],
    del: ['DELETE FROM kb_account WHERE account_code=?', 'DELETE FROM account_subject WHERE account_code=?'] },
  subaccounts: { refs: [['仕訳', 'SELECT 1 x FROM journal_line WHERE account_code=? AND sub_code=? LIMIT 1'], ['財務会計の伝票', 'SELECT 1 x FROM kb_line WHERE account_code=? AND sub_code=? LIMIT 1'],
    ['期首残高（財務会計）', 'SELECT 1 x FROM kb_opening WHERE account_code=? AND sub_code=? LIMIT 1'], ['定時請求・小口現金', 'SELECT 1 x FROM expense_line WHERE account_code=? AND sub_code=? LIMIT 1']],
    del: ['DELETE FROM account_subsubject WHERE account_code=? AND sub_code=?'] },
};
const argsFor = (sql, key) => Array.from({ length: (sql.match(/\?/g) || []).length }, (_, i) => key[i % key.length]);
export async function remove(c, ctx, kind, input) {
  const cfg = MASTERS[kind], rm = REMOVE[kind]; check(cfg, 'マスタ種別が不正です'); check(!cfg.readOnly, `${cfg.label}は削除できません`); check(rm, `${cfg?.label || 'このマスタ'}は削除できません`);
  const key = cfg.keyOf(input || {}), old = await current(c, cfg, key);
  if (!old) throw new Conflict('対象のマスタが見つかりません。再読込してください');
  if (old.version !== input.version) throw new Conflict('他の利用者が更新しました。再読込してからやり直してください');
  if (kind === 'accounts') check(!SYSTEM_ACCOUNTS.some(a => a[0] === key[0]), '請求システムの自動仕訳で使用する科目は削除できません');
  const used = []; for (const [label, sql] of rm.refs) if (await one(c, sql, argsFor(sql, key))) used.push(label);
  if (kind === 'taxRates') check(!used.length, '消費税率は最低1件必要です');
  check(!used.length, `${cfg.label}「${key.filter(v => v !== '').join('-')}」は ${used.join('・')} で使われているため削除できません。「有効」を外して無効にしてください（現行と同じ論理削除）`);
  for (const sql of rm.del) await c.query(sql, argsFor(sql, key));
  await audit(c, ctx, cfg.table, key.join('|'), 'master.delete', { kind, key: key.join('|') });
  return { kind, key: key.join('|') };
}
// CSV import: header row uses field names or labels. Whole file is rolled back on the first error.
export async function importCsv(c, ctx, kind, csvText) {
  const cfg = MASTERS[kind]; check(cfg, 'マスタ種別が不正です'); check(!cfg.readOnly, `${cfg.label}は取込できません`);
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
