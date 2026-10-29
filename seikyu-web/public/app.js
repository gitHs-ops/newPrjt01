// APLink 請求・入金管理 — single page client. All data comes from the PostgreSQL-backed API.
import { installKb } from './kb.js';
const $ =(s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = v => new Intl.NumberFormat('ja-JP').format(Number(v) || 0);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const thisMonth = () => today().slice(0, 7);
// DB timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS[.ffffff]"); screens show Japan time.
const jst = (v, len = 19) => { if (!v) return ''; const d = new Date(String(v).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z'); return isNaN(d) ? String(v) : new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, len); };
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
let session, meta, masters = {}, actions = {}, route = { name: 'dashboard', q: {} }, renderSeq = 0;
const canWrite = () => [1, 2, 3, 4].includes(session?.user.role), isAdmin = () => session?.user.role === 1;

// ---------- API ----------
// DB の読込は検索系のボタン（検索・タブ切替など）と登録・更新の後だけ（2026-10-23）。画面の描画中の GET は apiMode で切り替える：
//  lazy … メニュー・小メニューで開いたとき。読込済みの結果（apiCache）を使い、無ければサーバーに「空の画面」（X-Empty-View：DB を読まず0件）を頼む
//  fresh … DB から読み、結果を apiCache に入れる。登録・更新（GET 以外）の後はキャッシュを捨て、次の描画で読み直す
const apiCache = new Map(), LAZY_FETCH = /^\/api\/(business-date|petty\/settings|kb\/meta|kb\/bugyo|coverage|periods)(\?|$)/;
let apiMode = null, apiDirty = false, emptyShown = false;
const fetchJson = async (url, opt) => {
  const res = await fetch(url, { cache: 'no-store', ...opt });
  if (res.status === 401) { location.replace('/login' + location.hash); throw Error('ログインしてください'); }
  return [res, await res.json().catch(() => ({}))];
};
async function api(url, { method = 'GET', body } = {}) {
  if (method === 'GET' && apiMode === 'lazy' && !LAZY_FETCH.test(url)) {
    if (apiCache.has(url)) return structuredClone(apiCache.get(url));
    const mk = url.match(/^\/api\/masters\/(\w+)$/); if (mk && masters[mk[1]]) return structuredClone(masters[mk[1]]);
    const [res, data] = await fetchJson(url, { headers: { 'X-Empty-View': '1' } });
    if (res.ok) { emptyShown = true; return data; } // 形だけ作れない画面は下で通常どおり読む
  }
  const read = method === 'GET' && apiMode !== 'lazy'; if (read) busy(true, 'データを読み込み中…');
  try {
    const [res, data] = await fetchJson(url, { method, headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (method !== 'GET') { apiCache.clear(); apiDirty = true; }
    if (!res.ok) throw Error(data.error || `処理に失敗しました (${res.status})`);
    if (method === 'GET' && apiMode === 'fresh') { apiCache.delete(url); apiCache.set(url, structuredClone(data)); if (apiCache.size > 80) apiCache.delete(apiCache.keys().next().value); }
    return data;
  } finally { if (read) busy(false); }
}
// 登録・作成など時間のかかる POST は 0.4 秒を超えたら画面上部に「処理中…」を表示（全画面共通）
let busyCount = 0, busyTimer = null;
const busy = (on, label = '処理中…', now = false) => {
  const b = $('#busy-bar'); if (!b) return;
  if (on) { const l = $('#busy-label'); if (l && busyCount === 0) l.textContent = label; }
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (busyCount && !busyTimer && !(b.showPopover && b.matches(':popover-open'))) busyTimer = setTimeout(() => { busyTimer = null; if (busyCount && !$('#progress-dialog')?.open) { try { b.showPopover ? b.showPopover() : (b.style.display = 'flex'); } catch {} } }, now ? 0 : 400);
  if (!busyCount) { clearTimeout(busyTimer); busyTimer = null; try { b.showPopover ? b.hidePopover() : (b.style.display = 'none'); } catch {} }
};
const post = async (url, body) => { busy(true); try { return await api(url, { method: 'POST', body }); } finally { busy(false); } };
// 進捗ダイアログ（件数のわかる一括処理）：progress.open(題名, 件数) → progress.step(完了数, 処理中の名称) → progress.close()
const progress = {
  open(title, total) { const d = $('#progress-dialog'); $('#progress-title').textContent = title; this.total = total; this.step(0, ''); if (!d.open) d.showModal(); },
  step(done, label) { const pct = this.total ? Math.round(done * 100 / this.total) : 0; $('#progress-fill').style.width = pct + '%'; $('#progress-count').textContent = `${pct}%`; /* 件数は出さない（2026-10-29） */ $('#progress-label').textContent = label || ''; },
  close() { const d = $('#progress-dialog'); if (d.open) d.close(); },
};
$('#progress-dialog')?.addEventListener('cancel', e => e.preventDefault()); // 処理中は Esc で閉じない
async function loadMasters() { masters = await api('/api/masters'); }
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();

// ---------- UI helpers ----------
// 全画面共通のポップアップ通知。popover（最前面レイヤー）で出すので、開いているダイアログの上にも表示される。エラーは画面上部中央・赤・長めに表示、クリックで閉じる
// エラーは小さな確認ポップアップ（「確認」で閉じる。右上の×・Esc でも閉じる）。開いている入力ダイアログの上に重ねて表示し、入力内容は残す
document.addEventListener('click', e => { if (e.target.closest('#alert-ok, #alert-x')) $('#alert-dialog').close(); });
// 一覧ヘッダの「すべて選択」（data-pick-all＝行のチェックボックスのクラス）。行を個別に切り替えたらヘッダも合わせる
document.addEventListener('change', e => {
  const all = e.target.dataset?.pickAll; if (all) return $$('.' + all).forEach(x => { x.checked = e.target.checked; });
  const h = [...e.target.classList].map(k => $(`[data-pick-all="${k}"]`)).find(Boolean); if (h) { const xs = $$('.' + h.dataset.pickAll); h.checked = xs.every(x => x.checked); h.indeterminate = !h.checked && xs.some(x => x.checked); }
});
// ok: true で完了報告（緑の ✓・見出し title）。既定はエラー（赤の !・「確認してください」）
function alertBox(msg, { ok = false, title } = {}) {
  const d = $('#alert-dialog');
  if (!d?.showModal) return window.alert(msg);
  d.classList.toggle('ok', ok); $('#alert-title').textContent = title || (ok ? '完了しました' : '確認してください'); d.querySelector('.alert-icon').textContent = ok ? '✓' : '!';
  $('#alert-msg').textContent = msg;
  if (!d.open) d.showModal();
  $('#alert-ok').focus();
}
function toast(msg, error = false) {
  if (error) return alertBox(msg);
  const t = $('#toast'), top = !!t.showPopover;
  t.innerHTML = `${error ? '<b class="toast-icon">⚠</b>' : '<b class="toast-icon">✓</b>'}<span>${esc(msg)}</span>`; t.className = error ? 'error' : '';
  if (top) { try { t.hidePopover(); } catch {} t.showPopover(); } else t.style.display = 'flex';
  clearTimeout(toast.t); toast.t = setTimeout(() => (top ? t.hidePopover() : (t.style.display = 'none')), error ? 8000 : 4000);
  t.onclick = () => { clearTimeout(toast.t); top ? t.hidePopover() : (t.style.display = 'none'); };
}
const badge = (label, cls = '') => `<span class="badge ${cls}">${esc(label)}</span>`;
const STATUS = { draft: ['未発行', 'gray'], issued: ['発行済', ''], partial: ['一部入金', 'amber'], credit: ['クレジット', 'amber'], paid: ['入金済', 'green'], POSTED: ['計上済', 'green'], REVERSED: ['取消済', 'gray'], DRAFT: ['下書き', 'gray'] };
const status = s => badge(...(STATUS[s] || [s, 'gray']));
const nameOf = (kind, code) => masters[kind]?.find(r => r.code === code)?.name || code || '';
const active = kind => (masters[kind] || []).filter(r => r.active);
const options = (list, value, { blank, label = r => `${r.code} ${r.name}`, val = r => r.code } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') + list.map(r => `<option value="${esc(val(r))}" ${String(val(r)) === String(value ?? '') ? 'selected' : ''}>${esc(label(r))}</option>`).join('');
const siteOptions = (customer, value, blank) => options((masters.sites || []).filter(s => s.customer === customer && (s.active || `${s.code}|${s.suffix}` === value)), value, { blank, val: s => `${s.code}|${s.suffix}`, label: s => `${s.code}-${s.suffix} ${s.name}` });
function table(cols, rows, { empty = 'データがありません', foot, rowClass } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.head ?? esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="${rowClass ? rowClass(r) : ''}">${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(c.value(r))}</td>`).join('')}</tr>`).join('')}</tbody>${foot ? `<tfoot><tr>${foot.map(f => `<td class="num">${f ?? ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}
const field = (label, input, { req, hint, wide } = {}) => `<label class="field ${req ? 'req' : ''} ${wide ? 'wide' : ''}"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
const monthInput = (name, value) => `<input type="month" name="${name}" value="${esc(value)}" data-filter>`;
const filterSelect = (name, list, value, blank) => `<select name="${name}" data-filter>${options(list, value, { blank })}</select>`;
// 入力した文字の部分一致で候補を出す検索条件（コード・名称のどちらでも）。「検索」でコードに直す（comboCode）。2026-10-27
const comboFilter = (name, kind, value, placeholder, id = '') => { const x = (masters[kind] || []).find(r => r.code === value);
  return `<input name="${name}" ${id ? `id="${id}"` : ''} list="dl-f${name}" data-combo="${kind}" data-filter value="${esc(x ? `${x.code} ${x.name}` : value || '')}" placeholder="${esc(placeholder)}" title="${esc(placeholder)}" autocomplete="off" style="width:220px">
    <datalist id="dl-f${name}">${(masters[kind] || []).filter(r => r.active !== false).map(r => `<option value="${esc(`${r.code} ${r.name}`)}"></option>`).join('')}</datalist>`; };
// 部分一致で検索する得意先の入力欄（サーバーがコード・名称の部分一致で探す）の候補：値＝コード、表示＝名称
const custHints = () => `<datalist id="dl-pcust">${active('customers').map(x => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('')}</datalist>`;
const comboCode = el => { const t = el.value.trim(), list = masters[el.dataset.combo] || []; if (!t) return '';
  const hit = list.find(r => r.code === t || `${r.code} ${r.name}` === t), part = hit ? [hit] : list.filter(r => r.code.includes(t) || (r.name || '').includes(t));
  if (part.length === 1) return part[0].code;
  toast(`${el.title}「${t}」は${part.length ? `${part.length}件該当します。候補から選んでください` : '該当がありません'}`, true); el.focus(); return null; };
const page = (title, sub, actionsHtml, body) => `<div class="page"><div class="page-head"><div><h1>${esc(title)}</h1></div><div class="filters">${actionsHtml || ''}</div></div>${body}</div>`;
const csvLink = (kind, q = {}) => `<a class="button" href="/api/export/${kind}?${qs(q)}" download>⇩ CSV</a>`;

// Modal with top-right X and bottom close/cancel button. onSubmit returns truthy to close.
// sample：新規の入力画面に「サンプル入力」アイコンを付け、空欄に見本の値を入れる（関数なら汎用の入力の後に呼ぶ。画面独自のサンプル入力がある画面は sampleButton を直接置く）
function modal({ title, body, submit, onSubmit, wide = false, onOpen, danger = false, sample = false }) {
  const d = $('#dialog'), form = $('#modal-form');
  d.classList.toggle('wide', wide); $('#modal-title').textContent = title; $('#modal-body').innerHTML = (sample ? sampleButton : '') + body + '<p class="form-error" id="form-error"></p>';
  $('#modal-foot').innerHTML = `<button type="button" id="modal-cancel">${submit ? 'キャンセル' : '閉じる'}</button>${submit ? `<button type="submit" class="${danger ? 'danger' : 'primary'}" id="modal-submit">${esc(submit)}</button>` : ''}`;
  const close = () => { d.close(); form.onsubmit = null; };
  $('#modal-cancel').onclick = close; $('#modal-x').onclick = close;
  form.onsubmit = async e => {
    e.preventDefault(); if (!onSubmit) return close();
    const btn = $('#modal-submit'); btn.disabled = true; $('#form-error').textContent = '';
    try { if ((await onSubmit(Object.fromEntries(new FormData(form)), form)) !== false) close(); }
    catch (err) { $('#form-error').textContent = err.message; toast(err.message, true); }
    finally { btn.disabled = false; }
  };
  d.showModal(); onOpen?.(form);
  if (sample) form.querySelector('[data-sample]')?.addEventListener('click', () => { fillSampleForm(form); if (typeof sample === 'function') sample(form); });
}
// 汎用のサンプル入力：空欄だけを埋める（入力済み・0 の金額・パスワード・ファイル・チェックは変えない）。明細の表は先頭行だけ
function fillSampleForm(f) {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  for (const el of f.elements) {
    if (!el.name || el.disabled || el.readOnly || ['hidden', 'password', 'file', 'checkbox', 'radio'].includes(el.type) || (el._combo || el).offsetParent === null) continue;
    const tr = el.closest('tbody tr'); if (tr && tr !== tr.parentElement.firstElementChild) continue;
    const label = el.closest('label')?.querySelector('span')?.textContent || el.closest('td')?.dataset.label || '', key = `${el.name} ${label}`.toLowerCase(), max = el.maxLength > 0 ? el.maxLength : 20;
    if (el.tagName === 'SELECT') { if (el.value) continue; const o = [...el.options].filter(x => x.value); if (!o.length) continue; el.value = o[rnd(0, o.length - 1)].value; }
    else if (el.value) continue;
    else if ((el.dataset.fp || el.type) === 'date') el._flatpickr ? el._flatpickr.setDate(today(), true) : (el.value = today()); // カレンダー（datepick.js）に置き換えた入力も
    else if ((el.dataset.fp || el.type) === 'month') el._flatpickr ? el._flatpickr.setDate(thisMonth(), true) : (el.value = thisMonth());
    else if ((el.dataset.fp || el.type) === 'time') continue;
    else if (/税率/.test(key)) el.value = [8, 10][rnd(0, 1)];
    else if (/率|ratio/.test(key)) el.value = rnd(1, 50);
    else if (/表示順|seq|sort/.test(key)) el.value = rnd(1, 99);
    else if (el.type === 'number' || el.classList.contains('num')) {
      const range = (el.closest('label')?.querySelector('small')?.textContent || '').match(/(\d+)\s*[〜~～]\s*(\d+)/); // 入力欄の補足「1〜31」などの範囲
      el.value = range ? rnd(+range[1], +range[2]) : /数量|quantity|qty/.test(key) ? rnd(1, 20) : /単価|price/.test(key) ? rnd(10, 300) * 10 : Math.min(rnd(1, 99) * 1000, 10 ** max - 1);
    }
    else if (el.tagName === 'TEXTAREA') el.value = 'サンプル入力';
    else if (/(\d+)桁/.test(label)) { const n = +label.match(/(\d+)桁/)[1]; el.value = String(rnd(1, 10 ** n - 1)).padStart(n, '0'); } // 「銀行(4桁)」など
    else if (/kana|カナ/.test(key)) el.value = 'サンプル'.slice(0, max);
    else if (/tel|fax|電話/.test(key)) el.value = `052-000-${rnd(1000, 9999)}`.slice(0, max);
    else if (/post|郵便/.test(key)) el.value = '4600000'.slice(0, max);
    else if (/mail/.test(key)) el.value = 'sample@example.com'.slice(0, max);
    else if (/code|コード|番号|枝番|suffix/.test(key)) el.value = String(rnd(1, 10 ** Math.min(max, 4) - 1)).padStart(Math.min(max, 4), '0');
    else el.value = `サンプル${rnd(10, 99)}`.slice(0, max);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  toast('サンプルの値を入れました（登録はまだです）');
}
const confirmBox = (title, message, run, label = '実行') => modal({ title, body: `<p>${esc(message)}</p>`, submit: label, danger: true, onSubmit: async () => { await run(); } });
async function act(fn, msg) { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await render(); return r; } catch (e) { toast(e.message, true); } }

// ---------- マスタの選択リスト：直接入力もできるコンボ（2026-10-29） ----------
// マスタ由来の <select> の前に入力欄（datalist で候補）を置き、select は隠して値・change イベントをそのまま使う。
// コード（例 V002）・「コード 名称」・名称の一部（候補が1件）で決まる。フォーカスすると全候補を出す（入力済みの値は placeholder に退避）
const COMBO_SELECT = ['customer', 'otherCustomer', 'vendor', 'item', 'product', 'material', 'account', 'sub', 'dept', 'site', 'sitePick', 'operator', 'bankCode', 'payBank', 'invoiceBank', 'deliveryKbn', 'weather', 'unit', 'taxCode']
  .map(n => `select[name="${n}"]`).concat('select[data-pick]', '#pi-dept', '#pr-bank').join(',');
const SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'), SELECT_INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
let comboSeq = 0;
function comboize(sel) {
  if (sel._combo || sel.multiple) return;
  const id = `cmb-${++comboSeq}`, inp = document.createElement('input'), dl = document.createElement('datalist');
  inp.type = 'text'; inp.className = 'combo-input'; inp.autocomplete = 'off'; inp.setAttribute('list', id); inp.dataset.for = sel.name || sel.id; dl.id = id;
  if (sel.title) inp.title = sel.title; if (sel.getAttribute('style')) inp.setAttribute('style', sel.getAttribute('style')); if (sel.getAttribute('aria-label')) inp.setAttribute('aria-label', sel.getAttribute('aria-label'));
  // 欄の幅：.field・帳票入力欄の中は 100%（CSS）、それ以外（表の行・検索条件）は select の表示幅
  const w = sel.getBoundingClientRect().width; if (w && !sel.closest('.field, .sv') && !sel.style.width) inp.style.width = Math.max(w, 90) + 'px';
  if (sel.required) { inp.required = true; sel.required = false; }
  sel._combo = inp; sel.classList.add('combo-select'); sel.before(inp, dl);
  const opts = () => [...sel.options], text = o => o.textContent.trim(), cur = () => sel.options[SELECT_INDEX.get.call(sel)];
  const sync = () => { const o = cur(); inp.value = o && o.value !== '' ? text(o) : ''; inp.placeholder = o && o.value === '' ? text(o) : ''; inp.disabled = sel.disabled; inp.classList.remove('combo-ng'); };
  const build = () => { dl.innerHTML = opts().map(o => `<option value="${esc(text(o))}"></option>`).join(''); sync(); };
  const find = t => { t = t.trim(); const os = opts(), lt = t.toLowerCase(); if (!t) return os.find(o => o.value === '') || null;
    const hit = os.find(o => text(o) === t) || os.find(o => o.value === t) || os.find(o => o.value !== '' && text(o).startsWith(t + ' ')); if (hit) return hit;
    const part = os.filter(o => o.value !== '' && text(o).toLowerCase().includes(lt)); return part.length === 1 ? part[0] : null; };
  const pick = (o, final) => {
    if (!o) { if (!final) return; const blank = opts().find(x => x.value === '');
      if (blank && SELECT_VALUE.get.call(sel) !== '') { SELECT_VALUE.set.call(sel, ''); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      inp.classList.add('combo-ng'); if (!blank) { sync(); toast('候補にありません。一覧から選んでください', true); } return; }
    const changed = SELECT_VALUE.get.call(sel) !== o.value; SELECT_VALUE.set.call(sel, o.value); if (final) sync();
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  Object.defineProperty(sel, 'value', { configurable: true, get() { return SELECT_VALUE.get.call(this); }, set(v) { SELECT_VALUE.set.call(this, v); sync(); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return SELECT_INDEX.get.call(this); }, set(v) { SELECT_INDEX.set.call(this, v); sync(); } });
  sel.addEventListener('change', () => { if (document.activeElement !== inp) sync(); });
  new MutationObserver(build).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  // 候補を選んだ（全文一致）ときはすぐ反映。入力途中はフォーカスを外したとき（Tab・Enter で次の項目へ）に確定
  inp.addEventListener('input', () => { inp.classList.remove('combo-ng'); const t = inp.value.trim(), o = opts().find(x => text(x) === t); if (o) pick(o, false); });
  inp.addEventListener('focus', () => { if (inp.value) { inp.placeholder = inp.value; inp.value = ''; } });
  inp.addEventListener('blur', () => { if (!inp.value && inp.placeholder && cur()?.value !== '') return sync(); pick(find(inp.value), true); });
  build();
}
const comboizeIn = root => { if (root.matches?.(COMBO_SELECT)) comboize(root); root.querySelectorAll?.(COMBO_SELECT).forEach(comboize); };
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) comboizeIn(n); }).observe(document.documentElement, { childList: true, subtree: true });

// ---------- navigation ----------
// 小メニュー（サイドバー）：#画面/小メニュー で直接開ける。q＝従来のタブ等の条件、tools＝上部の検索・登録ボタンを出すか（既定は先頭と q 付きのみ）
const SUBMENUS = {
  // 出荷予定・納品書発行は機能一覧の範囲外（推定実装）のため小メニューを無効表示（納品書発行は 2026-10-24）（2026-10-23、要否は大西さんに確認。画面・API は残す）
  shipments: [{ k: 'slips', l: '出荷伝票一覧' }, // 10/27 打合せ：画面の題名を「出荷伝票一覧」に
    { k: 'plans', l: '出荷予定', q: { tab: 'plans' }, disabled: true }, { k: 'notes', l: '納品書発行', disabled: true }, { k: 'reports', l: '出荷・売上帳票' }],
  // 発行前確認一覧は 2026-10-25 非表示 → 2026-10-27 再表示（確認事項 F）→ 2026-10-27 再び非表示（画面・API は残す）
  // 請求書発行は 2026-10-27 に請求一覧照会から分けた（10/26 打合せ・提案書 P13。照会は確認と発行確認表の出力だけ）
  invoices: [{ k: 'precheck', l: '発行前確認一覧', q: { view: 'precheck' }, hidden: true }, { k: 'create', l: '請求データ作成', tools: false }, { k: 'list', l: '請求一覧照会', tools: true }, { k: 'issue', l: '請求書発行', q: { view: 'issue' } }, { k: 'reports', l: '請求帳票' }, { k: 'balance', l: '得意先別残高照会', q: { view: 'balance' } }, { k: 'ledger', l: '請求残高照会', q: { view: 'ledger' } }],
  // 入金予定一覧は 2026-10-27 削除（機能一覧 NO16 対象外。入金予定は入金予定チェックリストで確認）
  // 入金一覧・入金予定チェックリストは 2026-10-27 非表示（10/27 打合せ：消込の結果は入金消込の一覧で確認、入金予定チェックリストは不要。画面・API は残す）
  receipts: [{ k: 'targets', l: '入金消込', q: { tab: 'targets' } }, { k: 'list', l: '入金一覧', tools: true, hidden: true }, { k: 'schedule', l: '入金予定チェックリスト', hidden: true }],
  // 10/21 打合せの処理順（実在庫登録 → 配合計算 → 材料受払表 → 在庫計上）に並べる
  inventory: [{ k: 'count', l: '実在庫登録', tools: false }, { k: 'reports', l: '在庫登録リスト・配合計算・材料受払表' }, { k: 'post', l: '在庫計上', tools: false }, { k: 'list', l: '在庫一覧', tools: true }],
  purchases: [{ k: 'list', l: '商品仕入一覧・登録' }, { k: 'reports', l: '商品仕入登録リスト' }], // 2026-10-29 帳票を小メニューに分けた
  payables: [{ k: 'list', l: '定時請求一覧・入力' }, { k: 'reports', l: '定時請求入力明細表' }],
  cash: [{ k: 'list', l: '小口現金一覧・登録' }, { k: 'book', l: '出納簿・定額資金・現金補充' }],
  payments: [{ k: 'list', l: '支払一覧・登録' }, { k: 'reports', l: '支払帳票・全銀データ' }, { k: 'transfer', l: '振込先一覧' }, { k: 'bank', l: '銀行別随時支払一覧表' }],
  journals: [{ k: 'list', l: '仕訳一覧' }, { k: 'tb', l: '月次残高試算', q: { tab: 'tb' } }, { k: 'lists', l: '自動仕訳リスト（帳票）', q: { tab: 'lists' } }, { k: 'export', l: '会計連携データ' }],
  reports: [{ k: 'csv', l: 'CSV出力', tools: true }, { k: 'ar', l: '売掛金残高一覧' }, { k: 'ap', l: '未払残高一覧' }, { k: 'jv', l: '出資金（JV）帳票' }],
};
const subsOf = name => (name === 'masters' && meta?.masters ? Object.entries(meta.masters).map(([k, x]) => ({ k, l: x.label, q: { kind: k } })) : SUBMENUS[name] || null);
const TITLES = {};
// 非表示にするメニュー（2026-10-22 ダッシュボードは使わない）。初期画面は表示メニューの先頭
const HIDDEN_MENUS = new Set(['dashboard']);
// サイドバー最下部に固定表示するメニュー（表示名）と、クリックで開閉するグループ（アイコン）
const PINNED_MENUS = { migration: '前提・確認事項' };
const FOLD_GROUPS = { '財務会計': '¥' };
const foldOpen = new Set((() => { try { return JSON.parse(localStorage.getItem('navFold') || '[]'); } catch { return []; } })());
const home = () => Object.keys(TITLES).find(k => !PINNED_MENUS[k]) || 'shipments';
function nav() {
  const list = session.menus.filter(m => !HIDDEN_MENUS.has(m.url.slice(1))), groups = [];
  const link = m => `<a class="nav-link" href="${esc(m.url)}" data-nav="${esc(m.url.slice(1))}"><i>${esc(m.icon)}</i>${esc(m.title)}${subsOf(m.url.slice(1)) ? '<b class="nav-caret">▸</b>' : ''}</a>`;
  for (const m of list) {
    const k = m.url.slice(1); TITLES[k] = m.title; if (PINNED_MENUS[k]) continue;
    let g = groups[groups.length - 1]; if (!g || g.name !== m.grp) groups.push(g = { name: m.grp, items: [] }); g.items.push(m);
  }
  $('#navigation').innerHTML = groups.map(g => FOLD_GROUPS[g.name]
    ? `<button type="button" class="nav-link nav-fold" data-fold="${esc(g.name)}"><i>${esc(FOLD_GROUPS[g.name])}</i>${esc(g.name)}<b class="nav-caret">▸</b></button><div class="nav-fold-body" data-fold-body="${esc(g.name)}" hidden>${g.items.map(link).join('')}</div>`
    : `<div class="nav-group">${esc(g.name)}</div>${g.items.map(link).join('')}`).join('');
  const pin = $('#nav-pin'); if (pin) pin.innerHTML = list.filter(m => PINNED_MENUS[m.url.slice(1)]).map(m => `<a class="nav-link nav-pin" href="${esc(m.url)}" data-nav="${esc(m.url.slice(1))}"><i>${esc(m.icon)}</i>${esc(PINNED_MENUS[m.url.slice(1)])}</a>`).join('');
  const brand = $('.brand'); if (brand) brand.href = '#' + home();
}
// 開閉グループ：開いている画面がグループ内なら開く。それ以外は利用者の開閉を記憶
function navFolds() {
  $$('.nav-fold').forEach(b => {
    const name = b.dataset.fold, body = $(`.nav-fold-body[data-fold-body="${CSS.escape(name)}"]`), hasActive = !!body?.querySelector(`.nav-link[data-nav="${route.name}"]`);
    const open = foldOpen.has(name) || hasActive; if (body) body.hidden = !open; b.classList.toggle('open', open); b.classList.toggle('has-active', hasActive);
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('.nav-fold'); if (!b) return;
  const name = b.dataset.fold, body = $(`.nav-fold-body[data-fold-body="${CSS.escape(name)}"]`), opening = body?.hidden;
  if (opening) foldOpen.add(name); else foldOpen.delete(name);
  try { localStorage.setItem('navFold', JSON.stringify([...foldOpen])); } catch {}
  if (body) body.hidden = !opening; b.classList.toggle('open', !!opening);
});
// 開いている画面の小メニューをその下に展開
function navSubs() {
  $$('.nav-subs').forEach(x => x.remove());
  $$('.nav-link').forEach(a => a.classList.toggle('open', false));
  const subs = subsOf(route.name), link = $(`.nav-link[data-nav="${route.name}"]`);
  if (!subs || !link) return;
  link.classList.add('open');
  link.insertAdjacentHTML('afterend', `<div class="nav-subs">${subs.filter(s => !s.hidden).map(s => (s.disabled ? `<span class="nav-sub disabled" aria-disabled="true" title="現在は使用できません">${esc(s.l)}</span>` : `<a class="nav-sub ${s.k === route.sub ? 'active' : ''}" href="#${route.name}/${s.k}">${esc(s.l)}</a>`)).join('')}</div>`);
}
function parseHash() {
  const [path, q] = location.hash.slice(1).split('?'), [name, sub] = (path || '').split('/');
  return { name: name || '', sub: sub || '', q: Object.fromEntries(new URLSearchParams(q || '')) };
}
// 小メニューの決定：明示 → 条件（従来タブのURL）一致 → 先頭。小メニューの q を条件に足す
function resolveSub(r) {
  const subs = subsOf(r.name); if (!subs) return r;
  const usable = subs.filter(s => !s.disabled), item = usable.find(s => s.k === r.sub) || (!r.sub && usable.find(s => s.q && Object.entries(s.q).every(([k, v]) => r.q[k] === v))) || usable.find(s => !s.hidden);
  return { ...r, sub: item.k, subItem: item, subTools: item.tools ?? (item === subs[0] || !!item.q), q: { ...r.q, ...(item.q || {}) } };
}
// freshNext：次の描画で DB を読む。画面のボタン（検索・タブ切替など）から go() したときは読み、サイドバーのメニュー・小メニューは読まない
let freshNext = false;
const takeFresh = () => { const f = freshNext; freshNext = false; return f; };
const go = (name, q = {}) => { freshNext = true; const path = name === route.name && route.sub ? `${name}/${route.sub}` : name, h = '#' + path + (Object.keys(q).length ? '?' + qs(q) : ''); if (location.hash === h) render({ fresh: takeFresh() }); else location.hash = h; };
async function render({ fresh = false } = {}) {
  route = parseHash();
  if (!TITLES[route.name] || !VIEWS[route.name]) route = { name: home(), sub: '', q: {} };
  route = resolveSub(route); navSubs(); navFolds();
  const fn = VIEWS[route.name];
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === route.name));
  $('#crumb').textContent = (TITLES[route.name] || '') + (route.subItem ? ' › ' + route.subItem.l : ''); document.body.classList.remove('nav-open');
  const token = ++renderSeq, own = { go: d => go(d.to) }, prev = actions;
  let html, pending;
  const mode = fresh || apiDirty ? 'fresh' : 'lazy'; if (mode === 'fresh') apiDirty = false;
  // DB から読む描画（検索など）は、読込から一覧の表示が終わるまで「データを読み込み中…」のバーを出す（出荷伝票など件数の多い一覧）
  const reading = mode === 'fresh'; if (reading) { $('#content').classList.add('busy'); busy(true, 'データを読み込み中…', true); }
  apiMode = mode; emptyShown = false; actions = own; try { pending = fn(route.q); } finally { actions = prev; } // view captures `own` synchronously; old page stays usable while loading
  try { html = await pending; if (reading && token === renderSeq) await new Promise(r => requestAnimationFrame(() => setTimeout(r))); } // バーを描いてから一覧を組み立てる
  catch (e) { html = `<div class="card glass"><h2>読み込みエラー</h2><p class="check-ng">${esc(e.message)}</p></div>`; toast(e.message, true); }
  finally { if (token === renderSeq) apiMode = null; }
  if (token !== renderSeq) { if (reading) busy(false); return; } // a newer navigation finished first
  try {
    const content = $('#content');
    actions = own; content.innerHTML = html; content.dataset.view = route.name; content.classList.remove('busy');
    // 小メニュー：該当する区画だけ表示（data-sub はスペース区切りで複数可）。先頭以外では上部の検索・登録を隠す
    if (route.sub) { content.querySelectorAll('[data-sub]').forEach(el => (el.hidden = !el.dataset.sub.split(' ').includes(route.sub))); const tools = content.querySelector('.page-head > .filters'); if (tools) tools.hidden = !route.subTools; }
    // 画面の見出しは開いている小メニュー名（大メニュー名はパンくずに表示）
    const h1 = content.querySelector('.page-head h1'); if (h1 && route.subItem) h1.textContent = route.subItem.l;
    // カードの見出しが小メニュー名と同じなら出さない（より下位の名称のカードはそのまま）
    if (route.subItem) {
      const norm = t => t.replace(/[\s（）()・、,]|NO/g, ''), base = t => t.split(/[（(]/)[0].trim(), sub = norm(route.subItem.l);
      const heads = $$('.card-head > h2, section.card > h2', content).filter(h => h.offsetParent), one = heads.length === 1;
      for (const h2 of heads) {
        const t = norm(h2.textContent), b1 = base(h2.textContent), b2 = base(route.subItem.l);
        // 複数カードの小メニューでは同じ名称だけ、カード1枚なら前方一致・先頭の語の一致も同じとみなす
        const same = t === sub || b1 === b2 || (one && (sub.startsWith(t) || t.startsWith(sub) || b1.split('・')[0] === b2.split('・')[0]));
        if (!t || !same) continue;
        h2.hidden = true; const head = h2.parentElement; if (head.classList.contains('card-head') && ![...head.children].some(x => !x.hidden)) head.hidden = true;
      }
    }
    // 検索条件（data-filter）の並びの後ろに「検索」ボタン。条件を変えただけでは読み込まない
    for (const g of new Set($$('[data-filter]', content).map(el => el.closest('.filters') || el.parentElement))) {
      const last = $$('[data-filter]', g).pop(); (last.closest('label') && g.contains(last.closest('label')) ? last.closest('label') : last).insertAdjacentHTML('afterend', '<button type="button" class="primary" data-search>検索</button>');
    }
    // メニューで開いただけ（DB 未読込）の一覧：検索系ボタンで表示する旨を出す。画面に検索ボタンが無いときはここに置く
    if (emptyShown) {
      const visible = el => el.offsetParent !== null, hasSearch = $$('[data-search], [data-act="search"], [data-act="preview"]', content).some(visible);
      for (const el of $$('.empty', content)) el.innerHTML = `検索条件を指定して「検索」を押すと表示します${hasSearch ? '' : ' <button type="button" class="primary mini" data-search>検索</button>'}`;
    }
    document.dispatchEvent(new CustomEvent('view:rendered', { detail: route.name }));
  } finally { if (reading) busy(false); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || !actions[b.dataset.act]) return;
  e.preventDefault(); actions[b.dataset.act](b.dataset, b);
});
// 検索条件を変えたら「検索」ボタンを目立たせる。読込は「検索」（入力欄で Enter）を押したとき
const search = () => { const q = { ...route.q }; for (const el of $$('[data-filter]')) { const v = el.dataset.combo ? comboCode(el) : el.value; if (v === null) return; q[el.name] = v; } freshNext = true; go(route.name, q); };
document.addEventListener('change', e => { if (e.target.matches('[data-filter]')) $$('[data-search]').forEach(b => b.classList.add('pending')); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[data-filter]')) { e.preventDefault(); search(); } });
// Enter で次の入力項目へ（Tab と同じ。Shift+Enter で前へ）。最後の項目からは登録ボタンへ移り、もう一度 Enter で登録（2026-10-29）
// 対象外：日本語の変換中・テキストエリア（改行）・ボタン・検索条件（Enter＝検索）。移動先は入力欄だけ（無効・読取専用・行削除などのボタンは飛ばす）
document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey || !t.matches?.('input, select') || t.matches('[data-filter], [type=button], [type=submit], [type=reset], [type=file]')) return;
  const root = t.closest('dialog') || t.closest('main') || document;
  const list = [...root.querySelectorAll('input, select, textarea')].filter(el => !el.disabled && !el.readOnly && el.type !== 'hidden' && el.tabIndex >= 0 && !el.matches('[data-filter]') && el.getClientRects().length);
  e.preventDefault();
  const next = list[list.indexOf(t) + (e.shiftKey ? -1 : 1)];
  if (next) { next.focus(); if (next.select && /^(text|search|tel|number|email|)$/.test(next.type) && !next.classList.contains('combo-input')) next.select(); }
  else if (!e.shiftKey) root.querySelector('#modal-submit, button[type=submit]')?.focus();
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-search]')) { e.preventDefault(); search(); }
});

// ---------- views ----------
const VIEWS = {};
VIEWS.dashboard = async () => {
  const A = actions;
  const d = await api('/api/dashboard'), k = d.kpi;
  const max = Math.max(1, ...d.trend.flatMap(t => [t.sales, t.received])), W = 640, H = 200, bw = 30, gap = W / d.trend.length;
  const bars = d.trend.map((t, i) => { const x = i * gap + gap / 2, hs = t.sales / max * (H - 40), hr = t.received / max * (H - 40);
    return `<g><rect x="${x - bw - 2}" y="${H - 20 - hs}" width="${bw}" height="${hs}" rx="5" fill="#6366f1"><title>${t.month} 売上(税込) ${yen(t.sales)}円</title></rect>
      <rect x="${x + 2}" y="${H - 20 - hr}" width="${bw}" height="${hr}" rx="5" fill="#22d3ee"><title>${t.month} 入金 ${yen(t.received)}円</title></rect>
      <text x="${x}" y="${H - 4}" text-anchor="middle">${t.month.slice(2).replace('-', '/')}</text></g>`; }).join('');
  const kpi = (label, v, sub, cls = '') => `<div class="kpi card glass ${cls}"><span>${label}</span><b>${v}</b><small>${sub}</small></div>`;
  return page('ダッシュボード', `${d.month} の状況 · 請求・入金・支払の要対応事項`, `<button data-act="go" data-to="shipments">＋ 出荷登録</button><button class="primary" data-act="go" data-to="receipts">入金消込へ</button>`, `
    <div class="kpis">${kpi('当月売上(税抜)', yen(k.salesMonth) + '<small> 円</small>', '出荷日基準')}${kpi('未請求の掛売上', yen(k.unbilledAmount) + '<small> 円</small>', `${k.unbilledCount}件`, k.unbilledCount ? 'warn' : '')}
      ${kpi('売掛金残高', yen(k.arBalance) + '<small> 円</small>', '開始残高＋請求−消込', 'accent')}${kpi('当月入金', yen(k.receivedMonth) + '<small> 円</small>', '受領額（手数料等除く）')}
      ${kpi('未払残高', yen(k.apBalance) + '<small> 円</small>', '定時請求−支払')}${kpi('未発行の請求書', d.draftInvoices + '<small> 件</small>', '請求締め後に発行', d.draftInvoices ? 'warn' : '')}</div>
    <div class="grid2">
      <section class="card glass"><div class="card-head"><h2>売上と入金の推移（6か月）</h2><div class="legend"><span><i style="background:#6366f1"></i>売上(税込)</span><span><i style="background:#22d3ee"></i>入金(消込額)</span></div></div>
        <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="売上と入金の推移">${[0.25, .5, .75, 1].map(f => `<line x1="0" x2="${W}" y1="${H - 20 - f * (H - 40)}" y2="${H - 20 - f * (H - 40)}" stroke="rgba(148,163,184,.25)"/>`).join('')}${bars}</svg>
        </section>
      <section class="card glass"><div class="card-head"><h2>期日超過の請求</h2><a href="#invoices?status=open">すべて →</a></div>
        ${table([{ label: '得意先', value: r => r.customerName }, { label: '締日', value: r => r.closing }, { label: '支払期日', html: r => `<span class="check-ng">${esc(r.due)}</span>` }, { label: '残高', num: 1, value: r => yen(r.balance) }], d.overdue, { empty: '期日超過の請求はありません' })}</section>
      <section class="card glass"><div class="card-head"><h2>14日以内の支払予定</h2><a href="#payments">支払へ →</a></div>
        ${table([{ label: '業者', value: r => r.vendorName }, { label: '伝票', value: r => r.no }, { label: '支払予定日', value: r => r.due }, { label: '未払残高', num: 1, value: r => yen(r.balance) }], d.dueSoon, { empty: '予定はありません' })}</section>
      <section class="card glass"><div class="card-head"><h2>最近の操作</h2><a href="#audit">履歴 →</a></div>
        ${table([{ label: '日時', value: r => jst(r.occurred_at, 16) }, { label: '利用者', value: r => r.actor_id }, { label: '操作', value: r => ACTIONS[r.action] || r.action }, { label: '対象', value: r => `${r.entity_type} ${r.entity_id}` }], d.recent)}</section>
    </div>`);
};
const ACTIONS = { 'shipment.create': '出荷登録', 'shipment.update': '出荷修正', 'shipment.delete': '出荷取消', 'shipment.correct': '出荷伝票訂正', 'billing.create': '請求作成', 'billing.cancel': '請求取消', 'invoice.issue': '請求書発行', 'invoice.reissue': '請求書再発行',
  'receipt.create': '入金消込', 'receipt.reverse': '入金取消', 'purchase.create': '仕入登録', 'purchase.delete': '仕入取消', 'inventory.create': '在庫計上', 'inventory.delete': '在庫取消', 'payable.create': '定時請求登録', 'pettycash.create': '小口現金登録',
  'expense.reverse': '経費取消', 'payment.create': '支払登録', 'payment.reverse': '支払取消', 'period.close': '月次確定', 'period.reopen': '確定解除', 'master.create': 'マスタ登録', 'master.update': 'マスタ更新', 'user.create': '利用者登録', 'user.update': '利用者更新', 'user.login': 'ログイン', 'user.password': 'パスワード変更' };

// ----- 出荷・売上 -----
// 決済方法（現行 Java A0001）：1 現金 / 2 掛売 / 3 カード。伝票区分 5＝訂正（赤黒）。
const CREDIT = 2;
// 出荷伝票一覧の現場の候補（部分一致）：得意先の現場マスタ（コード）＋表示中の伝票の納入場所名。得意先を選ぶと絞る（2026-10-27）
let shipNames = [];
const shipSiteOptions = (customer, rows = null) => { if (rows) shipNames = rows;
  const sites = (masters.sites || []).filter(x => x.active && (!customer || x.customer === customer)).map(x => [x.code, `${x.suffix} ${x.name} ${x.name2 || ''}`]);
  const names = [...new Set(shipNames.filter(r => !customer || r.customer === customer).map(r => r.siteName).filter(Boolean))].map(n => [n, '']);
  return [...sites, ...names].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); };
document.addEventListener('change', e => { if (e.target.id !== 'ship-cust') return; const t = e.target.value.trim(), x = (masters.customers || []).find(r => `${r.code} ${r.name}` === t || r.code === t); $('#dl-fsite').innerHTML = shipSiteOptions(x ? x.code : ''); });
VIEWS.shipments = async q => {
  const A = actions;
  A.shipTab = d => go('shipments', d.tab === 'plans' ? { tab: 'plans' } : {});
  A.notes = () => deliveryNoteDialog(); A.notesIssue = () => issueDeliveryNotes({ date: $('#dn-date').value }).catch(e => toast(e.message, true));
  if (q.tab === 'plans' && SUBMENUS.shipments.some(x => x.k === 'plans' && !x.disabled)) return planView(q);
  // 10/23 打合せ：売上日 From〜To・得意先・現場で伝票を特定。既定は当月
  const month = q.month || thisMonth(), from = q.from || `${month}-01`, to = q.to || monthEnd(month), kind = SHIP_KINDS[q.kind] ? q.kind : '', list = await api('/api/shipments?' + qs({ from, to, customer: q.customer, site: q.site, ...(SHIP_KINDS[kind]?.q || {}) }));
  const bd = (await api('/api/business-date')).date;
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true));
  // 業務日付（現行 MA057 出荷日変更・自社情報の取引日）：出荷日の初期値。変更は自社情報で行う（現行どおり出荷伝票画面には出さない）
  A.new = () => shipmentForm(null, bd);
  // 類似登録（提案書 スライド7・17）は 2026-10-23 に画面から外した（A.copy は残す）
  A.copy = d => { const r = list.find(x => x.orderNo === d.id); shipmentForm({ ...r, orderNo: undefined, date: bd, copyOf: r.orderNo }, bd); };
  // 「詳細」：変更できる伝票は修正画面（更新できる）、できない伝票（請求済・訂正伝票・訂正済・参照権限）は照会画面で「更新する」を使えなくする
  A.detail = d => { const r = list.find(x => x.orderNo === d.id), why = slipLock(r); if (why) slipInquiry(r, why); else shipmentForm(r); }; A.correct = d => correctionForm(list.find(r => r.orderNo === d.id));
  A.del = d => confirmBox('出荷の取消', `売上No ${d.id} を取消します。請求前の伝票のみ取消できます（赤黒は組で取消）。`, () => post('/api/shipments/delete', { orderNo: d.id }).then(() => { toast('取消しました'); render(); }), '取消する');
  const red = r => r.shipKb === 5 && r.quantity < 0;
  // 赤黒訂正のある伝票：元伝票・赤・黒を常に並べて出す（10/26 打合せ「元のがあって、打ち消された赤伝があって、黒伝がある」）。
  // 赤・黒は元伝票のすぐ下（伝票No 元No－枝番の順）。元伝票と赤は打ち消し合うので薄く表示
  const hidden = r => r.corrected || red(r), root = r => String(r.slipNo || '').split('-')[0], has = new Set(list.map(r => String(r.orderNo)));
  const linked = r => r.shipKb === 5 && root(r) !== String(r.orderNo) && has.has(root(r)), kids = new Map();
  for (const r of list) if (linked(r)) { if (!kids.has(root(r))) kids.set(root(r), []); kids.get(root(r)).push(r); }
  const tree = r => [r, ...(kids.get(String(r.orderNo)) || []).sort((a, b) => String(a.slipNo).localeCompare(String(b.slipNo), 'ja', { numeric: true })).flatMap(tree)];
  const shown = list.filter(r => !linked(r)).flatMap(tree);
  const net = shown.reduce((n, r) => n + r.net, 0), tax = shown.reduce((n, r) => n + r.tax, 0);
  const acts = r => {
    const b = [`<button class="mini" data-act="detail" data-id="${esc(r.orderNo)}">詳細</button>`];
    if (!canWrite()) return `<div class="actions">${b.join('')}</div>`;
    if (!red(r) && !r.corrected) b.push(`<button class="mini" data-act="correct" data-id="${esc(r.orderNo)}">赤黒訂正</button>`);
    if (!r.billed && !r.corrected) b.push(`<button class="mini danger" data-act="del" data-id="${esc(r.orderNo)}">取消</button>`);
    return `<div class="actions">${b.join('')}</div>`;
  };
  return page('出荷・売上', '出荷伝票（shipment_slip）と売上（sales_trn）を同時に登録します。請求済みの伝票は「赤黒訂正」で、元伝票のマイナス（赤）と訂正後（黒）を起票します（NO11、10/14 打合せ）。',
    `<input type="date" name="from" value="${esc(from)}" data-filter title="売上日（から）"><span>〜</span><input type="date" name="to" value="${esc(to)}" data-filter title="売上日（まで）">${comboFilter('customer', 'customers', q.customer || '', '得意先（コード・名称）', 'ship-cust')}<input name="site" list="dl-fsite" value="${esc(q.site || '')}" placeholder="現場（コード・名称）" title="現場（コード・名称）" autocomplete="off" data-filter style="width:200px"><datalist id="dl-fsite">${shipSiteOptions(q.customer, list)}</datalist><select name="kind" data-filter title="決済方法">${options(Object.entries(SHIP_KINDS).map(([code, x]) => ({ code, name: x.name })), kind, { blank: 'すべて', label: r => r.name })}</select>
     ${canWrite() ? '<button class="primary" data-act="new">＋ 出荷登録</button>' : ''}`,
    `<section class="card glass" data-sub="slips">${table([{ label: '売上No', value: r => r.slipNo || r.orderNo } /* 赤黒は「元伝票No－枝番」だけ（内部の売上Noは出さない。指摘 No.6） */, { label: '出荷日', value: r => r.date }, { label: '得意先', value: r => r.customerName }, { label: '現場', value: r => r.siteName }, { label: '商品', value: r => r.itemName },
      { label: '数量', num: 1, html: r => `${r.quantity < 0 ? `<span class="check-ng">${r.quantity}</span>` : r.quantity} ${esc(r.unit)}${r.cumulativeCount ? `<br><span class="small muted" title="同日・同現場・同商品・同納入区分の累計">累計 ${r.cumulativeQty}／${r.cumulativeCount}台</span>` : ''}` },
      { label: '担当・納入', html: r => `<span class="small">${esc(r.operatorName || r.operator)}<br>${esc(r.deliveryKbnName)}</span>` },
      { label: '単価', num: 1, value: r => yen(r.price) }, { label: '運賃', num: 1, value: r => (r.freight ? yen(r.freight) : '') }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '税', num: 1, value: r => `${r.taxRate}%` },
      { label: '決済', html: r => r.method === CREDIT ? esc(r.methodName) : badge(r.methodName, 'amber') },
      { label: '状態', html: r => (r.shipKb === 5 ? (red(r) ? badge('赤', 'red') : badge('赤黒あり', 'amber')) + ' ' : r.shipKb !== 1 ? badge(r.shipKbName, 'gray') + ' ' : '') + (r.corrected ? badge('訂正済', 'gray') + ' ' : '') + (r.billed ? badge('請求済', 'green') : r.method === CREDIT ? badge('未請求', 'gray') : badge('請求対象外', 'amber')) },
      { label: '', html: acts }],
      shown, { empty: 'この条件の出荷はありません', rowClass: r => (hidden(r) ? 'reversed' : ''), foot: ['合計', '', '', '', '', '', '', '', '', yen(net), '', `税 ${yen(tax)}`, ''] })}</section><div data-sub="reports">${shipmentReportsCard()}</div>
     <section class="card glass" data-sub="notes"><div class="card-head"><h2>納品書発行</h2></div>
       <div class="filters"><label class="field">出荷日<input type="date" id="dn-date" value="${esc(bd)}"></label>${canWrite() ? '<button class="primary" data-act="notesIssue">伝票発行</button>' : ''}</div>
       </section>`);
};
const myOperator = () => active('operators').find(o => Number(o.userId) === Number(session.user.id))?.code || active('operators')[0]?.code || '';
const opFields = r => `${field('担当者', `<select name="operator">${options(active('operators'), r?.operator || myOperator(), { blank: '選択してください' })}</select>`, { req: 1 })}
    ${field('納入区分', `<select name="deliveryKbn">${options(active('deliveryKinds'), r?.deliveryKbn || active('deliveryKinds')[0]?.code, { blank: '選択してください', label: x => `${x.code} ${x.name}${x.pickup ? '（運賃なし）' : ''}` })}</select>`, { req: 1 })}`;
const kindFields = r => `${field('伝票区分', `<select name="shipKb">${[1, 2, 3, 4].map(k => `<option value="${k}" ${Number(r?.shipKb || 1) === k ? 'selected' : ''}>${k} ${esc(meta.shipKinds[k])}</option>`).join('')}</select>`)}
    ${field('他社得意先', `<select name="otherCustomer">${options(active('customers'), r?.otherCustomer || '', { blank: '（なし）' })}</select>`, { hint: '伝票区分 2・4（他社納入）のときは必須' })}`;
// 提案書 スライド7・17：出荷伝票照会（全項目）
// 提案書 スライド7・17（出荷伝票確認／照会）と同じ並び：ラベル＋値を4組／行
const SL = (label, html, { span = 1, req = false, cls = '' } = {}) => `<div class="sl ${req ? 'req' : ''}">${esc(label)}</div><div class="sv span${span * 2 - 1} ${cls}">${html}</div>`;
const RO = (v, num) => `<div class="ro ${num ? 'num' : ''}">${v === '' || v === null || v === undefined ? '&nbsp;' : v}</div>`;
const SEP = '<hr class="sep">';
// 得意先・商品などは「コード＋名称」の2枠（提案書の画面どおり）
const CODE_NAME = (codeHtml, nameHtml, after = '<div class="span2c fill"></div>') => `<div class="sv">${codeHtml}</div><div class="sv span4c">${nameHtml}</div>${after}`;
const SITE_ROW = (a, b, c, d) => `<div class="sv span7"><div class="sv-site">${a}<span>—</span>${b}${c}<span>—</span>${d}</div></div>`;
// 照会の現場CD：登録画面と同じ現場マスタの選択リスト（「コード-枝番　名称」）で、変更はできない（2026-10-27）
const siteSelectRO = (customer, code, suffix) => { const cur = code ? `${code}|${suffix || '000'}` : '', list = (masters.sites || []).filter(x => x.customer === customer && (x.active || `${x.code}|${x.suffix}` === cur)).map(x => ({ v: `${x.code}|${x.suffix}`, l: `${x.code}-${x.suffix}　${x.name} ${x.name2 || ''}` }));
  if (cur && !list.some(x => x.v === cur)) list.unshift({ v: cur, l: `${cur.replace('|', '-')}（マスタなし）` });
  return `<select disabled title="現場（得意先の現場マスタ）"><option value="">${list.length ? '（現場の指定なし）' : '（現場マスタなし）'}</option>${list.map(x => `<option value="${esc(x.v)}"${x.v === cur ? ' selected' : ''}>${esc(x.l)}</option>`).join('')}</select>`; };
// 出荷伝票を変更できない理由（無ければ変更可）
const slipLock = r => (!canWrite() ? '参照権限のため変更できません' : r.billed ? '請求済みのため変更できません（「赤黒訂正」で訂正）' : r.shipKb === 5 ? '訂正伝票（赤・黒）は変更できません（取消して再登録）' : r.corrected ? '赤黒訂正済みのため変更できません' : '');
function slipInquiry(r, why = '') {
  const n2 = v => Number(v || 0).toFixed(2), [sc = '', ss = ''] = r.site.split('|');
  modal({ title: `出荷伝票の詳細（${r.slipNo || r.orderNo}）`, wide: true, submit: '更新する', body: `${why ? `<p class="note small" style="margin-bottom:10px">照会のみ：${esc(why)}</p>` : ''}<div class="slip-sheet">
    ${SL('伝票番号', RO(esc(r.slipNo || r.orderNo)))}${SL('伝票区分', RO(esc(r.shipKbName)))}<div class="span4c sv right muted small status-cell">${r.billed ? '請求済' : '未請求'}・伝票 ${r.printed ? (r.printed >= 2 ? '再発行済' : '発行済') : '未発行'}</div>
    ${SL('出荷日', RO(esc(r.date.replaceAll('-', '/')) + (r.correctionDate ? `<span class="muted small">（訂正日 ${esc(r.correctionDate.replaceAll('-', '/'))}）</span>` : '')))}${SL('天候', RO(esc(r.weatherName)))}${SEP}
    <div class="sl">得意先</div>${CODE_NAME(RO(esc(r.customer)), RO(esc(r.customerName)))}
    <div class="sl">他社得意先</div>${CODE_NAME(RO(esc(r.otherCustomer)), RO(esc(r.otherCustomerName)))}
    <div class="sl">納入場所</div>${SITE_ROW(siteSelectRO(r.customer, sc, ss), RO(esc(ss)), RO(esc(r.siteName1)), RO(esc(r.siteName2)))}${SEP}
    <div class="sl">商品</div>${CODE_NAME(RO(esc(r.item)), RO(esc(r.itemName)), SL('納入区分', RO(esc(r.deliveryKbnName))))}
    ${SL('数量', RO(n2(r.quantity), 1))}${SL('単位', RO(esc(r.unit)))}${SL('累計数量', RO(n2(r.cumulativeQty), 1))}${SL('予定数量', RO(n2(r.planQty), 1))}${SEP}
    ${SL('決済方法', RO(esc(r.methodName)))}${SL('単価', RO(yen(r.price), 1))}${SL('運賃', RO(yen(r.freight), 1))}<div class="span2c fill"></div>
    ${SL('金額', RO(yen(r.net), 1))}${SL('税率', RO(Number(r.taxRate).toFixed(1), 1))}${SL('消費税', RO(yen(r.tax), 1))}${SL('決済金額', RO(yen(r.paymentMoney || r.net + r.tax), 1))}${SEP}
    ${SL('車両番号', RO(esc(r.vehicle), 1))}${SL('累計台数', RO(String(r.cumulativeCount), 1))}<div class="span4c fill"></div>
    ${SL('出発時間', RO(esc(r.startTime)))}${SL('予定時間', RO(esc(r.planTime)))}${SL('出発温度', RO(r.startTemp === '' ? '' : esc(r.startTemp) + ' ℃', 1))}${SL('担当者', RO(esc(r.operatorName || r.operator)))}
    ${SL('伝票備考', RO(esc(r.remarks)), { span: 4 })}</div>
    ${canWrite() && r.shipKb !== 5 ? '<div class="filters right" style="margin-top:12px"><button type="button" class="primary" id="dn-one">伝票発行</button></div>' : ''}`,
    onOpen: () => { const s = $('#modal-submit'); if (s) { s.disabled = true; s.title = why; } $('#dn-one')?.addEventListener('click', () => issueDeliveryNotes({ orderNo: r.orderNo }).catch(e => toast(e.message, true))); }, onSubmit: () => false });
}
const siteFields = (cust, r) => `${field('現場', `<select name="site">${siteOptions(cust, r?.site, '（マスタ外・自由入力）')}</select>`)}
    ${field('現場名1', `<input name="siteName1" maxlength="20" value="${esc(r?.siteName1 || '')}">`)}${field('現場名2', `<input name="siteName2" maxlength="20" value="${esc(r?.siteName2 || '')}">`)}`;
// 赤黒訂正（2026-10-23）：入力画面は出荷伝票登録と同じ様式。伝票区分＝訂正・元伝票No を持ち、元伝票の内容を初期値にする。
// 登録すると 赤（元伝票の全量マイナス）を自動作成し、画面の内容を 黒（訂正後）として起票（数量 0 なら赤のみ＝取消）
function correctionForm(r) { shipmentForm({ ...r, orderNo: undefined, correctOf: r, date: today(), remarks: r.remarks || '', shipKb: 5 }); } // 黒の備考は元伝票の備考を引き継ぐ（指摘 No.26）
// 確認用：入力欄に架空のサンプル値を入れる（登録はしない）
const SAMPLE_SITES = ['東名高速 豊田管内舗装補修工事', '市道3号線 舗装工事', '南町 駐車場整備工事', '北区 造成工事'];
// サンプル入力：ダイアログ右上（× の左）の小さなアイコン（2026-10-24）
const SAMPLE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="16" cy="8" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="8" cy="16" r="1.6" fill="currentColor"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/></svg>';
const sampleButton = `<div class="sample-bar"><button type="button" class="sample-btn" data-sample title="サンプル入力" aria-label="サンプル入力">${SAMPLE_ICON}</button></div>`;
function fillSample(f, { plan = false } = {}) {
  const pick = list => list[Math.floor(Math.random() * list.length)], cus = active('customers'), items = active('items');
  if (cus.length) { f.customer.value = pick(cus).code; if (!f.siteCode) f.customer.dispatchEvent(new Event('change')); }
  if (f.siteCode) { f.siteCode.value = ''; f.siteSuffix.value = ''; f.siteName1.readOnly = f.siteName2.readOnly = false; } else f.site.value = '';
  f.siteName1.value = pick(SAMPLE_SITES); f.siteName2.value = '';
  if (items.length) f.item.value = pick(items).code;
  f.quantity.value = (Math.floor(Math.random() * 1900) / 100 + 1).toFixed(2);
  f.vehicle.value = String(1000 + Math.floor(Math.random() * 9000));
  f.startTime.value = `${String(7 + Math.floor(Math.random() * 10)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
  if (f.weather && active('weathers').length) f.weather.value = pick(active('weathers')).code;
  if (f.startTemp) f.startTemp.value = String(140 + Math.floor(Math.random() * 30));
  if (plan) f.remarks.value = 'サンプル予定';
  else f.remarks.value = 'サンプル';
}
function shipmentForm(r, bizDate) {
  const cust = r?.customer || '', n2 = v => Number(v || 0).toFixed(2), [sc0 = '', ss0 = ''] = (r?.site || '').split('|');
  const opt = (list, v, blank) => options(list, v, { blank });
  const dl = (id, list) => `<datalist id="${id}">${list.map(x => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('')}</datalist>`;
  const methodOpts = options(Object.entries(meta.methods).map(([code, name]) => ({ code, name })), r?.method || CREDIT, { label: x => `${x.code} ${x.name}` });
  // 伝票区分 5 訂正は新規登録のみ（元伝票No を指定して赤伝票を起票、2026-10-23）
  const co = r?.correctOf, kbOpts = (co ? [5] : [1, 2, 3, 4, ...(r?.orderNo ? [] : [5])]).map(k => `<option value="${k}" ${Number(r?.shipKb || 1) === k ? 'selected' : ''}>${esc(meta.shipKinds[k])}</option>`).join('');
  const kbnOpts = options(active('deliveryKinds'), r?.deliveryKbn || active('deliveryKinds')[0]?.code, { blank: '選択', label: x => x.name + (x.pickup ? '（運賃なし）' : '') });
  modal({ title: co ? `出荷伝票の赤黒訂正（元 ${co.orderNo}）` : r?.orderNo ? `出荷伝票の詳細（${r.slipNo || r.orderNo}）` : r?.fromPlan ? `出荷伝票登録（出荷予定 ${r.fromPlan} から）` : r?.copyOf ? `出荷伝票登録（類似登録：元 ${r.copyOf}）` : '出荷伝票登録', submit: co ? '赤黒伝票を登録' : r?.orderNo ? '更新する' : '登録する', wide: true, body: `${co ? `<div class="note" style="margin-bottom:10px">元伝票：${esc(co.date)} ${esc(co.customerName)} ／ ${esc(co.siteName)} ／ ${esc(co.itemName)} ${co.quantity} ${esc(co.unit)} × ${yen(co.price)}${co.freight ? '＋運賃' + yen(co.freight) : ''} ＝ ${yen(co.net)} 円（${esc(co.methodName)}）<br>
      <b>赤</b>＝元伝票の全量マイナス（${-co.quantity} ${esc(co.unit)}）を自動作成。<b>黒</b>＝下の訂正後の内容（数量 0 なら赤のみ＝取消）。赤・黒の出荷日（売上日）は元伝票の出荷日、下の出荷日欄は訂正日として記録（2026-10-27 大西さん回答 H）。<br><b>訂正できるのは 単価・数量 だけ</b>です。<span id="corr-preview"></span></div>
      <div class="corr-fixed"><div class="corr-fixed-h">変更できない項目（元伝票のまま）</div><table><tr><th>得意先</th><td>${esc(co.customer)}</td><td colspan="2">${esc(co.customerName || '')}</td></tr><tr><th>現場</th><td>${esc((co.site || '').replace('|', '-'))}</td><td>${esc(co.siteName1 || '')}</td><td>${esc(co.siteName2 || '')}</td></tr></table></div>` : sampleButton}<div class="slip-sheet">
    ${SL('伝票番号', RO(r?.orderNo ? esc(r.slipNo || r.orderNo) : '<span class="muted">登録時に採番</span>'))}${SL('伝票区分', `<select name="shipKb">${kbOpts}</select>`)}${co ? `${SL('元伝票No', RO(esc(co.orderNo)))}<div class="span2c fill"></div>` : r?.orderNo ? '<div class="span4c fill"></div>' : `${SL('元伝票No', '<input name="originalNo" maxlength="12" class="num" placeholder="区分 訂正のとき" autocomplete="off" disabled>')}<div class="span2c sv muted small" id="sf-orig"></div>`}
    ${SL(co ? '訂正日' : '出荷日', `<input type="date" name="date" value="${esc(r?.date || bizDate || today())}" required>`, { req: 1 })}${SL('天候', `<select name="weather">${opt(active('weathers'), r?.weather || '', '　')}</select>`)}${SEP}
    <div class="sl req">得意先</div>${CODE_NAME(`<input name="customer" list="dl-cust" maxlength="5" value="${esc(cust)}" autocomplete="off" required>`, '<div class="ro" id="sf-cname">&nbsp;</div>')}
    <div class="sl">他社得意先</div>${CODE_NAME(`<input name="otherCustomer" list="dl-cust" maxlength="5" value="${esc(r?.otherCustomer || '')}" autocomplete="off" placeholder="伝票区分 2・4 のとき">`, '<div class="ro" id="sf-oname">&nbsp;</div>')}
    <div class="sl">納入場所</div>${SITE_ROW(`<select name="sitePick" title="現場（得意先の現場マスタから選択）"></select><input type="hidden" name="siteCode" value="${esc(sc0)}">`, `<input name="siteSuffix" maxlength="3" value="${esc(ss0 || (sc0 ? '000' : ''))}" placeholder="000" readonly tabindex="-1">`, `<input name="siteName1" maxlength="20" value="${esc(r?.siteName1 || '')}" placeholder="納入場所名1">`, `<input name="siteName2" maxlength="20" value="${esc(r?.siteName2 || '')}" placeholder="納入場所名2">`)}${SEP}
    <div class="sl req">商品</div>${CODE_NAME(`<input name="item" list="dl-item" maxlength="5" value="${esc(r?.item || '')}" autocomplete="off" required>`, '<div class="ro" id="sf-iname">&nbsp;</div>', SL('納入区分', `<select name="deliveryKbn">${kbnOpts}</select>`, { req: 1 }))}
    ${SL('数量', `<input name="quantity" class="num" inputmode="decimal" value="${esc(r?.quantity ?? '')}" required>`, { req: 1 })}${SL('単位', '<div class="ro" id="sf-unit">&nbsp;</div>')}${SL('累計数量', '<div class="ro num" id="sf-cq">0.00</div>')}${SL('予定数量', '<div class="ro num" id="sf-pq">0.00</div>')}${SEP}
    ${SL('決済方法', `<select name="method">${methodOpts}</select>`)}${SL('単価', `<input name="price" class="num" inputmode="numeric" value="${esc(r?.price ?? '')}" required>`, { req: 1 })}${SL('運賃', `<input name="freight" class="num" inputmode="numeric" value="${esc(r?.freight ?? 0)}">`)}<div class="span2c fill"></div>
    ${SL('金額', '<div class="ro num" id="sf-net">0</div>')}${SL('税率', `<input name="taxRate" class="num" value="${esc(r?.taxRate ?? '')}" readonly tabindex="-1">`)}${SL('消費税', '<div class="ro num" id="sf-tax">0</div>')}${SL('決済金額', '<div class="ro num" id="sf-pay">0</div>')}${SEP}
    ${SL('車両番号', `<input name="vehicle" maxlength="15" class="num" value="${esc(r?.vehicle || '')}">`)}${SL('累計台数', '<div class="ro num" id="sf-cn">0</div>')}<div class="span4c fill"></div>
    ${SL('出発時間', `<input type="time" name="startTime" value="${esc(r?.startTime || '')}">`)}${SL('予定時間', '<div class="ro" id="sf-pt">&nbsp;</div>')}${SL('出発温度', `<input name="startTemp" class="num" inputmode="numeric" maxlength="3" value="${esc(r?.startTemp ?? '')}">`)}${SL('担当者', `<select name="operator">${opt(active('operators'), r?.operator || myOperator(), '選択')}</select>`, { req: 1 })}
    ${SL('伝票備考', `<input name="remarks" maxlength="20" value="${esc(r?.remarks || '')}">`, { span: 4 })}</div>
    ${r?.orderNo && !co && r.shipKb !== 5 ? '<div class="filters right" style="margin-top:12px"><button type="button" id="dn-one">伝票発行</button></div>' : ''}
    ${dl('dl-cust', active('customers'))}${dl('dl-item', active('items'))}
    `,
    onOpen: f => {
      const nameOf = (list, code) => (masters[list] || []).find(x => x.code === code)?.name;
      const show = (id, list, code) => { const n = code ? nameOf(list, code) : ''; $(id).innerHTML = code && !n ? '<span class="check-ng">該当なし</span>' : esc(n || '') || '&nbsp;'; };
      const siteVal = () => (f.siteCode.value.trim() ? `${f.siteCode.value.trim()}|${(f.siteSuffix.value.trim() || '000')}` : '');
      const unitOf = () => { const it = masters.items.find(i => i.code === f.item.value); $('#sf-unit').innerHTML = it ? esc(active('units').find(u => u.code === it.unit)?.name || it.unit || '') : '&nbsp;'; };
      const preview = () => { const qn = Number(f.quantity.value), p = Number(f.price.value) + Number(f.freight.value || 0), rate = Number(f.taxRate.value);
        const net = qn ? Math.round(Math.round(qn * 100) * p / 100) : 0, tx = Math.floor(net * (rate || 0) / 100);
        $('#sf-net').textContent = yen(net); $('#sf-tax').textContent = yen(tx); $('#sf-pay').textContent = yen(net + tx); };
      let seq = 0;
      const cumulative = async () => { const my = ++seq, d = await api('/api/shipments/preview?' + qs({ date: f.date.value, customer: f.customer.value, site: siteVal(), siteName1: f.siteName1.value, siteName2: f.siteName2.value, item: f.item.value, deliveryKbn: f.deliveryKbn.value, quantity: f.quantity.value, shipKb: f.shipKb.value, orderNo: r?.orderNo || '' })).catch(() => null);
        if (!d || my !== seq) return; $('#sf-cq').textContent = n2(d.cumulativeQty); $('#sf-cn').textContent = d.cumulativeCount; $('#sf-pq').textContent = n2(d.planQty); $('#sf-pt').innerHTML = esc(d.planTime) || '&nbsp;'; };
      const pickup = () => active('deliveryKinds').find(k => k.code === f.deliveryKbn.value)?.pickup;
      const price = async () => { if (!nameOf('items', f.item.value) || !nameOf('customers', f.customer.value)) return; const p = await api('/api/price?' + qs({ item: f.item.value, customer: f.customer.value, site: siteVal(), date: f.date.value })); f.price.value = p.price; f.freight.value = pickup() ? 0 : p.freight; f.taxRate.value = p.taxRate; preview(); toast(`単価: ${p.source} ${yen(p.price)}円${p.freight ? '・運賃 ' + yen(p.freight) + '円' : ''}`); };
      // 現場CD は得意先の現場マスタから選ぶ（2026-10-27）。マスタに無い現場の伝票（移行データ等）はその現場を選択肢に残す
      const siteList = () => { const cur = siteVal(), list = (masters.sites || []).filter(x => x.customer === f.customer.value && x.active).map(x => ({ v: `${x.code}|${x.suffix}`, l: `${x.code}-${x.suffix}　${x.name} ${x.name2 || ''}` }));
        if (cur && !list.some(x => x.v === cur)) list.unshift({ v: cur, l: `${cur.replace('|', '-')}（マスタなし）` });
        f.sitePick.innerHTML = `<option value="">${list.length ? '（現場を選択）' : '（現場マスタなし）'}</option>` + list.map(x => `<option value="${esc(x.v)}">${esc(x.l)}</option>`).join(''); f.sitePick.value = cur; };
      // keep：伝票（修正・赤黒訂正・元伝票の写し）の現場名をそのまま残す（移行データは現場マスタに名称2が無いことがある）
      const siteNames = (keep = false) => { const code = f.siteCode.value.trim(); if (code && !f.siteSuffix.value.trim()) f.siteSuffix.value = '000';
        const s = (masters.sites || []).find(x => x.customer === f.customer.value && x.code === code && x.suffix === (f.siteSuffix.value.trim() || '000'));
        if (s && !(keep && (f.siteName1.value || f.siteName2.value))) { f.siteName1.value = s.name || ''; f.siteName2.value = s.name2 || ''; } f.siteName1.readOnly = f.siteName2.readOnly = !!s; };
      f.customer.onchange = () => { show('#sf-cname', 'customers', f.customer.value); siteList(); siteNames(); price(); cumulative(); };
      f.otherCustomer.onchange = () => show('#sf-oname', 'customers', f.otherCustomer.value);
      f.item.onchange = () => { show('#sf-iname', 'items', f.item.value); unitOf(); price(); cumulative(); };
      f.sitePick.onchange = () => { const [code = '', suffix = ''] = f.sitePick.value.split('|'); f.siteCode.value = code; f.siteSuffix.value = suffix; siteNames(); price(); cumulative(); };
      f.date.onchange = () => { price(); cumulative(); };
      f.deliveryKbn.onchange = () => { if (pickup()) f.freight.value = 0; preview(); cumulative(); };
      // 区分 5 訂正：元伝票No を入れると元伝票の内容を写し、数量を逆符号（全量）にする。数量は元の数量以内で減らせる
      const origInfo = t => { const e = $('#sf-orig'); if (e) e.innerHTML = t; };
      f.shipKb.onchange = () => { if (f.originalNo) { const on = f.shipKb.value === '5'; f.originalNo.disabled = !on; if (on) f.originalNo.focus(); else { f.originalNo.value = ''; origInfo(''); } } cumulative(); };
      if (f.originalNo) f.originalNo.onchange = async () => {
        const no = f.originalNo.value.trim(); origInfo(''); if (!no) return;
        const o = (await api('/api/shipments?' + qs({ orderNo: no })))[0];
        if (!o) return origInfo(`<span class="check-ng">元伝票No ${esc(no)} はありません</span>`);
        if (o.shipKb === 5 && o.quantity < 0) return origInfo('<span class="check-ng">赤伝票は元伝票にできません</span>');
        if (o.corrected) return origInfo('<span class="check-ng">この伝票は訂正済みです</span>');
        const [sc, ss] = (o.site || '|').split('|');
        Object.assign(f.customer, { value: o.customer }); f.siteCode.value = sc || ''; f.siteSuffix.value = ss || ''; f.siteName1.value = o.siteName1; f.siteName2.value = o.siteName2;
        f.item.value = o.item; f.deliveryKbn.value = o.deliveryKbn || f.deliveryKbn.value; f.method.value = o.method; f.price.value = o.price; f.freight.value = o.freight; f.quantity.value = -o.quantity; f.taxRate.value = o.taxRate;
        if (!f.remarks.value) f.remarks.value = `赤 ${o.orderNo}`;
        show('#sf-cname', 'customers', f.customer.value); show('#sf-iname', 'items', f.item.value); siteList(); siteNames(true); unitOf(); preview(); cumulative();
        origInfo(`元 ${esc(o.date)} ${esc(o.customerName || o.customer)}／${esc(o.itemName)} ${o.quantity}${esc(o.unit)}${o.billed ? '（請求済）' : ''}`);
      };
      f.siteName1.onchange = f.siteName2.onchange = cumulative;
      for (const n of ['quantity', 'price', 'freight']) f[n].oninput = preview; f.quantity.onchange = cumulative;
      // 赤黒訂正は 単価・数量・訂正日 だけ入力可（2026-10-27 制限）。ほかの項目は元伝票のまま表示
      if (co) [...f.elements].forEach(el => { if (!el.name || ['quantity', 'price', 'date'].includes(el.name) || el.type === 'hidden') return; if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'button') el.disabled = true; else el.readOnly = true; });
      if (co) { const pv = () => { const qn = Number(f.quantity.value) || 0, black = Math.round(Math.round(qn * 100) * (Number(f.price.value) + Number(f.freight.value || 0)) / 100); $('#corr-preview').innerHTML = `<br>赤 ${yen(-co.net)} 円 ＋ 黒 ${yen(black)} 円 ＝ 差額 <b>${yen(black - co.net)}</b> 円（税抜）`; };
        for (const n of ['quantity', 'price', 'freight']) f[n].addEventListener('input', pv); pv(); }
      show('#sf-cname', 'customers', f.customer.value); show('#sf-oname', 'customers', f.otherCustomer.value); show('#sf-iname', 'items', f.item.value);
      siteList(); unitOf(); siteNames(true); preview(); cumulative(); if (!r || r.fromPlan) price();
      f.querySelector('[data-sample]')?.addEventListener('click', () => { fillSample(f); f.customer.onchange(); f.item.onchange(); });
      $('#dn-one')?.addEventListener('click', () => issueDeliveryNotes({ orderNo: r.orderNo }).catch(e => toast(e.message, true)));
    },
    onSubmit: async v => { const { siteCode, siteSuffix, sitePick, ...rest } = v; const site = siteCode.trim() ? `${siteCode.trim()}|${(siteSuffix.trim() || '000')}` : '';
      if (co) { const res = await post('/api/shipments/correct', { ...rest, site, orderNo: co.orderNo }); toast(`赤 ${res.redSlip}${res.blackSlip ? '・黒 ' + res.blackSlip : ''} を登録しました（差額 ${yen(res.net)}円）`); render(); return; }
      const res = await post('/api/shipments', { ...rest, site, orderNo: r?.orderNo }); toast(`${r?.orderNo ? '更新' : '登録'}しました（伝票番号 ${res.orderNo}）`); render(); },
  });
}

// ----- 出荷予定（現行 NS001001 登録・NS005001 検索・NS002002 照会・NS003003 修正、推定実装）-----
async function planView(q) {
  const A = actions, bd = (await api('/api/business-date')).date, from = q.from || bd, to = q.to || from;
  const list = await api('/api/plans?' + qs({ from, to, customer: q.customer, site: q.site }));
  A.newPlan = () => planForm(null, bd);
  A.editPlan = d => planForm(list.find(r => r.orderNo === d.id));
  A.copyPlan = d => { const r = list.find(x => x.orderNo === d.id); planForm({ ...r, orderNo: undefined, cumulativeCount: '', cumulativeQty: '', copyOf: r.orderNo }, bd); };
  A.slipFromPlan = d => { const r = list.find(x => x.orderNo === d.id), now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);
    shipmentForm({ customer: r.customer, site: r.site, siteName1: r.siteName1, siteName2: r.siteName2, item: r.item, quantity: r.quantity, deliveryKbn: r.deliveryKbn, vehicle: r.vehicle, shipKb: r.shipKb, otherCustomer: r.otherCustomer, method: r.method, remarks: r.remarks.slice(0, 20), startTime: now, fromPlan: r.orderNo, date: bd }, bd); };
  A.delPlan = d => confirmBox('出荷予定の削除', `予定 ${d.id} を削除します（現行と同じく物理削除）。`, () => post('/api/plans/delete', { orderNo: d.id }).then(() => { toast('削除しました'); render(); }), '削除する');
  const acts = r => `<div class="actions">${canWrite() ? `<button class="mini primary" data-act="slipFromPlan" data-id="${esc(r.orderNo)}">伝票登録</button><button class="mini" data-act="editPlan" data-id="${esc(r.orderNo)}">修正</button><button class="mini danger" data-act="delPlan" data-id="${esc(r.orderNo)}">削除</button>` : ''}</div>`;
  return page('出荷・売上', '出荷予定（shipment_plan）は1台＝1行の予定伝票です。出荷伝票の「予定数量・予定時間」は、同じ出荷日・得意先・納入場所名・商品・納入区分で累計台数が同じ予定の累計数量・出発時間です。予定から伝票登録もできます。',
    `<input type="date" name="from" value="${esc(from)}" data-filter><span>〜</span><input type="date" name="to" value="${esc(to)}" data-filter>${comboFilter('customer', 'customers', q.customer || '', '得意先（コード・名称）')}<input name="site" placeholder="納入場所名" value="${esc(q.site || '')}" data-filter>${canWrite() ? '<button class="primary" data-act="newPlan">＋ 出荷予定登録</button>' : ''}`,
    `<section class="card glass">${table([{ label: '予定No', html: r => esc(r.orderNo) + (r.shipKb !== 1 ? `<br><span class="small muted">${esc(meta.shipKinds[r.shipKb] || '')}</span>` : '') }, { label: '出荷日', value: r => r.date }, { label: '出発', value: r => r.startTime },
      { label: '得意先', value: r => r.customerName }, { label: '納入場所', value: r => r.siteName }, { label: '商品', value: r => r.itemName }, { label: '納入区分', value: r => r.deliveryKbnName },
      { label: '数量', num: 1, value: r => `${r.quantity} ${r.unit}` }, { label: '累計（台／数量）', num: 1, value: r => `${r.cumulativeCount}台／${r.cumulativeQty}` }, { label: '車番', value: r => r.vehicle }, { label: '担当', value: r => r.operatorName },
      { label: '実績', html: r => (r.shippedNo ? badge('出荷 ' + r.shippedNo, 'green') : badge('未出荷', 'gray')) }, { label: '', html: acts }], list, { empty: 'この条件の出荷予定はありません', foot: ['合計', '', '', '', '', '', '', list.reduce((n, r) => n + r.quantity, 0).toFixed(2), `${list.length}台`, '', '', '', ''] })}</section>`);
}
function planForm(r, bizDate) {
  const cust = r?.customer || active('customers')[0]?.code || '';
  modal({ title: r?.orderNo ? `出荷予定の修正（${r.orderNo}）` : r?.copyOf ? `出荷予定登録（類似登録：元 ${r.copyOf}）` : '出荷予定登録', submit: r?.orderNo ? '更新する' : '登録する', wide: true, body: `<div class="form-grid">${r?.orderNo ? '' : sampleButton}
    ${field('出荷日', `<input type="date" name="date" value="${esc(r?.date || bizDate || today())}" required>`, { req: 1 })}${kindFields(r)}${opFields(r)}
    ${field('決済方法', `<select name="method">${options(Object.entries(meta.methods).map(([code, name]) => ({ code, name })), r?.method || CREDIT, { label: x => `${x.code} ${x.name}` })}</select>`)}
    ${field('得意先', `<select name="customer" required>${options(active('customers'), cust)}</select>`, { req: 1 })}${siteFields(cust, r)}
    ${field('商品', `<select name="item" required>${options(active('items'), r?.item, { blank: '選択してください' })}</select>`, { req: 1 })}
    ${field('数量', `<input name="quantity" class="num" inputmode="decimal" value="${esc(r?.quantity ?? '')}" required>`, { req: 1 })}
    ${field('累計台数', `<input name="cumulativeCount" class="num" inputmode="numeric" value="${esc(r?.cumulativeCount ?? '')}" placeholder="自動">`, { hint: '空欄は同じ出荷日・得意先・納入場所・商品・納入区分の予定件数＋1' })}
    ${field('累計数量', `<input name="cumulativeQty" class="num" inputmode="decimal" value="${esc(r?.cumulativeQty ?? '')}" placeholder="自動">`, { hint: '空欄は直前の台数の累計＋数量' })}
    ${field('出発時間', `<input type="time" name="startTime" value="${esc(r?.startTime || '')}">`)}${field('車両番号', `<input name="vehicle" maxlength="15" value="${esc(r?.vehicle || '')}">`)}
    ${field('伝票備考', `<input name="remarks" maxlength="128" value="${esc(r?.remarks || '')}">`, { wide: 1 })}</div>`,
    onOpen: f => { f.customer.onchange = () => (f.site.innerHTML = siteOptions(f.customer.value, '', '（マスタ外・自由入力）')); f.querySelector('[data-sample]')?.addEventListener('click', () => fillSample(f, { plan: true })); },
    onSubmit: async v => { const res = await post('/api/plans', { ...v, orderNo: r?.orderNo }); toast(`${r?.orderNo ? '更新' : '登録'}しました（予定 ${res.orderNo}・${res.cumulativeCount}台目・累計 ${res.cumulativeQty}）`); render(); } });
}

// ----- 納品書発行（現行 NI0060：出荷日単位、1伝票＝1ページ、単価・金額は印字しない、推定実装）-----
async function deliveryNoteDialog() {
  const bd = (await api('/api/business-date')).date;
  modal({ title: '納品書発行', submit: '伝票発行', body: `<div class="form-grid">${field('出荷日', `<input type="date" name="date" value="${esc(bd)}">`, { req: 1 })}</div>`,
    onSubmit: async v => { await issueDeliveryNotes({ date: v.date }); } });
}
async function issueDeliveryNotes(p) {
  const d = await post('/api/delivery-notes', p), co = d.company;
  const ck = (on, label) => `<span class="dn-carry ${on ? 'on' : ''}">${label}</span>`, temp = s => (s.temperature === '' || s.temperature === null ? '' : esc(String(s.temperature)) + ' ℃');
  $('#print-area').innerHTML = d.docs.map(s => `<section class="dn-doc">
    <div class="dn-head">${s.reissue ? '<span class="dn-re">再</span>' : ''}<h1>納 品 書</h1></div>
    <div class="dn-line"><span>${esc(s.date)}</span><span class="dn-no">No. ${esc(s.orderNo)}</span></div>
    <p class="dn-to">${esc(s.customerName)}　殿</p>
    <table class="dn-table"><tr><th>現場名</th><td colspan="3">${esc(s.siteName)}</td></tr><tr><th>種類</th><td colspan="3">${esc(s.itemName)}</td></tr>
      <tr><th>車両番号</th><td>${esc(s.vehicle)}</td><th>天候</th><td>${esc(s.weather)}</td></tr>
      <tr><th>出発時間</th><td>${esc(s.startH)} 時 ${esc(s.startM)} 分</td><th>出荷温度</th><td>${temp(s)}</td></tr>
      <tr><th>到着時間</th><td>${esc(s.arriveH)} 時 ${esc(s.arriveM)} 分</td><th>到着温度</th><td>${temp(s)}</td></tr>
      <tr><th>正味重量</th><td>${s.quantity.toFixed(2)} ${esc(s.unit)}</td><th rowspan="2">出荷係</th><td rowspan="2">${esc(s.operatorName)}</td></tr>
      <tr><th>累計量</th><td>${s.cumulativeQty.toFixed(2)} ${esc(s.unit)}</td></tr>
      <tr><th>累計台数</th><td>${s.cumulativeCount} 台</td><th>受領印</th><td class="dn-stamp"></td></tr>
      <tr><th>運搬方法</th><td colspan="3">${ck(s.carry === 1, '1. 持込')}　${ck(s.carry === 2, '2. Ｐ渡')}</td></tr>
      <tr><th>備考</th><td colspan="3" class="dn-remark">${esc(s.remarks)}</td></tr></table>
    <p class="dn-thanks">毎度　ありがとうございます</p>
    <div class="dn-co"><p>${esc(co.address)}</p><p class="dn-co1">${esc(co.name1)}</p><p>${esc(co.name2)}</p><p>TEL ${esc(co.tel)}</p><p>FAX ${esc(co.fax)}</p></div></section>`).join('');
  toast(`伝票 ${d.docs.length} 件を発行しました`);
  setTimeout(() => window.print(), 200);
  if (route.name === 'shipments') render();
}

// 請求書発行：発行状況の絞込（検索済みの結果を使い、DB は読まない）
document.addEventListener('change', e => { if (e.target.id !== 'inv-state') return; freshNext = false; location.hash = '#invoices/issue?' + qs({ ...route.q, istate: e.target.value }); });
// 請求残高照会：請求書状況の絞込（検索済みの結果を使い、DB は読まない）
document.addEventListener('change', e => { if (e.target.id !== 'lg-state') return; freshNext = false; location.hash = '#invoices/ledger?' + qs({ ...route.q, lstate: e.target.value }); });
// 得意先別残高照会：請求書状況の絞込（検索済みの結果を使い、DB は読まない）
document.addEventListener('change', e => { if (e.target.id !== 'bal-state') return; freshNext = false; location.hash = '#invoices/balance?' + qs({ ...route.q, bstate: e.target.value }); });
// 入金一覧・消込：「計上済のみ」（既定は取消も含めてすべて。検索済みの結果を使い、DB は読まない）
document.addEventListener('change', e => { if (e.target.id !== 'rec-state') return; freshNext = false; location.hash = '#receipts/list?' + qs({ ...route.q, rstate: e.target.value }); });
// 入金消込：「消込対象のみ」・締日の絞込（検索済みの結果を使い、DB は読まない）
document.addEventListener('change', e => { if (!['rt-only', 'rt-cl', 'rt-ym'].includes(e.target.id)) return; freshNext = false; location.hash = '#receipts/targets?' + qs({ ...route.q, all: $('#rt-only').checked ? '' : '1', cl: $('#rt-cl').value, ym: $('#rt-ym').value || '-' }); });
// 出荷伝票一覧の決済方法の絞込（10/26 打合せ：出荷伝票は請求前の段階なので 掛売（振込）・カード・現金 の3種だけ。未請求・請求済は出さない）
const SHIP_KINDS = { credit: { name: '掛売', q: { method: 2 } }, card: { name: 'カード', q: { method: 3 } }, cash: { name: '現金', q: { method: 1 } } };
const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
// ----- 請求締め・発行 -----
const closingLabel = c => (Number(c) === 31 ? '月末' : c + '日');
// 締日の選択肢は規定の 5・10・15・20・月末 だけ（2026-10-23：規定外の締日のデモ得意先は削除済み、得意先マスタも規定値のみ登録可）
const STD_CLOSINGS = [5, 10, 15, 20, 31];
const closingList = () => STD_CLOSINGS;
const closingName = closingLabel;
VIEWS.invoices = async q => {
  const A = actions;
  A.view = d => go('invoices', { view: d.view });
  if (q.view === 'precheck') return precheckView(q);
  if (q.view === 'balance') return invoiceBalanceView(q);
  if (q.view === 'ledger') return arLedgerView(q); // await より前に呼ぶ（画面のボタン actions は描画開始時に同期で受け取る）
  if (q.view === 'issue') return invoiceIssueView(q);
  const month = q.month || thisMonth(); // 請求年月の既定は当月（2026-10-27）
  const list = await api('/api/invoices?' + qs({ month, closing: q.closing, customer: q.customer }));
  const closings = closingList();
  // 請求データ作成（10/23 打合せ：年月・締日だけ指定し「請求データ作成」。得意先の選択一覧は出さない）。
  // 対象＝その締日の得意先のうち未請求の掛売があるもの。未作成は新規作成、作成済み（未発行・消込なし）は後から入力した分を追加（2026-10-27）。
  // 発行済み・消込ありの請求の得意先は対象外（未請求分は次回締めで請求）。得意先ごとに作成して進捗を表示し、終わったら請求一覧照会へ
  A.run = async (_, btn) => {
    const month = $('#bill-month').value, closing = $('#bill-closing').value; if (!month) return toast('請求年月を入力してください', true);
    const p = await api('/api/billing/preview?' + qs({ month, closing }));
    // 締日が来ていない締めは作成できない（サーバーも拒否する）。得意先ごとに失敗させず、ここで止める（2026-10-27）
    if (p.end > today()) return alertBox(`締日（${p.end}）が到来していないため、${month} ${closingLabel(closing)}締の請求データは作成できません。`);
    const targets = p.customers.filter(r => r.count && !(r.created && r.locked));
    const held = p.customers.filter(r => r.count && r.created && r.locked), done = p.customers.filter(r => r.created && !r.count).length;
    // メッセージに件数は出さない（2026-10-29）
    const heldNote = held.length ? `発行済みのため次回締めで請求する得意先：${held.map(r => `${r.customer} ${r.name}`).join('、')}` : '';
    if (!targets.length) return alertBox(`作成する請求データはありません（${month} ${closingLabel(closing)}締：請求期間 ${p.start}〜${p.end}${done ? '、作成済み' : ''}）${heldNote ? `
${heldNote}` : ''}`);
    // 確認のポップアップは出さずにそのまま作成し、終わったら請求書発行確認表（未発行を含む）の Excel を出す（2026-10-27。10/27 打合せ「メッセージはいらない、処理中→終了でよい」）
    const sum = { created: 0, appended: 0, skipped: [], failed: [] }; let slip = ''; // 売掛金計上の伝票番号（1伝票45得意先まで同じ番号、Q08）
    if (btn) btn.disabled = true;
    progress.open(`請求データ作成（${month} ${closingLabel(closing)}締）`, targets.length);
    for (const [k, r] of targets.entries()) {
      progress.step(k, `${r.customer} ${r.name} を作成中…`);
      try { const x = await post('/api/billing/run', { month, closing, customers: [r.customer], slip }); slip = x.slip || slip; sum.created += x.created || 0; sum.appended += x.appended || 0; sum.skipped.push(...(x.skipped || [])); }
      catch (e) { sum.failed.push(`${r.customer} ${r.name}：${e.message}`); }
    }
    progress.step(targets.length, '完了'); progress.close(); if (btn) btn.disabled = false;
    // 作成できなかった得意先・次回締めに回る得意先があるときだけ知らせる
    if (sum.failed.length || heldNote) alertBox([sum.failed.length ? `作成できなかった得意先：\n${sum.failed.join('\n')}` : '', heldNote].filter(Boolean).join('\n\n'));
    freshNext = true; location.hash = '#invoices/list?' + qs({ month, closing });
    if (sum.created || sum.appended) await billingReport('confirm', month, closing, true).catch(e => toast(e.message, true));
  };
  // 10/26 打合せ：［詳細］は現場の行ごと。その現場の明細だけを出す
  A.detail = d => { const x = lines[Number(d.k)]; if (x) invoiceDetail(x.inv.id, x.site || x.siteName ? x : null); };
  // 帳票は一覧を画面に出さない：0件ならその旨、あれば Excel をダウンロード（2026-10-27 選択のポップアップを廃止）
  // 請求一覧照会の［請求書発行確認表出力］（指摘 No.14）：検索条件の請求年月・締日・得意先で、未発行も含めて出す（発行前の確認用）
  A.confirmBook = async (_, btn) => {
    if (!q.closing) return toast('請求年月と締日を指定して検索してください', true);
    btn.disabled = true; try { await billingReport('confirm', month, q.closing, true, q.customer || ''); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  A.report = async (d, btn) => { btn.disabled = true; try { await billingReport(d.kind, $('#rep-month').value, $('#rep-closing').value, $('#rep-unissued')?.checked); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; } };
  // 請求一覧照会（10/23 打合せ：提案書 P11＋現場名）：行は 得意先×現場。発行状況は表示だけ（発行・一括ダウンロードは請求書発行。10/26 打合せ）
  const lines = invoiceLines(list);
  const sum = k => lines.reduce((n, r) => n + r[k], 0);
  const closeSel = id => `<select id="${id}">${closings.map(c => `<option value="${c}">${closingName(c)}</option>`).join('')}</select>`;
  return page('請求締め・発行', '得意先単位・締日ごとの請求を、得意先×現場の行で照会します。請求書の発行は「請求書発行」で行います。',
    `${invoiceSearch({ ...q, month })}<button data-act="confirmBook" title="検索条件（請求年月・締日・得意先）の請求書発行確認表（未発行を含む）">請求書発行確認表出力</button>`,
    `<div>${canWrite() ? `<section class="card glass" data-sub="create"><div class="card-head"><h2>請求データ作成</h2></div>
      <div class="filters"><label class="field">請求年月<input type="month" id="bill-month" value="${thisMonth()}"></label><label class="field">締日${closeSel('bill-closing')}</label><button class="primary" data-act="run">請求データ作成</button></div></section>` : ''}
    <section class="card glass" data-sub="reports"><div class="card-head"><h2>請求帳票</h2></div>
      <div class="filters"><label class="field">請求年月<input type="month" id="rep-month" value="${q.month || thisMonth()}"></label><label class="field">締日${closeSel('rep-closing')}</label>
      <label class="small" title="発行前に全得意先の明細を確認するときに使う（現行 HAR430 は請求書発行の前に出力）"><input type="checkbox" id="rep-unissued" checked> 未発行を含む</label>
      <button data-act="report" data-kind="confirm">請求書発行確認表</button></div>
      </section></div>
    <section class="card glass" data-sub="list">
    ${table([{ label: '締日', value: r => (r.first ? r.inv.closing : '') }, { label: '得意先コード', value: r => (r.first ? r.inv.customer : '') }, { label: '得意先名', value: r => (r.first ? r.inv.customerName : '') },
      { label: '現場名', html: siteCell }, { label: '決済区分', value: r => r.method || '' },
      { label: '売上額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '今回請求額', num: 1, value: r => yen(r.total) },
      // 発行状況は現場の行ごと（請求書発行と同じ 未発行／発行済／再発行。2026-10-28）。入金・クレジットの状況は得意先の先頭行に並べる
      { label: '請求書発行状況', html: r => issueCell(r) + (r.first && ['partial', 'paid', 'credit'].includes(r.inv.status) ? ' ' + status(r.inv.status) : '') },
      { label: '', html: r => `<button class="mini" data-act="detail" data-k="${r.k}">詳細</button>` }], lines, { empty: '請求がありません', foot: ['合計', '', '', '', '', yen(sum('net')), yen(sum('tax')), yen(sum('total')), '', ''] })}</section>`);
};
// 請求一覧照会・請求書発行で共通：検索条件（請求年月・締日・得意先。得意先は任意）と 得意先×現場 の行
const invoiceSearch = q => `${monthInput('month', q.month || '')}<select name="closing" data-filter title="締日">${options(closingList().map(x => ({ code: String(x), name: closingName(x) })), q.closing, { blank: 'すべての締日', label: x => x.name })}</select>${comboFilter('customer', 'customers', q.customer || '', '得意先（コード・名称）')}`;
const invoiceLines = list => list.flatMap(r => (r.sites?.length ? r.sites : [{ site: '', siteName: '', method: '', net: r.net, tax: r.tax, total: r.total }]).map((x, k) => ({ ...x, inv: r, first: k === 0 }))).map((x, k) => ({ ...x, k }));
const siteCell = r => (r.siteName ? esc(r.siteName) : '<span class="muted small">（現場なし）</span>');
// 請求書発行（10/26 打合せ・提案書 P13）：請求年月・締日・得意先（任意）で検索 → 得意先×現場の行と発行状況（未発行／発行済／再発行）。
// 請求書は現場ごとに1枚。チェック・発行状況は現場の行ごと（2026-10-27）。見出しのチェックで全件、行のチェックで選択した現場だけ（訂正後の再発行）
const ISSUE_STATES = { unissued: '未発行', issued: '発行済', reissued: '再発行' };
// 現場名の表記（請求書の「現場：」・現場別発行の単位。サーバーの siteLabel と同じ）
const siteLabel = n => (n && String(n).trim() ? String(n) : '（現場なし）');
// 現場ごとの発行回数（現場別発行より前の発行分は請求の発行回数）
const siteNo = s => s.siteIssueNo?.[siteLabel(s.siteName)] ?? s.issueNo;
const issueState = r => (!r.issues ? 'unissued' : r.issues > 1 ? 'reissued' : 'issued'); // r＝現場の行（issues＝その現場の発行回数）
const issueCell = r => badge(ISSUE_STATES[issueState(r)], r.issues ? 'green' : 'gray') + (r.issues ? ` <span class="small muted">${r.issues}回</span>` : '');
async function invoiceIssueView(q) {
  const A = actions;
  A.view = d => go('invoices', { view: d.view });
  const ist = ISSUE_STATES[q.istate] ? q.istate : '', month = q.month || thisMonth(); // 請求年月の既定は当月（2026-10-27）
  const list = await api('/api/invoices?' + qs({ month, closing: q.closing, customer: q.customer }));
  // 行＝得意先×現場。発行状況・チェックは現場の行ごと（請求書は現場ごとに1枚。訂正した現場だけを再発行できる。2026-10-27）
  const lines = invoiceLines(list).filter(r => !ist || issueState(r) === ist).map((x, k, a) => ({ ...x, k, first: k === 0 || a[k - 1].inv.id !== x.inv.id }));
  const sum = k => lines.reduce((n, r) => n + r[k], 0);
  const picks = rows => { const m = {}; for (const r of rows) (m[r.inv.id] ||= []).push(siteLabel(r.siteName)); return m; };
  const checked = () => $$('.inv-pick:checked').map(x => lines[Number(x.value)]).filter(Boolean);
  // 発行した現場の Excel（現場ごとに最新の発行分を1シート）をダウンロード
  const book = async rows => {
    const sites = picks(rows), ids = Object.keys(sites);
    const res = await fetch('/api/invoices/book', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }, body: JSON.stringify({ ids: ids.map(Number), sites }) });
    if (!res.ok) return toast((await res.json().catch(() => ({}))).error || `ダウンロードできません（HTTP ${res.status}）`, true);
    const url = URL.createObjectURL(await res.blob()), el = document.createElement('a'); el.href = url; el.download = `請求書_${today()}_${rows.length}現場.xlsx`; el.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  };
  // 確認ポップアップは出さずにそのまま発行して Excel をダウンロードし、結果だけ知らせる（2026-10-27）
  A.issue = async (_, btn) => { const rows = checked(); if (!rows.length) return toast('発行する現場を選択してください（見出しのチェックで全件）', true);
    const re = rows.filter(r => r.issues).length, sites = picks(rows), ids = Object.keys(sites).map(Number);
    if (btn) btn.disabled = true;
    try {
      await post('/api/invoices/issue', { ids, sites });
      if (await book(rows)) toast(`${ids.length}得意先・${rows.length}現場（請求額合計 ${yen(rows.reduce((n, r) => n + r.total, 0))} 円）の請求書を発行し、Excel をダウンロードしました${re ? `（うち再発行 ${re}現場）` : ''}`);
    } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
    await render();
  };
  // ［⇩ 一括ダウンロード］は 2026-10-27 削除（10/27 打合せ：［請求書発行］で Excel が出るためボタンは1つ。再出力は再発行）
  return page('請求締め・発行', '請求年月・締日・得意先（任意）で検索し、請求書を発行します。請求書は現場ごとに1枚で、見出しのチェックで全件、行のチェックで選択した現場だけを発行します（訂正後の再発行）。発行すると Excel（1現場＝1シート）をダウンロードします。',
    `${invoiceSearch({ ...q, month })}<select id="inv-state" title="発行状況">${options(Object.entries(ISSUE_STATES).map(([code, name]) => ({ code, name })), ist, { blank: 'すべての発行状況', label: x => x.name })}</select>${canWrite() ? '<button class="primary" data-act="issue">請求書発行</button>' : ''}`,
    `<section class="card glass" data-sub="issue">
    ${table([{ label: '', head: '<input type="checkbox" data-pick-all="inv-pick" title="すべて選択／解除">', html: r => `<input type="checkbox" class="inv-pick" value="${r.k}">` }, { label: '締日', value: r => (r.first ? r.inv.closing : '') }, { label: '得意先コード', value: r => (r.first ? r.inv.customer : '') }, { label: '得意先名', value: r => (r.first ? r.inv.customerName : '') },
      { label: '現場名', html: siteCell }, { label: '売上額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '今回請求額', num: 1, value: r => yen(r.total) },
      { label: '発行状況', html: issueCell }],
      lines, { empty: ist ? 'この発行状況の現場はありません' : '請求がありません', foot: ['', '合計', '', '', '', yen(sum('net')), yen(sum('tax')), yen(sum('total')), ''] })}</section>`);
}
// 発行前確認一覧（2026-10-25）：請求データ作成の前に、その締日で請求される未請求の掛売上（出荷伝票）を得意先ごとに確認する。
// 現行 HAR430（メニュー 11）と同じ明細項目。請求データは作らない（読み取りのみ）
const PRECHECK_PLAN = { new: ['新規作成', 'green'], append: ['作成済みの請求に追加', 'amber'], next: ['発行済みのため次回締め', 'gray'] };
async function precheckView(q) {
  const A = actions;
  A.view = d => go('invoices', { view: d.view });
  const closings = closingList(), month = q.pmonth || thisMonth(), closing = q.pclosing || closings[closings.length - 1];
  const d = await api('/api/reports/billing-precheck?' + qs({ month, closing, customer: q.pcust || '' })), all = String(closing) === 'all'; // すべて＝5・10・15・20・月末（2026-10-27）
  const ymd = iso => String(iso).slice(2).replaceAll('-', '/'), kb = l => (Number(l.shipKb) === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上');
  const lineTable = r => table([{ label: '売上日', value: l => ymd(l.date) }, { label: '伝票No', value: l => l.orderNo }, { label: '区分', value: kb }, { label: '商品名', value: l => `${l.item} ${l.itemName}` },
    { label: '数量', num: 1, value: l => Number(l.quantity).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }, { label: '単位', value: l => l.unit }, { label: '単価', num: 1, value: l => yen(l.price) },
    { label: '金額', num: 1, value: l => yen(l.net) }, { label: '税率', num: 1, value: l => l.taxRate + '%' }, { label: '運送', value: l => l.carry }, { label: '現場名', value: l => l.siteName }], r.lines);
  const block = r => `<div class="har430-cust"><div class="filters"><b>${esc(r.customer)} ${esc(r.name)}</b>${badge(PRECHECK_PLAN[r.plan][0], PRECHECK_PLAN[r.plan][1])}</div>${lineTable(r)}
    <p class="small har430-sum">（売上額 <b>${yen(r.net)}</b>）（消費税額 <b>${yen(r.tax)}</b>）（値引額 <b>0</b>）（今回請求額 <b>${yen(r.current)}</b>）</p>
    ${(r.byRate || []).map(x => `<p class="small har430-rate"><span>${x.rate} %</span><span>${yen(x.net)}</span><span>${yen(x.tax)}</span></p>`).join('')}</div>`;
  A.lines = dd => { const r = d.rows.find(x => x.customer === dd.id); if (r) modal({ title: `発行前確認 ${r.customer} ${r.name}（${month} ${closingLabel(r.closing)}締　請求期間 ${r.start}〜${r.end}）`, wide: true, body: block(r) }); };
  A.print = () => { $('#print-area').innerHTML = `<section class="invoice-doc report-doc"><h2>発行前確認一覧</h2><p>${all ? `締日 すべて（${esc(month)}）` : `締日 ${closingLabel(closing)} ／ 請求期間 ${esc(d.start)}〜${esc(d.end)}`} ／ 出力日 ${today()}</p>${d.rows.map(r => (all ? `<h3>${closingLabel(r.closing)}締（請求期間 ${esc(r.start)}〜${esc(r.end)}）</h3>` : '') + block(r)).join('')}</section>`; setTimeout(() => window.print(), 100); };
  A.tocreate = () => { location.hash = '#invoices/create'; setTimeout(() => { if ($('#bill-month')) $('#bill-month').value = month; if ($('#bill-closing') && !all) $('#bill-closing').value = String(closing); }, 400); };
  const s = k => d.rows.reduce((n, r) => n + r[k], 0);
  return page('請求締め・発行', '発行前確認一覧：請求データ作成の前に、その締日で請求される未請求の掛売上（出荷伝票）を得意先ごとに確認します。請求データは作成しません。',
    `<input type="month" name="pmonth" value="${esc(month)}" data-filter title="請求年月"><select name="pclosing" data-filter title="締日"><option value="all" ${all ? 'selected' : ''}>すべて</option>${closings.map(c => `<option value="${c}" ${String(c) === String(closing) ? 'selected' : ''}>${closingName(c)}</option>`).join('')}</select>
    <input name="pcust" list="dl-pcust" autocomplete="off" value="${esc(q.pcust || '')}" placeholder="得意先（コード・名称の一部）" data-filter>${custHints()}
    ${d.rows.length ? `<a class="button" href="/api/reports/billing-precheck?${qs({ month, closing, customer: q.pcust || '', format: 'xlsx' })}" download>⇩ Excel</a>` : ''}
    ${canWrite() ? '<button type="button" data-act="tocreate">請求データ作成へ →</button>' : ''}`,
    `<section class="card glass"><div class="card-head"><h2>${all ? `${esc(month)} すべての締日（5日・10日・15日・20日・月末）` : `${esc(month)} ${closingLabel(closing)}締（請求期間 ${esc(d.start)}〜${esc(d.end)}）`}</h2></div>
    ${table([...(all ? [{ label: '締日', value: r => closingLabel(r.closing) }] : []), { label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '請求データ作成で', html: r => badge(PRECHECK_PLAN[r.plan][0], PRECHECK_PLAN[r.plan][1]) }, { label: '伝票数', num: 1, value: r => r.count },
      { label: 'うち訂正（赤黒）', num: 1, value: r => r.corrections || '' }, { label: 'うち前回締め以前の日付', num: 1, value: r => r.late || '' }, { label: '現場数', num: 1, value: r => r.sites },
      { label: '売上額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '今回請求額', num: 1, value: r => yen(r.current) },
      { label: '', html: r => `<button class="mini" data-act="lines" data-id="${esc(r.customer)}">明細</button>` }],
      d.rows, { empty: all ? 'この請求年月で請求データ作成の対象となる未請求の掛売上はありません' : 'この締日で請求データ作成の対象となる未請求の掛売上はありません', foot: [...(all ? [''] : []), '合計', '', String(s('count')), String(s('corrections') || ''), String(s('late') || ''), '', yen(s('net')), yen(s('tax')), yen(s('current')), ''] })}
    <p class="muted small" style="margin-top:8px">対象＝締日の得意先の 掛売・未請求 で売上日が締日以前の出荷伝票（請求データ作成と同じ条件）。「発行済みのため次回締め」は、同じ締日の請求が発行済み（または入金消込あり）のため、請求データ作成では次回締めに回るもの。</p></section>`);
}
// NO9・NO15 得意先別残高照会（請求一覧照会で請求残高照会を兼ねる：削減案3）
async function invoiceBalanceView(q) {
  const A = actions;
  A.view = d => go('invoices', { view: d.view });
  A.detail = d => invoiceDetail(d.id);
  const closings = closingList();
  const month = q.bmonth || thisMonth(), closing = q.bclosing || closings[0] || 31;
  // 請求書状況で絞込（検索結果をそのまま絞るので DB は読み直さない）
  const st = ['none', 'draft', 'issued'].includes(q.bstate) ? q.bstate : '', all = await api('/api/reports/billing-list?' + qs({ month, closing })), d = { ...all, rows: all.rows.filter(r => !st || r.state === st) };
  const s = k => d.rows.reduce((n, r) => n + r[k], 0);
  return page('請求締め・発行', '得意先ごとの前回請求額・入金・繰越・今回請求額を締日単位で照会します（請求一覧表と同じ計算）。', `<input type="month" name="bmonth" value="${month}" data-filter><select name="bclosing" data-filter>${closings.map(c => `<option value="${c}" ${String(c) === String(closing) ? 'selected' : ''}>${closingName(c)}</option>`).join('')}</select><input type="hidden" name="view" value="balance" data-filter>
    <select id="bal-state" title="請求書状況">${options([{ code: 'none', name: '未作成' }, { code: 'draft', name: '未発行' }, { code: 'issued', name: '発行済' }], st, { blank: 'すべての請求書状況', label: x => x.name })}</select>
    <a class="button" href="/api/reports/billing-list?${qs({ month, closing, state: st, format: 'xlsx', layout: 'balance' })}" download>⇩ Excel</a>`,
    `<section class="card glass"><div class="card-head"><h2>${esc(month)} ${closingLabel(closing)}締（${esc(d.end)}）</h2></div>${table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '前回請求額', num: 1, value: r => yen(r.prevBalance) }, { label: '御入金額', num: 1, value: r => yen(r.received) },
      { label: '差引繰越額', num: 1, value: r => yen(r.carried) }, { label: '今回お買上額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '今回請求額', num: 1, value: r => yen(r.total) }, { label: '支払期日', value: r => r.due },
      { label: '請求書状況', html: r => badge(r.stateName, r.state === 'issued' ? 'green' : r.state === 'draft' ? '' : 'gray') }, { label: '', html: r => r.invoiceIds.map(id => `<button class="mini" data-act="detail" data-id="${id}">詳細</button>`).join('') }],
      d.rows, { empty: st ? 'この請求書状況の得意先はありません' : 'この締日の得意先はありません', foot: ['合計', yen(s('prevBalance')), yen(s('received')), yen(s('carried')), yen(s('net')), yen(s('tax')), yen(s('total')), '', '', ''] })}</section>`);
}
// NO12 / NO13 report viewer with print and Excel download.
async function billingReport(kind, month, closing, unissued = false, customer = '') {
  const url = `/api/reports/${kind === 'list' ? 'billing-list' : 'billing-confirm'}?${qs({ month, closing, customer, ...(kind !== 'list' && unissued ? { unissued: '1' } : {}) })}`, d = await api(url);
  const title = kind === 'list' ? '請求一覧表（確認用）' : unissued ? '請求書発行確認表（未発行を含む）' : '請求書発行確認表';
  let body;
  if (kind === 'list') {
    // 現行 HAR431：得意先・現場名・売上額・税額・値引額・請求額、得意先計・会社合計
    let html = '';
    for (const r of d.rows) {
      r.sites.forEach((x, i) => { html += `<tr><td>${i ? '' : esc(r.customer)}</td><td>${i ? '' : esc(r.name)}</td><td>${esc(x.siteName)}</td><td class="num">${yen(x.net)}</td><td class="num">${yen(x.tax)}</td><td class="num">${yen(x.discount)}</td><td class="num">${yen(x.total)}</td><td>${i ? '' : badge(r.stateName, r.state === 'issued' ? 'green' : r.state === 'draft' ? '' : 'gray')}</td></tr>`; });
      html += `<tr class="subtotal"><td></td><td colspan="2" class="right">得意先計</td><td class="num">${yen(r.net)}</td><td class="num">${yen(r.tax)}</td><td class="num">0</td><td class="num">${yen(r.current)}</td><td></td></tr>`;
    }
    const sum = k => d.rows.reduce((n, r) => n + r[k], 0);
    body = d.rows.length ? `<div class="table-wrap"><table><thead><tr><th>得意先CD</th><th>得意先名</th><th>現場名</th><th class="num">売上額</th><th class="num">税額</th><th class="num">値引額</th><th class="num">請求額</th><th>状態</th></tr></thead><tbody>${html}</tbody>
      <tfoot><tr><td colspan="3">会社合計</td><td class="num">${yen(sum('net'))}</td><td class="num">${yen(sum('tax'))}</td><td class="num">0</td><td class="num">${yen(sum('current'))}</td><td></td></tr></tfoot></table></div>
      ` : '<div class="empty">対象の得意先がありません</div>';
  } else {
    // 現行 HAR430（提案書 帳票②）：締日・請求日付・売上締切日、売上日・伝票No・区分・商品名・数量・単位・単価・金額・税率・運送・備考、（売上額）（消費税額）（値引額）（今回請求額）と税率別
    const ymd = iso => String(iso).slice(2).replaceAll('-', '/'), kb = l => (l.shipKb === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上');
    body = d.rows.length ? `<div class="har430-head"><span>締日 <b>${esc(closingLabel(closing))}</b></span><span>請求日付 <b>${ymd(d.end)}</b></span><span>売上締切日 <b>${ymd(d.end)}</b></span><span>作成日 <b>${ymd(today())}</b></span><span class="right">${esc(d.company)}</span></div>` + d.rows.map(r => `<div class="har430-cust"><div class="filters"><b>${esc(r.customer)} ${esc(r.name)}</b><span class="muted small">${r.lastIssue ? `${r.lastIssue.no}回目発行 ${String(r.lastIssue.at).slice(0, 16)} ${esc(r.lastIssue.by)}` : badge('未発行', 'amber')}</span></div>
      ${table([{ label: '売上日', value: l => ymd(l.date) }, { label: '伝票No', value: l => l.orderNo }, { label: '区分', value: kb }, { label: '商品名', value: l => `${l.item} ${l.itemName}` }, { label: '数量', num: 1, value: l => Number(l.quantity).toFixed(2) }, { label: '単位', value: l => l.unit },
        { label: '単価', num: 1, value: l => yen(l.price) }, { label: '金額', num: 1, value: l => yen(l.net) }, { label: '税率', num: 1, value: l => l.taxRate + '%' }, { label: '運送', value: l => l.carry }, { label: '備考', value: l => l.siteName }], r.lines)}
      <p class="small har430-sum">（売上額 <b>${yen(r.net)}</b>）（消費税額 <b>${yen(r.tax)}</b>）（値引額 <b>0</b>）（今回請求額 <b>${yen(r.current)}</b>）</p>
      ${(r.byRate || []).map(x => `<p class="small har430-rate"><span>${x.rate} %</span><span>${yen(x.net)}</span><span>${yen(x.tax)}</span></p>`).join('')}</div>`).join('') + ''
      : `<div class="empty">${unissued ? 'この請求年月・締日の請求はありません' : 'この請求年月・締日の発行済み請求書はありません'}</div>${d.available?.length ? `<p class="small">発行済みの請求がある年月・締日：${d.available.map(a => `<button type="button" class="mini" data-period="${a.month}|${a.closing}">${a.month} ${closingLabel(a.closing)}締</button>`).join(' ')}</p>` : ''}`;
  }
  // データがあれば選択のポップアップを出さず Excel をダウンロード（2026-10-27）。無いときだけ理由を出す
  const n = d.rows.length, total = d.rows.reduce((t, r) => t + (r.current || 0), 0);
  if (n) { await saveXlsx(url + '&format=xlsx'); return toast(`${title}（${n}得意先・今回請求額 ${yen(total)} 円）を Excel で出力しました`); }
  const head = `<p><b>データがありません。</b>（${esc(month)} ${esc(closingLabel(closing))}締）</p>`;
  modal({ title: `${title} ${month} ${closingLabel(closing)}締`, body: `${head}<div id="rep-body"${n ? ' hidden' : ''}>${n ? body : body.replace(/<div class="empty">[^<]*<\/div>/, '')}</div>`,
    onOpen: () => {
      // 該当なしのとき：発行済みがある年月・締日を押すとその条件で出し直す
      $$('#rep-body [data-period]').forEach(b => (b.onclick = () => { const [m, cl] = b.dataset.period.split('|'), sel = $('#rep-closing');
        if ($('#rep-month')) $('#rep-month').value = m; if (sel && ![...sel.options].some(o => o.value === cl)) sel.insertAdjacentHTML('beforeend', `<option value="${cl}">${closingLabel(cl)}</option>`); if (sel) sel.value = cl;
        billingReport(kind, m, cl, unissued, customer).catch(e => toast(e.message, true)); }));
    } });
}
// site：請求一覧照会の現場の行（10/26 打合せ）。その現場の明細・金額だけを出し、発行は請求書発行で行う
async function invoiceDetail(id, site = null) {
  const inv = await api('/api/invoices/' + id);
  const mine = l => (!site.site || l.site === site.site) && (l.siteName || '') === (site.siteName || ''), pick = ls => (site ? ls.filter(mine) : ls);
  // 明細：まとめずに伝票ごとの全行（請求書・請求書発行確認表と同じ。2026-10-27 内部会議 No.3）
  // 明細の列は請求書発行確認表と同じ（運送＝1 自社手配・2 先方引取、備考＝現場名。2026-10-27、10/27 打合せ）
  const lineTable = () => table([{ label: '日付', value: r => r.date }, { label: '売上No', value: r => r.orderNo }, { label: '区分', html: r => r.shipKb === 5 ? badge('訂正', 'amber') : '売上' }, { label: '商品', value: r => r.itemName }, { label: '数量', num: 1, value: r => r.quantity }, { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '税率', num: 1, value: r => r.taxRate + '%' },
    { label: '運送', value: r => r.carry || '' }, { label: '備考', value: r => r.siteName }], pick(inv.lines));
  modal({ title: `請求 No.${inv.id} ${inv.customerName}${site ? ' ／ ' + (site.siteName || '（現場なし）') : ''}`, wide: true, body: `
    <div class="grid3"><div><div class="muted small">${site ? '現場' : '請求単位'}</div><b>${esc(site ? site.siteName || '（現場なし）' : inv.siteName)}</b></div><div><div class="muted small">締日 / 支払期日</div><b>${esc(inv.closing)} / ${esc(inv.due)}</b></div><div><div class="muted small">状態</div>${status(inv.status)}</div></div>
    <div class="grid3" style="margin:12px 0"><div class="sum-line"><span>税抜金額</span><b>${yen(site ? site.net : inv.net)}</b></div><div class="sum-line"><span>消費税</span><b>${yen(site ? site.tax : inv.tax)}</b></div>${site ? `<div class="sum-line"><span>今回請求額</span><b>${yen(site.total)}</b></div>` : `<div class="sum-line"><span>請求額 / 残高</span><b>${yen(inv.total)} / ${yen(inv.balance)}</b></div>`}</div>
    <h3>明細</h3><div id="inv-lines">${lineTable()}</div>
    ${/* 発行履歴・入金消込の表は 2026-10-27 に削除（10/27 打合せ：詳細は請求書発行確認表と同じ明細だけ） */ ''}
    <div class="filters" style="margin-top:14px">${(site ? site.issues : inv.issues) ? '<button type="button" id="inv-copy">⇩ 最新発行分の Excel（控え）</button>' : ''}${canWrite() && !site ? `<button type="button" class="primary" id="inv-issue">${inv.issues ? '再発行して Excel' : '発行して Excel'}</button>` : ''}${canWrite() && !inv.issues && !inv.allocations.length ? `<button type="button" class="danger" id="inv-cancel">${site ? '請求取消（この現場）' : '請求取消'}</button>` : ''}</div>`,
    onOpen: () => {
      // 控え・発行は印刷せず Excel（現場ごとに最新の発行分を1シート）をダウンロード（2026-10-27 Excel に統一）
      const book = () => saveXlsx('/api/invoices/book', { ids: [inv.id], sites: site ? { [inv.id]: [siteLabel(site.siteName)] } : {} });
      $('#inv-copy')?.addEventListener('click', async () => { try { await book(); toast('最新発行分の請求書（控え）を Excel で出力しました'); } catch (e) { toast(e.message, true); } });
      $('#inv-issue')?.addEventListener('click', async () => { try { await post('/api/invoices/issue', { ids: [inv.id] }); $('#dialog').close(); await book(); toast('請求書を発行し、Excel をダウンロードしました'); render(); } catch (e) { $('#form-error').textContent = e.message; toast(e.message, true); } });
      // 現場の行から開いたときはその現場の明細だけを取消す（2026-10-28）。最後の現場なら請求ごと取消
      $('#inv-cancel')?.addEventListener('click', async () => { try { const x = await post('/api/invoices/cancel', site ? { id: inv.id, site: site.site || '', siteName: site.siteName || '' } : { id: inv.id }); $('#dialog').close();
        toast(x.site ? `現場「${x.site}」の請求を取消しました（売上${x.orders}件は未請求に戻り、請求額は ${yen(x.net + x.tax)} 円に再計算）` : '請求を取消しました（売上は未請求に戻り、仕訳は逆仕訳）'); render(); } catch (e) { $('#form-error').textContent = e.message; toast(e.message, true); } });
    } });
}
// 提案書 スライド14 の請求書様式：請求書番号・取引銀行（2行）・前回残高／今回入金額／今回請求額(税抜)／今回消費税／今回消費税(軽減)／今回請求額(税込)／今回残高、明細（月日・伝票NO・区分・品名・数量・単位・単価・金額）
const jpDate = d => (d ? `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日` : '');
// 請求書の明細を現場ごとにまとめる（現場コード＋現場名。コードの無い自由入力の現場は名称で分ける）。現場が2つ以上なら各現場の先頭に「現場：名称」、末尾に現場小計
const siteGroups = lines => { const m = new Map(); for (const l of lines) { const k = `${l.site || ''}|${l.siteName || ''}`; if (!m.has(k)) m.set(k, { name: l.siteName || '（現場なし）', lines: [], net: 0 }); const g = m.get(k); g.lines.push(l); g.net += l.net; } return [...m.values()]; };
// 請求書は現場ごとに1枚（指摘 No.18：10/23 打合せ「得意先に3つの現場があれば3枚」。小計は現場計）。
// 前回残高・今回入金額・繰越は1枚目だけに載せ、各枚の今回請求額の合計が得意先の請求額になる。消費税は税率ごとに得意先の税額を現場の金額で按分（端数は金額の大きい現場）
const splitBySite = s => {
  const gs = siteGroups(s.lines); if (gs.length <= 1) return [{ ...s, siteName: gs[0]?.name || '', page: 1, pages: 1 }];
  const bk = gs.map(() => []);
  for (const b of s.buckets) {
    const nets = gs.map(g => g.lines.filter(l => l.taxRate === b.rate).reduce((n, l) => n + l.net, 0)), taxes = nets.map(n => (b.net ? Math.floor(b.tax * n / b.net) : 0));
    taxes[nets.indexOf(Math.max(...nets))] += b.tax - taxes.reduce((a, t) => a + t, 0);
    nets.forEach((n, k) => { if (n || taxes[k]) bk[k].push({ rate: b.rate, net: n, tax: taxes[k] }); });
  }
  return gs.map((g, k) => { const tax = bk[k].reduce((n, b) => n + b.tax, 0), total = g.net + tax;
    return { ...s, lines: g.lines, buckets: bk[k], net: g.net, tax, total, discount: 0, prevBalance: 0, received: 0, carried: 0, grandTotal: total, siteName: g.name, page: k + 1, pages: gs.length }; });
};
function proposalInvoice(s) {
  const tax10 = s.buckets.filter(b => b.rate !== 8).reduce((n, b) => n + b.tax, 0), tax8 = s.buckets.filter(b => b.rate === 8).reduce((n, b) => n + b.tax, 0);
  const kind = l => (l.shipKb === 5 ? (l.quantity < 0 ? '赤' : '黒') : '売上');
  const no = s.invoiceNo || 'K' + String(s.closing).slice(0, 7).replace('-', '') + String(s.invoiceId).padStart(5, '0');
  const banks = s.company.banks || (s.company.bankText ? [s.company.bankText] : []);
  return `<section class="invoice-doc prop-inv">
    <div class="inv-top"><div style="flex:1"></div><h1 style="flex:0 0 auto">請 求 書</h1><div style="flex:1;text-align:right"><p>請求書番号: ${esc(no)}${s.copy ? `<br><span class="reissue">控え（${siteNo(s)}回目の発行分）</span>` : siteNo(s) > 1 ? `<br><span class="reissue">${esc(s.company.saisyutsu || '再発行')}（${siteNo(s)}回目）</span>` : ''}</p><p>${esc(jpDate(s.issuedOn || today()))}</p></div></div>
    <div class="inv-top"><div><p>${esc(s.customer.address)}</p><p class="to">${esc(s.customer.name)} 御中</p>
        <p>毎度ありがとうございます。<br>下記のとおり御請求申し上げます。</p><p>${esc(jpDate(s.periodStart))} 〜 ${esc(jpDate(s.closing))}</p>${s.siteName ? `<p class="site-name">現場：<b>${esc(s.siteName)}</b>${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}</p>` : ''}</div>
      <div><p><b>${esc(s.company.name)}</b><br>${esc(s.company.address)}<br>TEL ${esc(s.company.tel)}${s.company.fax ? ' FAX ' + esc(s.company.fax) : ''}${s.company.invoiceNo ? `<br>登録番号: ${esc(s.company.invoiceNo)}` : ''}</p>
        ${banks.length ? `<p>取引銀行 ${banks.map(esc).join('<br>')}</p>` : ''}<p>お支払期日 ${esc(s.due)}</p></div></div>
    <table class="totals"><tr><th>今回請求額(税抜)</th><th>今回消費税</th><th>今回消費税(軽減)</th><th>今回請求額(税込)</th></tr>
      <tr><td class="num">${yen(s.net)}</td><td class="num">${yen(tax10)}</td><td class="num">${yen(tax8)}</td><td class="num"><b>${yen(s.total)}</b></td></tr></table>
    <table><tr><th>月日</th><th>伝票NO</th><th>区分</th><th>品名</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th></tr>
      ${s.lines.map(l => `<tr><td>${esc(String(l.date).slice(5).replace('-', '/'))}</td><td>${esc(l.orderNo)}</td><td>${kind(l)}</td><td>${esc(l.itemName)}</td><td class="num">${l.quantity}</td><td>${esc(l.unit || '')}</td><td class="num">${yen(l.price)}</td><td class="num">${yen(l.net)}</td></tr>`).join('')}
      <tr class="subtotal"><td colspan="7" class="right">現場計</td><td class="num"><b>${yen(s.net)}</b></td></tr></table>
    <table class="inv-rates"><tr><th>税率区分</th><th>対象額(税抜)</th><th>消費税</th></tr>${s.buckets.map(b => `<tr><td>${b.rate}%対象</td><td class="num">${yen(b.net)}</td><td class="num">${yen(b.tax)}</td></tr>`).join('')}</table>
    </section>`;
}
// site：請求一覧照会の現場の行から控えを出すとき、その現場の1枚だけ（現場ごとに1枚の請求書）
function printDocs(docs, site = null) {
  // 現行の請求書（帳票一覧③）と同じ構成：当月御買上額・消費税額・当月値引額・当月御請求額、明細（年月日・伝票番号・商品名・数量・単位・単価・金額・備考）、税率別合計
  const all = docs.flatMap(d => splitBySite(d).filter(s => !d.sites || d.sites.includes(siteLabel(s.siteName)))), mine = site ? all.filter(s => siteLabel(s.siteName) === siteLabel(site.siteName)) : all, pages = mine.length ? mine : all;
  $('#print-area').innerHTML = pages.map(s => {
    if ((s.company.layout || 'proposal') !== 'legacy') return proposalInvoice(s);
    const lines = s.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.orderNo)}${l.shipKb === 5 ? (l.quantity < 0 ? ' 赤' : ' 黒') : ''}</td><td>${esc(l.itemName)}</td><td class="num">${l.quantity}</td><td>${esc(l.unit || '')}</td><td class="num">${yen(l.price)}</td><td class="num">${yen(l.net)}</td><td>${esc(l.siteName || '')}${l.remarks ? ' ' + esc(l.remarks) : ''}</td></tr>`).join('')
      + `<tr class="subtotal"><td colspan="6" class="right">現場計</td><td class="num"><b>${yen(s.net)}</b></td><td></td></tr>`;
    return `<section class="invoice-doc">
    <h1>請 求 書</h1>${s.copy || siteNo(s) > 1 ? `<p style="text-align:right"><span class="reissue">${s.copy ? `控え（${siteNo(s)}回目の発行分）` : `${esc(s.company.saisyutsu || '再発行')}（${siteNo(s)}回目）`}</span></p>` : ''}
    <div class="inv-top"><div><p class="to">${esc(s.customer.name)} 御中</p><p>${esc(s.customer.address)}</p></div>
      <div style="text-align:right"><p><b>${esc(s.company.name)}</b>${s.company.invoiceNo ? `　登録番号 ${esc(s.company.invoiceNo)}` : ''}<br>${esc(s.company.address)}<br>TEL ${esc(s.company.tel)}${s.company.fax ? ' FAX ' + esc(s.company.fax) : ''}</p>${s.company.bankText ? `<p>振込先 ${esc(s.company.bankText)}</p>` : ''}<p class="stamp">発行日 ${esc(s.issuedOn || today())}${s.copy ? '（控え）' : ''}　請求No. ${s.invoiceId}-${s.issueNo}</p></div></div>
    <table class="totals"><tr><th>請求年月日</th><th>得意先コード</th><th>締日</th><th>お支払期日</th></tr><tr><td>${esc(s.closing)}</td><td>${esc(s.customer.code)}</td><td>${esc(String(Number(s.closing.slice(8))))}</td><td>${esc(s.due)}</td></tr></table>
    <table class="totals"><tr><th>工事名</th><th>当月御買上額</th><th>消費税額</th><th>当月値引額</th><th>当月御請求額</th></tr>
      <tr><td>${esc(s.siteName || '')}${s.pages > 1 ? `（${s.page}/${s.pages}）` : ''}</td><td class="num">${yen(s.net)}</td><td class="num">${yen(s.tax)}</td><td class="num">${yen(s.discount || 0)}</td><td class="num">${yen(s.total)}</td></tr></table>
    <table><tr><th>年月日</th><th>伝票番号</th><th>商品名</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th><th>備考</th></tr>${lines}</table>
    <table><tr><th>税率区分</th><th>対象額(税抜)</th><th>消費税</th></tr>${s.buckets.map(b => `<tr><td>${b.rate}%対象</td><td class="num">${yen(b.net)}</td><td class="num">${yen(b.tax)}</td></tr>`).join('')}</table>
    </section>`; }).join('');
  toast(docs.some(d => d.copy) ? `請求書の控え ${pages.length}枚を印刷します` : `請求書 ${pages.length}枚を印刷します`);
  setTimeout(() => window.print(), 300);
}

// ----- 入金消込 (NO17) -----
const RC_KEYS = [['bank', 'BANK'], ['cash', 'CASH'], ['notes', 'NOTE'], ['fee', 'FEE'], ['coop', 'COOP'], ['deposit', 'DEPOSIT'], ['discount', 'DISCOUNT'], ['loss', 'LOSS']];
// 提案書 スライド19・21：得意先×請求年月の 前回残高・当月請求金額・今回請求金額・消込金額・消込残高（得意先は部分一致）
const ledgerTable = (d, { clear = false } = {}) => table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '請求年月', value: r => r.month }, { label: '前回残高', num: 1, html: r => (r.prev ? `<b class="${r.prev > 0 ? 'check-ng' : ''}">${yen(r.prev)}</b>` : '0') },
  { label: '当月請求金額', num: 1, value: r => yen(r.current) }, { label: '今回請求金額', num: 1, value: r => yen(r.claim) }, { label: '消込金額', num: 1, value: r => yen(r.cleared) }, { label: '消込残高', num: 1, html: r => (r.remain ? `<b class="${r.latest ? '' : 'check-ng'}">${yen(r.remain)}</b>` : '0') },
  // 消込済みでも月次確定前は［修正］で選び直して入金を更新できる（2026-10-27）
  ...(clear ? [{ label: '', html: r => (r.latest && (r.remain > 0 || r.receipt) && canWrite() ? `<button class="mini ${r.receipt ? 'edit' : 'primary'}" data-act="clear" data-customer="${esc(r.customer)}" data-receipt="${r.receipt || ''}">${r.receipt ? '修正' : '消込'}</button>` : '') }] : [])], d.rows,
  { empty: '該当する請求はありません', rowClass: r => (r.latest ? '' : 'muted'), foot: ['合計', '', '', yen(d.totals.current), '', yen(d.totals.cleared), yen(d.totals.remain), ...(clear ? [''] : [])] });
async function arLedgerView(q) {
  const A = actions; A.view = d => go('invoices', { view: d.view });
  // 請求書状況で絞込（検索結果を絞るだけで DB は読まない）。合計は絞込後の行で計算
  const LG_STATES = ['draft', 'issued', 'partial', 'paid', 'credit'], st = LG_STATES.includes(q.lstate) ? q.lstate : '';
  const month = q.ledgerMonth === 'all' ? '' : q.ledgerMonth || thisMonth(); // 請求年月の既定は当月、空欄で検索するとすべての年月（2026-10-27）
  const all = await api('/api/ar-ledger?' + qs({ customer: q.ledgerCustomer, month })), rows = all.rows.filter(r => !st || r.status === st);
  const d = { rows, totals: { current: rows.reduce((n, r) => n + r.current, 0), cleared: rows.reduce((n, r) => n + r.cleared, 0), remain: rows.filter(r => r.latest).reduce((n, r) => n + r.remain, 0) } };
  A.search = () => go('invoices', { view: 'ledger', ledgerCustomer: $('#lg-cust').value, ledgerMonth: $('#lg-month').value || 'all', lstate: st });
  return page('請求締め・発行', '請求残高照会：得意先×請求年月で 前回残高 → 当月請求金額 → 今回請求金額 → 消込金額（締日翌日〜次の締日の入金）→ 消込残高。',
    `<input type="month" id="lg-month" value="${esc(month)}"><input id="lg-cust" list="dl-pcust" autocomplete="off" placeholder="得意先（部分一致）" value="${esc(q.ledgerCustomer || '')}" style="width:200px">${custHints()}<button class="primary" data-act="search">検索</button><select id="lg-state" title="請求書状況">${options(LG_STATES.map(code => ({ code, name: STATUS[code][0] })), st, { blank: 'すべての請求書状況', label: x => x.name })}</select><a class="button" href="/api/ar-ledger?${qs({ customer: q.ledgerCustomer, month, state: st, format: 'xlsx' })}" download>⇩ Excel</a>`,
    `<section class="card glass">${ledgerTable(d)}</section>`);
}
VIEWS.receipts = async q => {
  const A = actions;
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true));
  const tab = ['targets'].includes(q.tab) ? q.tab : 'list'; // 'plan'（入金予定一覧）は 2026-10-27 削除
  A.tab = d => go('receipts', { tab: d.tab });
  A.clear = d => receiptForm(d.customer, Number(d.receipt) || 0);
  if (tab === 'targets') {
    // 提案書 スライド19：得意先（部分一致）で検索し、残高のある請求年月の行から「消込」へ
    const all = await api('/api/ar-ledger?' + qs({ customer: q.customer }));
    // 絞込（検索結果を絞るだけで DB は読まない）：「消込対象のみ」（既定オン）＝得意先ごとの最新の請求年月で残高のある行、締日（5・10・15・20・月末）
    // 消込済み（消込残高 0）でも月次確定前の入金がある行は残す（2026-10-27。［修正］で選び直す）
    const only = q.all !== '1', cl = STD_CLOSINGS.includes(Number(q.cl)) ? Number(q.cl) : 0;
    const dayOf = c => (c === monthEnd(c.slice(0, 7)) ? 31 : Number(c.slice(8, 10)));
    // デモ版：前回残高 0 の行は出さない（10/27 打合せ。実システムでの扱いは別途確認）
    // 請求年月（2026-10-28 追加）：指定時はその年月の請求の行（「消込対象のみ」は残高か入金のある行）。空欄は従来どおり得意先ごとの最新の請求年月
    // 請求年月の初期値＝直近の締め（20日）の年月（2026-10-29）。空欄で検索したときは '-' を渡して空欄のまま
    const ym0 = q.ym === undefined ? lastClosing().slice(0, 7) : q.ym, ym = /^\d{4}-\d{2}$/.test(ym0 || '') ? ym0 : '';
    // 前残（10-29 画面レビュー No.4「10月をやる時に9月に請求残があれば9月・10月を出す」）：請求年月の指定時は、前月の消込残高が残っている行も同じ得意先の上に表示（前々月以前は確認事項No.18 で検討中のため出さない）
    const pm = ym ? new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 2, 1)).toISOString().slice(0, 7) : '';
    // 「消込対象のみ」＝［消込］／［修正］できる行（得意先の最新の請求年月で残高か入金がある行）だけ。前残の行は、その得意先が消込対象のときだけ表示（2026-10-29 ユーザー指摘）
    const ymOf = r => String(r.closing).slice(0, 7), canClear = r => r.latest && (r.remain > 0 || r.receipt);
    const tg = all.rows.filter(r => r.prev && (ym ? ymOf(r) === ym : true) && (!only || canClear(r)) && (ym || !only || r.latest) && (!cl || dayOf(r.closing) === cl)), tgc = new Set(tg.map(r => r.customer));
    // 対象年月の請求が無い得意先も、対象年月より前の直近の請求に消込残高があればその1行を表示（2026-10-30 ユーザー指摘「当月の請求が無くても未収金は回収（消込）できる」。
    // 最新の請求なら［消込］できる。「消込対象のみ」では消込できる行だけ）
    const ymc = new Set(all.rows.filter(r => ymOf(r) === ym).map(r => r.customer)), lastBefore = new Map();
    if (ym) for (const r of all.rows) if (ymOf(r) < ym && !ymc.has(r.customer)) lastBefore.set(r.customer, r);
    const rows = all.rows.filter(r => (tg.includes(r) || (ym && ymOf(r) === pm && r.remain > 0 && tgc.has(r.customer)) || (lastBefore.get(r.customer) === r && r.remain > 0 && (!only || canClear(r)))) && (!cl || tg.includes(r) || dayOf(r.closing) === cl)), sum = k => rows.reduce((n, r) => n + r[k], 0);
    const ymLabel = m => `${m.slice(0, 4)}年${Number(m.slice(5, 7))}月`, months = [...new Set(rows.map(r => String(r.closing).slice(0, 7)))].sort();
    const prior = months.filter(m => m < ym), target = ym ? `${ymLabel(ym)}${prior.length ? `（前残 ${prior.length === 1 ? ymLabel(prior[0]) : `${ymLabel(prior[0])}〜${ymLabel(prior[prior.length - 1])}`} を含む）` : ''}` : !months.length ? '該当なし' : months.length === 1 ? ymLabel(months[0]) : `${ymLabel(months[0])}〜${ymLabel(months[months.length - 1])}（得意先ごとの最新）`;
    const d = { rows, totals: { current: sum('current'), cleared: sum('cleared'), remain: rows.filter(r => r.latest).reduce((n, r) => n + r.remain, 0) } };
    A.search = () => go('receipts', { tab, customer: $('#rt-cust').value, all: q.all, cl: q.cl, ym: $('#rt-ym').value || '-' });
    return page('入金消込', '対象年月の請求と、前月に消込残高が残っている請求（前残）を得意先ごとに表示します。対象年月の請求が無い得意先も、直近の請求に消込残高があれば表示し、［消込］できます。［消込］を押すと、その得意先の入金消込画面を開きます（請求の古い順に消し込みます）。消込済みでも月次確定前は［修正］で入金を更新できます。', `<input id="rt-cust" list="dl-pcust" autocomplete="off" placeholder="得意先（部分一致）" value="${esc(q.customer || '')}" style="width:200px">${custHints()}<label class="field">請求年月<input type="month" id="rt-ym" value="${esc(ym)}" title="空欄＝得意先ごとの最新の請求年月"></label><select id="rt-cl" title="締日">${options(STD_CLOSINGS.map(x => ({ code: String(x), name: closingLabel(x) })), cl ? String(cl) : '', { blank: 'すべての締日', label: x => x.name })}</select>
       <button class="primary" data-act="search">検索</button><label class="small"><input type="checkbox" id="rt-only" ${only ? 'checked' : ''}> 消込対象のみ</label>`,
      `<section class="card glass"><div class="card-head"><h2>消込対象 ${esc(target)}</h2><span class="muted small">${ym ? '対象年月の請求＋前月の消込残高（前残）・対象年月の請求が無い得意先は直近の請求' : '請求年月が空欄のため、得意先ごとの最新の請求年月を表示'}${cl ? `・締日 ${esc(closingLabel(cl))}` : ''}</span></div>${ledgerTable(d, { clear: true })}</section>`);
  }
  const month = q.month || thisMonth(), all = await api('/api/receipts?' + qs({ month, customer: q.customer }));
  // 状態の絞込（すべて／計上済／取消済。2026-10-27 チェック「計上済のみ」から変更）
  const RSTATES = { POSTED: '計上済', REVERSED: '取消済' }, rst = RSTATES[q.rstate] ? q.rstate : q.posted === '1' ? 'POSTED' : '', list = rst ? all.filter(r => r.status === rst) : all;
  A.rev = d => confirmBox('入金の取消', `入金No ${d.no} を取消します。消込が解除され、逆仕訳を計上します。`, () => post('/api/receipts/reverse', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('入金消込', '得意先ごとに、請求（得意先×請求年月）に対する入金を消し込みます。当座預金・現金・手形・振込手数料・協力会費・預り金充当・値引を処理します（receipt / receipt_component / receipt_allocation）。',
    `${monthInput('month', month)}${comboFilter('customer', 'customers', q.customer || '', '得意先（コード・名称）')}<select id="rec-state" title="状態">${options(Object.entries(RSTATES).map(([code, name]) => ({ code, name })), rst, { blank: 'すべて', label: x => x.name })}</select>${csvLink('receipts', { month })}`,
    `<section class="card glass" data-sub="list">${table([{ label: '入金No', value: r => r.no }, { label: '入金日', value: r => r.date }, { label: '得意先', value: r => r.customerName }, { label: '振込', num: 1, value: r => yen(r.bank) }, { label: '銀行', value: r => nameOf('banks', r.bankCode) },
      { label: '現金', num: 1, value: r => yen(r.cash) }, { label: '手形', num: 1, value: r => yen(r.notes) }, { label: '手数料', num: 1, value: r => yen(r.fee) }, { label: '協力会費', num: 1, value: r => yen(r.coop) }, { label: '預り金', num: 1, value: r => yen(r.deposit) }, { label: '値引', num: 1, value: r => yen(r.discount) }, { label: '雑損失', num: 1, value: r => yen(r.loss) }, { label: '消込額', num: 1, value: r => yen(r.settlement) },
      { label: '消込先(請求No)', value: r => r.allocations.map(a => `${a.invoiceId}`).join(', ') }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }], list, { empty: 'この条件の入金はありません', rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section><div data-sub="schedule">${receiptScheduleCard()}</div>`);
};
// 入金消込（提案書 スライド20「消込画面」の並び）：消込対象（得意先×請求年月）→ 仕訳明細入力（当座預金・振込手数料・協力金・預り金・雑損失・値引き・現金）→ 消込金額 → 登録
// 消込対象は最新の請求年月の1行に、請求残高（前月までの未入金）・当月請求金額・今回請求金額をまとめる。消込金額は請求No の古い順に自動配分（内訳で変更可）
const RC_ROWS = [['bank', '当座預金（振込）', '当座預金 1112・入金口座の内訳'], ['fee', '振込手数料', '先方差引・雑費 8330-101（B-02）'], ['coop', '協力金', '協力会費・災防協会費の差引・雑費 8330-107（B-03）'],
  ['deposit', '預り金', '預り金 4170 から充当（B-06）'], ['loss', '雑損失', '端数等・8850・対象外'], ['discount', '値引き', '8850（B-04）'], ['cash', '現金', '現金 1111']];
// 入金消込の入力（「入金消込」一覧の「消込」から得意先を決めて開く。得意先の選び直しはしない）
// receiptId＝修正する入金（月次確定前。元の入金を取り消して登録し直す。2026-10-27）
function receiptForm(customer, receiptId = 0) {
  const key = uuid(), cu = masters.customers.find(c => c.code === customer);
  const rcRow = ([k, l, h]) => `<tr><th>${esc(l)}</th><td><input name="${k}" class="num" value="0" style="width:150px"></td><td class="small muted">${esc(h)}${k === 'bank' ? `<br><select name="bankCode" aria-label="入金口座">${options(active('banks'), active('banks')[0]?.code)}</select>` : ''}${k === 'deposit' ? '<br><span id="rc-dep">預り金残高: -</span>' : ''}</td></tr>`;
  modal({ title: receiptId ? '入金消込（修正）' : '入金消込', wide: true, submit: receiptId ? '更新' : '登録', body: `${receiptId ? '<p class="small" id="rc-edit">読み込み中…</p>' : sampleButton}<div class="form-grid">
    ${field('得意先', `<input value="${esc(customer)} ${esc(cu?.name || '')}" readonly><input type="hidden" name="customer" value="${esc(customer)}">`)}
    ${/* 入金日は入力しない（10/27 内部会議 No.22：振込は月1回まとめて入る）。値は従来の初期値（直近の締日）、修正は元の入金の日付のまま */ ''}<input type="hidden" name="date" value="${lastClosing()}"></div>
    <h3 style="margin-top:14px">消込画面</h3><div id="rc-open" class="muted small">読み込み中…</div>
    <h3 style="margin-top:14px">仕訳明細入力</h3>
    <div class="table-wrap"><table class="rc-journal"><thead><tr><th>科目</th><th class="num">金額</th><th>補足</th></tr></thead><tbody>${RC_ROWS.map(rcRow).join('')}
      <tr class="muted"><th>手形・でんさい</th><td><input name="notes" class="num" value="0" style="width:150px"></td><td class="small">受取手形 1120<label class="rc-inline">手形期日 <input type="date" name="noteDue"></label></td></tr></tbody>
      <tfoot><tr><th>消込金額</th><td class="num"><b id="rc-sum">0</b></td><td id="rc-diff" class="small"></td></tr></tfoot></table></div>
    <label class="field wide" style="margin-top:8px"><span>差額の扱い</span><span><input type="checkbox" name="overpayToDeposit"> 今回請求金額を超えた分（過入金）を預り金として受け入れる（貸方 預り金 4170）</span></label>
    <details id="rc-detail" hidden><summary>請求No 別の消込内訳</summary><div id="rc-alloc" class="small muted" style="margin-top:6px"></div></details>`,
    onOpen: f => {
      let ctx = { invoices: [], deposit: 0 }, manual = false;
      const total = () => RC_KEYS.reduce((n, [k]) => n + (Number(f[k].value) || 0), 0);
      const invs = () => ctx.invoices, latest = () => invs().length ? invs()[invs().length - 1].month : '';
      const auto = () => { let rest = total(); for (const x of $$('.rc-amt')) { const b = Number(x.dataset.balance), v = Math.min(b, Math.max(rest, 0)); x.value = v; rest -= v; } };
      const refresh = () => {
        if (!manual) auto();
        const t = total(), a = $$('.rc-amt').reduce((n, x) => n + (Number(x.value) || 0), 0), open = invs().reduce((n, r) => n + r.balance, 0);
        $('#rc-sum').textContent = yen(t);
        $('#rc-dep').innerHTML = `預り金残高: ${yen(ctx.deposit)} 円${Number(f.deposit.value) > ctx.deposit ? ' <span class="check-ng">残高超過</span>' : ''}`;
        $('#rc-diff').innerHTML = t === a ? `<span class="check-ok">消込金額 ${yen(a)} 円を配分済み</span>`
          : t > a && a >= open ? `<span class="${f.overpayToDeposit.checked ? 'check-ok' : 'check-ng'}">今回請求金額を ${yen(t - a)} 円超えています${f.overpayToDeposit.checked ? '（預り金で受入）' : '（「差額の扱い」を選ぶか金額を見直してください）'}</span>`
          : t > a ? `<span class="check-ng">未配分 ${yen(t - a)} 円（内訳を見直すか「古い順に自動配分に戻す」を押してください）</span>` : `<span class="check-ng">内訳の合計 ${yen(a)} 円が消込金額を超えています</span>`;
        const cell = $('#rc-cleared'), left = $('#rc-left'); if (cell) cell.textContent = yen(a); if (left) left.textContent = yen(open - a);
        $$('.rc-amt').forEach(x => { const l = $(`#rc-left-${x.dataset.id}`); if (l) l.textContent = yen(Number(x.dataset.balance) - (Number(x.value) || 0)); });
      };
      const load = async () => {
        manual = false;
        ctx = await api('/api/receipt-context?' + qs({ customer, exclude: receiptId || '' }));
        const m = latest(), prior = invs().filter(r => r.month !== m), cur = invs().filter(r => r.month === m), sum = (l, k) => l.reduce((n, r) => n + r[k], 0);
        const partly = sum(cur, 'paid');
        $('#rc-open').innerHTML = !invs().length ? '<span class="muted">残高のある請求はありません</span>'
          : `<div class="table-wrap"><table><thead><tr><th>得意先</th><th>請求年月</th><th class="num">請求残高</th><th class="num">当月請求金額</th><th class="num">今回請求金額</th><th class="num">消込金額</th><th class="num">消込残高</th></tr></thead>
            <tbody><tr><td>${esc(customer)} ${esc(cu?.name || '')}</td><td>${esc(m)}</td><td class="num">${yen(sum(prior, 'balance'))}</td><td class="num">${yen(sum(cur, 'balance'))}${partly ? `<br><span class="small muted">（一部入金済 ${yen(partly)}）</span>` : ''}</td>
            <td class="num"><b>${yen(sum(invs(), 'balance'))}</b></td><td class="num" id="rc-cleared">0</td><td class="num" id="rc-left">${yen(sum(invs(), 'balance'))}</td></tr></tbody></table></div>
            `;
        $('#rc-alloc').innerHTML = !invs().length ? '' : table([{ label: '請求年月', value: r => r.month }, { label: '締日', value: r => r.closing }, { label: '請求No', value: r => r.id }, { label: '状態', html: r => status(r.status) }, { label: '請求金額', num: 1, value: r => yen(r.total) }, { label: '入金済', num: 1, value: r => yen(r.paid) },
          { label: '請求残高', num: 1, value: r => yen(r.balance) }, { label: '消込金額', html: r => `<input class="num rc-amt" data-id="${r.id}" data-balance="${r.balance}" value="0" style="width:130px">` }, { label: '消込残高', num: 1, html: r => `<span id="rc-left-${r.id}">${yen(r.balance)}</span>` }], invs())
          + '<p><button type="button" class="mini" id="rc-auto">古い順に自動配分に戻す</button></p>';
        $$('.rc-amt').forEach(x => (x.oninput = () => { manual = true; refresh(); }));
        const b = $('#rc-auto'); if (b) b.onclick = () => { manual = false; refresh(); };
        refresh();
      };
      RC_KEYS.forEach(([k]) => (f[k].oninput = refresh)); f.overpayToDeposit.onchange = refresh;
      // 修正：元の入金の内容（入金日・仕訳明細・口座・消込内訳）を入れて開く
      const edit = async () => {
        const old = (await api('/api/receipts?' + qs({ customer }))).find(r => r.id === receiptId);
        if (!old) return ($('#rc-edit').textContent = '修正する入金が見つかりません');
        $('#rc-edit').innerHTML = `入金No <b>${esc(old.no)}</b>（${esc(String(old.date).slice(0, 10))}）を修正します。「更新」で元の入金を取り消し（逆仕訳）、この内容で登録し直します。`;
        f.date.value = String(old.date).slice(0, 10); for (const [k, kind] of RC_KEYS) f[k].value = old[k] || 0;
        if (old.bankCode) f.bankCode.value = old.bankCode; if (old.noteDue) f.noteDue.value = String(old.noteDue).slice(0, 10); f.overpayToDeposit.checked = old.overpay > 0;
        await load(); manual = true;
        $$('.rc-amt').forEach(x => (x.value = old.allocations.filter(a => a.invoiceId === Number(x.dataset.id)).reduce((n, a) => n + a.amount, 0)));
        RC_KEYS.forEach(([k]) => (f[k].oninput = () => { manual = false; refresh(); })); // 金額を直したら古い順に配分し直す
        refresh();
      };
      if (receiptId) edit().catch(e => toast(e.message, true)); else load();
      // サンプル入力：振込（手数料差引）で今回請求金額の全額を消し込む値を入れる（登録はしない）
      f.querySelector('[data-sample]')?.addEventListener('click', () => {
        if (!invs().length) return toast('この得意先には残高のある請求がありません', true);
        const due = invs().reduce((n, r) => n + r.balance, 0), fee = due > 10000 ? 660 : 0;
        for (const [k] of RC_KEYS) f[k].value = 0;
        f.fee.value = fee; f.bank.value = due - fee;
        refresh();
      });
    },
    onSubmit: async v => {
      const allocations = $$('.rc-amt').map(x => ({ invoiceId: Number(x.dataset.id), amount: Number(x.value) || 0 })).filter(a => a.amount > 0);
      const body = { ...v, overpayToDeposit: v.overpayToDeposit === 'on', allocations, idempotencyKey: key };
      if (receiptId) { const r = await post('/api/receipts/update', { ...body, id: receiptId }); toast(`入金を修正しました（新しい入金No ${r.no}。元の入金は取消・逆仕訳）`); return render(); }
      const r = await post('/api/receipts', body); toast(`入金 ${r.no} を登録しました（仕訳 B01）`); render();
    } });
}

// ----- 明細行の入力表（仕入・定時請求・小口現金で共用） -----
// cols: [{ name, label, cell: row => input html, sum?: true }]。行の値は readLines で読む（ヘッダー項目と name が重ならないこと）。
// lineNo：先頭に行番号（01, 02 …）の列を付け、行追加・削除のたびに連番を振り直す（2026-10-29 商品仕入）
const lineGrid = (id, cols, rowsIn = [{}, {}, {}], { lineNo = false } = {}) => {
  const tr = (r, i = 0) => `<tr>${lineNo ? `<td class="line-no">${String(i + 1).padStart(2, '0')}</td>` : ''}${cols.map(c => `<td>${c.cell(r)}</td>`).join('')}<td><button type="button" class="mini quiet" data-line="del" aria-label="行を削除">×</button></td></tr>`;
  lineGrid.row[id] = () => tr({});
  return `<div class="table-wrap"><table class="line-grid" id="${id}"><thead><tr>${lineNo ? '<th class="line-no">行</th>' : ''}${cols.map(c => `<th class="${c.sum ? 'num' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${rowsIn.map(tr).join('')}</tbody>
    <tfoot><tr><td colspan="${cols.length + 1 + (lineNo ? 1 : 0)}"><button type="button" class="mini" data-line="add" data-grid="${id}">＋ 行追加</button><span class="right" style="float:right">合計 <b id="${id}-total">0</b> 円</span></td></tr></tfoot></table></div>`;
};
lineGrid.row = {};
const readLines = id => $$(`#${id} tbody tr`).map(tr => Object.fromEntries($$('[name]', tr).map(el => [el.name, el.value])));
const lineTotal = (id, field = 'amount', calc) => { const t = $(`#${id}-total`); if (t) t.textContent = yen($$(`#${id} tbody tr`).reduce((n, tr) => n + (calc ? calc(tr) : Number(String(tr.querySelector(`[name=${field}]`)?.value || '').replace(/,/g, '')) || 0), 0)); };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-line]'); if (!b) return; e.preventDefault();
  const tbody = b.dataset.line === 'add' ? $(`#${b.dataset.grid} tbody`) : b.closest('tbody');
  if (b.dataset.line === 'add') tbody.insertAdjacentHTML('beforeend', lineGrid.row[b.dataset.grid]());
  else if (tbody.rows.length > 1) b.closest('tr').remove();
  $$('td.line-no', tbody).forEach((td, i) => (td.textContent = String(i + 1).padStart(2, '0')));
  tbody.dispatchEvent(new Event('input', { bubbles: true }));
});
// 処税率は3桁のコードだけ表示（10-29 画面レビュー No.15b「解説は不要、241 などコードだけ」）。名称はマウスを重ねると表示
const taxSelect = (name, value) => `<select name="${name}">${meta.taxCodes.map(t => `<option value="${t.code}" title="${esc(t.name)}" ${t.code === value ? 'selected' : ''}>${esc(t.code)}</option>`).join('')}</select>`;

// ----- 商品仕入（10/19 打合せ・帳票⑭）-----
VIEWS.purchases = async q => {
  const A = actions;
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true));
  const month = q.month || thisMonth(), list = await api('/api/purchases?' + qs({ month, vendor: q.vendor }));
  // 明細は現行の商品仕入登録リスト（帳票⑭）と同じ並び：行・商品コード・商品名・数量・単位・単価・金額・処税率（2026-10-29。消費税率→処税率に戻す）。商品コードは入力（候補は商品マスタ）
  // 2026-10-29 画面・帳票処理イメージ一覧の指摘：種別は置かず商品コードで決める（運賃の商品コードなら金額だけ入力）・摘要は現行の入力画面にないので置かない・単位にガイダンス
  const isFreight = it => /運賃/.test(it?.name || '');
  // 値引き（88888 等）は商品仕入では使わない：候補に出さず、入力しても選べない（2026-10-29）
  const noPurchase = it => /値引/.test(it?.name || ''), puItems = () => active('items').filter(i => !noPurchase(i));
  const cols = [{ name: 'item', label: '商品コード', cell: () => '<input name="item" list="dl-pu-items" maxlength="12" style="width:90px" autocomplete="off">' }, { name: 'iname', label: '商品名', cell: () => '<span data-iname class="muted small">商品コードを入力</span>' },
    { name: 'quantity', label: '数量', cell: () => '<input name="quantity" class="num" style="width:90px">' }, { name: 'unit', label: '単位', cell: () => '<span data-unit class="muted small">マスタの単位</span>' },
    { name: 'price', label: '単価', cell: () => '<input name="price" class="num" style="width:100px" inputmode="decimal" placeholder="マスタ単価" title="小数2桁まで（例 2267.40）">' }, { name: 'amount', label: '金額', sum: 1, cell: () => '<input name="amount" class="num" style="width:120px" placeholder="自動">' },
    { name: 'taxCode', label: '処税率', cell: () => taxSelect('taxCode', '241') }];
  const calc = tr => { const f = n => tr.querySelector(`[name=${n}]`), code = f('item').value.trim(), hit = masters.items.find(i => i.code === code && !noPurchase(i)), fr = isFreight(hit), nm = tr.querySelector('[data-iname]'), un = tr.querySelector('[data-unit]');
    nm.innerHTML = code && !hit ? `<span class="check-ng">${masters.items.some(i => i.code === code) ? '仕入では使えない商品' : '該当なし'}</span>` : hit ? esc(hit.name) : '商品コードを入力'; nm.classList.toggle('muted', !hit);
    if (!fr) { const it = hit, qn = Number(f('quantity').value || 0), pr = f('price').value === '' ? Number(it?.price || 0) : Number(f('price').value.replace(/,/g, ''));
      un.textContent = it?.unit ? nameOf('units', it.unit) || it.unit : 'マスタの単位'; un.classList.toggle('muted', !it?.unit); f('amount').value = qn && pr ? Math.trunc(Math.round(qn * 100) * Math.round(pr * 100) / 10000) : ''; f('amount').readOnly = true; f('amount').placeholder = '自動'; f('quantity').disabled = false; f('price').disabled = false; }
    else { f('amount').readOnly = false; f('amount').placeholder = '運賃の金額'; f('quantity').disabled = true; f('price').disabled = true; un.textContent = '（金額のみ）'; un.classList.add('muted'); }
    return Number(f('amount').value || 0); };
  // 伝票No.：5桁＋行番号2桁の枝番（10/28 打合せ No.21。例 53192-01）。サーバの purchaseNo と同じ
  const pNo = (no, line) => String(no || '').replace(/\D/g, '').slice(-5).padStart(5, '0') + (line ? '-' + String(line).padStart(2, '0') : '');
  // ヘッダー：伝票No（キー。2026-10-29 指摘で先頭に）→ 仕入日（納入日）→ 仕入先（業者）→ 区分（10-29 画面レビュー No.11）。伝票摘要は根拠がないため置かない
  // サンプル入力は通常の商品から選ぶ（値引き・運賃は選ばない）
  const pickItem = f => { const it = puItems().filter(i => !isFreight(i)), tr = f.querySelector('#pu-lines tbody tr'), el = tr?.querySelector('[name=item]'); if (el && it.length && !hit(el.value)) { el.value = it[Math.floor(Math.random() * it.length)].code; el.dispatchEvent(new Event('input', { bubbles: true })); } };
  const hit = code => puItems().some(i => i.code === String(code || '').trim());
  A.new = () => modal({ title: '商品仕入の登録', submit: '登録する', wide: true, sample: pickItem, body: `<div class="form-grid">${field('伝票No', '<input value="（登録時に自動採番）" disabled>')}<div></div>${field('仕入日（納入日）', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('仕入先（業者）', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('区分', `<select name="kind">${Object.entries(meta.purchaseKinds).map(([k, v]) => `<option value="${k}">${k} ${esc(v)}</option>`).join('')}</select>`)}</div>
      <datalist id="dl-pu-items">${puItems().map(i => `<option value="${esc(i.code)}">${esc(i.name)}</option>`).join('')}</datalist>
      ${lineGrid('pu-lines', cols, undefined, { lineNo: true })}`,
    onOpen: f => { const g = $('#pu-lines'); g.addEventListener('input', () => lineTotal('pu-lines', 'amount', calc)); g.addEventListener('change', () => lineTotal('pu-lines', 'amount', calc)); },
    onSubmit: async v => { const lines = readLines('pu-lines').map(l => { const item = String(l.item || '').trim(); return { ...l, item, lineKind: isFreight(masters.items.find(i => i.code === item)) ? '2' : '1' }; }); const r = await post('/api/purchases', { date: v.date, vendor: v.vendor, kind: v.kind, memo: v.memo, lines }); toast(`仕入 ${pNo(r.no)}（${r.lines}行・${yen(r.net)}円）を登録しました`); render(); } });
  A.del = d => confirmBox('仕入の取消', `仕入伝票 ${pNo(d.no)} の全明細を削除します。`, () => post('/api/purchases/delete', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('商品仕入', '業者からの商品仕入を伝票（複数明細）で記録します（purchase）。区分 1=仕入／2=他社納入、運賃行あり。', `${monthInput('month', month)}${filterSelect('vendor', masters.vendors, q.vendor, 'すべての業者')}${csvLink('purchases', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 仕入登録</button>' : ''}`,
    `<section class="card glass" data-sub="list">${table([{ label: '伝票No.', value: r => pNo(r.no, r.line) }, { label: '仕入日', value: r => r.date }, { label: '区分', value: r => r.kindName }, { label: '業者', value: r => r.vendorName },
      { label: '商品', value: r => `${r.itemName || r.item}${r.lineKind === '2' && !/運賃/.test(r.itemName || '') ? '（運賃）' : ''}` }, { label: '数量', num: 1, value: r => (r.lineKind === '2' ? '' : `${r.quantity} ${r.unit || ''}`) },
      { label: '単価', num: 1, value: r => (r.lineKind === '2' ? '' : Number(r.price).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '処税率', value: r => r.taxCode },
      { label: '', html: r => canWrite() && r.line === 1 ? `<button class="mini danger" data-act="del" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }], list, { foot: ['合計', '', '', '', '', '', '', yen(list.reduce((n, r) => n + r.net, 0)), '', ''] })}</section>
    <div data-sub="reports">${miscCard('商品仕入登録リスト', '業者別・伝票明細', rangeInputs('pl', '仕入日'), '<button data-act="misc" data-kind="purchase-register" data-src="pl">⇩ Excel</button>')}</div>`);
};

// ----- 在庫計上 -----
// 10/21 打合せ：実在庫登録（調査日＝毎月20日、商品マスタの品目ごとに棚卸の在庫数量）→ 配合計算 → 材料受払表 → 在庫計上（月次1回・洗い替え仕訳 C01）
const lastClosing = () => { const [y, m, d] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 1 + (d >= 20 ? 0 : -1), 20)).toISOString().slice(0, 10); };
VIEWS.inventory = async q => {
  const A = actions;
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true)); A.mix = () => mixDialog().catch(e => toast(e.message, true));
  const [list, cnt] = await Promise.all([api('/api/inventory?' + qs({ month: q.month || thisMonth() })), api('/api/inventory/counts?' + qs({ date: q.date || lastClosing() }))]);
  A.countSave = async (_, btn) => {
    const lines = $$('.ic-qty').filter(x => x.value.trim() !== x.dataset.orig).map(x => ({ item: x.dataset.item, quantity: x.value.trim().replace(/,/g, '') }));
    if (!lines.length) return toast(`変更された在庫数量がありません。「在庫数量」欄に数量を入力・変更してから［登録］してください（${cnt.items.filter(r => qtyOf(r.quantity) !== '').length}件は登録済みで、そのまま有効です）`, true);
    // サーバのエラー（在庫計上済み・月次確定済み・数量の誤り 等）は確認ポップアップで表示する（以前は何も出ず、登録されたか分からなかった）
    if (btn) btn.disabled = true;
    try { const r = await post('/api/inventory/counts', { date: $('#ic-date').value, lines }); toast(`${r.month} 月度の実在庫を登録しました（${r.saved}件${r.cleared ? `・取消 ${r.cleared}件` : ''}）`); await render(); }
    catch (e) { alertBox(e.message); } finally { if (btn) btn.disabled = false; }
  };
  A.post = () => { const month = $('#ip-month').value; confirmBox('在庫計上', `${month} 月度の実在庫を評価し、月末在庫の洗い替え仕訳（C01）を作成します。在庫計上は月度ごとに1回です。`, async () => { const r = await post('/api/inventory/post', { month }); render(); alertBox(`計上月度　${r.month}
品目数　　${r.items} 品目
評価額　　${yen(r.value)} 円
仕訳日付　${r.date}
伝票番号　${r.slipNo ? r.slipNo + '（在庫計上 C01）' : 'なし（評価額・前月末在庫とも 0 円のため仕訳は作成されていません。評価単価は前月の評価単価と当月度の商品仕入から計算します）'}`, { ok: true, title: '在庫計上が完了しました' }); }, '在庫計上する'); };
  A.unpost = () => { const month = $('#ip-month').value; confirmBox('在庫計上の取消', `${month} 月度の在庫計上を取消し、洗い替え仕訳を逆仕訳します。実在庫の数量は残ります。`, async () => { const r = await post('/api/inventory/unpost', { month }); render(); alertBox(`計上月度　${r.month}
逆仕訳の日付　${r.date}
逆仕訳の伝票番号　${r.slipNo || 'なし（取り消す仕訳がありませんでした）'}
実在庫の数量は残っています。「実在庫登録」で修正できます。`, { ok: true, title: '在庫計上を取消しました' }); }, '取消する'); };
  const ro = cnt.posted || !canWrite(), qtyOf = v => (v === null || v === undefined ? '' : String(v));
  const countCard = `<section class="card glass" data-sub="count"><div class="card-head"><h2>実在庫登録</h2></div>
    <div class="filters"><label class="field">調査日<input type="date" id="ic-date" name="date" data-filter value="${esc(cnt.date)}"></label><span>月度 <b>${esc(cnt.month)}</b></span>${cnt.posted ? badge('在庫計上済', 'green') : badge(`登録 ${cnt.registered}品目`, cnt.registered ? '' : 'gray')}
      <input id="ic-search" placeholder="コード・名称で絞込" style="width:200px"><label class="small"><input type="checkbox" id="ic-only"> 入力済みのみ</label>${!canWrite() ? '' : cnt.posted ? '<button class="primary" disabled title="この月度は在庫計上済みです。「在庫計上」で取消すと登録できます">登録</button><span class="muted small">（在庫計上済みのため登録できません）</span>' : '<button class="primary" data-act="countSave">登録</button>'}</div>
    ${cnt.posted ? '<p class="note small">この月度は在庫計上済みのため変更できません（入力欄はロック）。修正するときは <a href="#inventory/post">在庫計上</a> で在庫計上を取消してください。未計上の月度は上の「調査日」を変えて［検索］すると入力できます。</p>' : '<p class="note small">① ここで品目ごとの在庫数量を入力して［登録］ → ② <a href="#inventory/reports">配合計算・材料受払表</a> → ③ <a href="#inventory/post">在庫計上</a> で［在庫計上］（月度ごとに1回）。</p>'}
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table id="ic-grid"><thead><tr><th>区分</th><th>コード</th><th>商品名／製品名</th><th class="num">在庫数量</th><th>単位</th><th style="width:40%"></th></tr></thead><tbody>
    ${cnt.items.map(r => `<tr data-text="${esc((r.code + ' ' + r.name).toLowerCase())}"><td class="small muted">${esc(r.kind)}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num"><input class="num ic-qty" data-item="${esc(r.code)}" data-orig="${esc(qtyOf(r.quantity))}" value="${esc(qtyOf(r.quantity))}" inputmode="decimal" style="width:130px" ${ro ? 'disabled' : ''}></td><td>${esc(r.unit)}</td><td></td></tr>`).join('')}
    </tbody></table></div>
    <div class="filters" style="margin-top:10px"><span class="muted small">空欄は未登録。登録済みの数量を消して登録すると、その品目の実在庫を取り消します。数量は小数2桁まで。</span></div></section>`;
  const postCard = `<section class="card glass" data-sub="post"><div class="card-head"><h2>在庫計上（月次1回）</h2></div>
    <div class="filters"><label class="field">計上月度<input type="month" id="ip-month" value="${esc(cnt.month)}"></label>${canWrite() ? '<button class="primary" data-act="post">在庫計上</button><button class="danger" data-act="unpost">在庫計上の取消</button>' : ''}</div>
    </section>`;
  return page('在庫', '実在庫登録 → 配合計算 → 材料受払表 → 在庫計上（月次1回）の順に処理します（10/21 打合せ）。', `${monthInput('month', q.month || thisMonth())}${csvLink('inventory', { month: q.month || thisMonth() })}`,
    `${countCard}${postCard}<section class="card glass" data-sub="list"><h2>在庫一覧</h2>${table([{ label: '月度', value: r => r.month }, { label: '調査日', value: r => String(r.countedOn || '').slice(0, 10) }, { label: '商品', value: r => `${r.item} ${r.itemName}` }, { label: '数量', num: 1, value: r => `${r.quantity} ${r.unit || ''}` },
      { label: '評価単価', num: 1, value: r => (r.status === 'POSTED' ? yen(r.price) : '') }, { label: '評価額', num: 1, value: r => (r.status === 'POSTED' ? yen(r.value) : '') }, { label: '状態', html: r => (r.status === 'POSTED' ? badge('計上済', 'green') : badge('未計上', 'gray')) }], list, { empty: 'この条件の在庫はありません' })}</section>
    <div data-sub="reports">${miscCard('在庫登録リスト', '実在庫登録のチェックリスト。画面で確認しにくいため一覧・Excel で確認', `<label class="field">月度<input type="month" id="ir-month" value="${esc(cnt.month)}"></label>`, '<button data-act="misc" data-kind="inventory-register" data-src="ir">⇩ Excel</button>')}</div><div data-sub="reports">${inventoryReportsCard()}</div>`);
};
// 実在庫登録の絞込（コード・名称、入力済みのみ）
document.addEventListener('input', e => { if (e.target.id === 'ic-search') icFilter(); });
document.addEventListener('change', e => { if (e.target.id === 'ic-only') icFilter(); });
function icFilter() { const t = ($('#ic-search')?.value || '').trim().toLowerCase(), only = $('#ic-only')?.checked; $$('#ic-grid tbody tr').forEach(tr => { const v = tr.querySelector('.ic-qty')?.value.trim(); tr.hidden = (t && !tr.dataset.text.includes(t)) || (only && !v); }); }

// 当月度の締切日（20日締め：21日以降は翌月20日）
// 業者マスタの支払繰延区分（「1 15」＝翌月15日、「3 31」＝3か月後の月末）と支払予定日。サーバの vendorDue と同じ計算
function vendorTerms(v, date) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { label: '', due: '' };
  const set = v.payMonths !== '' || v.payDay !== '', months = v.payMonths === '' ? 1 : Number(v.payMonths), day = v.payDay === '' ? 31 : Number(v.payDay), [y, mo] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo - 1 + months + 1, 0)).getUTCDate(), due = new Date(Date.UTC(y, mo - 1 + months, Math.min(day, last))).toISOString().slice(0, 10);
  const when = `${months === 0 ? '当月' : months === 1 ? '翌月' : months + 'か月後の'}${day >= 31 ? '月末' : day + '日'}`;
  return { due, label: set ? `${months} ${day}（${when}支払）→ 支払予定日 ${due}` : `未設定（翌月末支払）→ 支払予定日 ${due}` };
}
// ----- 定時請求 / 小口現金（10/19 打合せ：ヘッダー＋複数明細、合計自動、請求No＝業者ごと4桁連番、支払予定日＝業者マスタの支払繰延区分）-----
// 小口現金出納登録で先頭に出す科目（一般管理費 → 製造経費の順、2026-10-28）
const PETTY_ACCOUNTS = ['8310', '8317', '8318', '8319', '8331', '8323', '8315', '8327', '83181', '8332', '8316', '8328', '8330',
  '8254', '8255', '8257', '8256', '8258', '8253', '8260'];
function expenseView(kind) {
  return async q => {
    const A = actions;
    A.fund = () => pettyFundDialog().catch(e => toast(e.message, true)); A.refill = () => pettyRefillDialog().catch(e => toast(e.message, true));
    A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true));
    const month = q.month || thisMonth(), list = await api('/api/expenses?' + qs({ kind, month, vendor: q.vendor })), payable = kind === 'PAYABLE';
    const accs = active('accounts').filter(a => !['1111', '1112', '1120', '1131', '4121', '4415'].includes(a.code)), top = payable ? [] : PETTY_ACCOUNTS.map(c => accs.find(a => a.code === c)).filter(Boolean);
    const accOpts = top.length ? `<option value="">（科目）</option><optgroup label="小口現金でよく使う科目">${options(top, '')}</optgroup><optgroup label="その他の科目">${options(accs.filter(a => !top.includes(a)), '')}</optgroup>` : options(accs, '', { blank: '（科目）' });
    const hwCols = [{ name: 'account', label: '科目', cell: () => `<select name="account">${accOpts}</select>` },
      { name: 'sub', label: '内訳／摘要コード', cell: () => '<div class="l2"><select name="sub"><option value="">（なし）</option></select><input name="memoCode" maxlength="7" placeholder="摘要コード（工事・7桁）"></div>' },
      { label: '科目名・内訳名／摘要', cell: () => '<div class="l2"><span class="hw-names muted small">科目を選択</span><input name="lmemo" maxlength="500" placeholder="摘要（自由入力）"></div>' },
      { name: 'amount', label: '支払金額／処税率', sum: 1, cell: () => `<div class="l2"><input name="amount" class="num" inputmode="numeric">${taxSelect('taxCode', '141')}</div>` }];
    // 小口現金：支払先は明細の行ごと。1支払日＝1伝票（画面レビュー No.9）
    // 2026-10-29 画面・帳票処理イメージ一覧 v4 の指摘：支払先は自由入力ではない（業者マスタのコード）・支払先名を表示・「金額」でなく「支払額」・右は科目名・内訳名と摘要名（内訳は科目の補助で摘要コード（工事）とは別。摘要名は手入力。2026-10-29 列名を「内訳」に訂正）
    const vendorName = code => active('vendors').find(x => x.code === String(code || '').trim())?.name;
    const cols = [{ name: 'lvendor', label: '支払先コード', cell: () => '<input name="lvendor" list="dl-ex-payees" maxlength="12" placeholder="コード" style="width:84px" autocomplete="off">' }, { label: '支払先名', cell: () => '<span data-vname></span>' },
      { name: 'account', label: '科目', cell: () => `<select name="account">${accOpts}</select>` }, { name: 'sub', label: '内訳', cell: () => '<select name="sub"><option value="">（なし）</option></select>' },
      { name: 'taxCode', label: '処税率', cell: () => taxSelect('taxCode', '141') }, { name: 'amount', label: '支払額（税込）', sum: 1, cell: () => '<input name="amount" class="num" style="width:120px">' },
      { label: '科目名・内訳名／摘要名', cell: () => '<div class="l2"><span class="hw-names muted small">科目を選ぶと科目名・内訳名を表示</span><input name="lmemo" maxlength="500" placeholder="摘要名（手入力）"></div>' }];
    // 定時請求データ入力は現行 HAW050（10/21 打合せ資料 スライド5）の並び：組織・締切日／請求No／業者／支払繰延区分・合計金額 → 明細（2段）→ 対象外・内税・外税・外税消費税・合計
    const deptSel = `<select name="dept">${options(active('depts').length ? active('depts') : [{ code: '063', name: '部門063' }], '063')}</select>`;
    const head = payable ? `<div class="hw-head">
        ${field('組織', deptSel)}<div></div>${field('締切日', `<input type="date" name="date" value="${lastClosing()}">`, { req: 1 })}
        ${field('請求No', '<input value="自動採番（業者ごと4桁）" disabled>')}<div class="span2"></div>
        <div class="span2">${field('業者', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 })}</div><div></div>
        ${field('支払繰延区分', '<output id="ex-defer" class="muted">業者を選択すると業者マスタから表示</output>')}${field('支払予定日', '<input type="date" name="due" readonly tabindex="-1" style="background:transparent;border-style:dashed" title="業者マスタの支払繰延区分から自動計算（入力不可）">', { hint: '業者マスタから自動' })}${field('合計金額', '<input name="total" class="num" inputmode="numeric">', { req: 1, hint: '明細の合計と一致させる' })}
      </div>` : `<div class="form-grid">
      ${field('支払日（領収書の日付）', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('組織（部門）', deptSel)}
</div>
      <datalist id="dl-ex-payees">${active('vendors').map(x => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('')}</datalist>`;
    const sumBar = payable ? `<div class="hw-sum"><span>対象外 <b id="hw-out">0</b></span><span>内税 <b id="hw-in">0</b></span><span>外税 <b id="hw-ex">0</b></span>
      <label>外税消費税 <input name="extTax" class="num" value="0" inputmode="numeric" style="width:110px"></label><span>合計 <b id="hw-total">0</b> 円</span><span id="hw-check" class="small"></span></div>` : '';
    // 処税率の区分（1桁目 1＝内税、2・空白＝外税、税率0や対象外は対象外）
    const RATE = { 0: 0, 1: 10, 2: 3, 3: 6, 4: 2.8, 5: 5, 8: 8 }, taxClass = code => { const s3 = String(code || '').padStart(3, '0'), rate = RATE[s3[2]] || 0, taxable = rate > 0 && [1, 4, 5, 6].includes(Number(s3[1])); return { kind: !taxable ? 'out' : s3[0] === '1' ? 'in' : 'ex', rate }; };
    const num = v => Number(String(v || '').replace(/[,，\s]/g, '')) || 0;
    // 登録画面と詳細（R：登録済みの伝票）は同じ様式。詳細は値を入れて全項目を入力不可にする（2026-10-29）
    const form = R => modal({ title: R ? `${R.no} の詳細` : payable ? '定時請求データ入力' : '小口現金出納登録', submit: R ? '' : payable ? '登録' : '登録する', wide: true, sample: R ? false : payable ? f => { f.total.value = $('#hw-total').textContent.replace(/[^\d-]/g, ''); f.total.dispatchEvent(new Event('input', { bubbles: true })); } : f => { const el = f.querySelector('#ex-lines tbody tr [name=lvendor]'), vs = active('vendors'); if (el && vs.length && !vendorName(el.value)) { el.value = vs[Math.floor(Math.random() * vs.length)].code; el.dispatchEvent(new Event('input', { bubbles: true })); } }, body: `${head}${lineGrid('ex-lines', payable ? hwCols : cols, R ? R.lines.map(() => ({})) : undefined)}${sumBar}
      `,
      onOpen: () => { const g = $('#ex-lines'), f = $('#modal-body');
        const recalc = () => {
          lineTotal('ex-lines'); if (!payable) return;
          const t = { out: 0, in: 0, ex: 0 }; let calc = 0;
          $$('#ex-lines tbody tr').forEach(tr => { const a = num(tr.querySelector('[name=amount]')?.value), c = taxClass(tr.querySelector('[name=taxCode]')?.value); t[c.kind] += a; if (c.kind === 'ex') calc += Math.sign(a) * Math.floor(Math.abs(a) * c.rate / 100); });
          const ext = f.querySelector('[name=extTax]'); if (!ext.dataset.manual) ext.value = calc;
          const total = t.out + t.in + t.ex + num(ext.value), head = f.querySelector('[name=total]').value.trim();
          $('#hw-out').textContent = yen(t.out); $('#hw-in').textContent = yen(t.in); $('#hw-ex').textContent = yen(t.ex); $('#hw-total').textContent = yen(total);
          $('#hw-check').innerHTML = !head ? '<span class="muted">合計金額を入力してください</span>' : num(head) === total ? '<span class="check-ok">合計金額と一致</span>' : `<span class="check-ng">合計金額と ${yen(num(head) - total)} 円の差</span>`;
          return total;
        };
        const names = tr => { const n = tr.querySelector('.hw-names'); if (!n) return; const acc = masters.accounts.find(a => a.code === tr.querySelector('[name=account]').value), sub = active('subaccounts').find(x => x.account === acc?.code && x.code === tr.querySelector('[name=sub]').value); 
          // 上段は科目名・内訳名、下段の摘要名は手入力（小口現金も定時請求と同じ）
          n.textContent = acc ? `${acc.name}${sub ? '　' + sub.name : ''}` : payable ? '科目を選択' : '科目を選ぶと科目名・内訳名を表示'; };
        const vname = tr => { const el = tr.querySelector('[name=lvendor]'), s = tr.querySelector('[data-vname]'); if (!el || !s) return; const t = el.value.trim(), nm = vendorName(t); s.innerHTML = !t ? '' : nm ? esc(nm) : '<span class="check-ng">該当なし</span>'; };
        g.addEventListener('input', e => { if (e.target.name === 'lvendor') vname(e.target.closest('tr')); });
        if (payable) {
          $('#ex-lines-total')?.parentElement && ($('#ex-lines-total').parentElement.hidden = true);
          // 支払予定日は入力項目ではない（10-29 画面レビュー No.6）。業者マスタの支払繰延区分から計算して表示するだけ
          const due = f.querySelector('[name=due]');
          const terms = () => { const v = (masters.vendors || []).find(x => x.code === f.querySelector('[name=vendor]').value), t = vendorTerms(v, f.querySelector('[name=date]').value);
            $('#ex-defer').textContent = v ? t.label : '業者を選択すると業者マスタから表示'; due.value = v && t.due ? t.due : ''; };
          f.querySelector('[name=vendor]').addEventListener('change', terms); f.querySelector('[name=date]').addEventListener('change', terms);
          const ext = f.querySelector('[name=extTax]'); ext.addEventListener('input', () => { ext.dataset.manual = ext.value.trim() === '' ? '' : '1'; recalc(); });
          f.querySelector('[name=total]').addEventListener('input', recalc);
        }
        // 業者立替金 1431（10/28 回答②）：相殺の行。処税率は対象外に固定し、マイナスで入力する
        g.addEventListener('change', e => { if (e.target.name !== 'account') return; const tr = e.target.closest('tr'), t = tr.querySelector('[name=taxCode]'), a = tr.querySelector('[name=amount]'), adv = e.target.value === '1431';
          if (t) { if (adv && [...t.options].some(o => o.value === '090')) t.value = '090'; t.disabled = adv; } if (a) a.placeholder = adv ? '相殺額をマイナスで（例 -50000）' : ''; });
        g.addEventListener('change', e => { if (e.target.name === 'account') { const tr = e.target.closest('tr'), acc = masters.accounts.find(a => a.code === e.target.value); tr.querySelector('[name=sub]').innerHTML = '<option value="">（なし）</option>' + options(active('subaccounts').filter(s => s.account === e.target.value), ''); if (acc?.tax && tr.querySelector(`[name=taxCode] option[value="${acc.tax}"]`)) tr.querySelector('[name=taxCode]').value = acc.tax; }
          if (['account', 'sub'].includes(e.target.name)) names(e.target.closest('tr')); recalc(); });
        g.addEventListener('input', recalc); g.addEventListener('click', () => setTimeout(recalc)); recalc();
        if (R) showDoc(R, f); },
      onSubmit: async v => {
        const lines = readLines('ex-lines').map(({ lvendor, ...l }) => ({ ...l, memo: l.lmemo, ...(payable ? {} : { vendor: String(lvendor || '').trim() }) }));
        let total, extTax;
        if (payable) {
          const raw = String(v.total || '').replace(/[,，\s]/g, ''); if (!raw) throw Error('合計金額を入力してください');
          total = Number(raw); if (!Number.isInteger(total)) throw Error('合計金額は整数で入力してください');
          extTax = num(v.extTax);
          const t = lines.reduce((n, l) => n + num(l.amount), 0) + extTax;
          if (total !== t) throw Error(`合計金額（${yen(total)}円）と明細の合計（対象外＋内税＋外税＋外税消費税 ${yen(t)}円）が一致しません`);
        }
        const r = await post('/api/expenses', { kind, date: v.date, dept: v.dept, vendor: v.vendor, payee: v.payee, due: v.due, memo: v.memo, total, extTax, lines });
        toast(`${r.no}${r.billNo ? '（請求No ' + r.billNo + '）' : ''}${r.docs > 1 ? `（支払先ごとに ${r.docs} 伝票）` : ''} を登録しました${r.due ? '・支払予定日 ' + r.due : ''}（仕訳 ${payable ? 'D01' : 'E01'}）`); render(); } });
    A.new = () => form();
    A.detail = d => form(list.find(x => x.id === Number(d.id)));
    const showDoc = (R, f) => {
      const set = (el, v, ev = 'change') => { if (!el) return; if (el._flatpickr) el._flatpickr.setDate(v || '', false); el.value = v ?? ''; el.dispatchEvent(new Event(ev, { bubbles: true })); };
      const q = n => f.querySelector(`[name=${n}]`);
      set(q('date'), R.date); set(q('dept'), R.dept);
      const bill = $$('input', f).find(e => e.value.startsWith('自動採番')); if (bill) bill.value = R.billNo || '';
      if (payable) { set(q('vendor'), R.vendor); set(q('due'), R.due, 'input'); set(q('total'), R.amount, 'input'); }
      $$('#ex-lines tbody tr').forEach((tr, i) => { const l = R.lines[i], t = n => tr.querySelector(`[name=${n}]`);
        // 行に支払先が無い旧データ（伝票の見出しに支払先）は見出しの業者・支払先を出す。自由入力の支払先は名称だけ
        if (!payable) { set(t('lvendor'), l.vendor || (!l.payee && R.vendor) || '', 'input'); const vn = tr.querySelector('[data-vname]'); if (vn && !vn.textContent) vn.textContent = l.payee || R.payee || ''; } set(t('account'), l.account); set(t('sub'), l.sub); set(t('taxCode'), l.taxCode);
        set(t('amount'), taxClass(l.taxCode).kind === 'ex' ? l.net : l.amount, 'input'); set(t('memoCode'), l.memoCode, 'input'); set(t('lmemo'), l.memo, 'input'); });
      if (payable) { const ext = q('extTax'); ext.dataset.manual = '1'; set(ext, R.lines.filter(l => taxClass(l.taxCode).kind === 'ex').reduce((n, l) => n + l.tax, 0), 'input'); }
      // 値を入れ終えてから（候補入力の欄は後から作られるため次の順番で）全項目を入力不可にし、行追加・行削除を隠す
      setTimeout(() => { $$('input, select, textarea', f).forEach(el => (el.disabled = true)); $$('[data-line]', f).forEach(b => (b.style.display = 'none')); });
    };
    A.rev = d => confirmBox('伝票の取消', `${d.no} を取消し、逆仕訳を計上します。`, () => post('/api/expenses/reverse', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
    A.lines = d => { const r = list.find(x => x.id === Number(d.id)); modal({ title: `${r.no} の明細`, wide: true, body: table([{ label: '行', value: l => l.no }, { label: '科目', value: l => `${l.account} ${l.accountName}` }, { label: '内訳', value: l => (l.sub ? `${l.sub} ${l.subName}` : '') },
      ...(payable ? [] : [{ label: '支払先', value: l => l.payee }]), { label: '処税率', value: l => l.taxCode }, { label: '金額', num: 1, value: l => yen(l.amount) }, { label: 'うち消費税', num: 1, value: l => yen(l.tax) }, { label: '摘要コード', value: l => l.memoCode }, { label: '摘要名', value: l => l.memo }], r.lines) }); };
    const cols2 = [{ label: '伝票No', value: r => r.no }, ...(payable ? [{ label: '請求No', value: r => r.billNo }] : []), { label: payable ? '締切日' : '支払日', value: r => r.date }, ...(payable ? [{ label: '業者', value: r => r.vendorName }, { label: '支払予定日', value: r => r.due }] : [{ label: '支払先', value: r => r.payee }]),
      { label: '科目', html: r => `${esc(r.account)} ${esc(r.accountName || '')}${r.lines.length > 1 ? ` <button class="mini quiet" data-act="lines" data-id="${r.id}">他${r.lines.length - 1}行</button>` : ''}` }, { label: '処税率', value: r => r.taxCode }, { label: '金額', num: 1, value: r => yen(r.amount) },
      ...(payable ? [{ label: '支払済', num: 1, value: r => yen(r.paid) }, { label: '未払残高', num: 1, value: r => yen(r.balance) }] : []), { label: '摘要', value: r => r.memo }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' && !r.paid ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' },
      { label: '', html: r => `<button class="mini" data-act="detail" data-id="${r.id}">詳細</button>` }];
    return page(payable ? '定時請求' : '小口現金', payable ? '業者からの請求（買掛金）を伝票＋明細で計上します（expense_document / expense_line、仕訳 D01）。' : '小口現金での経費支出を伝票＋明細で計上します（仕訳 E01）。',
      `${monthInput('month', month)}${payable ? filterSelect('vendor', masters.vendors, q.vendor, 'すべての業者') : ''}${csvLink('expenses', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 登録</button>' : ''}`,
      `<section class="card glass" data-sub="list">${table(cols2, list, { rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section><div data-sub="${payable ? 'reports' : 'book'}">${payable ? payableReportsCard() : pettyReportsCard()}</div>`);
  };
}
VIEWS.payables = expenseView('PAYABLE');
VIEWS.cash = expenseView('PETTY_CASH');

// ----- 支払 -----
VIEWS.payments = async q => {
  const A = actions;
  A.bankList = () => { location.hash = '#journals/lists?' + qs({ tab: 'lists', list: 'BANK', from: $('#bp-from').value, to: $('#bp-to').value }); };
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true));
  const month = q.month || thisMonth(), list = await api('/api/payments?' + qs({ month }));
  A.new = () => { const key = uuid(); modal({ title: '支払の登録', wide: true, submit: '支払を登録', sample: true, body: `<div class="form-grid">${field('業者', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('支払日', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('支払元口座', `<select name="bankCode">${options(active('banks'), active('banks')[0]?.code)}</select>`, { req: 1 })}${field('振込手数料（先方負担・差引）', '<input name="fee" class="num" value="0">')}${/* 業者立替金の相殺は定時請求データ入力の明細（科目 1431、マイナス）で入力する（10/28 回答②）。支払の画面では入力しない */ ''}<input type="hidden" name="offset" value="0">${field('安全協力費（差引）', '<input name="safety" class="num" value="0">')}<div class="note" id="py-payee">振込先: -</div></div>
      <h3 style="margin-top:12px">支払対象の定時請求</h3><div id="py-open" class="muted small">業者を選択してください</div>`,
    onOpen: f => { f.vendor.onchange = async () => {
      const v = masters.vendors.find(x => x.code === f.vendor.value); $('#py-payee').textContent = v?.bank ? `振込先: ${v.bank}-${v.branch} ${({ 1: '普通', 2: '当座', 4: '貯蓄' })[v.accountType] || ''} ${v.account} ${v.holder}` : '振込先: 未登録（マスタ管理で登録できます）';
      const open = f.vendor.value ? await api('/api/expenses?' + qs({ kind: 'PAYABLE', vendor: f.vendor.value, open: 1 })) : [];
      $('#py-open').innerHTML = table([{ label: '伝票No', value: r => r.no }, { label: '計上日', value: r => r.date }, { label: '支払予定日', value: r => r.due }, { label: '摘要', value: r => r.memo }, { label: '未払残高', num: 1, value: r => yen(r.balance) },
        { label: '支払額', html: r => `<input class="num py-amt" data-id="${r.id}" value="${r.balance}" style="width:130px">` }], open, { empty: '未払の定時請求はありません' }); }; },
    onSubmit: async v => { const allocations = $$('.py-amt').map(x => ({ expenseId: Number(x.dataset.id), amount: Number(x.value) || 0 })).filter(a => a.amount > 0);
      const r = await post('/api/payments', { ...v, allocations, idempotencyKey: key }); toast(`支払 ${r.no} を登録しました（仕訳 F01）`); render(); } }); };
  A.rev = d => confirmBox('支払の取消', d.exported ? `⚠ 支払 ${d.no} は全銀データ作成済みです（${d.exported.slice(0, 16)}）。銀行へ送信済みなら振込の組戻しが必要です。それでも取消し、逆仕訳を計上しますか？` : `支払 ${d.no} を取消し、逆仕訳を計上します。`, () => post('/api/payments/reverse', { id: Number(d.id), force: !!d.exported }).then(() => { toast('取消しました'); render(); }), '取消する');
  A.prep = d => paymentReport(d.kind).catch(e => toast(e.message, true)); A.zengin = () => zenginDialog().catch(e => toast(e.message, true));
  return page('支払', '定時請求（買掛金）に対する振込支払を登録します（payment / payment_allocation）。', `${monthInput('month', month)}${csvLink('payments', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 支払登録</button>' : ''}`,
    `<section class="card glass" data-sub="list">${table([{ label: '支払No', value: r => r.no }, { label: '支払日', value: r => r.date }, { label: '業者', value: r => r.vendorName }, { label: '支払額', num: 1, value: r => yen(r.amount) }, { label: '支払元', value: r => nameOf('banks', r.fromBank) },
      { label: '振込先', value: r => r.payee ? `${r.payee.bank}-${r.payee.branch} ${r.payee.account}` : '未登録' }, { label: '対象伝票', value: r => r.allocations.map(a => a.no).join(', ') }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}" data-exported="${esc(r.exported || '')}">取消</button>` : '' }], list, { rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section><div data-sub="reports">${paymentReportsCard()}</div><div data-sub="bank">${miscCard('銀行別随時支払一覧表', '支払日→支払元口座（銀行）別に、業者・振込先銀行・支店を一覧', rangeInputs('bp', '支払日'),
      '<button data-act="bankList">表示・Excel</button>', '「仕訳・会計連携 › 自動仕訳リスト」の「銀行別随時支払一覧表」と同じ帳票です。')}</div><div data-sub="transfer">${miscCard('振込先一覧', '業者マスタの振込サイクル（15日／月末）・振込元口座・振込先口座（10/19 打合せ）', `<label class="field">支払予定日（まで）<input type="date" id="tl-to" value="${today()}"></label>`, '<button data-act="misc" data-kind="transfer-list" data-src="tl">表示・Excel</button>')}</div>`);
};

// ③ 支払帳票（NO37 全銀データ・NO45〜48）
// 帳票は一覧を画面に出さない（2026-10-23）。データがあれば Excel を直接ダウンロード（2026-10-27）、0件のときだけ「データがありません」を出す
// 帳票の件数（通知書の枚数または明細の行数）
const reportCount = body => { const t = document.createElement('div'); t.innerHTML = body; return t.querySelectorAll('.notice-doc').length || [...t.querySelectorAll('tr')].filter(tr => tr.querySelector('td') && !tr.closest('thead, tfoot') && !tr.matches('.subtotal, .kb-group')).length; };
// 出力は Excel だけ：選択のポップアップを出さずにダウンロードする（2026-10-27。10/27 打合せ「請求書以外は全部 Excel」）
async function saveXlsx(href, body = null) { // body があれば POST（請求書：現場の指定が長くなるため）
  const res = await fetch(href, body ? { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  if (!res.ok) throw Error((await res.json().catch(() => ({}))).error || `ダウンロードできません（HTTP ${res.status}）`);
  const cd = res.headers.get('Content-Disposition') || '', name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '') || 'report.xlsx';
  const url = URL.createObjectURL(await res.blob()), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}
function reportConfirm(body, id, sub, buttons) {
  const t = document.createElement('div'); t.innerHTML = body;
  const docs = t.querySelectorAll('.notice-doc').length, n = reportCount(body);
  if (!n) { const e = t.querySelector('.empty'); return `<p><b>データがありません。</b>${sub ? `（${esc(sub)}）` : ''}</p>${e ? `<p class="muted small">${esc(e.textContent)}</p>` : ''}`; }
  return `<p>対象 <b>${n}</b> ${docs ? '件' : '行'}${sub ? `　<span class="muted small">${esc(sub)}</span>` : ''}</p><div class="filters" style="margin-top:10px">${buttons}</div><div id="${id}" hidden>${body}</div>`;
}
function paymentReportsCard() {
  const lastDay = new Date(Date.UTC(+thisMonth().slice(0, 4), +thisMonth().slice(5, 7), 0)).toISOString().slice(0, 10);
  return `<section class="card glass"><div class="card-head"><h2>支払帳票・支払データ</h2></div>
    <div class="filters"><label class="field">支払日／基準日<input type="date" id="pr-date" value="${today()}"></label><label class="field">期間（開始）<input type="date" id="pr-from" value="${thisMonth()}-01"></label><label class="field">期間（終了）<input type="date" id="pr-to" value="${lastDay}"></label>
      <label class="field">振込元口座<select id="pr-bank">${options(active('banks'), active('banks')[0]?.code)}</select></label></div>
    <div class="filters" style="margin-top:10px"><button data-act="zengin">支払データ作成（全銀）</button><button data-act="prep" data-kind="vendor-payments">業者別支払内訳表</button>
      <button data-act="prep" data-kind="transfer-request">振込依頼書</button><button data-act="prep" data-kind="carryover">支払繰越一覧表</button><button data-act="prep" data-kind="notices">支払案内書</button></div>
    </section>`;
}
const acctText = p => (p ? `${esc(p.bank)}-${esc(p.branch)} ${esc(p.typeName)} ${esc(p.account)}` : '<span class="check-ng">振込先未登録</span>');
async function paymentReport(kind) {
  const date = $('#pr-date').value, from = $('#pr-from').value, to = $('#pr-to').value;
  const params = kind === 'vendor-payments' ? { from, to } : { date };
  const url = `/api/reports/payments/${kind}?${qs(params)}`, d = await api(url);
  let body = '';
  if (kind === 'vendor-payments') body = d.vendors.length ? d.vendors.map(v => `<h3 style="margin:10px 0 4px">${esc(v.vendor)} ${esc(v.name)}</h3>` + table([{ label: '支払日', value: r => r.date }, { label: '支払No', value: r => r.no }, { label: '支払方法', value: r => r.method },
    { label: '振込額', num: 1, value: r => yen(r.bank) }, { label: '手数料', num: 1, value: r => yen(r.fee) }, { label: '相殺（前払金・立替金）', num: 1, value: r => yen(r.offset) }, { label: '安全協力費', num: 1, value: r => yen(r.safety) }, { label: '支払額', num: 1, value: r => yen(r.paid) }, { label: '振込先', html: r => acctText(r.payee) }, { label: '対象伝票', value: r => r.docs }],
    v.rows, { foot: ['業者計', '', '', '', '', '', '', yen(v.total), '', ''] })).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">期間内の支払はありません</div>';
  if (kind === 'transfer-request') body = d.groups.length ? `<p>依頼人: ${esc(d.company)} ／ 振込指定日: <b>${esc(d.date)}</b></p>` + d.groups.map(g => `<h3 style="margin:10px 0 4px">振込元口座 ${esc(g.fromBank)} ${esc(g.fromBankName)}</h3>` + table([{ label: '業者CD', value: r => r.vendor }, { label: '業者名', value: r => r.name },
    { label: '振込銀行', html: r => r.payee ? esc(r.payee.bank) : '<span class="check-ng">未登録</span>' }, { label: '支店', value: r => r.payee?.branch || '' }, { label: '種目', value: r => r.payee?.typeName || '' }, { label: '口座番号', value: r => r.payee?.account || '' }, { label: '受取人', value: r => r.payee?.holder || '' }, { label: '金額', num: 1, value: r => yen(r.amount) }],
    g.rows, { foot: ['件数 ' + g.rows.length, '', '', '', '', '', '合計', yen(g.total)] })).join('') : '<div class="empty">この振込指定日の支払はありません</div>';
  if (kind === 'carryover') { const m = d.months, t = d.totals; body = `<p>基準日 <b>${esc(d.date)}</b> 時点の未払残高（定時請求の計上月で区分）</p>` + table([{ label: '業者', value: r => `${r.vendor} ${r.name}` }, { label: m.m3, num: 1, value: r => yen(r.m3) }, { label: m.m2, num: 1, value: r => yen(r.m2) }, { label: m.m1, num: 1, value: r => yen(r.m1) }, { label: m.m0, num: 1, value: r => yen(r.m0) },
    { label: '支払繰越合計', num: 1, value: r => yen(r.total) }, { label: '相殺繰越額', num: 1, value: r => yen(r.offset) }, { label: '差引繰越額', num: 1, value: r => yen(r.net) }], d.vendors, { empty: '未払残高はありません', foot: ['合計', yen(t.m3), yen(t.m2), yen(t.m1), yen(t.m0), yen(t.total), yen(t.offset), yen(t.net)] }); }
  if (kind === 'notices') { const m = d.months; body = d.notices.length ? d.notices.map(n => `<div class="notice-doc"><h3>支払案内書</h3><p><b>${esc(n.name)} 御中</b>（${esc(n.vendor)}）</p><p class="right">${esc(d.company.name)}<br>${esc(d.company.address)}　TEL ${esc(d.company.tel)}</p>
      <p>下記のとおりお支払いいたしましたのでご案内申し上げます。</p>
      <table><tr><th>支払日</th><th>支払合計額</th><th>振込額</th><th>振込手数料</th><th>振込先</th></tr><tr><td>${esc(d.date)}</td><td class="num">${yen(n.total)}</td><td class="num">${yen(n.bank)}</td><td class="num">${yen(n.fee)}</td><td>${acctText(n.payee)}</td></tr></table>
      ${table([{ label: '伝票No', value: x => x.no }, { label: '計上日', value: x => x.date }, { label: '摘要', value: x => x.memo }, { label: '請求額', num: 1, value: x => yen(x.gross) }, { label: '今回支払額', num: 1, value: x => yen(x.paid) }], n.docs)}
      <p class="small"><b>支払繰越（支払後の未払残高）</b></p><table><tr><th>${esc(m.m3)}</th><th>${esc(m.m2)}</th><th>${esc(m.m1)}</th><th>${esc(m.m0)}</th><th>合計</th></tr><tr><td class="num">${yen(n.carry.m3)}</td><td class="num">${yen(n.carry.m2)}</td><td class="num">${yen(n.carry.m1)}</td><td class="num">${yen(n.carry.m0)}</td><td class="num">${yen(n.carry.total)}</td></tr></table></div>`).join('')
    : '<div class="empty">この支払日の支払はありません</div>'; }
  if (reportCount(body)) { await saveXlsx(url + '&format=xlsx'); return toast(`${d.title} を Excel で出力しました`); } // 選択のポップアップは出さない（2026-10-27）
  modal({ title: `${d.title}`, body: reportConfirm(body, 'pr-body', d.sub || (d.from ? `${d.from} 〜 ${d.to}` : d.date || ''), '') });
}
async function zenginDialog() {
  const date = $('#pr-date').value, bank = $('#pr-bank').value, url = '/api/reports/zengin?' + qs({ date, bank }), d = await api(url);
  modal({ title: `支払データ作成（全銀・総合振込）${date}`, wide: true, body: `
    <div class="grid3"><div class="sum-line"><span>振込元口座</span><b>${esc(d.bank)} ${esc(d.bankName)}</b></div><div class="sum-line"><span>件数</span><b>${d.count}</b></div><div class="sum-line"><span>合計金額</span><b>${yen(d.total)}</b></div></div>
    ${d.errors.length ? `<div class="note warn" style="margin:10px 0"><b>作成できません</b><ul class="list">${d.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${table([{ label: '業者', value: r => r.label }, { label: '振込先', value: r => `${r.bank || '-'}-${r.branch || '-'} ${r.typeName} ${r.account || ''}` }, { label: '受取人名', value: r => r.holder }, { label: '金額', num: 1, value: r => yen(r.amount) }, { label: '支払No', value: r => r.nos.join(' ') }], d.transfers, { empty: '対象の支払がありません' })}
    <h3 style="margin-top:12px">レコードプレビュー</h3><pre class="zengin-pre">${d.records.map(r => esc(r)).join('\n')}</pre>
    <div class="filters" style="margin-top:10px">${!d.errors.length && canWrite() ? `<a class="button primary" href="${url}&format=file" download>⇩ 全銀データをダウンロード</a>` : ''}</div>` });
}

