// NO20 会計連携（データダウンロード）。会計システムは勘定奉行（奉行クラウド）が前提（10/14 打合せ・QA 回答 2026-10-08）。
//  bugyo   … 勘定奉行向け（借貸併記 CSV、見出しは会計設定の OBC受入記号／未登録は項目名、税区分は処税率→奉行税区分の対応表）
//  generic … 借貸併記（現行自動仕訳リストと同じ並び）UTF-8 BOM CSV、科目・内訳はコード＋名称
//  yayoi   … 弥生会計「仕訳日記帳」インポート形式（25項目、Shift_JIS）。科目は名称、税区分は処税率を分解して変換
// 補助科目は内訳科目だけ。得意先・業者は取引先コードで連携し、取引先コード変換表（code_m PCNV）があれば会計の取引先コードに置き換える（2026-11-03）。
// 勘定奉行の取引先コードは半角英数のため、カナを含むコードが変換表に無いと勘定奉行CSVは出力しない
import iconv from 'iconv-lite';
import { check, isoDate, csv, parseCsv, DomainError, addMonths } from './domain.mjs';
import { importCsv as masterImport } from './masters.mjs';
import { audit, rows as dbRows, one, isClosed, cycleMonth, cycleRange, JOURNAL_CLOSE } from './db.mjs';
import { journalList, LISTS, markAcctLinked } from './journal-lists.mjs';
import { decode, NON_TAX } from './taxcode.mjs';
import { bugyoSettings, bugyoFile } from './bugyo.mjs';

