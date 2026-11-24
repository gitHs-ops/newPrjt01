// ② 自動仕訳リスト（帳票一覧⑥⑦⑨・9/17資料ア〜エ）。現行 HAR363/HAR413/HAR152/HAR733/CS5785 と同じ「借方・貸方を1行に併記」形式。
// 削減案5により全リストを同一フォーマットで出力する。エ（銀行別随時支払一覧表）のみ別形式。
import { check, isoDate, fromNum, today, addMonths, closingPeriodOfDate } from './domain.mjs';
import { businessDate } from './sales.mjs';
import { rows, one, audit, invoiceNos, assertOpen } from './db.mjs';
import { BOOKED, postPayableJournal, PAY_BOOKED, postPaymentJournal } from './payables.mjs';
import { xlsx, band } from './xlsx.mjs';
import { normalize } from './taxcode.mjs';
// 処税率は 3 桁で出す（自動仕訳の「9」は対象外 090。2026-11-12 結合テスト IT-05）
const taxOut = v => normalize(v) || String(v || '');

export const LISTS = {
  A01: { title: '売掛金計上自動仕訳リスト', ref: 'NO8 / 帳票⑦（HAR363）', prefix: 'R', source: 'billing_head' },
  B01: { title: '入金自動仕訳リスト', ref: 'NO18 / 帳票⑥（HAR413）', prefix: 'B', source: 'receipt' },
  C01: { title: '在庫計上自動仕訳リスト', ref: 'NO28 / 帳票⑨', prefix: '', source: 'inventory_count' },
  D01: { title: '定時請求自動仕訳リスト', ref: 'NO31 / 資料ア（HAR152）', prefix: 'S', source: 'expense_document' },
  E01: { title: '小口現金出納分自動仕訳リスト', ref: 'NO34 / 資料イ（HAR733）', prefix: 'K', source: 'expense_document' },
  F01: { title: '支払内訳自動仕訳リスト', ref: 'NO38 / 資料ウ（CS5785）', prefix: 'U', source: 'payment' },
  G03: { title: '小口現金出納分自動仕訳リスト', ref: 'G-03（現行は手入力。補充分）', prefix: '', source: 'petty_refill' },
};
export const BANK_LIST = { title: '銀行別随時支払一覧表', ref: 'NO39 / 資料エ（HAR321）' };
const ph = a => a.map(() => '?').join(',');
const range = q => {
  const from = isoDate(q.from, '開始日'), to = isoDate(q.to, '終了日');
  check(from <= to, '期間が不正です'); check((Date.parse(to) - Date.parse(from)) / 864e5 <= 400, '期間は400日以内で指定してください');
  return { from, to };
};