// ④ 出荷集計（NO41〜43）・材料受払表（NO26）・配合計算（NO25）・出資金（NO35・36）
const monthLastDay = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const rangeInputs = (id, label = '期間', from = `${thisMonth()}-01`, to = monthLastDay(thisMonth())) => `<label class="field">${label}（開始）<input type="date" id="${id}-from" value="${from}"></label><label class="field">${label}（終了）<input type="date" id="${id}-to" value="${to}"></label>`;
// 直近の締日の月度（前月21日〜当月20日）
// 小口現金出納簿の期間の初期値：今日を含む月度（21日〜翌月20日）。入力したばかりの支払がすぐ出るように（2026-10-29。以前は締め済みの前月度）
const closingRange = () => { const [y, m, d] = today().split('-').map(Number), k = d <= 20 ? -1 : 0, iso = (mm, dd) => new Date(Date.UTC(y, m - 1 + mm, dd)).toISOString().slice(0, 10); return [iso(k, 21), iso(k + 1, 20)]; };
function miscCard(title, sub, inputs, buttons, note = '') {
  return `<section class="card glass"><div class="card-head"><h2>${title}</h2></div><div class="filters">${inputs}</div>${buttons ? `<div class="filters" style="margin-top:10px">${buttons}</div>` : ''}</section>`;
}
const shipmentReportsCard = () => miscCard('出荷・売上帳票', 'Excel で出力', rangeInputs('ms', '出荷日'),
  '<button data-act="misc" data-kind="shipment-summary" data-src="ms">商品・製品別出荷集計表</button><button data-act="misc" data-kind="customer-items" data-src="ms">得意先別商品別出荷累計表</button><button data-act="misc" data-kind="cash-sales" data-src="ms">現金売上明細表</button><button data-act="misc" data-kind="sales-register" data-src="ms">商品売上登録リスト</button>',
  '期間は締日単位（例: 前月21日〜当月20日）で指定できます。<span id="ms-range"></span>');