// 処税率 → 弥生の税区分（2桁目＝区分、3桁目＝税率）
export function yayoiTax(code) {
  const t = decode(code); if (!t) return null;
  const rate = t.rate === 8 ? '8%(軽)' : `${t.rate}%`;
  if (t.kind === 9) return '対象外';
  if (t.side === 'S') return t.kind === 1 ? (t.taxable ? `課税売上${rate}` : '対象外') : t.kind === 2 ? '非課売上' : '輸出売上';
  if (!t.taxable) return t.kind === 7 || NON_TAX.has(t.code) ? '非課仕入' : '対象外';   // 「 41」＝非課税（2026-11-16）
  return { 4: '課対仕入', 5: '非対仕入', 6: '共対仕入' }[t.kind] + rate;
}
async function entries(c, from, to) {
  const out = [];
  for (const pattern of Object.keys(LISTS)) {
    const d = await journalList(c, { pattern, from, to });
    for (const s of d.slips) out.push({ ...s, pattern });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}
export async function accountingExport(c, ctx, q) {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日'); check(from <= to, '期間が不正です');
  const format = ['yayoi', 'bugyo'].includes(q.format) ? q.format : 'generic';
  // 会計連携は月の順番どおり（飛ばし不可。2026-11-27 打合せ 01:35「2月の次に4月は✕」）：まだ連携していない最初の月は「連携済みの最後の月の翌月」
  const last = (await one(c, 'SELECT MAX(month) m FROM app_acct_link'))?.m;
  if (last) {
    const next = addMonths(last, 1), first = [cycleMonth(from), cycleMonth(to)].sort()[0];
    const fresh = []; for (let m = first; m <= cycleMonth(to); m = addMonths(m, 1)) if (m > last) fresh.push(m);
    if (fresh.length && fresh[0] !== next) throw new DomainError(`会計連携は月の順番どおりに行います。連携済みは ${last} までです。先に ${next}（${last}-21 〜 ${next}-20）を連携してください（${next} を飛ばして ${fresh[0]} を連携することはできません）`);
  }
  let slips = await entries(c, from, to);
  check(slips.length, '期間内の仕訳がありません');
  // 勘定奉行 受入CSV（2026-11-25）：① 月次確定してから出力（10 連携仕様 IF-01「月次確定の後」）② 出力済みの仕訳は出さない。再出力は確認のうえ again=1
  let exported = [];
  if (format === 'bugyo') {
    // 連携の条件は自動仕訳 4 種（売掛金計上・在庫計上・定時請求・小口現金出納分）がすべて確定済み（2026-11-27 打合せ 01:04。以前は月次確定）。月次確定済みの月はすべて確定済み
    const open = [];
    for (const m of [...new Set([cycleMonth(from), cycleMonth(to), ...slips.map(s => cycleMonth(s.date))])].sort()) {
      if (await isClosed(c, m)) continue;
      const done = new Set((await dbRows(c, 'SELECT pattern FROM app_journal_close WHERE period=?', [m])).map(r => r.pattern));
      const miss = Object.entries(JOURNAL_CLOSE).filter(([k]) => !done.has(k)).map(([, n]) => n);
      if (miss.length) open.push(`${m}（${cycleRange(m).from}〜${cycleRange(m).to}）：${miss.join('・')}`);
    }
    if (open.length) throw new DomainError(`確定していない自動仕訳があります。${open.join(' / ')}。各計上の［実行］（小口現金出納分は「自動仕訳別月次確定」の［確定］）で確定してから連携してください`);
    const ids = slips.map(s => s.id), done = new Set(ids.length ? (await dbRows(c, `SELECT journal_id FROM journal_entry WHERE export_id IS NOT NULL AND journal_id IN (${ids.map(() => '?').join(',')})`, ids)).map(r => Number(r.journal_id)) : []);
    exported = slips.filter(s => done.has(Number(s.id)));
    if (String(q.again || '') !== '1') {
      if (exported.length === slips.length) throw new DomainError(`ALREADY:期間内の仕訳 ${slips.length} 件はすべて出力済みです。もう一度出力しますか（勘定奉行で二重に取り込まないよう注意）`);
      slips = slips.filter(s => !done.has(Number(s.id)));
    }
  }
  const bad = [...new Set(slips.flatMap(s => s.pairs.flatMap(p => [p.dr?.tax, p.cr?.tax])).filter(t => t && !decode(t)))];
  if (format !== 'generic' && bad.length) throw new DomainError('処税率として解釈できないコードがあります: ' + bad.join(', '));
  const conv = new Map((await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='PCNV' AND category3<>'0'")).map(r => [r.code_dtl, r.code_dtl_nam])), missing = new Map();
  const link = x => {
    if (!x) return x;
    const code = x.partnerCode ? conv.get(`${x.partnerKind}:${x.partnerCode}`) || x.partnerCode : '';
    if (code && !/^[0-9A-Za-z]+$/.test(code)) missing.set(`${x.partnerKind}:${x.partnerCode}`, `${x.partnerKind === 'C' ? '得意先' : '業者'} ${x.partnerCode} ${x.partnerName}`);
    return { ...x, sub: x.inner, subName: x.innerName, partner: code };
  };
  for (const s of slips) s.pairs = s.pairs.map(p => ({ ...p, dr: link(p.dr), cr: link(p.cr) }));
  if (format === 'bugyo' && missing.size) throw new DomainError(`取引先コードに半角英数以外の文字がある得意先・業者が ${missing.size} 件あります。マスタ管理の「取引先コード変換表」で会計の取引先コードを登録してください: ${[...missing.values()].slice(0, 10).join(' / ')}${missing.size > 10 ? ' ほか' : ''}`);
  let file;
  if (format === 'bugyo') {
    file = bugyoFile(slips.map(s => ({ date: s.date, slipNo: s.slipNo, memo: `${s.pattern} ${s.sourceNo}`,
      pairs: s.pairs.map(p => ({ dr: p.dr, cr: p.cr, memo: [p.dr?.memo1 || p.cr?.memo1, p.dr?.memo2 || p.cr?.memo2].filter(Boolean).join(' ') })) })), await bugyoSettings(c), `会計連携_勘定奉行_${from}_${to}.csv`);
  } else if (format === 'generic') {
    const rows = [['伝票日付', '伝票番号', '行', '借方部門', '借方科目CD', '借方科目名', '借方補助CD', '借方補助名', '借方取引先CD', '借方取引先名', '借方税区分', '借方金額', '貸方部門', '貸方科目CD', '貸方科目名', '貸方補助CD', '貸方補助名', '貸方取引先CD', '貸方取引先名', '貸方税区分', '貸方金額', '摘要1', '摘要2', '摘要1コード', 'パターン', '元伝票', '状態']];
    for (const s of slips) s.pairs.forEach((p, i) => {
      const d = p.dr || {}, cr = p.cr || {};
      rows.push([s.date, s.slipNo, i + 1, d.dept, d.account, d.accountName, d.sub, d.subName, d.partner, d.partnerName, d.tax, d.amount ?? '', cr.dept, cr.account, cr.accountName, cr.sub, cr.subName, cr.partner, cr.partnerName, cr.tax, cr.amount ?? '',
        d.memo1 || cr.memo1 || '', d.memo2 || cr.memo2 || '', d.memo1Code || cr.memo1Code || '', s.pattern, s.sourceNo, s.status]);
    });
    file = { name: `会計連携_汎用_${from}_${to}.csv`, body: Buffer.from(csv(rows), 'utf8'), type: 'text/csv; charset=utf-8' };
  } else {
    const q2 = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t; };
    const lines = [];
    for (const s of slips) s.pairs.forEach((p, i, all) => {
      const flag = all.length === 1 ? '2000' : i === 0 ? '2110' : i === all.length - 1 ? '2101' : '2100';
      const d = p.dr, cr = p.cr, memo = [d?.memo1 || cr?.memo1, d?.memo2 || cr?.memo2].filter(Boolean).join(' ').slice(0, 64);
      lines.push([flag, s.slipNo.replace(/\D/g, '').slice(-6), '', s.date.replaceAll('-', '/'),
        d?.accountName || '', d?.subName || '', d?.dept || '', d ? yayoiTax(d.tax) || '対象外' : '', d?.amount ?? '', '',
        cr?.accountName || '', cr?.subName || '', cr?.dept || '', cr ? yayoiTax(cr.tax) || '対象外' : '', cr?.amount ?? '', '',
        memo, '', '', '0', '', `${s.pattern} ${s.sourceNo}`, '0', '0', 'no'].map(q2).join(','));
    });
    file = { name: `会計連携_弥生_${from}_${to}.csv`, body: iconv.encode(lines.join('\r\n') + '\r\n', 'Shift_JIS'), type: 'text/csv; charset=Shift_JIS' };
  }
  if (format === 'bugyo') {
    const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    await c.query('INSERT INTO app_acct_export (exported_at,exported_by,from_d,to_d,slips,again) VALUES (?,?,?,?,?,?)', [now, ctx?.user?.login_id || 'system', from, to, slips.length, String(q.again || '') === '1']);
    const eid = Number((await dbRows(c, 'SELECT MAX(export_id) id FROM app_acct_export'))[0]?.id);
    const ids = slips.map(s => s.id); if (eid && ids.length) await c.query(`UPDATE journal_entry SET export_id=? WHERE journal_id IN (${ids.map(() => '?').join(',')})`, [eid, ...ids]);
  }
  // 出力と取込完了を分ける（2026-11-27 ユーザー指示）：出力では会計連携済みにしない（何度でも出力できる）。会計連携済みの印は 月次確定 › 連携取込完了 の［取込完了］で付ける
  await audit(c, ctx, 'journal_entry', `${from}..${to}`, 'accounting.export', { format, slips: slips.length, skippedExported: format === 'bugyo' && String(q.again || '') !== '1' ? exported.length : 0, again: String(q.again || '') === '1' });
  return { file };
}

// ---------- 連携取込完了（2026-11-27 ユーザー指示：月次確定の最後の小メニュー）----------
// 会計月ごとに 自動仕訳 4 種の確定・勘定奉行 受入CSV の出力・取込完了 を見せ、勘定奉行に取り込んだ月に［取込完了］を付ける。
// 取込完了は月の順番どおり（連携済みの最後の月の翌月だけ）。付けたら戻せない（その期間の計上・登録・修正が止まる）
const linkMonthsOf = async c => {
  const last = (await one(c, 'SELECT MAX(month) m FROM app_acct_link'))?.m || null;
  const exps = await dbRows(c, 'SELECT export_id, exported_at, exported_by, from_d, to_d, slips, again FROM app_acct_export ORDER BY export_id DESC');
  const firstExp = exps.length ? exps.map(e => cycleMonth(e.from_d)).sort()[0] : null;
  return { last, exps, next: last ? addMonths(last, 1) : firstExp };
};
export async function acctLinkStatus(c) {
  const { last, exps, next } = await linkMonthsOf(c), now = cycleMonth(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10));
  const links = await dbRows(c, 'SELECT month, linked_by, linked_at, period FROM app_acct_link');
  const jc = await dbRows(c, 'SELECT period, pattern FROM app_journal_close'), pc = new Set((await dbRows(c, 'SELECT period FROM app_period_close')).map(r => r.period));
  const out = [];
  for (let i = -6; i <= 1; i++) {
    const m = addMonths(now, i), { from, to } = cycleRange(m), l = links.find(r => r.month === m);
    const e = exps.find(x => x.from_d <= to && x.to_d >= from);
    const done = Object.keys(JOURNAL_CLOSE).filter(k => pc.has(m) || jc.some(r => r.period === m && r.pattern === k));
    out.push({ month: m, from, to, journals: Object.fromEntries(Object.keys(JOURNAL_CLOSE).map(k => [k, done.includes(k)])), allClosed: done.length === Object.keys(JOURNAL_CLOSE).length,
      exported: e ? { at: e.exported_at, by: e.exported_by, slips: Number(e.slips), period: `${e.from_d}..${e.to_d}`, again: !!e.again } : null,
      linked: l ? { at: l.linked_at, by: l.linked_by } : null, next: m === next });
  }
  return { last, next, journalNames: JOURNAL_CLOSE, months: out.reverse() };
}
export async function completeAcctLink(c, ctx, b) {
  const month = String(b?.month || ''); check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), '対象年月を指定してください');
  const { last, exps, next } = await linkMonthsOf(c), { from, to } = cycleRange(month);
  check(!(await one(c, 'SELECT 1 x FROM app_acct_link WHERE month=?', [month])), `${month} は取込完了済みです`);
  check(exps.some(x => x.from_d <= to && x.to_d >= from), `${month}（${from}〜${to}）は勘定奉行 受入CSV を出力していません。先に 会計連携データ で出力してください`);
  check(!next || month === next, `取込完了は月の順番どおりに行います。${last ? `取込完了済みは ${last} までです。` : ''}次は ${next}（${next ? cycleRange(next).from + '〜' + cycleRange(next).to : ''}）です`);
  if (!(await isClosed(c, month))) {
    const done = new Set((await dbRows(c, 'SELECT pattern FROM app_journal_close WHERE period=?', [month])).map(r => r.pattern));
    const miss = Object.entries(JOURNAL_CLOSE).filter(([k]) => !done.has(k)).map(([, n]) => n);
    check(!miss.length, `${month} は確定していない自動仕訳があります：${miss.join('・')}`);
  }
  const linked = await markAcctLinked(c, ctx, from, to);
  await audit(c, ctx, 'app_acct_link', month, 'accounting.linkdone', { month, from, to, linked });
  return acctLinkStatus(c);
}