export async function journalList(c, q) {
  const def = LISTS[q.pattern]; check(def, '仕訳リストの種類が不正です');
  const { from, to } = range(q);
  const es = await rows(c, 'SELECT e.*, n.slip_no FROM journal_entry e LEFT JOIN app_slip_no n ON n.journal_id=e.journal_id WHERE e.pattern_code=? AND e.journal_date BETWEEN ? AND ? ORDER BY e.journal_date, e.journal_id', [q.pattern, from, to]);
  const ids = es.map(e => e.journal_id);
  const ls = ids.length ? await rows(c, `SELECT l.*, a.account_name, s.sub_name, cu.customers_name, v.vendor_code, v.vendor_name FROM journal_line l
    LEFT JOIN account_subject a ON a.account_code=l.account_code LEFT JOIN account_subsubject s ON s.account_code=l.account_code AND s.sub_code=l.sub_code
    LEFT JOIN client_m cu ON cu.customers_cd=l.customers_cd LEFT JOIN vendor v ON v.vendor_id=l.vendor_id WHERE l.journal_id IN (${ph(ids)}) ORDER BY l.journal_id, l.line_no`, ids) : [];
  // Source documents for 摘要 (memo) columns.
  const src = new Map(), srcIds = [...new Set(es.filter(e => e.source_type === def.source).map(e => Number(e.source_id)))];
  if (srcIds.length) {
    const invRows = def.source === 'billing_head' ? await rows(c, `SELECT h.invoice_id id, h.closing_date, h.customers_cd, c.customers_name FROM billing_head h LEFT JOIN client_m c ON c.customers_cd=h.customers_cd WHERE h.invoice_id IN (${ph(srcIds)})`, srcIds) : [];
    const invNo = await invoiceNos(c, invRows.map(r => ({ id: r.id, closing: fromNum(r.closing_date) })));
    // 売掛金計上（A01）の摘要2 は現行 HAR363 どおり空欄（2026-11-04。従来は「締日＋締」）
    for (const r of invRows) src.set(r.id, { no: invNo.get(Number(r.id)), memo2: '' });
    if (def.source === 'receipt') {
      for (const r of await rows(c, `SELECT receipt_id id, receipt_no FROM receipt WHERE receipt_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.receipt_no, closings: [], note: '' });
      for (const a of await rows(c, `SELECT a.receipt_id, h.closing_date FROM receipt_allocation a JOIN billing_head h ON h.invoice_id=a.invoice_id WHERE a.receipt_id IN (${ph(srcIds)}) ORDER BY a.receipt_id, a.invoice_id`, srcIds)) src.get(a.receipt_id)?.closings.push(fromNum(a.closing_date));
      for (const k of await rows(c, `SELECT receipt_id, maturity_date FROM receipt_component WHERE component_kind='NOTE' AND receipt_id IN (${ph(srcIds)})`, srcIds)) if (src.get(k.receipt_id)) src.get(k.receipt_id).note = `手形 期日${k.maturity_date || ''}`;
      // 現行入金処理で入力した摘要2（借方の内訳ごと。2026-11-01）
      for (const k of await rows(c, `SELECT receipt_id, component_kind, memo2, memo1 FROM receipt_component WHERE (memo2 IS NOT NULL OR memo1 IS NOT NULL) AND receipt_id IN (${ph(srcIds)})`, srcIds)) if (src.get(k.receipt_id)) { const x = src.get(k.receipt_id); if (k.memo2 !== null) (x.memo2Of ||= {})[k.component_kind] = k.memo2; if (k.memo1) (x.memo1Of ||= {})[k.component_kind] = k.memo1; }   // 摘要1 は手入力したものだけ（2026-11-17）
    }
    // 伝票No は実在庫登録・在庫登録リストと同じ月度の V 番号（V＋年度＋連番。app_doc_no）。番号が無い月度だけ従来の V＋ID（2026-11-21 ユーザー指示）
    if (def.source === 'inventory_count') {
      const ns = await rows(c, `SELECT n.inventory_id id, n.period_start, n.item_cd, i.item_nam FROM inventory_count n LEFT JOIN item_m i ON i.item_cd=n.item_cd WHERE n.inventory_id IN (${ph(srcIds)})`, srcIds), ms = [...new Set(ns.map(r => String(r.period_start).slice(0, 7)))];
      const vno = new Map(ms.length ? (await rows(c, `SELECT ref, doc_no FROM app_doc_no WHERE kind='count' AND ref IN (${ph(ms)})`, ms)).map(r => [r.ref, r.doc_no]) : []);
      for (const r of ns) src.set(r.id, { no: vno.get(String(r.period_start).slice(0, 7)) || 'V' + r.id, item: `${r.item_cd} ${r.item_nam || ''}` });
    }
    if (def.source === 'expense_document') {
      for (const r of await rows(c, `SELECT d.expense_id id, d.document_no, d.memo FROM expense_document d WHERE d.expense_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.document_no, memo2: r.memo, lines: [] });
      // 小口現金（E01）：借方の行ごとの 摘要1＝行の支払先、摘要2＝行の摘要（現行 HAR733。2026-10-29）
      for (const l of await rows(c, `SELECT l.expense_id, l.gross_amount, l.memo, l.payee, v.vendor_code, v.vendor_name FROM expense_line l LEFT JOIN vendor v ON v.vendor_id=l.vendor_id WHERE l.expense_id IN (${ph(srcIds)}) ORDER BY l.expense_id, l.line_no`, srcIds)) src.get(l.expense_id)?.lines.push(l);
    }
    if (def.source === 'payment') for (const r of await rows(c, `SELECT payment_id id, payment_no FROM payment WHERE payment_id IN (${ph(srcIds)})`, srcIds)) src.set(r.id, { no: r.payment_no });
  }
  // 8330-101 各種手数料 の摘要2「手数料」は 2026-11-17 ユーザー指示で外した（入力した摘要2 だけ出す）
  const DEDUCT = { '8330|107': '協力費', '8850|': '値引き', '4170|': '預り金充当' };
  // 在庫計上（月度ごと）の伝票No は実在庫登録の V 番号（V＋年度＋連番。app_doc_no）。番号が無い月度は従来の「棚卸 yyyy-mm月度」（2026-11-21 ユーザー指示）
  const cms = [...new Set(es.filter(e => e.source_type === 'inventory_month').map(e => `${e.source_id.slice(0, 4)}-${e.source_id.slice(4)}`))];
  const countNo = new Map(cms.length ? (await rows(c, `SELECT ref, doc_no FROM app_doc_no WHERE kind='count' AND ref IN (${ph(cms)})`, cms)).map(r => [r.ref, r.doc_no]) : []);
  const slips = es.map(e => {
    const s = e.source_type === 'inventory_month' ? { no: countNo.get(`${e.source_id.slice(0, 4)}-${e.source_id.slice(4)}`) || `棚卸 ${e.source_id.slice(0, 4)}-${e.source_id.slice(4)}月度` } : src.get(Number(e.source_id)) || { no: '' }, lines = ls.filter(l => l.journal_id === e.journal_id);
    const partnerLine = lines.find(l => l.customers_cd || l.vendor_id), partner = partnerLine ? { kind: partnerLine.customers_cd ? 'C' : 'V', code: partnerLine.customers_cd || partnerLine.vendor_code, name: partnerLine.customers_name || partnerLine.vendor_name } : null;
    let creditNo = 0, debitNo = 0, bk = null; const usedKind = new Set();
    // 入金（B01）の借方の行 → 入金の内訳（receipt_component）。8850 は値引き → 雑損失の順
    const kindOf = l => { const k = { 1112: 'BANK', 1111: 'CASH', 1120: 'NOTE', 4170: 'DEPOSIT' }[l.account_code] || (l.account_code === '8330' ? { 101: 'FEE', 107: 'COOP' }[l.sub_code] : l.account_code === '8850' ? ['DISCOUNT', 'LOSS'].find(x => !usedKind.has(x) && s.memo2Of?.[x] !== undefined) || (usedKind.has('DISCOUNT') ? 'LOSS' : 'DISCOUNT') : null); if (k) usedKind.add(k); return k; };
    const side = l => {
      if (!l) return null;
      let sub = l.sub_code || '', subName = l.sub_name || '';
      if (!sub && l.customers_cd) { sub = l.customers_cd; subName = l.customers_name || ''; }
      if (!sub && l.vendor_id) { sub = l.vendor_code; subName = l.vendor_name || ''; }
      if (!sub && l.account_code === '8130' && partner) { sub = partner.code; subName = partner.name; }
      // 会計連携用（2026-11-03）：補助科目は内訳科目だけ（inner）、得意先・業者は取引先コード（partner*）。上の sub は自動仕訳リスト（現行の内訳1）用
      const own = l.customers_cd ? { kind: 'C', code: l.customers_cd, name: l.customers_name || '' } : l.vendor_id ? { kind: 'V', code: l.vendor_code, name: l.vendor_name || '' } : l.account_code === '8130' ? partner : null;
      const link = { inner: l.sub_code || '', innerName: l.sub_name || '', partnerKind: own?.kind || '', partnerCode: own?.code || '', partnerName: own?.name || '' };
      let memo2 = s.memo2 || '';
      if (e.pattern_code === 'B01') {
        memo2 = DEDUCT[`${l.account_code}|${l.sub_code || ''}`] || (l.account_code === '1120' ? s.note : '');
        bk = null; if (l.side === 'D') { const k = kindOf(l); bk = k; if (k && s.memo2Of?.[k]) memo2 = s.memo2Of[k]; }
        // 売掛金の摘要2＝消し込んだ請求の締日。表記は現行 HAR413 の YY/MM/DD（2026-11-04）
        if (l.side === 'C' && l.account_code === '1131') { const cl = s.closings?.[creditNo++] || ''; memo2 = cl ? `${cl.slice(2, 4)}/${cl.slice(5, 7)}/${cl.slice(8, 10)}` : ''; }
      }
      // 在庫計上（C01）：現行 HAR463 と同じく 摘要1＝前月末在庫／当月末在庫（商品は 1360 の内訳1）。2026-10-28 摘要1＝商品・摘要2＝前月末在庫 から変更
      if (e.pattern_code === 'C01') return { ...link, dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: taxOut(l.source_tax_code), amount: Number(l.amount),
        memo1Code: '', memo1: (l.side === 'D' ? l.account_code === '82316' : l.account_code === '1360') ? '前月末在庫' : '当月末在庫', memo2: '' };
      // 定時請求（D01）は現行 HAR152：摘要1 は借方だけ（業者）、摘要2＝明細の摘要（無ければ伝票の摘要）。貸方の摘要2 は下で借方と同じにする（2026-11-04）
      if (e.pattern_code === 'D01' && s.lines) {
        const x = l.side === 'D' ? s.lines.filter(y => Number(y.gross_amount) > 0)[debitNo++] : null;
        return { ...link, dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: taxOut(l.source_tax_code), amount: Number(l.amount),
          memo1Code: l.side === 'D' ? partner?.code || '' : '', memo1: l.side === 'D' ? partner?.name || '' : '', memo2: x?.memo || memo2 };
      }
      if (e.pattern_code === 'E01' && l.side === 'D' && s.lines) {
        const x = s.lines.filter(y => Number(y.gross_amount) > 0)[debitNo++];
        if (x && (x.vendor_code || x.payee)) return { ...link, dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: taxOut(l.source_tax_code), amount: Number(l.amount), memo1Code: x.vendor_code || '', memo1: x.vendor_name || x.payee, memo2: x.memo || memo2 };
      }
      return { ...link, dept: l.department_code || '', account: l.account_code, accountName: l.account_name || '', sub, subName, sub2: '', tax: taxOut(l.source_tax_code), amount: Number(l.amount),
        memo1Code: partner?.code || '', memo1: (e.pattern_code === 'B01' && bk && s.memo1Of?.[bk]) || partner?.name || '', memo2 };
    };
    const dr = lines.filter(l => l.side === 'D'), cr = lines.filter(l => l.side === 'C'), pairs = [];
    // Inventory pairs follow the 洗替 order (前月末戻し, 当月末計上) even if one side is zero.
    for (let i = 0; i < Math.max(dr.length, cr.length); i++) pairs.push({ dr: side(dr[i]), cr: side(cr[i]) });
    // 小口現金（E01）は現行 HAR733 の並び：現金 1111 の 1 行を相手の行ごとに同じ金額で分け、摘要1・摘要2 も相手の行と同じ（2026-11-04）
    if (e.pattern_code === 'E01') {
      const [one, many, k] = cr.length === 1 && dr.length > 1 ? [cr[0], dr, 'cr'] : dr.length === 1 && cr.length > 1 ? [dr[0], cr, 'dr'] : [null, null, null];
      if (one?.account_code === '1111') { const base = pairs[0][k]; pairs.forEach(p => { const o = p[k === 'cr' ? 'dr' : 'cr']; p[k] = { ...base, amount: o.amount, memo1Code: o.memo1Code, memo1: o.memo1, memo2: o.memo2 }; }); }
      else pairs.forEach(p => { if (p.dr && p.cr) Object.assign(p.cr, { memo1Code: p.dr.memo1Code, memo1: p.dr.memo1, memo2: p.dr.memo2 }); });
    }
    if (e.pattern_code === 'D01') pairs.forEach(p => { if (p.dr && p.cr) p.cr.memo2 = p.dr.memo2; });
    // 支払内訳（F01）は現行 CS5785 の並び：貸方（当座預金・雑収入・業者立替金・預り金）を 1 行ずつ、最後に借方の買掛金だけの行。借方の行に摘要は出さない（2026-11-04）
    if (e.pattern_code === 'F01') pairs.splice(0, pairs.length, ...cr.map(l => ({ dr: null, cr: side(l) })), ...dr.map(l => ({ dr: { ...side(l), memo1Code: '', memo1: '', memo2: '' }, cr: null })));
    // 在庫計上（C01）は現行 HAR463 の並び：前月末在庫（借 82316／貸 1360）を商品順に全部、続けて当月末在庫（借 1360／貸 82316）を商品順に（2026-11-04）
    if (e.pattern_code === 'C01') pairs.sort((a, b) => (a.dr?.memo1 === '前月末在庫' ? 0 : 1) - (b.dr?.memo1 === '前月末在庫' ? 0 : 1));
    const total = dr.reduce((n, l) => n + Number(l.amount), 0);
    return { id: e.journal_id, date: e.journal_date, slipNo: e.slip_no || String(e.journal_id), sourceNo: s.no, status: e.reversal_of ? `逆仕訳（#${e.reversal_of}）` : e.status === 'REVERSED' ? '取消済' : '', pairs, total };
  });
  // NO8: 売掛金計上は締日単位で一括、1伝票に最大45得意先（Q08：R00829→R00830 が45得意先目で分割）。請求締めで同じ伝票番号を振った請求をまとめて1伝票で表示する。
  if (q.pattern === 'A01' && q.group !== 'none') {
    const merged = [], bySlip = new Map();
    for (const s of slips) {
      // 逆仕訳は自分の伝票番号のまま。後で取り消された請求も計上した伝票の一部として残す。
      const key = s.status.startsWith('逆仕訳') ? null : `${s.date}|${s.slipNo}`, m = key && bySlip.get(key);
      if (!m) { const x = { ...s, nos: [s.sourceNo], voided: s.status ? 1 : 0 }; merged.push(x); if (key) bySlip.set(key, x); continue; }
      m.nos.push(s.sourceNo); m.pairs = m.pairs.concat(s.pairs); m.total += s.total; if (s.status) m.voided++;
    }
    for (const m of merged) {
      if (m.nos.length > 1) { m.sourceNo = `${m.nos[0]}〜${m.nos[m.nos.length - 1]}（${m.nos.length}件）`; m.status = m.voided ? `取消済 ${m.voided}件を含む` : ''; }
      delete m.nos; delete m.voided;
    }
    slips.splice(0, slips.length, ...merged);
  }
  // 状態の絞込（2026-11-21）：valid＝取消・逆仕訳を除く（A01 の「取消済 N件を含む」は有効に含める）、void＝取消済、rev＝逆仕訳
  const stOk = { valid: s => !s.status || s.status.endsWith('を含む'), void: s => s.status.startsWith('取消済') && !s.status.endsWith('を含む'), rev: s => s.status.startsWith('逆仕訳') }[q.status];
  if (stOk) slips.splice(0, slips.length, ...slips.filter(stOk));
  const dates = [...new Set(slips.map(s => s.date))].map(date => ({ date, total: slips.filter(s => s.date === date).reduce((n, s) => n + s.total, 0) }));
  return { pattern: q.pattern, ...def, from, to, slips, dates, total: slips.reduce((n, s) => n + s.total, 0) };
}