const inventoryReportsCard = () => miscCard('配合計算・材料受払表', '月次（実在庫登録と商品仕入登録の後に実行）', `<label class="field">処理年月（計算年月）<input type="month" id="mi-month" value="${lastClosing().slice(0, 7)}"></label><label class="field">締日<select id="mi-closing"><option value="20" selected>20日</option><option value="10">10日</option><option value="31">月末（暦月）</option></select></label>`,
  '<button data-act="mix">配合計算</button><button data-act="misc" data-kind="material-ledger" data-src="mi">材料受払表</button>',
  '材料は商品マスタの「製品・材料区分＝材料」と、仕入・在庫のある商品が対象。配合計算は配合表の資料が未提供のため暫定で、配合率は「マスタ管理 → 配合」で登録します。');
// 10/19 打合せ：出力指示＝締切日・部門コード（組織マスタ）・区分（ブランク＝工事、1＝組織）・業者コード From〜To（ブランク〜9999999＝全業者）
const payableReportsCard = () => miscCard('定時請求入力明細表', '部門（工事）→業者→請求明細', `<label class="field">月度<input type="month" id="pi-month" value="${lastClosing().slice(0, 7)}"></label><label class="field">締日<select id="pi-closing"><option value="20" selected>20日</option><option value="31">月末（暦月）</option></select></label>
  <label class="field">部門コード<select id="pi-dept">${options(masters.depts || [], '', { blank: '全部門' })}</select></label><label class="field">区分<select id="pi-kb"><option value="1" selected>1：組織</option><option value="">ブランク：工事</option></select></label>
  <label class="field">業者コード（From）<input id="pi-vfrom" list="pi-vlist" maxlength="7" style="width:110px"></label><label class="field">業者コード（To）<input id="pi-vto" list="pi-vlist" maxlength="7" style="width:110px" value="9999999"></label><datalist id="pi-vlist">${(masters.vendors || []).map(v => `<option value="${esc(v.code)}">${esc(v.name)}</option>`).join('')}</datalist>`,
  '<button data-act="misc" data-kind="payable-input" data-src="pi">定時請求データ入力明細表（組織別）</button>', '業者コード：ブランク＝出力しない／From〜To＝範囲の業者／To に 9999999＝全業者（10/21 打合せ）。発注残・相殺は未確定（Q03）のため0。削減案6では画面照会で代用可とされていますが、帳票としても出力できます。');