// マスタの会計システム（勘定奉行）形式の出力（D-059・D-060。2026-11-12 結合テスト IT-13）：取引先（得意先・業者）・部門・摘要。
// 11/11 打合せ No.3（課題管理表 No.1）：勘定科目・補助科目は勘定奉行 → APLink（受入は accountingMasterImport）、取引先・部門・摘要は APLink → 勘定奉行（2026-11-20 ユーザー指示）
// 取引先コードは取引先コード変換表で会計の取引先コードに置き換える（変換表に無いカナ付きコードがあると出力しない。仕訳の勘定奉行CSVと同じ）。有効なものだけ。文字コードは勘定奉行連携の設定
export const BUGYO_MASTERS = { partners: '取引先', depts: '部門', tekiyo: '摘要' };
export async function accountingMasters(c, ctx, q) {
  const kind = String(q.kind || ''); check(BUGYO_MASTERS[kind], '出力するマスタが不正です');
  let out;
  if (kind === 'partners') {
    const conv = new Map((await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='PCNV' AND category3<>'0'")).map(r => [r.code_dtl, r.code_dtl_nam])), missing = [];
    const list = [...(await dbRows(c, "SELECT customers_cd code, customers_name name FROM client_m WHERE delete_f<>'1' ORDER BY customers_cd")).map(r => ({ ...r, kind: 'C' })),
      ...(await dbRows(c, 'SELECT vendor_code code, vendor_name name FROM vendor WHERE active ORDER BY vendor_code')).map(r => ({ ...r, kind: 'V' }))];
    out = [['取引先コード', '取引先名称'], ...list.map(r => { const code = conv.get(`${r.kind}:${r.code}`) || r.code; if (!/^[0-9A-Za-z]+$/.test(code)) missing.push(`${r.kind === 'C' ? '得意先' : '業者'} ${r.code} ${r.name}`); return [code, r.name]; })];
    if (missing.length) throw new DomainError(`取引先コードに半角英数以外の文字がある得意先・業者が ${missing.length} 件あります。マスタ管理の「取引先コード変換表」で会計の取引先コードを登録してください: ${missing.slice(0, 10).join(' / ')}${missing.length > 10 ? ' ほか' : ''}`);
  } else if (kind === 'depts') out = [['部門コード', '部門名称'], ...(await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='DEPT' AND COALESCE(category1,'')<>'0' ORDER BY code_dtl")).map(r => [r.code_dtl, r.code_dtl_nam])];
  else out = [['摘要コード', '摘要名称'], ...(await dbRows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='TKYO' AND COALESCE(category1,'')<>'0' ORDER BY LENGTH(code_dtl), code_dtl")).map(r => [r.code_dtl, r.code_dtl_nam])];   // 摘要マスタ（2026-11-20）
  const { encoding } = await bugyoSettings(c), text = csv(out), name = `会計連携_勘定奉行_${BUGYO_MASTERS[kind]}マスタ.csv`;
  await audit(c, ctx, 'master', kind, 'accounting.masters', { kind, rows: out.length - 1 });
  return { file: { name, body: encoding === 'utf-8' ? Buffer.from(text, 'utf8') : iconv.encode(text.replace(/^\uFEFF/, ''), 'Shift_JIS'), type: `text/csv; charset=${encoding === 'utf-8' ? 'utf-8' : 'Shift_JIS'}` } };
}

// 勘定奉行から受け取る勘定科目・補助科目（11/11 打合せ No.3。2026-11-20 ユーザー指示）。勘定奉行のマスタ出力 CSV（Shift_JIS／UTF-8）を見出しで判定して取り込む。
// 列名は「勘定科目コード／科目コード」「勘定科目名／科目名」「補助科目コード」「補助科目名」（末尾の「称」「名称」は有無とも可）。既存コードは更新、新しいコードは登録。1 件でもエラーなら全件取消
// 勘定奉行の受入・出力形式（データ受入形式一覧表）が確定したら列名を合わせる（U-01）
export const BUGYO_IMPORTS = { accounts: '勘定科目', subaccounts: '補助科目' };
export async function accountingMasterImport(c, ctx, b) {
  const kind = String(b.kind || ''); check(BUGYO_IMPORTS[kind], '受け取るマスタが不正です');
  const table = parseCsv(String(b.csv || '')).filter(r => r.some(v => String(v).trim())); check(table.length >= 2, 'CSV にデータがありません（1 行目は列名）');
  const head = table[0].map(h => String(h).replace(/^\uFEFF/, '').replace(/\s/g, '')), col = re => head.findIndex(h => re.test(h));
  const acc = col(/^(勘定)?科目(コード|CD|ｺｰﾄﾞ)$/i), accName = col(/^(勘定)?科目名(称)?$/), sub = col(/^補助(科目)?(コード|CD|ｺｰﾄﾞ)$/i), subName = col(/^補助(科目)?名(称)?$/);
  check(acc >= 0, `勘定科目コードの列がありません（列名：${head.join('、')}）`);
  let out;
  if (kind === 'accounts') { check(accName >= 0, `勘定科目名の列がありません（列名：${head.join('、')}）`); out = [['code', 'name', 'active'], ...table.slice(1).map(r => [r[acc], r[accName], '1'])]; }
  else { check(sub >= 0 && subName >= 0, `補助科目コード・補助科目名の列がありません（列名：${head.join('、')}）`); out = [['account', 'code', 'name', 'active'], ...table.slice(1).map(r => [r[acc], r[sub], r[subName], '1'])]; }
  // 受入の結果を 1 行ずつ返す（2026-11-21 ユーザー指示：結果を一覧で表示）。取込む前のマスタと比べて 登録／更新（名称変更・有効化）／変更なし
  const T = v => String(v ?? '').trim(), sub2 = kind === 'subaccounts';
  const before = new Map((await dbRows(c, sub2 ? 'SELECT account_code a, sub_code s, sub_name n, active FROM account_subsubject' : 'SELECT account_code a, account_name n, active FROM account_subject')).map(x => [sub2 ? `${x.a}|${x.s}` : x.a, x]));
  const names = new Map((await dbRows(c, 'SELECT account_code, account_name FROM account_subject')).map(x => [x.account_code, x.account_name]));
  const r = await masterImport(c, ctx, kind, csv(out).replace(/^\uFEFF/, ''));
  await audit(c, ctx, 'master', kind, 'accounting.masters.import', { kind, created: r.created, updated: r.updated });
  const result = out.slice(1).map(x => {
    const [account, code, name] = sub2 ? [T(x[0]), T(x[1]), T(x[2])] : [T(x[0]), '', T(x[1])], old = before.get(sub2 ? `${account}|${code}` : account);
    const state = !old ? '登録' : T(old.n) !== name ? '更新（名称変更）' : !old.active ? '更新（有効化）' : '変更なし';
    return { account, accountName: sub2 ? names.get(account) || '' : '', code, name, oldName: old && T(old.n) !== name ? T(old.n) : '', state };
  });
  return { ...r, rows: result };
}