// 売掛金計上（2026-11-17 ユーザー指示）：締日は毎月20日に固定（前月21日〜当月20日）。画面は「次に会計連携する締日」を出し、［実行］は何度でもできる
// （確認・完了のメッセージは出さない。漏れた伝票があれば押し直す）。実行した締日は売掛金計上自動仕訳リスト（Excel）を出せる（一度も実行していなければ押せない）。
// 会計連携データ（仕訳 → 会計連携データ）を作成すると、期間に入る締日に会計連携済みの印が付き、元に戻せない。売掛金計上は次の締日（翌月20日）に進む（11/20 → 12/20）。
// 一度も会計連携していなければ、業務日付以前で直近の20日（業務日付 11/17 → 10/20、11/20 → 11/20）。A01 の仕訳は従来どおり請求データ作成で起票する（実行では起票しない）
// 対象は締日20日の請求だけでなく、対象期間（前月21日〜当月20日）に計上したすべての売掛金計上（5・10・15・月末締めを含む。2026-11-17 ユーザー指示）
const arRange = month => { const [y, m] = month.split('-').map(Number); return { month, from: new Date(Date.UTC(y, m - 2, 21)).toISOString().slice(0, 10), to: `${month}-20` }; };
const jstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
// 締日の月は画面で選べる（日は20日固定。2026-11-17 ユーザー指示）。month 未指定は次の締日。会計連携済みの月は実行できない
export async function arPostStatus(c, month) {
  const linked = await one(c, 'SELECT month, linked_by, linked_at FROM app_acct_link ORDER BY month DESC LIMIT 1'), bd = isoDate(String(await businessDate(c)).slice(0, 10));
  const next = linked ? addMonths(linked.month, 1) : Number(bd.slice(8)) >= 20 ? bd.slice(0, 7) : addMonths(bd.slice(0, 7), -1);
  const sel = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : next;
  const r = await one(c, 'SELECT run_by, run_at, slips, total FROM app_ar_post_run WHERE month=?', [sel]);
  return { closing: 20, next: arRange(next), sel: { ...arRange(sel), linked: !!linked && sel <= linked.month }, run: r ? { by: r.run_by, at: r.run_at, slips: Number(r.slips), total: Number(r.total) } : null,
    linked: linked ? { ...arRange(linked.month), by: linked.linked_by, at: linked.linked_at } : null };
}
export async function runArPost(c, ctx, b) {
  check(/^\d{4}-(0[1-9]|1[0-2])$/.test(b?.month || ''), '締日の年月を指定してください');
  const st = await arPostStatus(c, b.month), { month, from, to } = st.sel;
  check(!st.sel.linked, `締日 ${to} は会計連携済みのため実行できません。次の締日は ${st.next.to} です`);
  const d = await journalList(c, { pattern: 'A01', from, to }); // 締日20日の請求だけでなく、対象期間（前月21日〜当月20日）の売掛金計上をすべて対象（2026-11-17 ユーザー指示）
  await c.query('INSERT INTO app_ar_post_run (month,run_by,run_at,slips,total) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE run_by=VALUES(run_by),run_at=VALUES(run_at),slips=VALUES(slips),total=VALUES(total)', [month, ctx.user.login_id, jstNow(), d.slips.length, d.total]);
  await audit(c, ctx, 'app_ar_post_run', month, 'arpost.run', { closing: to, slips: d.slips.length, total: d.total });
  return arPostStatus(c, month);
}
// 定時請求計上（2026-11-21 ユーザー指示）：締切日を指定して［実行］。未計上の定時請求に仕訳 D01 を作る（C-2 案 B。登録では作らない。それまでの伝票は登録時に起票済み）。
// 対象は前月の同じ締日の翌日〜締切日（定時請求一覧と同じ）。何度でも実行でき、最後の実行で上書き。会計連携済みの期間の締切日は実行できない。
// 実行した締切日は定時請求自動仕訳リスト（Excel）を出せる。締切日の初期値は売掛金計上と同じ「次に会計連携する締日」
export async function apPostStatus(c, date) {
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : (await arPostStatus(c)).next.to, { from, to } = closingPeriodOfDate(dt);
  const lk = await one(c, "SELECT period FROM app_acct_link WHERE CAST(? AS date) BETWEEN CAST(split_part(period,'..',1) AS date) AND CAST(split_part(period,'..',2) AS date) LIMIT 1", [to]);
  const r = await one(c, 'SELECT run_by, run_at, slips, total FROM app_ap_post_run WHERE closing=?', [to]);
  const pend = await one(c, `SELECT COUNT(*) n, COALESCE(SUM(d.gross_amount),0) amt FROM expense_document d WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? AND NOT ${BOOKED}`, [from, to]);
  return { sel: { date: to, from, to, linked: !!lk }, pending: { count: Number(pend.n), amount: Number(pend.amt) }, run: r ? { by: r.run_by, at: r.run_at, slips: Number(r.slips), total: Number(r.total) } : null };
}
export async function runApPost(c, ctx, b) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(b?.date || ''), '締切日を指定してください');
  const st = await apPostStatus(c, b.date), { from, to } = st.sel;
  check(!st.sel.linked, `締切日 ${to} は会計連携済みのため実行できません`);
  // 2026-11-21 ユーザー指示（C-2 案 B）：期間の未計上の定時請求に仕訳 D01 を作る（登録では作らない）。計上済みの伝票はそのまま
  const todo = await rows(c, `SELECT d.* FROM expense_document d WHERE d.expense_kind='PAYABLE' AND d.status='POSTED' AND d.booked_on BETWEEN ? AND ? AND NOT ${BOOKED} ORDER BY d.booked_on, d.document_no FOR UPDATE`, [from, to]);
  // E-1（2026-11-23 ユーザー指示 A＋C）：1 伝票でも計上できなければ全体を取り消す（全部か無し）。どの伝票で止まったかをメッセージに出す
  for (const x of todo) { try { await assertOpen(c, x.booked_on); await postPayableJournal(c, x); } catch (e) { check(false, `伝票 ${x.document_no} を計上できないため、定時請求計上を中止しました（1 件も計上していません）：${e.message}`); } }
  const d = await journalList(c, { pattern: 'D01', from, to });
  await c.query('INSERT INTO app_ap_post_run (closing,run_by,run_at,slips,total) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE run_by=VALUES(run_by),run_at=VALUES(run_at),slips=VALUES(slips),total=VALUES(total)', [to, ctx.user.login_id, jstNow(), d.slips.length, d.total]);
  await audit(c, ctx, 'app_ap_post_run', to, 'appost.run', { from, to, posted: todo.map(x => x.document_no), slips: d.slips.length, total: d.total });
  return apPostStatus(c, to);
}
// 支払計上（2026-11-24 ユーザー指示：定時請求計上と同じ形）：締切日を指定して［実行］。期間（前月の同じ締日の翌日〜締切日）の支払日の未計上の支払に仕訳 F01 を作る。
// 支払の登録では仕訳を作らない。何度でも実行でき、最後の実行で上書き。会計連携済みの期間の締切日は実行できない。実行した締切日は支払内訳自動仕訳リスト（Excel）を出せる
export async function payPostStatus(c, date) {
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : (await arPostStatus(c)).next.to, { from, to } = closingPeriodOfDate(dt);
  const lk = await one(c, "SELECT period FROM app_acct_link WHERE CAST(? AS date) BETWEEN CAST(split_part(period,'..',1) AS date) AND CAST(split_part(period,'..',2) AS date) LIMIT 1", [to]);
  const r = await one(c, 'SELECT run_by, run_at, slips, total FROM app_pay_post_run WHERE closing=?', [to]);
  const pend = await one(c, `SELECT COUNT(*) n, COALESCE(SUM(p.bank_amount+p.fee_amount+p.offset_amount+COALESCE(p.safety_amount,0)),0) amt FROM payment p WHERE p.status='POSTED' AND p.paid_on BETWEEN ? AND ? AND NOT ${PAY_BOOKED}`, [from, to]);
  return { sel: { date: to, from, to, linked: !!lk }, pending: { count: Number(pend.n), amount: Number(pend.amt) }, run: r ? { by: r.run_by, at: r.run_at, slips: Number(r.slips), total: Number(r.total) } : null };
}
export async function runPayPost(c, ctx, b) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(b?.date || ''), '締切日を指定してください');
  const st = await payPostStatus(c, b.date), { from, to } = st.sel;
  check(!st.sel.linked, `締切日 ${to} は会計連携済みのため実行できません`);
  const todo = await rows(c, `SELECT p.* FROM payment p WHERE p.status='POSTED' AND p.paid_on BETWEEN ? AND ? AND NOT ${PAY_BOOKED} ORDER BY p.paid_on, p.payment_no FOR UPDATE`, [from, to]);
  // 1 件でも計上できなければ全体を取り消す（定時請求計上と同じく全部か無し）
  for (const x of todo) { try { check(x.from_bank, '支払元口座がありません'); await assertOpen(c, x.paid_on); await postPaymentJournal(c, x); } catch (e) { check(false, `支払 ${x.payment_no} を計上できないため、支払計上を中止しました（1 件も計上していません）：${e.message}`); } }
  const d = await journalList(c, { pattern: 'F01', from, to });
  await c.query('INSERT INTO app_pay_post_run (closing,run_by,run_at,slips,total) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE run_by=VALUES(run_by),run_at=VALUES(run_at),slips=VALUES(slips),total=VALUES(total)', [to, ctx.user.login_id, jstNow(), d.slips.length, d.total]);
  await audit(c, ctx, 'app_pay_post_run', to, 'paypost.run', { from, to, posted: todo.map(x => x.payment_no), slips: d.slips.length, total: d.total });
  return payPostStatus(c, to);
}
// 会計連携データを作成したとき：期間に入る締日（毎月20日）に会計連携済みの印を付ける（元に戻さない）
export async function markAcctLinked(c, ctx, from, to) {
  const months = []; for (let m = from.slice(0, 7); `${m}-20` <= to; m = addMonths(m, 1)) if (`${m}-20` >= from) months.push(m);
  for (const m of months) await c.query('INSERT INTO app_acct_link (month,linked_by,linked_at,period) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE linked_by=VALUES(linked_by),linked_at=VALUES(linked_at),period=VALUES(period)', [m, ctx.user.login_id, jstNow(), `${from}..${to}`]);
  return months;
}