const pettyReportsCard = () => miscCard('小口現金出納簿', '定額資金前渡制（推定）', rangeInputs('pc', '期間', ...closingRange()),
  '<button data-act="misc" data-kind="petty-book" data-src="pc">小口現金出納簿</button>' + (canWrite() ? '<button data-act="fund">定額資金の設定</button><button data-act="refill">現金補充を登録</button>' : ''), '期首に定額資金を受入、支払ごとに残高を表示し、支払合計を次期補充額とします。JV構成員が登録済みなら出資比率で配分列を表示します。');
const receiptScheduleCard = () => miscCard('入金予定チェックリスト', '得意先別・工事（現場）別', `<label class="field">入金予定日（から）<input type="date" id="rs-from" value="${addMonths(thisMonth(), -6)}-01"></label><label class="field">入金予定日（まで）<input type="date" id="rs-to" value="${today()}"></label><label class="field"><span>超過分のみ</span><span><input type="checkbox" id="rs-over"> 予定日を過ぎた未入金</span></label><button data-act="misc" data-kind="receipt-schedule" data-src="rs">入金予定チェックリスト</button>`,
  '', '残高のある請求が対象（未発行を含み、発行の有無を表示）。入金方法・入金先は過去の入金実績から推定します。'); // 条件とボタンを1行に（2026-10-27）
const accountingCard = () => miscCard('会計連携データ', '会計システムは勘定奉行（奉行クラウド）。受入は CSV／Excel（QA回答 2026-10-08）', rangeInputs('ac', '仕訳日'),
  '<button class="primary" data-act="acct" data-format="bugyo">⇩ 勘定奉行 受入CSV</button><button data-act="acct" data-format="generic">⇩ 汎用CSV（借貸併記・UTF-8）</button><button data-act="acct" data-format="yayoi">⇩ 弥生会計形式（Shift_JIS）</button>',
  '勘定奉行CSVの見出しは「財務会計 → 会計設定 → 勘定奉行連携」で登録した OBC受入記号（未登録は項目名）、税区分は処税率→奉行税区分の対応表で変換します。受入記号・税区分コードは「データ受入形式一覧表」で確定予定（Q14/Q19）。出力は操作履歴に記録されます。');
async function accountingDownload(format) {
  const url = '/api/accounting/export?' + qs({ from: $('#ac-from').value, to: $('#ac-to').value, format }), res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || '出力できません', true);
  const blob = await res.blob(), href = URL.createObjectURL(blob), el = document.createElement('a');
  el.href = href; el.download = `会計連携_${{ yayoi: '弥生', bugyo: '勘定奉行' }[format] || '汎用'}_${$('#ac-from').value}_${$('#ac-to').value}.csv`; el.click(); setTimeout(() => URL.revokeObjectURL(href), 2000);
  toast('会計連携データを出力しました');
}
const jvReportsCard = () => miscCard('出資金（JV）帳票', 'JV構成員・出資比率で配分（10/21 打合せ：締切日＝対象月20日で指示）', `<label class="field">締切日<input type="date" id="jv-closing" value="${lastClosing()}"></label>`,
  '<button data-act="misc" data-kind="jv-expenses" data-src="jv">出資金請求明細表（定時請求分）</button><button data-act="misc" data-kind="jv-expenses" data-src="jvs">出資金請求合計表（定時請求分）</button><button data-act="misc" data-kind="jv-receipts" data-src="jv">入金明細及び配分表</button>' + (canWrite() ? '<button data-act="jvAlloc">入金額配賦登録（端数調整）</button>' : ''),
  '構成員と出資比率は「マスタ管理 → JV構成員・出資比率」で登録します（有効な構成員の合計100%）。配分は各社切捨て、端数は第1構成員。端数を調整するときは「入金額配賦登録」で入金ごとに構成員別の金額を直し、はその金額で出力します。');