export async function bankPaymentList(c, q) {
  const { from, to } = range(q);
  const ps = await rows(c, `SELECT p.*, v.vendor_code, v.vendor_name, b.bank_code, b.branch_code, b.account_type_code, b.account_number, COALESCE(p.safety_amount,0) safety, p.from_bank
    FROM payment p JOIN vendor v ON v.vendor_id=p.vendor_id LEFT JOIN bank_account b ON b.bank_account_id=COALESCE(p.bank_account_id, v.bank_account_id)
    WHERE p.status='POSTED' AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, from_bank, v.vendor_code, p.payment_id`, [from, to]);
  const banks = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BANK'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const dir = Object.fromEntries((await rows(c, "SELECT code_dtl, code_dtl_nam FROM code_m WHERE code_key='BKDIR'")).map(r => [r.code_dtl, r.code_dtl_nam]));
  const days = [];
  for (const p of ps) {
    let d = days.find(x => x.date === p.paid_on); if (!d) days.push(d = { date: p.paid_on, rows: [], total: 0 });
    const bank = Number(p.bank_amount), fee = Number(p.fee_amount), offset = Number(p.offset_amount), safety = Number(p.safety);
    // 同じ業者・同じ支払日・同じ支払元口座の支払は 1 行にまとめる。伝票No. は「最初の支払No 他n」（2026-11-23 内部会議 No.21、ユーザー指示）。全銀も業者ごとに 1 件
    const same = d.rows.find(r => r.vendor === p.vendor_code && r.fromBankCode === (p.from_bank || ''));
    if (same) { same.count++; same.no = `${same.firstNo} 他${same.count - 1}`; same.billed += bank + fee + offset + safety; same.offset += offset; same.safety += safety; same.fee += fee; same.vendorTotal += bank; d.total += bank; continue; }
    d.rows.push({ firstNo: p.payment_no, count: 1, vendor: p.vendor_code, vendorName: p.vendor_name, no: p.payment_no, date: p.paid_on, billed: bank + fee + offset + safety, offset, safety, fee, vendorTotal: bank,
      method: '銀行振込', fromBankCode: p.from_bank || '', fromBank: p.from_bank ? `${p.from_bank} ${banks[p.from_bank] || ''}` : '', payeeBank: p.bank_code ? `${p.bank_code} ${dir[p.bank_code] || ''}`.trim() : '未登録', payeeBranch: p.branch_code ? `${p.branch_code} ${dir[p.bank_code + '-' + p.branch_code] || ''}`.trim() : '' });
    d.total += bank;
  }
  // 現行 HAR321：銀行名・支店名は支払元口座の銀行・支店（BANK → ZGN の銀行・支店コード → 銀行支店名 BKDIR）。2026-11-04
  const zgn = Object.fromEntries((await rows(c, "SELECT code_dtl, category1 bk, category2 bt FROM code_m WHERE code_key='ZGN'")).map(r => [r.code_dtl, r]));
  for (const d of days) for (const r of d.rows) { const z = zgn[r.fromBankCode], br = String(z?.bt || '').slice(0, 3); r.fromBankName = z ? dir[z.bk] || banks[r.fromBankCode] || '' : banks[r.fromBankCode] || ''; r.fromBranchName = z ? dir[`${z.bk}-${br}`] || '' : ''; }
  // 銀行別（支払元口座別）小計
  // 銀行計・日付計は請求金額・相殺金額・安全協力費・手数料と支払方法計（業者計の合計）。支払方法計は銀行内の支払方法ごとに最後の行へ
  const sums = rs => ({ billed: rs.reduce((n, r) => n + r.billed, 0), offset: rs.reduce((n, r) => n + r.offset, 0), safety: rs.reduce((n, r) => n + r.safety, 0), fee: rs.reduce((n, r) => n + r.fee, 0), total: rs.reduce((n, r) => n + r.vendorTotal, 0) });
  for (const d of days) {
    d.banks = [...new Set(d.rows.map(r => r.fromBank))].map(b => { const rs = d.rows.filter(r => r.fromBank === b); rs.sort((x, y) => (x.method < y.method ? -1 : x.method > y.method ? 1 : 0)); return { bank: b, bankName: rs[0]?.fromBankName || '', branchName: rs[0]?.fromBranchName || '', rows: rs, ...sums(rs) }; });
    for (const g of d.banks) g.rows.forEach((r, i) => { const nx = g.rows[i + 1]; r.methodTotal = !nx || nx.method !== r.method ? g.rows.filter(x => x.method === r.method).reduce((n, x) => n + x.vendorTotal, 0) : null; });
    Object.assign(d, { sums: sums(d.rows) });
  }
  return { ...BANK_LIST, from, to, days, total: days.reduce((n, d) => n + d.total, 0) };
}