// 入金額配賦登録（現行 HJW030）：締切日の月度の NO36 対象行ごとに構成員別の配分額（青字欄）を調整。行の合計＝入金額で登録
async function jvAllocDialog() {
  const closing = $('#jv-closing').value, d = await api('/api/reports/misc/jv-receipts?' + qs({ closing })), ms = d.members;
  if (!d.lines.length) return alertBox(`データがありません（締切日 ${closing} の月度 ${d.from}〜${d.to} の入金・現金売上はありません）`);
  const row = (l, i) => `<tr data-i="${i}"><td>${esc(l.date)}</td><td>${esc(l.account)}<br><span class="small muted">${esc(l.memo)}</span></td><td>${esc(l.customer || '')}</td><td class="num">${yen(l.amount)}</td>
    ${ms.map((m, k) => `<td><input class="num jv-part" style="width:110px;color:#0369a1" data-k="${k}" value="${l.parts[k]}"></td>`).join('')}<td class="small jv-st">${l.adjusted ? badge('調整済', 'amber') : ''}</td><td><button type="button" class="mini quiet" data-auto="${i}" title="出資比率で自動配分に戻す">自動</button></td></tr>`;
  const foot = `<tr><td colspan="3"><b>支払計</b></td><td class="num" id="jva-total"></td>${ms.map((_, k) => `<td class="num" id="jva-t${k}"></td>`).join('')}<td colspan="2"></td></tr>`;
  modal({ title: `入金額配賦登録　締切日 ${closing}（${d.from}〜${d.to}）`, wide: true, submit: '登録',
    body: `
      <div class="table-wrap" style="max-height:60vh;overflow:auto"><table id="jva"><thead><tr><th>入金日</th><th>入金科目</th><th>得意先</th><th class="num">入金額</th>${ms.map(m => `<th>${esc(m.name || m.code)}<br><span class="small muted">${m.ratio.toFixed(2)}%</span></th>`).join('')}<th></th><th></th></tr></thead>
      <tbody>${d.lines.map(row).join('')}</tbody><tfoot>${foot}</tfoot></table></div>`,
    onOpen: () => {
      const t = $('#jva'), val = x => Number(String(x.value).replace(/[,\s]/g, ''));
      const sums = () => {
        let ok = true;
        for (const tr of $$('tbody tr', t)) { const l = d.lines[tr.dataset.i], s = $$('.jv-part', tr).reduce((n, x) => n + val(x), 0), bad = s !== l.amount; tr.classList.toggle('check-ng', bad); if (bad) ok = false; }
        $('#jva-total').textContent = yen(d.lines.reduce((n, l) => n + l.amount, 0));
        ms.forEach((_, k) => ($(`#jva-t${k}`).textContent = yen($$(`.jv-part[data-k="${k}"]`, t).reduce((n, x) => n + val(x), 0))));
        return ok;
      };
      t.addEventListener('input', sums);
      t.addEventListener('click', e => { const b = e.target.closest('[data-auto]'); if (!b) return; const l = d.lines[b.dataset.auto]; $$(`tr[data-i="${b.dataset.auto}"] .jv-part`, t).forEach((x, k) => (x.value = l.auto[k])); sums(); });
      sums();
    },
    onSubmit: async () => {
      const t = $('#jva'), val = x => Number(String(x.value).replace(/[,\s]/g, '')), changed = [];
      for (const tr of $$('tbody tr', t)) {
        const l = d.lines[tr.dataset.i], parts = $$('.jv-part', tr).map(val);
        if (parts.some((v, k) => v !== l.parts[k])) changed.push({ key: l.key, parts: Object.fromEntries(ms.map((m, k) => [m.code, parts[k]])) });
      }
      if (!changed.length) { toast('変更はありません'); return; }
      const r = await post('/api/jv/allocations', { closing, rows: changed });
      toast(`入金額配賦を登録しました（調整 ${r.saved}行${r.cleared ? `・自動配分に戻した行 ${r.cleared}行` : ''}）`);
    } });
}
function miscParams(kind, src) {
  if (src === 'mi') return { month: $('#mi-month').value, closing: $('#mi-closing').value };
  if (src === 'pi') return { month: $('#pi-month').value, closing: $('#pi-closing').value, dept: $('#pi-dept').value, kb: $('#pi-kb').value, vendorFrom: $('#pi-vfrom').value.trim().toUpperCase(), vendorTo: $('#pi-vto').value.trim().toUpperCase() };
  if (src === 'jv') return { closing: $('#jv-closing').value };
  if (src === 'jvs') return { closing: $('#jv-closing').value, layout: 'summary' };
  if (src === 'pc') return { from: $('#pc-from').value, to: $('#pc-to').value };
  if (src === 'rs') return { from: $('#rs-from').value, to: $('#rs-to').value, overdue: $('#rs-over').checked ? '1' : '' };
  if (src === 'ir') return { month: $('#ir-month').value };
  if (src === 'tl') return { to: $('#tl-to').value };
  return { from: $(`#${src}-from`).value, to: $(`#${src}-to`).value };
}
async function miscReport(kind, src) {
  const params = miscParams(kind, src), url = `/api/reports/misc/${kind}?${qs(params)}`, d = await api(url);
  const pct = m => `${esc(m.name)}<br><span class="small">${m.ratio}%</span>`;
  let body = '';
  if (kind === 'shipment-summary') body = table([{ label: '商品', value: r => `${r.item} ${r.name}` }, { label: '件数', num: 1, value: r => r.count }, { label: '出荷数量', num: 1, value: r => `${r.qty} ${r.unit}` }, { label: '売上金額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) },
    { label: '掛売', num: 1, value: r => yen(r.credit) }, { label: '現金', num: 1, value: r => yen(r.cash) }, { label: 'カード', num: 1, value: r => yen(r.card) }], d.items, { empty: '期間内の出荷はありません', foot: ['合計', d.totals.count, '', yen(d.totals.net), yen(d.totals.tax), yen(d.totals.credit), yen(d.totals.cash), yen(d.totals.card)] });
  if (kind === 'customer-items') body = d.customers.length ? d.customers.map(cu => `<h3 style="margin:10px 0 4px">${esc(cu.customer)} ${esc(cu.name)}</h3>` + table([{ label: '商品', value: r => `${r.item} ${r.name}` }, { label: '件数', num: 1, value: r => r.count }, { label: '出荷数量', num: 1, value: r => `${r.qty} ${r.unit}` }, { label: '売上金額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }],
    cu.items, { foot: ['得意先計', '', '', yen(cu.net), yen(cu.tax)] })).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">期間内の出荷はありません</div>';
  if (kind === 'cash-sales') body = (d.customers.length ? d.customers.map(cu => `<h3 style="margin:10px 0 4px">${esc(cu.customer)} ${esc(cu.name)}</h3>` + table([{ label: '売上日', value: r => r.date }, { label: '伝票No', value: r => r.no }, { label: '現場', value: r => r.site }, { label: '商品', value: r => r.item }, { label: '数量', num: 1, value: r => r.qty },
    { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '合計', num: 1, value: r => yen(r.total) }], cu.rows, { foot: ['得意先計', '', '', '', '', '', yen(cu.net), yen(cu.tax), yen(cu.total)] })).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">期間内の現金売上はありません</div>') + ``;
  if (kind === 'material-ledger') { const q = (o, k = 'qty') => (o ? (k === 'qty' ? o.qty : yen(o.value)) : ''); body = `<p class="muted small">対象月 ${esc(d.month)}（期首 ${esc(d.fiscalStart)}）</p>` + table([{ label: '材料', value: r => `${r.item} ${r.name}` },
    { label: '期首 数量', num: 1, value: r => q(r.opening) }, { label: '期首 金額', num: 1, value: r => q(r.opening, 'v') }, { label: '前月来 数量', num: 1, value: r => q(r.prev) }, { label: '前月来 金額', num: 1, value: r => q(r.prev, 'v') }, { label: '当月仕入 数量', num: 1, value: r => q(r.purchase) }, { label: '当月仕入 金額', num: 1, value: r => q(r.purchase, 'v') },
    { label: '当月使用 数量', num: 1, value: r => q(r.used) }, { label: '当月使用 金額', num: 1, value: r => q(r.used, 'v') }, { label: '当月末 数量', num: 1, value: r => q(r.end) }, { label: '当月末 金額', num: 1, value: r => q(r.end, 'v') }, { label: '単価', num: 1, value: r => (r.price ?? '') === '' ? '' : yen(r.price) }],
    d.items, { empty: '対象の材料がありません', foot: ['【合計】', '', yen(d.totals.opening), '', yen(d.totals.prev), '', yen(d.totals.purchase), '', yen(d.totals.used), '', yen(d.totals.end), ''] }); }
  if (kind === 'jv-expenses') {
    const detail = d.layout === 'detail', mcols = d.members.map(m => `<th class="num">${pct(m)}</th>`).join(''), money = v => `<td class="num">${yen(v)}</td>`;
    body = `` + (!d.accounts.length ? '<div class="empty">この締切日の月度の定時請求はありません</div>' : d.days.map(day => `<h3 style="margin:12px 0 4px">支払日 ${esc(day.due)}</h3><div class="table-wrap"><table><thead><tr>`
      + (detail ? `<th>科目</th><th>伝票No</th><th>支払先</th><th>摘要</th><th>税区分</th>` : `<th>科目</th><th class="num">件数</th>`) + `<th class="num">支払金額</th><th class="num">支払本体</th><th class="num">消費税</th>${mcols}</tr></thead><tbody>`
      + d.accounts.filter(a => a.due === day.due).map(a => detail
        ? a.rows.map((r, k) => `<tr><td>${k ? '' : esc(`${a.account} ${a.name}`)}</td><td>${esc(r.no)}</td><td>${esc(r.vendor)}</td><td>${esc(r.memo)}</td><td>${esc(r.taxCode)}</td>${money(r.gross)}${money(r.net)}${money(r.tax)}${r.parts.map(money).join('')}</tr>`).join('')
          + `<tr class="subtotal"><td colspan="5" class="right">＊科目計＊</td>${money(a.gross)}${money(a.net)}${money(a.tax)}${a.parts.map(money).join('')}</tr>`
        : `<tr><td>${esc(`${a.account} ${a.name}`)}</td><td class="num">${a.count}</td>${money(a.gross)}${money(a.net)}${money(a.tax)}${a.parts.map(money).join('')}</tr>`).join('')
      + `</tbody><tfoot><tr><td colspan="${detail ? 5 : 2}">支払日計</td>${money(day.gross)}<td></td><td></td>${day.parts.map(money).join('')}</tr></tfoot></table></div>`).join('')
      + `<p class="right"><b>合計 ${yen(d.totals.gross)} 円</b>（${d.members.map((m, k) => `${esc(m.name)} ${yen(d.totals.parts[k])}`).join(' ／ ')}）</p>`);
  }
  if (kind === 'jv-receipts') body = `` + (!d.lines.length ? '<div class="empty">この締切日の月度の入金・現金売上はありません</div>' : `<div class="table-wrap"><table><thead><tr><th>入金日</th><th>入金科目</th><th>摘要</th><th>入金先</th><th class="num">入金額</th>${d.members.map(m => `<th class="num">${pct(m)}</th>`).join('')}</tr></thead><tbody>`
    + d.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.account)}</td><td>${esc(l.memo)}</td><td>${esc(l.customer)}</td><td class="num">${yen(l.amount)}</td>${l.parts.map(v => `<td class="num">${yen(v)}</td>`).join('')}</tr>`).join('')
    + `</tbody><tfoot><tr><td colspan="4">合計</td><td class="num">${yen(d.totals.amount)}</td>${d.totals.parts.map(v => `<td class="num">${yen(v)}</td>`).join('')}</tr></tfoot></table></div>`);
  if (kind === 'sales-register') body = d.customers.length ? d.customers.map(cu => `<h3 style="margin:10px 0 4px">${esc(cu.customer)} ${esc(cu.name)}</h3>` + table([{ label: '売上日', value: r => r.date }, { label: '区分', value: r => r.kind }, { label: '伝票No', value: r => r.no }, { label: '現場', value: r => r.site }, { label: '商品', value: r => r.item },
    { label: '数量', num: 1, value: r => `${r.qty} ${r.unit}` }, { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '請求', value: r => r.billed }], cu.rows, { foot: ['得意先計', '', '', '', '', '', '', yen(cu.net), yen(cu.tax), ''] })).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円（税 ${yen(d.tax)}）</b></p>` : '<div class="empty">期間内の売上はありません</div>';
  if (kind === 'payable-input') body = `<p class="small">部門 ${esc(d.dept)} ／ 区分 ${d.kb ? '1 組織' : 'ブランク 工事'} ／ 業者 ${esc(d.vendor)}</p>` + (d.depts.length ? d.depts.map(dp => `<h3 style="margin:10px 0 4px">${esc(d.groupLabel)} : ${esc(dp.dept)} ${esc(dp.name)}</h3>` + dp.vendors.map(v => `<p class="small"><b>${esc(v.vendor)} ${esc(v.name)}</b></p>` + table([{ label: '請求No', value: r => r.no }, { label: '計上日', value: r => r.date }, { label: '科目', value: r => `${r.account}${r.sub ? '-' + r.sub : ''} ${r.accountName}${r.subName ? ' ' + r.subName : ''}` },
    { label: '発注残金額', num: 1, value: r => yen(r.orderRemain) }, { label: '請求金額', num: 1, value: r => yen(r.amount) }, { label: '相殺金額', num: 1, value: r => yen(r.offset) }, { label: '摘要コード', value: r => r.memoCode }, { label: '摘要', value: r => r.memo }, { label: '処税率', value: r => r.tax }], v.rows, { foot: ['業者計', '', '', '', yen(v.total), '', '', '', ''] })).join('') + `<p class="right">${esc(d.groupLabel)}計 <b>${yen(dp.total)}</b></p>`).join('') : '<div class="empty">この条件の定時請求はありません</div>');
  // 現行 HJR051 と同じ並び・表示（2026-10-29）。前期繰越・受入・残高は出さない
  if (kind === 'petty-book') { const ms = d.members || [], pay = d.rows.filter(r => r.amount); body = `<div class="table-wrap"><table><thead><tr><th>支払日</th><th>支払先</th><th>摘要</th><th>科目コード</th><th>科目名</th><th>税率</th><th class="num">支払額</th>${ms.map(m => `<th class="num">${esc(m.name)}<br><span class="small">${m.ratio}%</span></th>`).join('')}</tr></thead><tbody>`
    + pay.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.payee)}</td><td>${esc(r.memo)}</td><td>${esc(r.account)}${r.sub ? ' ' + esc(r.sub) : ''}</td><td>${esc(r.accountName)}</td><td>${esc(r.rate)}</td><td class="num">${yen(r.amount)}</td>${(r.parts || []).map(v => `<td class="num">${yen(v)}</td>`).join('')}</tr>`).join('')
    + `</tbody><tfoot><tr><td colspan="6">合計</td><td class="num">${yen(d.spent)}</td>${ms.map(() => '<td></td>').join('')}</tr></tfoot></table></div>`; }
  if (kind === 'receipt-schedule') body = `` + (d.customers.length ? d.customers.map(cu => `<h3 style="margin:10px 0 4px">${esc(cu.customer)} ${esc(cu.name)} <span class="muted small">入金方法: ${esc(cu.method)} ／ 入金先: ${esc(cu.bank)}</span></h3>` + table([{ label: '工事（現場）', value: r => `${r.site} ${r.siteName}` }, { label: '請求締日', value: r => r.closing }, { label: '請求No', value: r => r.invoiceId }, { label: '発行', value: r => (r.issued ? '発行済' : '未発行') },
    { label: '請求金額', num: 1, value: r => yen(r.billed) }, { label: '入金予定日', html: r => `${r.overdue ? `<span class="check-ng">${esc(r.dueDate)} 超過</span>` : esc(r.dueDate)}${r.computed ? ' <span class="muted small" title="支払期日がないため得意先マスタの回収条件から計算">※</span>' : ''}` }, { label: '入金予定額', num: 1, value: r => yen(r.due) }], cu.rows, { foot: ['得意先計', '', '', '', yen(cu.billed), '', yen(cu.due)] })).join('') + `<p class="right"><b>入金予定合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">入金予定（残高あり）の請求はありません</div>');
  // 共通形式（server/new-reports.mjs）：columns＋groups
  if (d.columns) { const cell = (col, v) => (col.num && typeof v === 'number' ? (col.dec ? v.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : yen(v)) : esc(v ?? '')); const tot = (label, t) => `<tr class="subtotal">${d.columns.map((col, i) => `<td class="${col.num ? 'num' : ''}">${i === 0 ? esc(label) : t[col.key] !== undefined ? yen(t[col.key]) : ''}</td>`).join('')}</tr>`;
    body = d.groups.length ? `<div class="table-wrap"><table class="jl"><thead><tr>${d.columns.map(col => `<th class="${col.num ? 'num' : ''}">${esc(col.label)}</th>`).join('')}</tr></thead><tbody>${d.groups.map(g => (g.head ? `<tr class="kb-group"><td colspan="${d.columns.length}" style="font-size:1.05em;padding-top:10px"><b>${esc(g.head)}</b></td></tr>` : '') + `<tr class="kb-group"><td colspan="${d.columns.length}"><b>${esc(g.title)}</b></td></tr>`
      + g.rows.map(r => `<tr>${d.columns.map(col => `<td class="${col.num ? 'num' : ''}">${cell(col, r[col.key])}</td>`).join('')}</tr>`).join('') + tot(g.label || '計', g.totals) + (g.foot ? tot(g.foot.label, g.foot.totals) : '')).join('')}${tot('総合計', d.totals)}</tbody></table></div>` : '<div class="empty">対象データがありません</div>'; }
  if (reportCount(body)) { await saveXlsx(url + '&format=xlsx'); return toast(`${d.title} を Excel で出力しました`); } // 選択のポップアップは出さない（2026-10-27）
  modal({ title: `${d.title}`, body: reportConfirm(body, 'mr-body', d.sub || (d.from ? `${d.from} 〜 ${d.to}` : d.month), '') });
}
async function mixDialog() {
  const month = $('#mi-month').value, closing = $('#mi-closing').value, d = await api('/api/reports/misc/mix?' + qs({ month, closing }));
  const s0 = d.products.find(p => p.saved)?.saved || { denki: d.suggest.denki, touyu: d.suggest.touyu, seizou: d.suggest.seizou, ippann: d.suggest.ippann };
  const body = `<p class="note warn small">${esc(d.note)}</p>` + (d.products.length ? d.products.map(p => `<h3 style="margin:10px 0 4px">${esc(p.item)} ${esc(p.name)} ${p.missing ? badge('材料単価なし', 'red') : ''} ${p.ratio !== 100 ? badge(`配合率計 ${p.ratio}%`, 'amber') : ''}</h3>`
    + table([{ label: '材料', value: l => `${l.material} ${l.name}` }, { label: '配合率', num: 1, value: l => l.ratio + '%' }, { label: '材料単価', num: 1, value: l => (l.price === null ? '—' : yen(l.price)) }, { label: '単価根拠', value: l => l.source }, { label: '配合金額', num: 1, value: l => (l.cost === null ? '—' : yen(l.cost)) }], p.lines, { foot: ['配合単価', '', '', '', yen(p.haigo)] })
    + (p.saved ? `<p class="small muted">保存済（マスタ管理 → 原価）: 配合 ${yen(p.saved.haigo)} ＋ 電気 ${yen(p.saved.denki)} ＋ 灯油 ${yen(p.saved.touyu)} ＋ 製造 ${yen(p.saved.seizou)} ＋ 一般 ${yen(p.saved.ippann)} ＝ <b>${yen(p.saved.total)}</b> 円/単位</p>` : '')).join('')
    : '<div class="empty">配合マスタが登録されていません（マスタ管理 → 配合）</div>');
  modal({ title: `配合計算 ${month}`, wide: true, submit: canWrite() && d.products.length ? '原価に保存' : undefined, body: `<div class="filters" style="margin-bottom:10px"><a class="button" href="/api/reports/misc/mix?${qs({ month })}&format=xlsx" download>⇩ Excel</a></div>${body}
    ${d.products.length ? `<h3 style="margin-top:12px">材料使用量の比較（理論＝製品出荷×配合率 ／ 実際＝材料受払）</h3>${table([{ label: '材料', value: u => `${u.material} ${u.name}` }, { label: '理論使用量', num: 1, value: u => u.theoretical }, { label: '実使用量', num: 1, value: u => u.actual ?? '—' }, { label: '差異', num: 1, html: u => u.diff === null ? '—' : `<span class="${Math.abs(u.diff) > Math.max(1, u.theoretical * 0.05) ? 'check-ng' : ''}">${u.diff}</span>` }], d.usage)}
    <h3 style="margin-top:12px">経費単価（推定・手修正可）</h3><p class="small muted">製品出荷数量 ${d.suggest.tons}／推定: 電気 ${yen(d.suggest.denki)}・灯油 ${yen(d.suggest.touyu)}・製造 ${yen(d.suggest.seizou)}・一般 ${yen(d.suggest.ippann)} 円/単位。${esc(d.suggest.basis)}</p><div class="form-grid">${[['denki', '電気'], ['touyu', '灯油'], ['seizou', '製造'], ['ippann', '一般']].map(([k, l]) => field(l + '（円）', `<input name="${k}" class="num" value="${s0[k]}">`)).join('')}</div>` : ''}`,
    onSubmit: async v => { const r = await post('/api/mix/save', { month, closing, ...v }); toast(`原価に ${r.saved} 製品を保存しました`); } });
}

async function pettyFundDialog() {
  const s = await api('/api/petty/settings');
  modal({ title: '小口現金 定額資金の設定', submit: '保存する', body: `<div class="form-grid">${field('定額資金（円）', `<input name="fund" class="num" value="${s.fund}">`, { req: 1 })}</div>`,
    onSubmit: async v => { await post('/api/petty/fund', v); toast('定額資金を保存しました'); } });
}
async function pettyRefillDialog() {
  const s = await api('/api/petty/settings');
  modal({ title: '小口現金の補充（受入）', submit: '補充を登録', sample: true, body: `<div class="form-grid">${field('補充日', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('補充額（円）', '<input name="amount" class="num">', { req: 1 })}
    ${field('引出口座', `<select name="bankCode">${options(active('banks'), (active('banks').find(b => b.code === '041') || active('banks')[0])?.code)}</select>`, { req: 1 })}</div>
    ${table([{ label: '補充日', value: r => r.date }, { label: '補充額', num: 1, value: r => yen(r.amount) }, { label: '引出口座', value: r => r.bank }], s.refills, { empty: '補充の履歴はありません' })}`,
    onSubmit: async v => { await post('/api/petty/refill', v); toast('現金補充を登録しました'); } });
}
// ----- 仕訳・会計連携 -----
VIEWS.journals = async q => {
  const A = actions;
  A.acct = d => accountingDownload(d.format).catch(e => toast(e.message, true));
  const month = q.month || thisMonth(), tab = q.tab || 'list';
  A.tab = d => go('journals', { ...route.q, tab: d.tab });
  let body;
  if (tab === 'lists') return journalListsView(q);
  if (tab === 'tb') {
    const tb = await api('/api/trial-balance?month=' + month);
    body = table([{ label: '科目', value: r => r.account }, { label: '科目名', value: r => r.name }, { label: '借方', num: 1, value: r => yen(r.debit) }, { label: '貸方', num: 1, value: r => yen(r.credit) }, { label: '差額(借-貸)', num: 1, value: r => yen(r.debit - r.credit) }], tb,
      { foot: ['合計', '', yen(tb.reduce((n, r) => n + r.debit, 0)), yen(tb.reduce((n, r) => n + r.credit, 0)), ''] });
  } else {
    const list = await api('/api/journals?' + qs({ month, pattern: q.pattern }));
    body = list.length ? list.map(j => `<div style="margin-bottom:12px" class="${j.status === 'REVERSED' || j.reversalOf ? 'muted' : ''}"><div class="filters small"><b>#${j.id}</b><span>${esc(j.date)}</span>${badge(j.pattern + ' ' + j.patternName)}<span class="muted">元伝票 ${esc(j.source)}:${esc(j.sourceId)} 版${j.revision}</span>${j.reversalOf ? badge('逆仕訳 ← #' + j.reversalOf, 'amber') : ''}${j.status === 'REVERSED' ? badge('取消済', 'gray') : ''}</div>
      ${table([{ label: '貸借', value: l => l.side === 'D' ? '借方' : '貸方' }, { label: '科目', value: l => `${l.account} ${l.accountName || ''}` }, { label: '内訳', value: l => l.sub ? `${l.sub} ${l.subName}` : '' }, { label: '部門', value: l => l.dept }, { label: '税区分', value: l => l.tax },
        { label: '取引先', value: l => l.partner }, { label: '借方金額', num: 1, value: l => l.side === 'D' ? yen(l.amount) : '' }, { label: '貸方金額', num: 1, value: l => l.side === 'C' ? yen(l.amount) : '' }], j.lines)}</div>`).join('') : '<div class="empty">仕訳がありません</div>';
  }
  return page('仕訳・会計連携', '業務処理から自動作成された仕訳（journal_entry / journal_line）。取消は原仕訳を残し逆仕訳で記録します。会計システムの受入形式は確認待ちです（Q14/Q19）。',
    `${monthInput('month', month)}${tab === 'tb' ? csvLink('trial-balance', { month }) : `<select name="pattern" data-filter>${options(Object.entries(meta.patterns).map(([code, name]) => ({ code, name })), q.pattern, { blank: 'すべてのパターン' })}</select>${csvLink('journals', { month, pattern: q.pattern })}`}`,
    `<section class="card glass" data-sub="list tb">${body}</section><div data-sub="export">${accountingCard()}</div>`);
};
// ② 自動仕訳リスト 7種（帳票形式：借方・貸方併記、伝票合計・日付合計）
const monthStart = () => thisMonth() + '-01';
async function journalListsView(q) {
  const A = actions, kind = meta.journalLists[q.list] ? q.list : 'A01', from = q.from || monthStart(), to = q.to || today();
  A.tab = d => go('journals', { tab: d.tab });
  A.print = () => { $('#print-area').innerHTML = `<section class="invoice-doc report-doc journal-doc"><h2>${esc(meta.journalLists[kind].title)}</h2><p>期間 ${from} 〜 ${to} ／ 出力日 ${today()}</p>${$('#jl-body').innerHTML}</section>`; setTimeout(() => window.print(), 200); };
  const url = kind === 'BANK' ? '/api/reports/bank-payments?' + qs({ from, to }) : '/api/reports/journal-list?' + qs({ pattern: kind, from, to });
  const d = await api(url);
  let body;
  const side = s => s ? `<td>${esc(s.dept)} ${esc(s.account)}<br><span class="small">${esc(s.accountName)}</span></td><td>${esc(s.sub)}<br><span class="small">${esc(s.subName)}</span></td><td class="num">${esc(s.tax)}</td><td class="num">${yen(s.amount)}</td><td><span class="small">${esc(s.memo1Code)} ${esc(s.memo1)}<br>${esc(s.memo2)}</span></td>` : '<td></td><td></td><td></td><td></td><td></td>';
  if (kind === 'BANK') {
    body = d.days.length ? d.days.map(day => `<h3 style="margin:10px 0 6px">${esc(day.date)} 支払（支払日計 ${yen(day.total)}）</h3>` + day.banks.map(g => `<p class="small"><b>支払元口座 ${esc(g.bank || '未設定')}</b></p>` + table([{ label: '業者CD', value: r => r.vendor }, { label: '業者名', value: r => r.vendorName }, { label: '伝票No', value: r => r.no }, { label: '日付', value: r => r.date },
      { label: '請求金額', num: 1, value: r => yen(r.billed) }, { label: '相殺金額', num: 1, value: r => yen(r.offset) }, { label: '安全協力費', num: 1, value: r => yen(r.safety) }, { label: '手数料', num: 1, value: r => yen(r.fee) }, { label: '業者計', num: 1, value: r => yen(r.vendorTotal) },
      { label: '支払方法', value: r => r.method }, { label: '支払元口座', value: r => r.fromBank }, { label: '振込先銀行・支店', value: r => `${r.payeeBank} ${r.payeeBranch}` }], g.rows, { foot: ['銀行計', '', '', '', '', '', '', '', yen(g.total), '', '', ''] })).join('')).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">対象期間の支払はありません</div>';
  } else {
    let html = '', last = null;
    const dateTotal = dt => `<tr class="subtotal"><td></td><td colspan="3" class="right">日付合計</td><td class="num"><b>${yen(d.dates.find(x => x.date === dt).total)}</b></td><td colspan="7"></td></tr>`;
    for (const sl of d.slips) {
      if (last && sl.date !== last) html += dateTotal(last); last = sl.date;
      sl.pairs.forEach((p, i) => { html += `<tr class="${sl.status && !sl.status.endsWith('を含む') ? 'muted' : ''}"><td>${i ? '' : esc(sl.date)}<br><span class="small">${i ? '' : esc(sl.slipNo)}</span></td>${side(p.dr)}${side(p.cr)}<td class="small">${i ? '' : esc(sl.sourceNo) + (sl.status ? '<br>' + esc(sl.status) : '')}</td></tr>`; });
      html += `<tr class="subtotal"><td></td><td colspan="2" class="right">伝票合計</td><td></td><td class="num"><b>${yen(sl.total)}</b></td><td></td><td colspan="3"></td><td class="num"><b>${yen(sl.total)}</b></td><td colspan="2"></td></tr>`;
    }
    if (last) html += dateTotal(last);
    body = d.slips.length ? `<div class="table-wrap"><table class="jl"><thead><tr><th>日付<br>伝票No</th><th>借方 部・科目</th><th>内訳1</th><th class="num">処税率</th><th class="num">借方金額</th><th>摘要1／摘要2（借方）</th><th>貸方 部・科目</th><th>内訳1</th><th class="num">処税率</th><th class="num">貸方金額</th><th>摘要1／摘要2（貸方）</th><th>元伝票</th></tr></thead><tbody>${html}</tbody>
      <tfoot><tr><td>総合計</td><td></td><td></td><td></td><td class="num">${yen(d.total)}</td><td></td><td></td><td></td><td></td><td class="num">${yen(d.total)}</td><td></td><td></td></tr></tfoot></table></div>` : '<div class="empty">対象期間の仕訳はありません</div>';
  }
  const kinds = Object.entries(meta.journalLists).map(([code, v]) => ({ code, name: v.title }));
  return page('仕訳・会計連携', '自動仕訳リストは現行帳票（⑥⑦⑨・資料ア〜エ）と同じ項目を、借方・貸方を1行に並べた形式で表示・Excel出力します（削減案5：同一フォーマット）。',
    `<select name="list" data-filter>${options(kinds, kind, { label: r => r.name })}</select><input type="date" name="from" value="${from}" data-filter><input type="date" name="to" value="${to}" data-filter><input type="hidden" name="tab" value="lists" data-filter>
     <a class="button" href="${url}&format=xlsx" download>⇩ Excel</a>`,
    `<section class="card glass"><div class="card-head"><h2>${esc(d.title)}</h2><span class="muted small">${from} 〜 ${to}</span></div><div id="jl-body">${body}</div></section>`);
}

// ----- 帳票・データ出力 -----
VIEWS.reports = async q => {
  const A = actions;
  A.acct = d => accountingDownload(d.format).catch(e => toast(e.message, true));
  A.misc = d => miscReport(d.kind, d.src).catch(e => toast(e.message, true)); A.jvAlloc = () => jvAllocDialog().catch(e => toast(e.message, true));
  const month = q.month || thisMonth(), [ar, ap] = await Promise.all([api('/api/reports/ar'), api('/api/reports/ap')]);
  const exp = [['shipments', '売上明細'], ['invoices', '請求一覧'], ['receipts', '入金一覧'], ['journals', '仕訳（会計連携用）'], ['payments', '支払・振込データ'], ['expenses', '定時請求・小口'], ['purchases', '仕入'], ['inventory', '在庫']];
  return page('帳票・データ出力', 'CSVはExcelで開けるUTF-8(BOM付き)形式です。', monthInput('month', month), `
    <section class="card glass" data-sub="csv"><div class="card-head"><h2>CSV出力（${esc(month)}）</h2></div><div class="filters">${exp.map(([k, l]) => `<a class="button" href="/api/export/${k}?month=${month}" download>⇩ ${l}</a>`).join('')}<a class="button" href="/api/export/ar" download>⇩ 売掛金残高</a><a class="button" href="#journals?tab=lists">自動仕訳リスト（帳票7種）→</a><a class="button" href="/api/export/ap" download>⇩ 未払残高</a></div></section>
    <section class="card glass" data-sub="ar"><div class="card-head"><h2>売掛金残高一覧</h2></div>${table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '締日', num: 1, value: r => r.closing === 31 ? '月末' : r.closing + '日' }, { label: '開始残高', num: 1, value: r => yen(r.opening) },
      { label: '請求累計', num: 1, value: r => yen(r.billed) }, { label: '消込累計', num: 1, value: r => yen(r.received) }, { label: '売掛残高', num: 1, value: r => yen(r.balance) }, { label: '期日超過', num: 1, html: r => r.overdue ? `<span class="check-ng">${yen(r.overdue)}</span>` : '0' }, { label: '未請求(税抜)', num: 1, value: r => yen(r.unbilled) }], ar,
      { foot: ['合計', '', yen(ar.reduce((n, r) => n + r.opening, 0)), yen(ar.reduce((n, r) => n + r.billed, 0)), yen(ar.reduce((n, r) => n + r.received, 0)), yen(ar.reduce((n, r) => n + r.balance, 0)), yen(ar.reduce((n, r) => n + r.overdue, 0)), yen(ar.reduce((n, r) => n + r.unbilled, 0))] })}</section>
    <section class="card glass" data-sub="ap"><div class="card-head"><h2>未払残高一覧</h2></div>${table([{ label: '業者', value: r => `${r.vendor} ${r.name}` }, { label: '計上累計', num: 1, value: r => yen(r.billed) }, { label: '支払累計', num: 1, value: r => yen(r.paid) }, { label: '未払残高', num: 1, value: r => yen(r.balance) }], ap)}</section><div data-sub="csv">${accountingCard()}</div><div data-sub="jv">${jvReportsCard()}</div>`);
};

// ----- 月次確定 -----
VIEWS.periods = async () => {
  const A = actions;
  const p = await api('/api/periods');
  A.check = async d => { const issues = await api('/api/periods/check?month=' + d.month); $(`#chk-${d.month}`).innerHTML = issues.length ? `<ul class="list check-ng small">${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="check-ok small">確定可能です</span>'; };
  // 確定：先にチェックし、未請求・未発行があれば一覧（得意先・締日・件数）を見せて「それでも確定する」を選べるようにする
  A.close = async d => {
    const k = await api('/api/periods/check?' + qs({ month: d.month, detail: 1 })), open = k.unbilled.length || k.drafts;
    if (!open) return confirmBox('月次確定', `${d.month} を確定します。確定後はこの月の日付で登録・変更・取消ができません。`, () => post('/api/periods/close', { month: d.month }).then(() => { toast('確定しました'); render(); }), '確定する');
    modal({ title: `月次確定（${d.month}）`, submit: '確定する', danger: true, wide: true, body: `<p>${esc(d.month)} を確定します。確定後はこの月の日付で登録・変更・取消ができません。</p>
      <div class="note" style="margin:10px 0"><b class="check-ng">確定前チェックで未処理があります</b>：未請求の出荷がある得意先 <b>${k.unbilled.length}社（${yen(k.unbilledCount)}件）</b>${k.drafts ? `・未発行の請求書 <b>${k.drafts}件</b>` : ''}。<br>通常は「請求締め・発行」で請求を作成・発行してから確定します。</div>
      ${k.unbilled.length ? `<details><summary>未請求の出荷がある得意先（${k.unbilled.length}社）</summary><div style="max-height:260px;overflow:auto;margin-top:6px">${table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '締日', value: r => r.closing }, { label: '未請求出荷', num: 1, value: r => r.count + '件' }], k.unbilled)}</div></details>` : ''}
      <label class="field wide" style="margin-top:12px"><span><input type="checkbox" name="force"> 未請求・未発行があっても確定する（テスト・移行データ用。操作履歴に記録します）</span></label>`,
      onSubmit: async v => { if (v.force !== 'on') throw Error('未請求・未発行があるため確定できません。確定する場合は「未請求・未発行があっても確定する」にチェックしてください'); await post('/api/periods/close', { month: d.month, force: true }); toast('確定しました'); render(); } });
  };
  A.reopen = d => confirmBox('確定解除', `${d.month} の確定を解除します。`, () => post('/api/periods/reopen', { month: d.month }).then(() => { toast('解除しました'); render(); }), '解除する');
  return page('月次確定', '確定した月の伝票は登録・変更・取消ができなくなります。確定・解除は管理者のみ実行できます。', '', `<section class="card glass">${table([{ label: '月', value: r => r.month }, { label: '状態', html: r => r.closed ? badge('確定済', 'green') : badge('未確定', 'gray') },
    { label: '確定日時 / 実行者', value: r => r.closed ? `${jst(r.closedAt, 16)} / ${r.closedBy}` : '' }, { label: 'チェック', html: r => `<div id="chk-${r.month}">${r.closed ? '' : `<button class="mini" data-act="check" data-month="${r.month}">確定前チェック</button>`}</div>` },
    { label: '', html: r => isAdmin() ? (r.closed ? `<button class="mini danger" data-act="reopen" data-month="${r.month}">解除</button>` : `<button class="mini primary" data-act="close" data-month="${r.month}">確定</button>`) : '' }], p.months)}</section>
    `);
};

// ----- マスタ管理 -----
VIEWS.masters = async q => {
  const A = actions;
  const kind = meta.masters[q.kind] ? q.kind : 'customers', m = meta.masters[kind], all = masters[kind] = await api('/api/masters/' + kind);
  const term = (q.search || '').trim().toLowerCase(), byMonth = q.month ? all.filter(r => r.month === q.month) : all, list = term ? byMonth.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(term))) : byMonth;
  // 照会のみのマスタ（原価）は年月で絞り込む
  const months = m.fields.some(f => f.name === 'month') ? [...new Set(all.map(r => r.month))] : [];
  A.tab = d => go('masters', { kind: d.kind });
  A.search = () => go('masters', { kind, search: $('#m-search').value.trim(), ...(months.length ? { month: $('#m-month').value } : {}) });
  A.new = () => masterForm(kind); A.edit = d => masterForm(kind, list.find(r => r.key === d.key));
  A.import = () => modal({ title: `${m.label} CSV取込`, submit: '取込む', body: `<p class="small">1行目は列名（${m.fields.map(f => f.label).join('、')}）です。<b>1件でもエラーがあれば全件取消</b>します。既存コードは更新、新規コードは登録します。</p>
      <input type="file" name="file" accept=".csv,text/csv" required><p class="muted small"><a href="/api/export/master-${kind}" download>現在のデータをCSVで出力</a></p>`,
    onSubmit: async (v, f) => { const file = f.file.files[0]; if (!file) throw Error('ファイルを選択してください'); const buf = await file.arrayBuffer();
      let csv; try { csv = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { csv = new TextDecoder('shift_jis').decode(buf); }
      const r = await post(`/api/masters/${kind}/import`, { csv }); toast(`登録 ${r.created}件・更新 ${r.updated}件`); await loadMasters(); render(); } });
  // 一覧はマスタの全項目を表示する（2026-10-29：list:false の非表示項目も表示。未設定は空欄）
  const show = f => r => r[f.name] === null || r[f.name] === undefined || (r[f.name] === '' && f.type !== 'bool') ? '' : f.type === 'bool' ? (r[f.name] ? '○' : '') : f.type === 'ref' ? `${r[f.name]} ${nameOf(f.ref, r[f.name])}` : f.type === 'select' ? (f.options.find(o => o[0] === String(r[f.name]))?.[1] || r[f.name]) : f.type === 'int' ? yen(r[f.name]) : f.type === 'dec' ? Number(r[f.name]).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : r[f.name];
  return page('マスタ管理', `${Object.keys(meta.masters).length}種類のマスタを業務テーブルで直接管理します。登録後のコード・所属は変更できません（新規登録して旧マスタを無効化）。使われていないコードは編集画面から削除できます。`, `${months.length ? `<select id="m-month" name="month" data-filter><option value="">全年月</option>${months.map(x => `<option ${x === q.month ? 'selected' : ''}>${x}</option>`).join('')}</select>` : ''}<input id="m-search" placeholder="コード・名称などで検索" value="${esc(q.search || '')}" style="width:220px"><button class="primary" data-act="search">検索</button>${csvLink('master-' + kind)}${canWrite() && !m.readOnly ? '<button data-act="import">⇧ CSV取込</button><button class="primary" data-act="new">＋ 新規登録</button>' : ''}`,
    `<section class="card glass master-list">${term ? `<p class="muted small">「${esc(q.search)}」の検索結果 ${list.length} / ${all.length} 件</p>` : ''}${table([...m.fields.filter(f => f.name !== 'active').map(f => ({ label: f.label, num: f.type === 'int' || f.type === 'dec', value: show(f) })), { label: '状態', html: r => r.active ? badge('有効', 'green') : badge('無効', 'gray') },
      { label: '', html: r => canWrite() && !m.readOnly ? `<button class="mini" data-act="edit" data-key="${esc(r.key)}">編集</button>` : '' }], list, { rowClass: r => r.active ? '' : 'muted' })}</section>`);
};
function masterInput(f, r, isNew) {
  const v = r?.[f.name] ?? (f.type === 'bool' ? true : ''), dis = f.key && !isNew ? 'disabled' : '';
  if (f.type === 'bool') return `<label class="field"><span>${esc(f.label)}</span><span><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> 有効</span></label>`;
  let input;
  if (f.readonly) return field(f.label, `<input value="${esc(v)}" disabled>`, { hint: f.hint });
  // 参照先にないコード（商品マスタ差し替え前の登録など）もそのまま表示する
  if (f.type === 'ref') input = `<select name="${f.name}" data-pick ${dis}>${v && !(masters[f.ref] || []).some(x => x.code === v) ? `<option value="${esc(v)}" selected>${esc(v)}（マスタ未登録）</option>` : ''}${options(isNew ? active(f.ref) : masters[f.ref], v, { blank: '選択してください' })}</select>`;
  else if (f.type === 'site') input = `<select name="${f.name}" data-pick ${dis}>${siteOptions(r?.customer || '', v, '（得意先共通）')}</select>`;
  // 選択肢に無い登録済みの値（移行データの規定外の締日など）は「（規定外）」として残し、黙って先頭の選択肢に変わらないようにする
  else if (f.type === 'select') { const opts = f.options.map(([code, name]) => ({ code, name })); if (v !== undefined && v !== null && v !== '' && !opts.some(o => o.code === String(v))) opts.push({ code: String(v), name: `${v}（規定外）` }); input = `<select name="${f.name}">${options(opts, v || f.options[0][0], { label: x => x.name })}</select>`; }
  else input = `<input name="${f.name}" type="${f.type === 'date' || f.type === 'month' ? f.type : 'text'}" class="${f.type === 'int' || f.type === 'dec' ? 'num' : ''}" value="${esc(v)}" ${f.max ? `maxlength="${f.max}"` : ''} ${dis}>`;
  return field(f.label, input, { req: !f.optional, hint: f.hint });
}
function masterForm(kind, r) {
  const m = meta.masters[kind];
  // サンプル入力は新規・編集・自社情報のすべてに付ける（2026-10-29。空欄だけを埋めるので入力済みの値は変わらない）
  modal({ title: `${m.label}の${r ? '編集' : '新規登録'}`, submit: r ? '更新する' : '登録する', sample: true, body: `<div class="form-grid">${m.fields.map(f => masterInput(f, r, !r)).join('')}</div>${r?.system ? '<p class="note small">自動仕訳で使用する科目のため無効化できません。</p>' : ''}`,
    onOpen: f => {
      if (f.site && f.customer) f.customer.onchange = () => (f.site.innerHTML = siteOptions(f.customer.value, '', '（得意先共通）'));
      // 削除：使用中のコードはサーバーが拒否し、無効化を案内する
      if (r && kind !== 'company' && !r.system) { $('#modal-body').insertAdjacentHTML('beforeend', '<div class="filters" style="margin-top:10px"><button type="button" class="danger" id="m-del">削除</button><span class="muted small">取引などで使われているコードは削除できません（「有効」を外して無効化）</span></div>');
        $('#m-del').onclick = () => confirmBox(`${m.label}の削除`, `「${r.key.split('|').filter(Boolean).join('-')}」を削除します。元に戻せません。`, async () => { await post(`/api/masters/${kind}/delete`, { record: r }); toast('削除しました'); await loadMasters(); render(); }, '削除する'); }
    },
    onSubmit: async (v, f) => {
      const rec = { ...(r || {}), ...v }; for (const x of m.fields) if (x.type === 'bool') rec[x.name] = f[x.name].checked;
      await post('/api/masters/' + kind, { mode: r ? 'update' : 'create', record: rec }); toast(r ? '更新しました' : '登録しました'); await loadMasters(); render();
    } });
}

// ----- 移行・確認事項 -----
VIEWS.migration = async () => {
  const A = actions;
  const [cov, req] = await Promise.all([api('/api/coverage'), fetch('/requirements.json').then(r => r.json())]);
  const used = cov.filter(t => t.use.startsWith('使用')).length;
  return page('移行・確認事項', 'AS400 業務の Web 移行における本システムの前提と、確認が必要な事項です（2026-10-23 更新）。', '', `
    <div class="grid2"><section class="card glass"><div class="card-head"><h2>本システムの前提（仮決定）</h2></div><ol class="list small">
      <li>出荷1件＝1商品＝売上1行（sales_trn.order_suffix=1）。請求明細（billing_detail）は売上No単位で作成し、請求ヘッダとは得意先・請求年月・締日で結び付けます。<b>billing_detail と sales_trn 枝番の正式な関係は確認待ち</b>です。</li><li>出荷伝票訂正は<b>赤黒</b>（10/14 打合せ）：元伝票は変更せず、赤＝元伝票の全量マイナス、黒＝訂正後の内容（日付・得意先・現場・商品・数量・単価・運賃すべて変更可）を伝票区分5で起票（sales_no＝元売上No）。次回の請求締めに含めます。</li>
      <li>請求は<b>得意先×締日の単位</b>（NO6：現場単位から得意先単位へ変更、2026-10-15決定）。現場は明細に保持し、<b>請求書は得意先1枚で現場ごとに小計</b>（2026-10-24 決定、10/23 打合せの確認事項 A）。掛売のみ対象とし、現金・カード売上は請求対象外（Q16/Q17）。値引は請求時点では行わず、入金消込で処理します（Q18 回答済）。</li>
      <li>消費税は請求書単位で税率ごとに合計し、円未満切り捨て。支払期日は締日の翌月末（仮）。</li>
      <li>入金は振込・現金・手形・振込手数料・協力会費等・預り金充当・値引の内訳で記録し、得意先×請求年月の請求へ消込できます（仕訳 B-01〜B-06）。協力会費の処税率は141で仮置き（Q04）、預り金の受入は開始残高のみ（Q11）。</li>
      <li>仕訳パターン A01〜G03 は仕訳パターン分析と現行の仕訳帳（ハーツ＆ソウル AC2205）に合わせています。伝票番号は現行の系列（R 売掛計上・B 入金・S 定時請求・K 小口現金・U 支払・6桁 在庫計上/小口補充）を引き継ぎます。会計システムは勘定奉行、受入形式は 10/26 打合せで確定予定（Q14/Q19）。</li>
      <li>銀行マスタ（code_m BANK）は当座預金 1112・普通預金 1113 の内訳科目として同期します。支払の振込手数料差引は雑収入 8790-001（処税率9）、相殺は業者立替金 1431 で仕訳します（Q03）。</li>
      <li>月次確定はアプリ用テーブル app_period_close で管理。利用者・権限は users / roles / menus を使用し、ロールは現行 Java と同じ 1 管理者／2 担当者（受付）／3 担当者（事務）／4 担当者（出荷のみ）／5 参照者です。</li>
      <li>運用環境は Render（アプリ）＋ Supabase（PostgreSQL）です（2026-10-21、Railway の障害により移行）。データは現行システムのテストデータを移行したもので、2022年の月度分（2021-12-21〜2022-12-31）だけを残し、4年後ろへずらして 2026年として表示しています（出荷 2025-12-21〜2026-10-20、請求 2026-01〜03・締日20日）。実取引のデータではありません。</li></ol><h3 style="margin-top:12px">2026-10-21 再構成（議事メモ 10/14・10/19、QA回答、消費税区分、現行 Java ソース）</h3><ul class="list small">
      <li>現行 Java とコードを統一：決済方法 1 現金／2 掛売／3 カード、伝票区分 2 他社納入（訂正は 5）、製品・材料区分 2 製品／1 材料、ロール 1〜5、採番キー 101〜105。既存データは起動時に一度だけ変換。</li>
      <li>単価は現行と同じ選び方（現場別→得意先共通、出荷日が適用期間内なら適用単価・適用運賃）。金額＝数量×(単価＋運賃) を自社情報の端数処理（金額 四捨五入・税 切捨）で計算。現場はマスタ外の自由入力も可。</li>
      <li>売掛金計上（A01）は締日単位で一括し、請求締め1回分を得意先コード順に<b>1伝票最大45得意先</b>で分割して同じ伝票番号（R）を振ります（Q08 指定 2026-10-23：R00829→R00830 が45得意先目で分割）。1請求＝1伝票ではありません。自動仕訳リスト・会計連携・会計の仕訳受入も伝票番号単位で1伝票。逆仕訳は別の伝票番号です。</li>
      <li>税区分は処税率（3桁）をそのまま使用。1桁目は 1=内税、2・空白=外税で確定（2026-10-22、Q01・Q26）。</li>
      <li>定時請求・小口現金・商品仕入は伝票＋複数明細。請求No は業者ごと4桁、支払予定日は業者マスタの支払繰延区分。仕入は区分（仕入／他社納入）と運賃行。帳票⑭⑰・振込先一覧を追加。</li>
      <li>JV構成員は業者マスタ参照（最大7社）。按分端数の規則は現行帳票と一致しない行があり確認中（Q27）。</li></ul>
      <h3 style="margin-top:12px">2026-10-21〜22 追加（見積提案書・現行 Java・仕訳帳）</h3><ul class="list small">
      <li>出荷：伝票番号 YYMM＋5桁、伝票区分・他社得意先、担当者・納入区分は必須、天候・出発時間・出発温度、累計数量・累計台数・予定数量。画面は提案書 スライド7・17 の配置。</li>
      <li>出荷予定と納品書発行（NI0060）を推定で実装（機能一覧の範囲外）。</li>
      <li>会計月度は 21日〜20日、決算は 10月20日（期首 10月21日）。財務会計（勘定奉行相当）も同じ月度で集計します。</li>
      <li>請求書は提案書様式（前回残高・今回入金額・今回残高、取引銀行2行）。請求書発行確認表は現行 HAR430 の項目。</li>
      <li>マスタは使用中のコードを削除せず無効化を案内。画面はサイドバーの小メニューで機能ごとに表示します。</li></ul>
      <h3 style="margin-top:12px">2026-10-23 反映（議事メモ 10/22 版・入金配賦登録）</h3><ul class="list small"><li>出資金：現行の端数調整画面「入金額配賦登録」（HJW030）に合わせ、帳票・データ出力 → 出資金（JV）帳票に「入金額配賦登録（端数調整）」を追加。締切日の月度の入金ごとに構成員別の配分額を直して登録し、入金明細及び配分表はその金額で出力（Q27・Q36）。</li><li>定時請求の締切日：初期値は直近の締日、手入力で変更できる（決算月は更新処理が遅れるため）。</li><li>定時請求入力明細表は請求書登録後のチェック用（月末〜翌月3日頃に出力）。小口現金出納簿は20日締め・翌月1〜3日頃に出力（Q31）。</li><li>現行メニューの「出資金支払日別明細表印刷」は要否を確認（Q37）。</li></ul>
      <h3 style="margin-top:12px">2026-10-22 反映（10/21 打合せ・再検証）</h3><ul class="list small"><li>在庫：実在庫登録（調査日の月度に品目ごとの数量）と在庫計上を分離。在庫計上は月度ごとに1回、単価＝(前月末在庫金額＋当月仕入)÷(前月末在庫数＋当月仕入数)で評価し洗い替え仕訳。修正は「在庫計上の取消」（逆仕訳）後に再実行（Q07）。</li><li>定時請求データ入力：現行 HAW050 の並び（組織・締切日・請求No・業者・支払繰延区分・支払予定日・合計金額、明細2段）。合計金額は手入力で、明細合計（対象外＋内税＋外税＋外税消費税）と一致しないと登録不可。外税消費税は自動計算（端数は手修正、仮払消費税 1465）。締切日の初期値は直近の締日。</li><li>処税率の1桁目は 1=内税、2・空白=外税で確定（Q01・Q26）。</li><li>定時請求入力明細表：部門・区分（1 組織／ブランク 工事）・業者コード From〜To（ブランク＝出力しない、To 9999999＝全業者、From＞To はエラー、英字は大文字にそろえて比較）。月度の初期値は直近の締日。</li><li>出資金帳票：締切日で指示。明細表・合計表は支払日別・科目別。入金明細は当座預金への入金（振込・手形）・入金時手数料・現金売上（Q36）。</li><li>配合計算：材料単価の手入力（マスタ管理 → 材料単価、月別）と原価の照会画面（マスタ管理 → 原価、照会のみ）を追加。配合マスタのサンプルは削除し、配合表の受領待ち（Q34）。</li></ul>
      <h3 style="margin-top:12px">資料未着のため推定で実装した項目（2026-10-15）</h3><ul class="list small"><li>会計連携: 勘定奉行受入CSV（OBC受入記号・税区分は会計設定で登録）・汎用CSV・弥生形式。処税率は3桁を分解して変換（消費税区分.xlsx）。</li><li>配合計算: 配合率は配合マスタ、材料単価は材料単価マスタ（手入力・月別）を優先し無ければ移動平均、経費単価は当月経費（電気8242／製造8244・8243／一般管理費系）÷製品出荷数量で自動算出。灯油は材料「灯油」の使用高。結果は原価（genka_m）に保存（Q34）。</li><li>定時請求入力明細表: 発注残・相殺は0。現比は振込のみのため出力しない（10/19）。</li><li>小口現金出納簿: 定額資金前渡制（期首受入・支払後残高・次期補充額）を仮定。期間は20日締め（初期値は直近の締日の月度、Q31）。</li><li>入金予定チェックリスト: 予定日＝支払期日、予定額＝残高の現場別売上比按分、入金方法・入金先は過去実績から推定。</li><li>一括ダウンロード: Excel（1請求書＝1シート）。は得意先別残高照会タブで請求残高照会を兼ねる（削減案3）。</li></ul></section>
    <section class="card glass"><div class="card-head"><h2>テーブル使用状況</h2>${badge(`${used} / ${cov.length} 表を使用`, 'green')}</div>${table([{ label: 'テーブル', value: r => r.table }, { label: '内容', value: r => r.label }, { label: '区分', value: r => r.origin }, { label: '本システム', html: r => r.use.startsWith('使用') ? badge(r.use, 'green') : badge(r.use, 'gray') }, { label: '件数', num: 1, value: r => yen(r.rows) }], cov)}</section></div>
    ${questionsSection(req)}`);
};
// 確認事項（2026-10-23 整理）：回答済みは「解決済み」に分け、同じ論点の質問はグループ（G1〜）にまとめてお客様に1問として確認する
function questionsSection(req) {
  const qs = req.questions, byId = Object.fromEntries(qs.map(q => [q.id, q])), groups = req.groups || [];
  const stBadge = s => badge(s || '未回答', s === '回答済' ? 'green' : s === '一部回答' ? 'amber' : 'gray');
  const done = qs.filter(q => q.status === '回答済'), grouped = new Set(groups.flatMap(g => g.members));
  const rank = { '未回答': 0, '一部回答': 1, '回答済': 2 };
  const ask = [...groups.map(g => { const ms = g.members.map(id => byId[id]).filter(Boolean); return { group: g, ms, status: ms.reduce((s, q) => (rank[q.status] < rank[s] ? q.status : s), '回答済'), key: ms[0]?.id || '' }; }),
    ...qs.filter(q => q.status !== '回答済' && !grouped.has(q.id)).map(q => ({ q, status: q.status, key: q.id }))];
  const lines = (ms, f) => ms.map(q => `<div><b>${esc(q.id)}</b> ${esc(f(q) || '—')}</div>`).join('');
  const askTable = table([
    { label: 'No', html: r => (r.group ? `<b>${esc(r.group.id)}</b><br><span class="small muted">${r.ms.map(q => esc(q.id)).join('・')}</span>` : esc(r.q.id)) },
    { label: '状態', html: r => stBadge(r.status) },
    { label: '確認事項', html: r => (r.group ? `<b>${esc(r.group.title)}</b>：${esc(r.group.point)}<div class="small" style="margin-top:4px">${lines(r.ms, q => q.question)}</div>` : esc(r.q.question)) },
    { label: '回答・根拠（現状）', html: r => (r.group ? `<div class="small">${lines(r.ms, q => q.answer)}</div>` : esc(r.q.answer || '')) },
    { label: '影響', html: r => (r.group ? esc([...new Set(r.ms.map(q => q.impact))].join(' ／ ')) : esc(r.q.impact)) }], ask);
  const doneTable = table([{ label: 'No', value: r => r.id }, { label: '状態', html: r => stBadge(r.status) }, { label: '確認事項', value: r => r.question }, { label: '回答・根拠', value: r => r.answer || '' }, { label: '影響', value: r => r.impact }], done);
  return `<section class="card glass"><div class="card-head"><h2>確認事項（${qs.length}件：お客様確認 ${qs.length - done.length}件＝${ask.length}問／解決済み ${done.length}件）</h2></div>
      <p class="muted small">${req.reviewed ? `${esc(req.reviewed)} 整理。` : ''}同じ論点の質問は G1〜G${groups.length} にまとめて1問として確認します。状態はまとめた質問のうち最も進んでいないもの。</p>${askTable}
      <details style="margin-top:12px"><summary><b>解決済み（${done.length}件）</b> <span class="muted small">お客様確認から外したもの</span></summary>${doneTable}</details></section>`;
}

// ----- 操作履歴 -----
VIEWS.audit = async q => {
  const A = actions;
  const list = await api('/api/audit?' + qs({ entity: q.entity }));
  const entities = [...new Set(list.map(r => r.entity))].map(code => ({ code, name: code }));
  return page('操作履歴', '登録・変更・取消・ログインの記録（audit_event）。口座番号やパスワードは記録しません。', filterSelect('entity', entities, q.entity, 'すべての対象'),
    `<section class="card glass">${table([{ label: '日時', value: r => jst(r.at) }, { label: '利用者', value: r => r.actor }, { label: '操作', value: r => ACTIONS[r.action] || r.action }, { label: '対象', value: r => `${r.entity} ${r.entityId}` },
      { label: '内容', cls: 'small muted', value: r => JSON.stringify(r.summary).slice(0, 160) }], list)}</section>`);
};

// ----- 利用者管理 -----
VIEWS.users = async () => {
  const A = actions;
  const list = await api('/api/users');
  const form = u => modal({ title: u ? `利用者の編集（${u.loginId}）` : '利用者の追加', submit: u ? '更新する' : '追加する', body: `<div class="form-grid">
      ${field('ログインID', `<input name="loginId" value="${esc(u?.loginId || '')}" ${u ? 'disabled' : ''} maxlength="64">`, { req: 1 })}${field('氏名', `<input name="name" value="${esc(u?.name || '')}" maxlength="60">`, { req: 1 })}
      ${field('ロール', `<select name="role">${options(Object.entries(meta.roles).map(([code, name]) => ({ code, name })), u?.role || 2, { label: x => x.name })}</select>`, { hint: '参照者は閲覧のみ' })}
      ${field(u ? '新しいパスワード（変更時のみ）' : 'パスワード', '<input name="password" type="password" autocomplete="new-password">', { req: !u, hint: '12文字以上' })}
      <label class="field"><span>状態</span><span><input type="checkbox" name="enabled" ${u?.enabled === false ? '' : 'checked'}> 有効</span></label></div>`,
    onSubmit: async (v, f) => { await post('/api/users', { ...v, id: u?.id, enabled: f.enabled.checked }); toast('保存しました'); render(); } });
  A.new = () => form(); A.edit = d => form(list.find(u => u.id === Number(d.id)));
  return page('利用者管理', '利用者ごとにログインIDとロールを設定します（users / user_role_ts / roles）。初期管理者のパスワードは環境変数で管理しています。', '<button class="primary" data-act="new">＋ 利用者追加</button>',
    `<section class="card glass">${table([{ label: 'ID', value: r => r.id }, { label: 'ログインID', value: r => r.loginId }, { label: '氏名', value: r => r.name }, { label: 'ロール', html: r => badge(r.roleName) }, { label: '状態', html: r => r.enabled ? badge('有効', 'green') : badge('無効', 'gray') },
      { label: '', html: r => `<button class="mini" data-act="edit" data-id="${r.id}">編集</button>` }], list)}</section>`);
};

// 財務会計（勘定奉行相当）の画面は kb.js
installKb({ VIEWS, api, post, page, table, esc, yen, badge, modal, confirmBox, toast, today, addMonths, qs, go, $, $$, canWrite, isAdmin, jst, loadMasters, render, SAMPLE_ICON,
  acts: () => actions, route: () => route, masters: () => masters });

// ---------- boot ----------
async function boot() {
  try { session = await api('/api/session'); meta = await api('/api/meta'); await loadMasters(); }
  catch (e) { $('#content').innerHTML = `<div class="card glass"><h2>接続できません</h2><p class="check-ng">${esc(e.message)}</p></div>`; return; }
  nav(); $('#user-name').textContent = session.user.name; $('#user-role').textContent = session.user.roleName; $('#avatar').textContent = (session.user.name || 'A').slice(0, 1); $('#app-version').textContent = 'v' + meta.version;
  $('#logout').onclick = async () => { await post('/api/logout', {}).catch(() => {}); location.replace('/login'); };
  $('#refresh').onclick = async () => { await loadMasters(); await render({ fresh: true }); toast('最新の状態を読み込みました'); };
  $('#menu-toggle').onclick = () => document.body.classList.toggle('nav-open');
  $('#change-password').onclick = () => modal({ title: 'パスワード変更', submit: '変更する', body: `<div class="form-grid">${field('現在のパスワード', '<input type="password" name="current" autocomplete="current-password">', { req: 1, wide: 1 })}${field('新しいパスワード', '<input type="password" name="password" autocomplete="new-password">', { req: 1, wide: 1, hint: '12文字以上' })}</div>`,
    onSubmit: async v => { await post('/api/password', v); toast('パスワードを変更しました'); } });
  window.addEventListener('hashchange', () => render({ fresh: takeFresh() }));
  await render();
}
boot();

// 出荷・売上帳票：登録済みの出荷日の範囲を表示し、押すとその最終月を期間に入れる（移行データは過去日付のため）
document.addEventListener('view:rendered', async () => {
  const el = $('#ms-range'); if (!el) return;
  const r = await api('/api/shipments/range').catch(() => null); if (!r?.to) return;
  el.innerHTML = ` 登録済みの出荷日：${esc(r.from)}〜${esc(r.to)} <button type="button" class="mini" id="ms-last">最終月を指定</button>`;
  $('#ms-last').onclick = () => { $('#ms-from').value = r.to.slice(0, 8) + '01'; $('#ms-to').value = r.to; };
}); // shipmentRangeHint