// ---------- Excel ----------
const H = v => ({ v, s: 'bold' }), S = v => ({ v, s: 'sum' }), T = v => ({ v, s: 'title' });
// 自動仕訳リストの Excel は現行帳票（HAR463 在庫計上・HAR413 入金・HAR363 売掛・HAR152 定時請求・HAR733 小口・CS5785 支払内訳）と同じ2段レイアウト（2026-10-28）。
//   1段目：日付 ／ 借方の部・科目・内訳1・内訳2・処税率・借方金額 ／ 工種CD・摘要1・摘要1（借方）・摘要2（借方）／ 貸方の部・科目・内訳1・内訳2・処税率
//   2段目：伝票No ／ 借方の科目名・内訳1名 ／ 工種CD・摘要1・摘要1（貸方）・摘要2（貸方）／ 貸方の科目名・内訳1名・貸方金額
//   見出しの上下と合計行の上は破線。右端の元伝票・状態は新システムで追加した列。
const JOURNAL_COLS = 18, JOURNAL_WIDTHS = [12, 5, 9, 15, 6, 6, 13, 6, 8, 20, 20, 5, 9, 15, 6, 6, 13, 24];
const yymmdd = d => (d ? `${d.slice(2, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}` : '');
// cells：{列番号: 値}。style を付けると空の列にも同じ書式（破線）を付ける
const jrow = (cells, style) => Array.from({ length: JOURNAL_COLS }, (_, i) => { const v = cells[i] ?? ''; return style ? { v, s: typeof v === 'number' && style === 'dashTop' ? 'dashTopNum' : style } : v; });
export const JOURNAL_HEAD = [
  jrow({ 0: '日付', 1: '部', 2: '科目', 3: '内訳1', 4: '内訳2', 5: '処税率', 6: '借方金額', 7: '工種CD', 8: '摘要1', 9: '摘　要　1　（借　方）', 10: '摘　要　2　（借　方）', 11: '部', 12: '科目', 13: '内訳1', 14: '内訳2', 15: '処税率', 17: '元伝票' }, 'dashTop'),
  jrow({ 0: '伝票No', 1: '科　目　名', 3: '内　訳　1　名', 7: '工種CD', 8: '摘要1', 9: '摘　要　1　（貸　方）', 10: '摘　要　2　（貸　方）', 11: '科　目　名', 13: '内　訳　1　名', 16: '貸方金額', 17: '状態' }, 'dashBottom')];
const pairRows = (p, first, s, end = true) => {
  const dr = p.dr || {}, cr = p.cr || {}, amt = x => (x.account ? x.amount : '');
  // 2026-11-17 ユーザー指示：日付・伝票No の列は横の点線なし（xlsx の jCol0）。2026-11-18 ユーザー指示：実線は科目ごとではなく借方・貸方の 1 組（貸借が一致したところ）の下だけ（jEnd）
  const r1 = jrow({ 0: first ? yymmdd(s.date) : '', 1: dr.dept, 2: dr.account, 3: dr.sub, 4: dr.sub2, 5: dr.tax, 6: amt(dr), 8: dr.memo1Code, 9: dr.memo1, 10: dr.memo2, 11: cr.dept, 12: cr.account, 13: cr.sub, 14: cr.sub2, 15: cr.tax, 17: first ? s.sourceNo : '' }),
    r2 = jrow({ 0: first ? s.slipNo : '', 1: dr.accountName, 3: dr.subName, 8: cr.memo1Code, 9: cr.memo1, 10: cr.memo2, 11: cr.accountName, 13: cr.subName, 16: amt(cr), 17: first ? s.status : '' });
  r1[0] = { v: r1[0], s: first ? 'jCol0D' : 'jCol0' }; r2[0] = { v: r2[0], s: 'jCol0' };   // 日付と伝票No の間は点線（2026-11-21 ユーザー指示）
  if (end) for (let i = 1; i < r2.length; i++) r2[i] = { v: r2[i], s: 'jEnd' };
  return [r1, r2];
};
// 伝票合計・日付合計の行（2026-11-21 ユーザー様式「定時請求自動仕訳リスト_2026-10-21_2026-11-20 (3).xlsx」）：上下は実線、縦線は 借方金額・摘要1（借方）の右・貸方金額・元伝票の区切りだけ。
// 伝票合計は日付・伝票No の列を伝票の明細から続けて（上の線なし）、その右に縦線。日付合計は日付の列から続けて 1 つの枠
const TOTAL_V = [5, 6, 9, 15, 16, 17];
const totalRow = (label, amount, slip = false) => jrow({ 9: label, 6: amount, 16: amount }).map((v, j) => {
  const V = new Set(slip ? [0, ...TOTAL_V] : TOTAL_V), mask = (j === 0 || V.has(j - 1) ? 8 : 0) + (V.has(j) ? 4 : 0) + (slip && j === 0 ? 0 : 2) + 1;
  return { v, s: `jEdge${mask}` };
});
export async function journalListBook(c, q) {
  const d = await journalList(c, q), now = new Date(Date.now() + 9 * 36e5).toISOString();
  const out = [jrow({ 0: `出力 ${yymmdd(now.slice(0, 10))} ${now.slice(11, 19)}`, 7: T(d.title) }), [d.pattern === 'A01' && d.to.endsWith('-20') && d.from === arRange(d.to.slice(0, 7)).from ? `締日 ${d.to}` : d.pattern === 'B01' ? '' : `期間 ${d.from} 〜 ${d.to}`], [], ...JOURNAL_HEAD];   // 売掛金計上は締日のみ・入金は期間を出さない（対象期間の表示は 2026-11-18 ユーザー指示で削除）
  let lastDate = null;
  for (const s of d.slips) {
    if (lastDate && s.date !== lastDate) out.push(totalRow('日　付　合　計', d.dates.find(x => x.date === lastDate).total));
    lastDate = s.date;
    // 売掛金計上（A01）は元伝票（C202600001〜C202600045（45件）など）を出さない（2026-11-17 ユーザー指示）
    // 借方・貸方の 1 組の終わり＝その伝票の中で借方の累計と貸方の累計が一致した行（最後の行は必ず終わり）
    let dr = 0, cr = 0;
    s.pairs.forEach((p, i) => { dr += p.dr?.account ? Number(p.dr.amount) || 0 : 0; cr += p.cr?.account ? Number(p.cr.amount) || 0 : 0;
      out.push(...pairRows(p, !i, d.pattern === 'A01' ? { ...s, sourceNo: '' } : s, i === s.pairs.length - 1 || (dr === cr && dr !== 0))); });
    out.push(totalRow('伝　票　合　計', s.total, true));
  }
  if (lastDate) out.push(totalRow('日　付　合　計', d.dates.find(x => x.date === lastDate).total));
  // 現行の自動仕訳リスト（HAR363・HAR413・HAR152・HAR733・CS5785）には総合計の行が無い（2026-11-04）
  if (!d.slips.length) out.push(['対象期間の仕訳はありません']);
  return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title.slice(0, 28), rows: out, widths: JOURNAL_WIDTHS, printTitles: '4:5', header: `&L${d.title}&R&P 頁` }]) };
}
// 現行 HAR321 の並び（2026-11-04）：ｺｰﾄﾞ 業者名 伝票No. 日付 請求金額 相殺金額 安全協力費 手数料 業者計 支払方法計 支払方法 銀行名 支店名（銀行・支店は支払元）。
const BANKPAY_W = [9, 26, 9, 10, 13, 11, 11, 10, 13, 13, 11, 16, 14];
// 1 ページの明細・合計の行数：A4 横・上下余白 0.6in の 509pt から見出し（約 82pt）を引き、行 15pt（縮小なしで数えるので縮小されても必ず入る）
const BANKPAY_ROWS = 28;
// 支払日ごとに「YY 年 M 月 D 日支払」、銀行ごとに銀行計、支払日ごとに日付計（金額 4 列と支払方法計）
// 2026-11-24 ユーザー指示：支払日ごとに改ページ（11/24 No.28「支払日ごとに 1 枚」）。各ページに表題。左上に帳票ID・出力日時、右上に会社名・頁（頁はページの右上。フッターの頁は出さない）。
// 「yy 年 mm 月 dd 日支払」は支払方法の列の上（右寄り）。いずれも現行 HAR321 どおり
export async function bankPaymentBook(c, q) {
  const d = await bankPaymentList(c, q), yy = x => `${x.slice(2, 4)}/${x.slice(5, 7)}/${x.slice(8, 10)}`;
  const head = ['ｺｰﾄﾞ', '業　者　名', '伝票No.', '日付', '請求金額', '相殺金額', '安全協力費', '手数料', '業者計', '支払方法計', '支払方法', '銀　行　名', '支　店　名'].map(H);
  const sum = (x, label, bank, branch) => ['', '', '', '', S(x.billed), S(x.offset), S(x.safety), S(x.fee), '', S(x.total), S(label), bank === undefined ? '' : S(bank), branch === undefined ? '' : S(branch)];
  const co = await one(c, 'SELECT company_name1 FROM company_info_m ORDER BY company_info_id LIMIT 1');
  const W = BANKPAY_W.length, top = Array.from({ length: W }, (_, j) => (j === 0 ? `HAR321　出力日時 ${today()} ${new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 19)}`   /* yy/mm/dd hh:mm:ss（現行どおり。2026-11-25 ユーザー指示） */ : j === W - 1 ? { v: co?.company_name1 || '', s: 'tInfo' } : ''));
  const sheets = d.days.map(day => {
    const [y, m, dd] = day.date.split('-'), label = Array.from({ length: W }, (_, j) => (j === 10 ? { v: `${y.slice(2)} 年 ${m} 月 ${dd} 日支払`, s: 'tInfo' } : ''));
    const body = [];
    for (const g of day.banks) { for (const r of g.rows) body.push([r.vendor, r.vendorName, r.no, yy(r.date), r.billed, r.offset, r.safety, r.fee, r.vendorTotal, r.methodTotal ?? '', r.method, r.fromBankName, r.fromBranchName]); body.push(sum(g, '銀　行　計', g.bankName, g.branchName)); }
    body.push(sum(day.sums, '日　付　計'));
    // 1 つの支払日が 1 ページに入らないときは BANKPAY_ROWS 行ごとに改ページし、続きのページにも同じ見出し（帳票ID・出力日時・会社名・頁・題名・支払日・列見出し）を出す
    const pages = []; for (let i = 0; i < body.length; i += BANKPAY_ROWS) pages.push(body.slice(i, i + BANKPAY_ROWS));
    return pages.map(rs => ({ name: d.title, rows: [top, [T(d.title)], label, head, ...rs], widths: BANKPAY_W, pageTop: true }));   // 期間は出さない（2026-11-19 ユーザー指示）
  }).flat();
  if (!sheets.length) sheets.push({ name: d.title, rows: [top, [T(d.title)], [`期間 ${d.from} 〜 ${d.to}`], [], ['対象期間の支払はありません']], widths: BANKPAY_W, pageTop: true });
  return { name: `${d.title}_${d.from}_${d.to}.xlsx`, body: xlsx([{ name: d.title, stack: sheets, pageBreak: true }]) };
}
