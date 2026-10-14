// APLink 請求・入金管理 — single page client. All data comes from the MySQL-backed API.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = v => new Intl.NumberFormat('ja-JP').format(Number(v) || 0);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const thisMonth = () => today().slice(0, 7);
// DB timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS[.ffffff]"); screens show Japan time.
const jst = (v, len = 19) => { if (!v) return ''; const d = new Date(String(v).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z'); return isNaN(d) ? String(v) : new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, len); };
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
let session, meta, masters = {}, actions = {}, route = { name: 'dashboard', q: {} }, renderSeq = 0;
const canWrite = () => [1, 2].includes(session?.user.role), isAdmin = () => session?.user.role === 1;

// ---------- API ----------
async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { location.replace('/login' + location.hash); throw Error('ログインしてください'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error || `処理に失敗しました (${res.status})`);
  return data;
}
const post = (url, body) => api(url, { method: 'POST', body });
async function loadMasters() { masters = await api('/api/masters'); }
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();

// ---------- UI helpers ----------
function toast(msg, error = false) { const t = $('#toast'); t.textContent = msg; t.className = error ? 'error' : ''; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), error ? 7000 : 4000); }
const badge = (label, cls = '') => `<span class="badge ${cls}">${esc(label)}</span>`;
const STATUS = { draft: ['未発行', 'gray'], issued: ['発行済', ''], partial: ['一部入金', 'amber'], paid: ['入金済', 'green'], POSTED: ['計上済', 'green'], REVERSED: ['取消', 'gray'], DRAFT: ['下書き', 'gray'] };
const status = s => badge(...(STATUS[s] || [s, 'gray']));
const nameOf = (kind, code) => masters[kind]?.find(r => r.code === code)?.name || code || '';
const active = kind => (masters[kind] || []).filter(r => r.active);
const options = (list, value, { blank, label = r => `${r.code} ${r.name}`, val = r => r.code } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') + list.map(r => `<option value="${esc(val(r))}" ${String(val(r)) === String(value ?? '') ? 'selected' : ''}>${esc(label(r))}</option>`).join('');
const siteOptions = (customer, value, blank) => options((masters.sites || []).filter(s => s.customer === customer && (s.active || `${s.code}|${s.suffix}` === value)), value, { blank, val: s => `${s.code}|${s.suffix}`, label: s => `${s.code}-${s.suffix} ${s.name}` });
function table(cols, rows, { empty = 'データがありません', foot, rowClass } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr class="${rowClass ? rowClass(r) : ''}">${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(c.value(r))}</td>`).join('')}</tr>`).join('')}</tbody>${foot ? `<tfoot><tr>${foot.map(f => `<td class="num">${f ?? ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}
const field = (label, input, { req, hint, wide } = {}) => `<label class="field ${req ? 'req' : ''} ${wide ? 'wide' : ''}"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
const monthInput = (name, value) => `<input type="month" name="${name}" value="${esc(value)}" data-filter>`;
const filterSelect = (name, list, value, blank) => `<select name="${name}" data-filter>${options(list, value, { blank })}</select>`;
const page = (title, sub, actionsHtml, body) => `<div class="page"><div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="filters">${actionsHtml || ''}</div></div>${body}</div>`;
const csvLink = (kind, q = {}) => `<a class="button" href="/api/export/${kind}?${qs(q)}" download>⇩ CSV</a>`;

// Modal with top-right X and bottom close/cancel button. onSubmit returns truthy to close.
function modal({ title, body, submit, onSubmit, wide = false, onOpen, danger = false }) {
  const d = $('#dialog'), form = $('#modal-form');
  d.classList.toggle('wide', wide); $('#modal-title').textContent = title; $('#modal-body').innerHTML = body + '<p class="form-error" id="form-error"></p>';
  $('#modal-foot').innerHTML = `<button type="button" id="modal-cancel">${submit ? 'キャンセル' : '閉じる'}</button>${submit ? `<button type="submit" class="${danger ? 'danger' : 'primary'}" id="modal-submit">${esc(submit)}</button>` : ''}`;
  const close = () => { d.close(); form.onsubmit = null; };
  $('#modal-cancel').onclick = close; $('#modal-x').onclick = close;
  form.onsubmit = async e => {
    e.preventDefault(); if (!onSubmit) return close();
    const btn = $('#modal-submit'); btn.disabled = true; $('#form-error').textContent = '';
    try { if ((await onSubmit(Object.fromEntries(new FormData(form)), form)) !== false) close(); }
    catch (err) { $('#form-error').textContent = err.message; }
    finally { btn.disabled = false; }
  };
  d.showModal(); onOpen?.(form);
}
const confirmBox = (title, message, run, label = '実行') => modal({ title, body: `<p>${esc(message)}</p>`, submit: label, danger: true, onSubmit: async () => { await run(); } });
async function act(fn, msg) { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await render(); return r; } catch (e) { toast(e.message, true); } }

// ---------- navigation ----------
const TITLES = {};
function nav() {
  let last = '';
  $('#navigation').innerHTML = session.menus.map(m => { TITLES[m.url.slice(1)] = m.title; const g = m.grp !== last ? `<div class="nav-group">${esc(m.grp)}</div>` : ''; last = m.grp; return `${g}<a class="nav-link" href="${esc(m.url)}" data-nav="${esc(m.url.slice(1))}"><i>${esc(m.icon)}</i>${esc(m.title)}</a>`; }).join('');
}
function parseHash() { const [name, q] = location.hash.slice(1).split('?'); return { name: name || 'dashboard', q: Object.fromEntries(new URLSearchParams(q || '')) }; }
const go = (name, q = {}) => { const h = '#' + name + (Object.keys(q).length ? '?' + qs(q) : ''); if (location.hash === h) render(); else location.hash = h; };
async function render() {
  route = parseHash();
  if (!TITLES[route.name] || !VIEWS[route.name]) route.name = 'dashboard';
  const fn = VIEWS[route.name];
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === route.name));
  $('#crumb').textContent = TITLES[route.name] || 'ダッシュボード'; document.body.classList.remove('nav-open');
  const token = ++renderSeq, own = { go: d => go(d.to) }, prev = actions;
  let html, pending;
  $('#content').classList.add('busy');
  actions = own; try { pending = fn(route.q); } finally { actions = prev; } // view captures `own` synchronously; old page stays usable while loading
  try { html = await pending; }
  catch (e) { html = `<div class="card glass"><h2>読み込みエラー</h2><p class="check-ng">${esc(e.message)}</p></div>`; }
  if (token !== renderSeq) return; // a newer navigation finished first
  const content = $('#content');
  actions = own; content.innerHTML = html; content.dataset.view = route.name; content.classList.remove('busy');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || !actions[b.dataset.act]) return;
  e.preventDefault(); actions[b.dataset.act](b.dataset, b);
});
document.addEventListener('change', e => {
  if (!e.target.matches('[data-filter]')) return;
  const q = { ...route.q }; for (const el of $$('[data-filter]')) q[el.name] = el.value; go(route.name, q);
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
        <p class="muted small">最大 ${yen(max)} 円。棒にカーソルを合わせると金額を表示します。</p></section>
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
VIEWS.shipments = async q => {
  const A = actions;
  const month = q.month || thisMonth(), list = await api('/api/shipments?' + qs({ month, customer: q.customer, status: q.status, method: q.method }));
  A.new = () => shipmentForm(); A.edit = d => shipmentForm(list.find(r => r.orderNo === d.id)); A.correct = d => correctionForm(list.find(r => r.orderNo === d.id));
  A.del = d => confirmBox('出荷の取消', `売上No ${d.id} を取消します。請求前の伝票のみ取消できます。`, () => post('/api/shipments/delete', { orderNo: d.id }).then(() => { toast('取消しました'); render(); }), '取消する');
  const net = list.reduce((n, r) => n + r.net, 0), tax = list.reduce((n, r) => n + r.tax, 0);
  const acts = r => {
    if (!canWrite()) return '';
    const b = [];
    if (!r.billed && r.shipKb !== 2) b.push(`<button class="mini" data-act="edit" data-id="${esc(r.orderNo)}">編集</button>`);
    if (r.shipKb !== 2) b.push(`<button class="mini" data-act="correct" data-id="${esc(r.orderNo)}">訂正</button>`);
    if (!r.billed) b.push(`<button class="mini danger" data-act="del" data-id="${esc(r.orderNo)}">取消</button>`);
    return `<div class="actions">${b.join('')}</div>`;
  };
  return page('出荷・売上', '出荷伝票（shipment_slip）と売上（sales_trn）を同時に登録します。請求済みの伝票は「訂正」で数量のマイナス訂正伝票を起票します（NO11）。',
    `${monthInput('month', month)}${filterSelect('customer', masters.customers, q.customer, 'すべての得意先')}<select name="status" data-filter>${options([{ code: 'open', name: '未請求' }, { code: 'billed', name: '請求済' }], q.status, { blank: 'すべて', label: r => r.name })}</select>
     <select name="method" data-filter>${options(Object.entries(meta.methods).map(([code, name]) => ({ code, name })), q.method, { blank: 'すべての決済', label: r => r.name })}</select>${csvLink('shipments', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 出荷登録</button>' : ''}`,
    `<section class="card glass">${table([{ label: '売上No', html: r => esc(r.orderNo) + (r.shipKb === 2 ? `<br><span class="small muted">元 ${esc(r.originalNo)}</span>` : '') }, { label: '出荷日', value: r => r.date }, { label: '得意先', value: r => r.customerName }, { label: '現場', value: r => r.siteName }, { label: '商品', value: r => r.itemName },
      { label: '数量', num: 1, html: r => `${r.quantity < 0 ? `<span class="check-ng">${r.quantity}</span>` : r.quantity} ${esc(r.unit)}${r.corrected ? `<br><span class="small muted">訂正 ${r.corrected > 0 ? '+' : ''}${r.corrected}</span>` : ''}` },
      { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '税', num: 1, value: r => `${r.taxRate}%` },
      { label: '決済', html: r => r.method === 1 ? esc(r.methodName) : badge(r.methodName, 'amber') },
      { label: '状態', html: r => (r.shipKb === 2 ? badge('訂正', 'amber') + ' ' : '') + (r.billed ? badge('請求済', 'green') : r.method === 1 ? badge('未請求', 'gray') : badge('請求対象外', 'amber')) },
      { label: '', html: acts }],
      list, { empty: 'この条件の出荷はありません', foot: ['合計', '', '', '', '', '', '', yen(net), '', '', `税 ${yen(tax)}`, ''] })}</section>`);
};
function correctionForm(r) {
  modal({ title: `出荷伝票訂正（元 ${r.orderNo}）`, submit: '訂正伝票を登録', body: `
    <div class="grid3"><div><div class="muted small">得意先 / 現場</div><b>${esc(r.customerName)}</b><br>${esc(r.siteName)}</div><div><div class="muted small">商品 / 単価</div><b>${esc(r.itemName)}</b><br>${yen(r.price)} 円 ・ ${r.taxRate}% ・ ${esc(r.methodName)}</div>
      <div><div class="muted small">元数量 / 訂正済</div><b>${r.quantity} ${esc(r.unit)}</b>${r.corrected ? ` / ${r.corrected}` : ''}</div></div>
    <div class="form-grid" style="margin-top:12px">${field('訂正日', `<input type="date" name="date" value="${today()}">`, { req: 1, hint: '月次確定済みの月は不可' })}
      ${field('訂正数量', `<input name="quantity" class="num" inputmode="decimal" value="${-r.quantity}">`, { req: 1, hint: 'マイナス入力可（例: -2.5）。訂正後の合計がマイナスになる入力は不可' })}
      ${field('備考', `<input name="remarks" maxlength="20" value="訂正 ${esc(r.orderNo)}">`, { wide: 1 })}<div class="wide note" id="corr-preview"></div></div>
    <p class="muted small">得意先・現場・商品・単価・税率・決済方法は元伝票を引き継ぎます。訂正伝票は次回の請求締めで請求に反映されます（請求済みの請求書は変更しません）。一括訂正・訂正伝票の再発行は対象外です。</p>`,
    onOpen: f => { const pv = () => { const qn = Number(f.quantity.value) || 0, net = Math.trunc(Math.round(qn * 100) * r.price / 100); $('#corr-preview').textContent = `訂正金額: ${yen(net)} 円 ／ 訂正後数量: ${Math.round((r.quantity + r.corrected + qn) * 100) / 100}`; }; f.quantity.oninput = pv; pv(); },
    onSubmit: async v => { const res = await post('/api/shipments/correct', { ...v, orderNo: r.orderNo }); toast(`訂正伝票 ${res.orderNo} を登録しました（${yen(res.net)}円）`); render(); } });
}
function shipmentForm(r) {
  const cust = r?.customer || active('customers')[0]?.code || '';
  modal({ title: r ? `出荷の修正（${r.orderNo}）` : '出荷登録', submit: r ? '更新する' : '登録する', body: `<div class="form-grid">
    ${field('出荷日', `<input type="date" name="date" value="${esc(r?.date || today())}" required>`, { req: 1 })}
    ${field('決済方法', `<select name="method">${options(Object.entries(meta.methods).map(([code, name]) => ({ code, name })), r?.method || 1, { label: x => x.name })}</select>`, { hint: '現金・カードは請求対象外（Q16/Q17確認待ち）' })}
    ${field('得意先', `<select name="customer" required>${options(active('customers'), cust)}</select>`, { req: 1 })}
    ${field('現場', `<select name="site" required>${siteOptions(cust, r?.site, '選択してください')}</select>`, { req: 1, hint: '現場はマスタ管理で登録します' })}
    ${field('商品', `<select name="item" required>${options(active('items'), r?.item, { blank: '選択してください' })}</select>`, { req: 1 })}
    ${field('税率', `<select name="taxRate">${options(meta.rates.map(x => ({ code: x, name: x + '%' })), r?.taxRate ?? 10, { label: x => x.name })}</select>`)}
    ${field('数量', `<input name="quantity" class="num" inputmode="decimal" value="${esc(r?.quantity ?? '')}" required>`, { req: 1, hint: '小数2桁まで（マイナスは請求後の「訂正」で入力）' })}
    ${field('単価（円）', `<input name="price" class="num" inputmode="numeric" value="${esc(r?.price ?? '')}" required>`, { req: 1, hint: '商品・得意先・現場を選ぶと単価マスタから自動設定' })}
    ${field('車番', `<input name="vehicle" maxlength="15" value="${esc(r?.vehicle || '')}">`)}${field('備考', `<input name="remarks" maxlength="20" value="${esc(r?.remarks || '')}">`)}
    <div class="wide note" id="amount-preview">金額: -</div></div>`,
    onOpen: f => {
      const preview = () => { const qn = Number(f.quantity.value), p = Number(f.price.value), rate = Number(f.taxRate.value); if (!qn || !p && p !== 0) return ($('#amount-preview').textContent = '金額: -');
        const net = Math.floor(Math.round(qn * 100) * p / 100); $('#amount-preview').textContent = `金額: ${yen(net)} 円 ／ 消費税(参考): ${yen(Math.floor(net * rate / 100))} 円`; };
      const price = async () => { if (!f.item.value || !f.customer.value) return; const p = await api('/api/price?' + qs({ item: f.item.value, customer: f.customer.value, site: f.site.value, date: f.date.value })); f.price.value = p.price; $('#amount-preview').dataset.src = p.source; preview(); toast(`単価: ${p.source} ${yen(p.price)}円`); };
      f.customer.onchange = () => { f.site.innerHTML = siteOptions(f.customer.value, '', '選択してください'); price(); };
      f.item.onchange = price; f.site.onchange = price; f.quantity.oninput = preview; f.price.oninput = preview; f.taxRate.onchange = preview; preview();
    },
    onSubmit: async v => { const res = await post('/api/shipments', { ...v, orderNo: r?.orderNo }); toast(`${r ? '更新' : '登録'}しました（売上No ${res.orderNo}）`); render(); },
  });
}

// ----- 請求締め・発行 -----
const closingLabel = c => (Number(c) === 31 ? '月末' : c + '日');
VIEWS.invoices = async q => {
  const A = actions;
  const list = await api('/api/invoices?' + qs({ month: q.month, customer: q.customer, status: q.status }));
  const closings = [...new Set(active('customers').map(c => c.closing))].sort((a, b) => a - b);
  A.preview = async () => {
    const month = $('#bill-month').value, closing = $('#bill-closing').value, p = await api('/api/billing/preview?' + qs({ month, closing }));
    $('#bill-result').innerHTML = `<p class="muted small">請求期間 ${p.start} 〜 ${p.end} ／ 支払期日 ${p.due} ／ 請求は<b>得意先単位</b>で作成し、複数現場は明細にまとめます（NO6）</p>` + table([
      { label: '', html: r => r.count && !r.created ? `<input type="checkbox" class="bill-pick" value="${esc(r.customer)}" checked>` : '' }, { label: '得意先', value: r => `${r.customer} ${r.name}` },
      { label: '未請求(掛売)', num: 1, value: r => `${r.count}件` }, { label: '現場数', num: 1, value: r => r.sites || '' }, { label: '税抜金額', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) },
      { label: '請求対象外', num: 1, value: r => r.excluded ? `${r.excluded}件（現金・カード）` : '' },
      { label: '状態', html: r => r.created ? badge('作成済', 'green') : r.count ? badge('作成可能') : badge('対象なし', 'gray') }], p.customers, { empty: 'この締日の得意先はありません' }) +
      (canWrite() ? `<div style="margin-top:10px;display:flex;justify-content:flex-end"><button class="primary" data-act="run" data-month="${month}" data-closing="${closing}">選択した得意先の請求を作成</button></div>` : '');
  };
  A.run = d => { const customers = $$('.bill-pick:checked').map(x => x.value); if (!customers.length) return toast('得意先を選択してください', true);
    act(() => post('/api/billing/run', { month: d.month, closing: d.closing, customers }), r => `請求 ${r.created} 件を作成しました（売掛金仕訳 A01 計上）${r.skipped?.length ? ' ／ 対象外: ' + r.skipped.join('、') : ''}`); };
  A.detail = d => invoiceDetail(d.id);
  A.issue = async () => { const ids = $$('.inv-pick:checked').map(x => Number(x.value)); if (!ids.length) return toast('発行する請求を選択してください', true);
    try { const r = await post('/api/invoices/issue', { ids }); printDocs(r.documents); await render(); } catch (e) { toast(e.message, true); } };
  A.report = d => billingReport(d.kind, $('#rep-month').value, $('#rep-closing').value);
  const sum = k => list.reduce((n, r) => n + r[k], 0);
  const closeSel = id => `<select id="${id}">${closings.map(c => `<option value="${c}">${closingLabel(c)}</option>`).join('')}</select>`;
  return page('請求締め・発行', '得意先単位・締日ごとに請求を作成し、請求書を発行します。発行内容はスナップショットとして保存され、再発行時も同じ内容を出力します。',
    `${monthInput('month', q.month || '')}${filterSelect('customer', masters.customers, q.customer, 'すべての得意先')}<select name="status" data-filter>${options(Object.entries({ open: '未入金あり', draft: '未発行', issued: '発行済', partial: '一部入金', paid: '入金済' }).map(([code, name]) => ({ code, name })), q.status, { blank: 'すべて', label: r => r.name })}</select>${csvLink('invoices', { month: q.month })}`,
    `<div class="grid2">${canWrite() ? `<section class="card glass"><div class="card-head"><h2>請求データ作成（NO6）</h2><span class="muted small">掛売の未請求売上が対象</span></div>
      <div class="filters"><label class="field">請求年月<input type="month" id="bill-month" value="${thisMonth()}"></label><label class="field">締日${closeSel('bill-closing')}</label><button data-act="preview" style="align-self:flex-end">対象得意先を表示</button></div>
      <div id="bill-result" style="margin-top:10px"></div></section>` : ''}
    <section class="card glass"><div class="card-head"><h2>請求帳票（NO12・NO13）</h2><span class="muted small">画面表示・印刷・Excel出力</span></div>
      <div class="filters"><label class="field">請求年月<input type="month" id="rep-month" value="${q.month || thisMonth()}"></label><label class="field">締日${closeSel('rep-closing')}</label>
      <button data-act="report" data-kind="list" style="align-self:flex-end">請求一覧表（確認用）</button><button data-act="report" data-kind="confirm" style="align-self:flex-end">請求書発行確認表</button></div>
      <p class="muted small">請求一覧表は発行前の確認用（得意先ごとの集計）、発行確認表は発行後の請求内容（明細付き）です。同じ計算ロジックで出力形式だけを変えています。</p></section></div>
    <section class="card glass"><div class="card-head"><h2>請求一覧</h2>${canWrite() ? '<button class="primary" data-act="issue">☑ 選択した請求書を発行・印刷</button>' : ''}</div>
    ${table([{ label: '', html: r => `<input type="checkbox" class="inv-pick" value="${r.id}">` }, { label: 'No', value: r => r.id }, { label: '締日', value: r => r.closing }, { label: '得意先', value: r => r.customerName }, { label: '請求単位', value: r => r.siteName },
      { label: '税抜', num: 1, value: r => yen(r.net) }, { label: '消費税', num: 1, value: r => yen(r.tax) }, { label: '請求額', num: 1, value: r => yen(r.total) }, { label: '入金済', num: 1, value: r => yen(r.paid) }, { label: '残高', num: 1, html: r => r.overdue ? `<span class="check-ng">${yen(r.balance)}</span>` : yen(r.balance) },
      { label: '支払期日', html: r => r.overdue ? `<span class="check-ng">${esc(r.due)} 超過</span>` : esc(r.due) }, { label: '発行', num: 1, value: r => r.issues ? r.issues + '回' : '' }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => `<button class="mini" data-act="detail" data-id="${r.id}">詳細</button>` }], list, { empty: '請求がありません', foot: ['', '合計', '', '', '', yen(sum('net')), yen(sum('tax')), yen(sum('total')), yen(sum('paid')), yen(sum('balance')), '', '', '', ''] })}</section>`);
};
// NO12 / NO13 report viewer with print and Excel download.
async function billingReport(kind, month, closing) {
  const url = `/api/reports/${kind === 'list' ? 'billing-list' : 'billing-confirm'}?${qs({ month, closing })}`, d = await api(url);
  const title = kind === 'list' ? '請求一覧表（確認用）' : '請求書発行確認表';
  const amounts = [['前回請求額', 'prevBalance'], ['御入金額', 'received'], ['差引繰越額', 'carried'], ['今回お買上額', 'net'], ['消費税額', 'tax'], ['今回請求額', 'total']];
  let body;
  if (kind === 'list') {
    const s = k => d.rows.reduce((n, r) => n + r[k], 0);
    body = table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, ...amounts.map(([l, k]) => ({ label: l, num: 1, value: r => yen(r[k]) })), { label: '明細', num: 1, value: r => r.lineCount + '件' }, { label: '状態', html: r => badge(r.stateName, r.state === 'issued' ? 'green' : r.state === 'draft' ? '' : 'gray') }],
      d.rows, { empty: '対象の得意先がありません', foot: ['合計', ...amounts.map(([, k]) => yen(s(k))), '', ''] });
  } else {
    body = d.rows.length ? d.rows.map(r => `<div style="margin-bottom:16px"><div class="filters"><b>${esc(r.customer)} ${esc(r.name)}</b><span class="muted small">${r.lastIssue ? `${r.lastIssue.no}回目発行 ${jst(r.lastIssue.at, 16)} ${esc(r.lastIssue.by)}` : ''}</span></div>
      <div class="grid3">${amounts.map(([l, k]) => `<div class="sum-line"><span>${l}</span><b>${yen(r[k])}</b></div>`).join('')}</div>
      ${table([{ label: '日付', value: l => l.date }, { label: '伝票No', value: l => l.orderNo }, { label: '区分', html: l => l.shipKb === 2 ? badge('訂正', 'amber') : '売上' }, { label: '現場', value: l => l.siteName }, { label: '商品', value: l => l.itemName }, { label: '数量', num: 1, value: l => l.quantity }, { label: '単価', num: 1, value: l => yen(l.price) }, { label: '金額', num: 1, value: l => yen(l.net) }, { label: '税率', num: 1, value: l => l.taxRate + '%' }], r.lines)}</div>`).join('')
      : '<div class="empty">この締日の発行済み請求書はありません</div>';
  }
  modal({ title: `${title} ${month} ${closingLabel(closing)}締`, wide: true, body: `<div class="filters" style="margin-bottom:10px"><a class="button" href="${url}&format=xlsx" download>⇩ Excel</a><button type="button" id="rep-print">🖨 印刷</button></div><div id="rep-body">${body}</div>`,
    onOpen: () => $('#rep-print').addEventListener('click', () => { $('#print-area').innerHTML = `<section class="invoice-doc report-doc"><h2>${esc(title)}</h2><p>請求年月 ${esc(month)} ／ 締日 ${closingLabel(closing)} ／ 出力日 ${today()}</p>${$('#rep-body').innerHTML}</section>`; setTimeout(() => window.print(), 200); }) });
}
async function invoiceDetail(id) {
  const inv = await api('/api/invoices/' + id);
  modal({ title: `請求 No.${inv.id} ${inv.customerName}`, wide: true, body: `
    <div class="grid3"><div><div class="muted small">請求単位</div><b>${esc(inv.siteName)}</b></div><div><div class="muted small">締日 / 支払期日</div><b>${esc(inv.closing)} / ${esc(inv.due)}</b></div><div><div class="muted small">状態</div>${status(inv.status)}</div></div>
    <div class="grid3" style="margin:12px 0"><div class="sum-line"><span>税抜金額</span><b>${yen(inv.net)}</b></div><div class="sum-line"><span>消費税</span><b>${yen(inv.tax)}</b></div><div class="sum-line"><span>請求額 / 残高</span><b>${yen(inv.total)} / ${yen(inv.balance)}</b></div></div>
    <h3>明細（billing_detail）</h3>${table([{ label: '日付', value: r => r.date }, { label: '売上No', value: r => r.orderNo }, { label: '区分', html: r => r.shipKb === 2 ? badge('訂正', 'amber') : '売上' }, { label: '現場', value: r => r.siteName }, { label: '商品', value: r => r.itemName }, { label: '数量', num: 1, value: r => r.quantity }, { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '税率', num: 1, value: r => r.taxRate + '%' }], inv.lines)}
    <div class="grid2" style="margin-top:12px"><div><h3>発行履歴（invoice_issue）</h3>${table([{ label: '回', value: r => r.no }, { label: '発行日時', value: r => jst(r.at) }, { label: '発行者', value: r => r.by }, { label: 'SHA-256', value: r => r.sha256.slice(0, 12) + '…' }], inv.issueLog, { empty: '未発行' })}</div>
    <div><h3>入金消込</h3>${table([{ label: '入金No', value: r => r.receiptNo }, { label: '入金日', value: r => r.date }, { label: '状態', html: r => status(r.status) }, { label: '消込額', num: 1, value: r => yen(r.amount) }], inv.allocations, { empty: '消込なし' })}</div></div>
    <div class="filters" style="margin-top:14px">${inv.issues ? '<button type="button" id="inv-copy">最新発行分を印刷（控え）</button>' : ''}${canWrite() ? `<button type="button" class="primary" id="inv-issue">${inv.issues ? '再発行して印刷' : '発行して印刷'}</button>` : ''}${canWrite() && !inv.issues && !inv.allocations.length ? '<button type="button" class="danger" id="inv-cancel">請求取消</button>' : ''}</div>`,
    onOpen: () => {
      $('#inv-copy')?.addEventListener('click', async () => printDocs([await api(`/api/invoices/${inv.id}/document`)]));
      $('#inv-issue')?.addEventListener('click', async () => { try { const r = await post('/api/invoices/issue', { ids: [inv.id] }); $('#dialog').close(); printDocs(r.documents); render(); } catch (e) { $('#form-error').textContent = e.message; } });
      $('#inv-cancel')?.addEventListener('click', async () => { try { await post('/api/invoices/cancel', { id: inv.id }); $('#dialog').close(); toast('請求を取消しました（売上は未請求に戻り、仕訳は逆仕訳）'); render(); } catch (e) { $('#form-error').textContent = e.message; } });
    } });
}
function printDocs(docs) {
  $('#print-area').innerHTML = docs.map(s => {
    const prev = s.prevBalance ?? s.carried, received = s.received ?? 0;
    let lastSite = null, rowsHtml = '';
    const sub = {}; for (const l of s.lines) sub[l.site || ''] = (sub[l.site || ''] || 0) + l.net;
    s.lines.forEach((l, i) => {
      if (l.siteName && l.site !== lastSite) rowsHtml += `<tr><td colspan="8"><b>現場: ${esc(l.siteName)}</b></td></tr>`;
      lastSite = l.site;
      rowsHtml += `<tr><td>${esc(l.date)}</td><td>${esc(l.orderNo)}${l.shipKb === 2 ? ' 訂正' : ''}</td><td>${esc(l.itemName)}</td><td class="num">${l.quantity}</td><td class="num">${yen(l.price)}</td><td class="num">${yen(l.net)}</td><td class="num">${l.taxRate}%</td><td>${esc(l.remarks || '')}</td></tr>`;
      if (l.siteName && s.lines[i + 1]?.site !== l.site) rowsHtml += `<tr><td colspan="5" class="num">現場小計</td><td class="num"><b>${yen(sub[l.site || ''])}</b></td><td colspan="2"></td></tr>`;
    });
    return `<section class="invoice-doc">
    <h1>請 求 書</h1>${s.reissue ? `<p style="text-align:right"><span class="reissue">再発行（${s.issueNo}回目）</span></p>` : ''}
    <div class="inv-top"><div><p class="to">${esc(s.customer.name)} 御中</p><p>${esc(s.customer.address)}</p>
      <p>請求期間 ${esc(s.periodStart)} 〜 ${esc(s.closing)}<br>お支払期日 <b>${esc(s.due)}</b></p></div>
      <div style="text-align:right"><p>請求No. ${s.invoiceId}-${s.issueNo}</p><p><b>${esc(s.company.name)}</b><br>${esc(s.company.address)}<br>TEL ${esc(s.company.tel)}</p><p class="stamp">発行日 ${esc(s.issuedOn || today())}${s.copy ? '（控え）' : ''}</p></div></div>
    <table class="totals"><tr><th>前回御請求額</th><th>御入金額</th><th>差引繰越額</th><th>今回お買上額</th><th>消費税額</th><th>今回御請求額</th></tr>
      <tr><td class="num">${yen(prev)}</td><td class="num">${yen(received)}</td><td class="num">${yen(s.carried)}</td><td class="num">${yen(s.net)}</td><td class="num">${yen(s.tax)}</td><td class="num">${yen(s.grandTotal)}</td></tr></table>
    <table><tr><th>税率区分</th><th>対象額(税抜)</th><th>消費税</th></tr>${s.buckets.map(b => `<tr><td>${b.rate}%対象</td><td class="num">${yen(b.net)}</td><td class="num">${yen(b.tax)}</td></tr>`).join('')}</table>
    <table><tr><th>日付</th><th>伝票No</th><th>品名</th><th>数量</th><th>単価</th><th>金額</th><th>税率</th><th>備考</th></tr>${rowsHtml}</table>
    <p class="stamp">※ 架空データによる検証用の請求書です。消費税は税率ごとに合計して端数を切り捨てています。</p></section>`; }).join('');
  toast(`${docs.length}件の請求書を印刷します`);
  setTimeout(() => window.print(), 300);
}

// ----- 入金・消込 (NO17) -----
const RC_KEYS = [['bank', 'BANK'], ['cash', 'CASH'], ['notes', 'NOTE'], ['fee', 'FEE'], ['coop', 'COOP'], ['deposit', 'DEPOSIT'], ['discount', 'DISCOUNT']];
VIEWS.receipts = async q => {
  const A = actions;
  const month = q.month || thisMonth(), list = await api('/api/receipts?' + qs({ month, customer: q.customer }));
  A.new = () => receiptForm();
  A.rev = d => confirmBox('入金の取消', `入金No ${d.no} を取消します。消込が解除され、逆仕訳を計上します。`, () => post('/api/receipts/reverse', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('入金・消込', '得意先ごとに、請求（得意先×請求年月）に対する入金を消し込みます。当座預金・現金・手形・振込手数料・協力会費・預り金充当・値引を処理します（receipt / receipt_component / receipt_allocation）。',
    `${monthInput('month', month)}${filterSelect('customer', masters.customers, q.customer, 'すべての得意先')}${csvLink('receipts', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 入金消込</button>' : ''}`,
    `<section class="card glass">${table([{ label: '入金No', value: r => r.no }, { label: '入金日', value: r => r.date }, { label: '得意先', value: r => r.customerName }, { label: '振込', num: 1, value: r => yen(r.bank) }, { label: '銀行', value: r => nameOf('banks', r.bankCode) },
      { label: '現金', num: 1, value: r => yen(r.cash) }, { label: '手形', num: 1, value: r => yen(r.notes) }, { label: '手数料', num: 1, value: r => yen(r.fee) }, { label: '協力会費', num: 1, value: r => yen(r.coop) }, { label: '預り金', num: 1, value: r => yen(r.deposit) }, { label: '値引', num: 1, value: r => yen(r.discount) }, { label: '消込額', num: 1, value: r => yen(r.settlement) },
      { label: '消込先(請求No)', value: r => r.allocations.map(a => `${a.invoiceId}`).join(', ') }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }], list, { empty: 'この条件の入金はありません', rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section>`);
};
function receiptForm() {
  const key = uuid();
  modal({ title: '入金消込', wide: true, submit: '入金を登録', body: `<div class="form-grid">
    ${field('得意先検索（部分一致）', '<input id="rc-search" placeholder="得意先名・コードの一部">')}${field('得意先', `<select name="customer" required>${options(masters.customers, '', { blank: '選択してください' })}</select>`, { req: 1 })}
    ${field('入金日', `<input type="date" name="date" value="${today()}" required>`, { req: 1 })}${field('入金口座', `<select name="bankCode">${options(active('banks'), active('banks')[0]?.code)}</select>`, { hint: '当座預金 1112 の内訳' })}
    ${field('振込額（当座預金）', '<input name="bank" class="num" value="0">')}${field('現金', '<input name="cash" class="num" value="0">')}
    ${field('手形・でんさい', '<input name="notes" class="num" value="0">')}${field('手形期日', '<input type="date" name="noteDue">', { hint: '手形がある場合のみ' })}
    ${field('振込手数料（先方差引）', '<input name="fee" class="num" value="0">', { hint: '雑費 8330-101（B-02）' })}${field('協力会費・災防協会費（差引）', '<input name="coop" class="num" value="0">', { hint: '雑費 8330-107（B-03）処税率は確認待ち Q04' })}
    ${field('預り金充当', '<input name="deposit" class="num" value="0">', { hint: '預り金 4170（B-06）' })}${field('値引・端数', '<input name="discount" class="num" value="0">', { hint: '雑損失 8850（B-04）' })}
    <div class="note wide" id="rc-total">入金合計: 0 円</div></div>
    <h3 style="margin-top:14px">消込対象（得意先×請求年月・発行済みで残高あり）</h3><div id="rc-open" class="muted small">得意先を選択してください</div>
    <div class="filters" style="margin-top:8px"><button type="button" id="rc-auto">古い順に自動配分</button><span id="rc-diff" class="small"></span></div>`,
    onOpen: f => {
      let ctx = { invoices: [], deposit: 0 };
      const all = masters.customers;
      $('#rc-search').oninput = e => { const t = e.target.value.trim(), cur = f.customer.value; f.customer.innerHTML = options(all.filter(c => !t || c.name.includes(t) || c.code.includes(t)), cur, { blank: '選択してください' }); };
      const total = () => RC_KEYS.reduce((n, [k]) => n + (Number(f[k].value) || 0), 0);
      const diff = () => {
        const t = total(), a = $$('.rc-amt').reduce((n, x) => n + (Number(x.value) || 0), 0);
        $('#rc-total').innerHTML = `入金合計（消込可能額）: <b>${yen(t)}</b> 円 ／ 預り金残高: ${yen(ctx.deposit)} 円${Number(f.deposit.value) > ctx.deposit ? ' <span class="check-ng">残高超過</span>' : ''}`;
        $('#rc-diff').innerHTML = t === a ? `<span class="check-ok">消込合計 ${yen(a)} 円 — 一致</span>` : `<span class="check-ng">消込合計 ${yen(a)} 円 — 差額 ${yen(t - a)} 円</span>`;
        $$('.rc-amt').forEach(x => { const left = $(`#rc-left-${x.dataset.id}`); if (left) left.textContent = yen(Number(x.dataset.balance) - (Number(x.value) || 0)); });
      };
      const auto = () => { let rest = total(); for (const x of $$('.rc-amt')) { const b = Number(x.dataset.balance), v = Math.min(b, Math.max(rest, 0)); x.value = v; rest -= v; } diff(); };
      f.customer.onchange = async () => {
        ctx = f.customer.value ? await api('/api/receipt-context?customer=' + encodeURIComponent(f.customer.value)) : { invoices: [], deposit: 0 };
        $('#rc-open').innerHTML = table([{ label: '請求年月', value: r => r.month }, { label: '締日', value: r => r.closing }, { label: '請求No', value: r => r.id }, { label: '当月請求金額', num: 1, value: r => yen(r.total) }, { label: '入金済', num: 1, value: r => yen(r.paid) },
          { label: '請求残高', num: 1, value: r => yen(r.balance) }, { label: '消込金額', html: r => `<input class="num rc-amt" data-id="${r.id}" data-balance="${r.balance}" value="0" style="width:130px">` }, { label: '消込残高', num: 1, html: r => `<span id="rc-left-${r.id}">${yen(r.balance)}</span>` }],
          ctx.invoices, { empty: '発行済みで残高のある請求はありません' });
        $$('.rc-amt').forEach(x => (x.oninput = diff)); diff();
      };
      RC_KEYS.forEach(([k]) => (f[k].oninput = diff)); $('#rc-auto').onclick = auto;
    },
    onSubmit: async v => {
      const allocations = $$('.rc-amt').map(x => ({ invoiceId: Number(x.dataset.id), amount: Number(x.value) || 0 })).filter(a => a.amount > 0);
      const r = await post('/api/receipts', { ...v, allocations, idempotencyKey: key }); toast(`入金 ${r.no} を登録しました（仕訳 B01）`); render();
    } });
}

// ----- 商品仕入 -----
VIEWS.purchases = async q => {
  const A = actions;
  const month = q.month || thisMonth(), list = await api('/api/purchases?' + qs({ month, vendor: q.vendor }));
  A.new = () => modal({ title: '商品仕入の登録', submit: '登録する', body: `<div class="form-grid">${field('仕入日', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('業者', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('商品', `<select name="item">${options(active('items'), '', { blank: '選択してください' })}</select>`, { req: 1 })}${field('税区分', `<select name="taxCode">${meta.taxCodes.map(t => `<option>${esc(t)}</option>`).join('')}</select>`)}
      ${field('数量', '<input name="quantity" class="num">', { req: 1 })}${field('単価（円）', '<input name="price" class="num">', { req: 1 })}${field('摘要', '<input name="memo" maxlength="500">', { wide: 1 })}</div>
      <p class="muted small">仕入は数量・金額の記録です。買掛金の計上は「定時請求」で行います（仕訳パターン分析 D-01 に準拠）。</p>`,
    onSubmit: async v => { const r = await post('/api/purchases', v); toast(`仕入 ${r.no} を登録しました`); render(); } });
  A.del = d => confirmBox('仕入の取消', `仕入 ${d.no} を削除します。`, () => post('/api/purchases/delete', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('商品仕入', '業者からの商品仕入を記録します（purchase）。', `${monthInput('month', month)}${filterSelect('vendor', masters.vendors, q.vendor, 'すべての業者')}${csvLink('purchases', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 仕入登録</button>' : ''}`,
    `<section class="card glass">${table([{ label: '伝票No', value: r => r.no }, { label: '仕入日', value: r => r.date }, { label: '業者', value: r => r.vendorName }, { label: '商品', value: r => r.itemName }, { label: '数量', num: 1, value: r => `${r.quantity} ${r.unit || ''}` },
      { label: '単価', num: 1, value: r => yen(r.price) }, { label: '金額', num: 1, value: r => yen(r.net) }, { label: '税区分', value: r => r.taxCode }, { label: '摘要', value: r => r.memo },
      { label: '', html: r => canWrite() ? `<button class="mini danger" data-act="del" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }], list, { foot: ['合計', '', '', '', '', '', yen(list.reduce((n, r) => n + r.net, 0)), '', '', ''] })}</section>`);
};

// ----- 在庫計上 -----
VIEWS.inventory = async q => {
  const A = actions;
  const list = await api('/api/inventory?' + qs({ month: q.month }));
  A.new = () => modal({ title: '月末在庫の計上', submit: '計上する', body: `<div class="form-grid">${field('計上月', `<input type="month" name="month" value="${addMonths(thisMonth(), -1)}">`, { req: 1 })}${field('商品', `<select name="item">${options(active('items'), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('月末在庫数量', '<input name="quantity" class="num">', { req: 1 })}${field('評価単価（円）', '<input name="price" class="num">', { req: 1, hint: '評価方法は確認待ち（Q07）' })}</div>
      <p class="muted small">前月の在庫評価額を戻し、当月評価額を計上する仕訳（C01: 期末棚卸高 82316 / 材料及び貯蔵品 1360）を作成します。</p>`,
    onSubmit: async v => { const r = await post('/api/inventory', v); toast(`在庫を計上しました（評価額 ${yen(r.value)}円・前月 ${yen(r.previous)}円）`); render(); } });
  A.del = d => confirmBox('在庫計上の取消', '最新月の在庫計上を取消し、逆仕訳を計上します。', () => post('/api/inventory/delete', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('在庫計上', '月末在庫の数量と評価額を記録します（inventory_count）。', `${monthInput('month', q.month || '')}${csvLink('inventory', { month: q.month })}${canWrite() ? '<button class="primary" data-act="new">＋ 在庫計上</button>' : ''}`,
    `<section class="card glass">${table([{ label: '計上月', value: r => r.month }, { label: '商品', value: r => `${r.item} ${r.itemName}` }, { label: '数量', num: 1, value: r => `${r.quantity} ${r.unit || ''}` }, { label: '評価単価', num: 1, value: r => yen(r.price) },
      { label: '評価額', num: 1, value: r => yen(r.value) }, { label: '状態', html: r => status(r.status) }, { label: '', html: r => canWrite() ? `<button class="mini danger" data-act="del" data-id="${r.id}">取消</button>` : '' }], list)}</section>`);
};

// ----- 定時請求 / 小口現金 -----
function expenseView(kind) {
  return async q => {
    const A = actions;
    const month = q.month || '', list = await api('/api/expenses?' + qs({ kind, month, vendor: q.vendor })), payable = kind === 'PAYABLE';
    A.new = () => modal({ title: payable ? '定時請求（買掛金）の登録' : '小口現金の登録', submit: '登録する', body: `<div class="form-grid">
      ${field('計上日', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${payable ? field('業者', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 }) + field('支払予定日', '<input type="date" name="due">', { hint: '未入力は計上日の翌月末' }) : ''}
      ${field('費用科目', `<select name="account">${options(active('accounts').filter(a => !['1111', '1112', '1120', '1131', '4121', '4415'].includes(a.code)), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('内訳科目', '<select name="sub"><option value="">（なし）</option></select>')}${field('部門', '<input name="dept" value="063" maxlength="20">')}
      ${field('税区分', `<select name="taxCode">${meta.taxCodes.map(t => `<option>${esc(t)}</option>`).join('')}</select>`, { hint: '原本の処税率コード対応は確認待ち（Q01）' })}${field('金額（税込）', '<input name="amount" class="num">', { req: 1 })}
      ${field('摘要', '<input name="memo" maxlength="500" required>', { req: 1, wide: 1 })}</div>`,
      onOpen: f => { f.account.onchange = () => (f.sub.innerHTML = '<option value="">（なし）</option>' + options(active('subaccounts').filter(s => s.account === f.account.value), '')); },
      onSubmit: async v => { const r = await post('/api/expenses', { ...v, kind }); toast(`${r.no} を登録しました（仕訳 ${payable ? 'D01' : 'E01'}）`); render(); } });
    A.rev = d => confirmBox('伝票の取消', `${d.no} を取消し、逆仕訳を計上します。`, () => post('/api/expenses/reverse', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
    const cols = [{ label: '伝票No', value: r => r.no }, { label: '計上日', value: r => r.date }, ...(payable ? [{ label: '業者', value: r => r.vendorName }, { label: '支払予定日', value: r => r.due }] : []),
      { label: '科目', value: r => `${r.account} ${r.accountName || ''}${r.sub ? '-' + r.sub : ''}` }, { label: '税区分', value: r => r.taxCode }, { label: '金額', num: 1, value: r => yen(r.amount) },
      ...(payable ? [{ label: '支払済', num: 1, value: r => yen(r.paid) }, { label: '未払残高', num: 1, value: r => yen(r.balance) }] : []), { label: '摘要', value: r => r.memo }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' && !r.paid ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }];
    return page(payable ? '定時請求' : '小口現金', payable ? '業者からの請求（買掛金）を計上します（expense_document / expense_line、仕訳 D01）。' : '小口現金での経費支出を計上します（仕訳 E01）。',
      `${monthInput('month', month)}${payable ? filterSelect('vendor', masters.vendors, q.vendor, 'すべての業者') : ''}${csvLink('expenses', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 登録</button>' : ''}`,
      `<section class="card glass">${table(cols, list, { rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section>`);
  };
}
VIEWS.payables = expenseView('PAYABLE');
VIEWS.cash = expenseView('PETTY_CASH');

// ----- 支払 -----
VIEWS.payments = async q => {
  const A = actions;
  const month = q.month || '', list = await api('/api/payments?' + qs({ month }));
  A.new = () => { const key = uuid(); modal({ title: '支払の登録', wide: true, submit: '支払を登録', body: `<div class="form-grid">${field('業者', `<select name="vendor">${options(active('vendors'), '', { blank: '選択してください' })}</select>`, { req: 1 })}
      ${field('支払日', `<input type="date" name="date" value="${today()}">`, { req: 1 })}${field('支払元口座', `<select name="bankCode">${options(active('banks'), active('banks')[0]?.code)}</select>`, { req: 1 })}<div class="note" id="py-payee">振込先: -</div></div>
      <h3 style="margin-top:12px">支払対象の定時請求</h3><div id="py-open" class="muted small">業者を選択してください</div><p class="muted small">振込手数料・相殺の処理ルールは確認待ちのため 0 円固定です（Q03）。</p>`,
    onOpen: f => { f.vendor.onchange = async () => {
      const v = masters.vendors.find(x => x.code === f.vendor.value); $('#py-payee').textContent = v?.bank ? `振込先: ${v.bank}-${v.branch} ${({ 1: '普通', 2: '当座', 4: '貯蓄' })[v.accountType] || ''} ${v.account} ${v.holder}` : '振込先: 未登録（マスタ管理で登録できます）';
      const open = f.vendor.value ? await api('/api/expenses?' + qs({ kind: 'PAYABLE', vendor: f.vendor.value, open: 1 })) : [];
      $('#py-open').innerHTML = table([{ label: '伝票No', value: r => r.no }, { label: '計上日', value: r => r.date }, { label: '支払予定日', value: r => r.due }, { label: '摘要', value: r => r.memo }, { label: '未払残高', num: 1, value: r => yen(r.balance) },
        { label: '支払額', html: r => `<input class="num py-amt" data-id="${r.id}" value="${r.balance}" style="width:130px">` }], open, { empty: '未払の定時請求はありません' }); }; },
    onSubmit: async v => { const allocations = $$('.py-amt').map(x => ({ expenseId: Number(x.dataset.id), amount: Number(x.value) || 0 })).filter(a => a.amount > 0);
      const r = await post('/api/payments', { ...v, allocations, idempotencyKey: key }); toast(`支払 ${r.no} を登録しました（仕訳 F01）`); render(); } }); };
  A.rev = d => confirmBox('支払の取消', `支払 ${d.no} を取消し、逆仕訳を計上します。`, () => post('/api/payments/reverse', { id: Number(d.id) }).then(() => { toast('取消しました'); render(); }), '取消する');
  return page('支払', '定時請求（買掛金）に対する振込支払を登録します（payment / payment_allocation）。', `${monthInput('month', month)}${csvLink('payments', { month })}${canWrite() ? '<button class="primary" data-act="new">＋ 支払登録</button>' : ''}`,
    `<section class="card glass">${table([{ label: '支払No', value: r => r.no }, { label: '支払日', value: r => r.date }, { label: '業者', value: r => r.vendorName }, { label: '支払額', num: 1, value: r => yen(r.amount) }, { label: '支払元', value: r => nameOf('banks', r.fromBank) },
      { label: '振込先', value: r => r.payee ? `${r.payee.bank}-${r.payee.branch} ${r.payee.account}` : '未登録' }, { label: '対象伝票', value: r => r.allocations.map(a => a.no).join(', ') }, { label: '状態', html: r => status(r.status) },
      { label: '', html: r => canWrite() && r.status === 'POSTED' ? `<button class="mini danger" data-act="rev" data-id="${r.id}" data-no="${esc(r.no)}">取消</button>` : '' }], list, { rowClass: r => r.status === 'REVERSED' ? 'reversed' : '' })}</section>`);
};

// ----- 仕訳・会計連携 -----
VIEWS.journals = async q => {
  const A = actions;
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
    `${monthInput('month', month)}<select name="pattern" data-filter>${options(Object.entries(meta.patterns).map(([code, name]) => ({ code, name })), q.pattern, { blank: 'すべてのパターン' })}</select>${csvLink('journals', { month })}`,
    `<div class="tabs"><button class="${tab === 'list' ? 'active' : ''}" data-act="tab" data-tab="list">仕訳一覧</button><button class="${tab === 'tb' ? 'active' : ''}" data-act="tab" data-tab="tb">月次残高試算（発生額）</button><button data-act="tab" data-tab="lists">自動仕訳リスト（帳票）</button></div><section class="card glass">${body}</section>`);
};
// ② 自動仕訳リスト 7種（帳票形式：借方・貸方併記、伝票合計・日付合計）
const monthStart = () => thisMonth() + '-01';
async function journalListsView(q) {
  const A = actions, kind = meta.journalLists[q.list] ? q.list : 'A01', from = q.from || monthStart(), to = q.to || today();
  A.tab = d => go('journals', { tab: d.tab });
  A.print = () => { $('#print-area').innerHTML = `<section class="invoice-doc report-doc journal-doc"><h2>${esc(meta.journalLists[kind].title)}</h2><p>${esc(meta.journalLists[kind].ref)} ／ 期間 ${from} 〜 ${to} ／ 出力日 ${today()}</p>${$('#jl-body').innerHTML}</section>`; setTimeout(() => window.print(), 200); };
  const url = kind === 'BANK' ? '/api/reports/bank-payments?' + qs({ from, to }) : '/api/reports/journal-list?' + qs({ pattern: kind, from, to });
  const d = await api(url);
  let body;
  const side = s => s ? `<td>${esc(s.dept)} ${esc(s.account)}<br><span class="small">${esc(s.accountName)}</span></td><td>${esc(s.sub)}<br><span class="small">${esc(s.subName)}</span></td><td class="num">${esc(s.tax)}</td><td class="num">${yen(s.amount)}</td><td><span class="small">${esc(s.memo1Code)} ${esc(s.memo1)}<br>${esc(s.memo2)}</span></td>` : '<td></td><td></td><td></td><td></td><td></td>';
  if (kind === 'BANK') {
    body = d.days.length ? d.days.map(day => `<h3 style="margin:10px 0 6px">${esc(day.date)} 支払</h3>` + table([{ label: '業者CD', value: r => r.vendor }, { label: '業者名', value: r => r.vendorName }, { label: '伝票No', value: r => r.no }, { label: '日付', value: r => r.date },
      { label: '請求金額', num: 1, value: r => yen(r.billed) }, { label: '相殺金額', num: 1, value: r => yen(r.offset) }, { label: '安全協力費', num: 1, value: r => yen(r.safety) }, { label: '手数料', num: 1, value: r => yen(r.fee) }, { label: '業者計', num: 1, value: r => yen(r.vendorTotal) },
      { label: '支払方法', value: r => r.method }, { label: '支払元口座', value: r => r.fromBank }, { label: '振込先銀行・支店', value: r => `${r.payeeBank} ${r.payeeBranch}` }], day.rows, { foot: ['支払日計', '', '', '', '', '', '', '', yen(day.total), '', '', ''] })).join('') + `<p class="right"><b>総合計 ${yen(d.total)} 円</b></p>` : '<div class="empty">対象期間の支払はありません</div>';
  } else {
    let html = '', last = null;
    const dateTotal = dt => `<tr class="subtotal"><td></td><td colspan="3" class="right">日付合計</td><td class="num"><b>${yen(d.dates.find(x => x.date === dt).total)}</b></td><td colspan="7"></td></tr>`;
    for (const sl of d.slips) {
      if (last && sl.date !== last) html += dateTotal(last); last = sl.date;
      sl.pairs.forEach((p, i) => { html += `<tr class="${sl.status ? 'muted' : ''}"><td>${i ? '' : esc(sl.date)}<br><span class="small">${i ? '' : esc(sl.slipNo)}</span></td>${side(p.dr)}${side(p.cr)}<td class="small">${i ? '' : esc(sl.sourceNo) + (sl.status ? '<br>' + esc(sl.status) : '')}</td></tr>`; });
      html += `<tr class="subtotal"><td></td><td colspan="2" class="right">伝票合計</td><td></td><td class="num"><b>${yen(sl.total)}</b></td><td></td><td colspan="3"></td><td class="num"><b>${yen(sl.total)}</b></td><td colspan="2"></td></tr>`;
    }
    if (last) html += dateTotal(last);
    body = d.slips.length ? `<div class="table-wrap"><table class="jl"><thead><tr><th>日付<br>伝票No</th><th>借方 部・科目</th><th>内訳1</th><th class="num">処税率</th><th class="num">借方金額</th><th>摘要1／摘要2（借方）</th><th>貸方 部・科目</th><th>内訳1</th><th class="num">処税率</th><th class="num">貸方金額</th><th>摘要1／摘要2（貸方）</th><th>元伝票</th></tr></thead><tbody>${html}</tbody>
      <tfoot><tr><td>総合計</td><td></td><td></td><td></td><td class="num">${yen(d.total)}</td><td></td><td></td><td></td><td></td><td class="num">${yen(d.total)}</td><td></td><td></td></tr></tfoot></table></div>` : '<div class="empty">対象期間の仕訳はありません</div>';
  }
  const kinds = Object.entries(meta.journalLists).map(([code, v]) => ({ code, name: v.title }));
  return page('仕訳・会計連携', '自動仕訳リストは現行帳票（⑥⑦⑨・資料ア〜エ）と同じ項目を、借方・貸方を1行に並べた形式で表示・印刷・Excel出力します（削減案5：同一フォーマット）。',
    `<select name="list" data-filter>${options(kinds, kind, { label: r => r.name })}</select><input type="date" name="from" value="${from}" data-filter><input type="date" name="to" value="${to}" data-filter><input type="hidden" name="tab" value="lists" data-filter>
     <a class="button" href="${url}&format=xlsx" download>⇩ Excel</a><button data-act="print">🖨 印刷</button>`,
    `<div class="tabs"><button data-act="tab" data-tab="list">仕訳一覧</button><button data-act="tab" data-tab="tb">月次残高試算（発生額）</button><button class="active" data-act="tab" data-tab="lists">自動仕訳リスト（帳票）</button></div>
     <section class="card glass"><div class="card-head"><h2>${esc(d.title)}</h2><span class="muted small">${esc(d.ref)} ／ ${from} 〜 ${to}</span></div><div id="jl-body">${body}</div></section>`);
}

// ----- 帳票・データ出力 -----
VIEWS.reports = async q => {
  const A = actions;
  const month = q.month || thisMonth(), [ar, ap] = await Promise.all([api('/api/reports/ar'), api('/api/reports/ap')]);
  const exp = [['shipments', '売上明細'], ['invoices', '請求一覧'], ['receipts', '入金一覧'], ['journals', '仕訳（会計連携用）'], ['payments', '支払・振込データ'], ['expenses', '定時請求・小口'], ['purchases', '仕入'], ['inventory', '在庫']];
  return page('帳票・データ出力', 'CSVはExcelで開けるUTF-8(BOM付き)形式です。', monthInput('month', month), `
    <section class="card glass"><div class="card-head"><h2>CSV出力（${esc(month)}）</h2></div><div class="filters">${exp.map(([k, l]) => `<a class="button" href="/api/export/${k}?month=${month}" download>⇩ ${l}</a>`).join('')}<a class="button" href="/api/export/ar" download>⇩ 売掛金残高</a><a class="button" href="#journals?tab=lists">自動仕訳リスト（帳票7種）→</a><a class="button" href="/api/export/ap" download>⇩ 未払残高</a></div></section>
    <section class="card glass"><div class="card-head"><h2>売掛金残高一覧</h2></div>${table([{ label: '得意先', value: r => `${r.customer} ${r.name}` }, { label: '締日', num: 1, value: r => r.closing === 31 ? '月末' : r.closing + '日' }, { label: '開始残高', num: 1, value: r => yen(r.opening) },
      { label: '請求累計', num: 1, value: r => yen(r.billed) }, { label: '消込累計', num: 1, value: r => yen(r.received) }, { label: '売掛残高', num: 1, value: r => yen(r.balance) }, { label: '期日超過', num: 1, html: r => r.overdue ? `<span class="check-ng">${yen(r.overdue)}</span>` : '0' }, { label: '未請求(税抜)', num: 1, value: r => yen(r.unbilled) }], ar,
      { foot: ['合計', '', yen(ar.reduce((n, r) => n + r.opening, 0)), yen(ar.reduce((n, r) => n + r.billed, 0)), yen(ar.reduce((n, r) => n + r.received, 0)), yen(ar.reduce((n, r) => n + r.balance, 0)), yen(ar.reduce((n, r) => n + r.overdue, 0)), yen(ar.reduce((n, r) => n + r.unbilled, 0))] })}</section>
    <section class="card glass"><div class="card-head"><h2>未払残高一覧</h2></div>${table([{ label: '業者', value: r => `${r.vendor} ${r.name}` }, { label: '計上累計', num: 1, value: r => yen(r.billed) }, { label: '支払累計', num: 1, value: r => yen(r.paid) }, { label: '未払残高', num: 1, value: r => yen(r.balance) }], ap)}</section>`);
};

// ----- 月次確定 -----
VIEWS.periods = async () => {
  const A = actions;
  const p = await api('/api/periods');
  A.check = async d => { const issues = await api('/api/periods/check?month=' + d.month); $(`#chk-${d.month}`).innerHTML = issues.length ? `<ul class="list check-ng small">${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="check-ok small">確定可能です</span>'; };
  A.close = d => confirmBox('月次確定', `${d.month} を確定します。確定後はこの月の日付で登録・変更・取消ができません。`, () => post('/api/periods/close', { month: d.month }).then(() => { toast('確定しました'); render(); }), '確定する');
  A.reopen = d => confirmBox('確定解除', `${d.month} の確定を解除します。`, () => post('/api/periods/reopen', { month: d.month }).then(() => { toast('解除しました'); render(); }), '解除する');
  return page('月次確定', '確定した月の伝票は登録・変更・取消ができなくなります。確定・解除は管理者のみ実行できます。', '', `<section class="card glass">${table([{ label: '月', value: r => r.month }, { label: '状態', html: r => r.closed ? badge('確定済', 'green') : badge('未確定', 'gray') },
    { label: '確定日時 / 実行者', value: r => r.closed ? `${jst(r.closedAt, 16)} / ${r.closedBy}` : '' }, { label: 'チェック', html: r => `<div id="chk-${r.month}">${r.closed ? '' : `<button class="mini" data-act="check" data-month="${r.month}">確定前チェック</button>`}</div>` },
    { label: '', html: r => isAdmin() ? (r.closed ? `<button class="mini danger" data-act="reopen" data-month="${r.month}">解除</button>` : `<button class="mini primary" data-act="close" data-month="${r.month}">確定</button>`) : '' }], p.months)}</section>
    <div class="note">確定は古い月から順に行います（前月が未確定の場合は確定できません）。業務別の締め（請求・支払・在庫）を分けた設計は今後の検討事項です。</div>`);
};

// ----- マスタ管理 -----
VIEWS.masters = async q => {
  const A = actions;
  const kind = meta.masters[q.kind] ? q.kind : 'customers', m = meta.masters[kind], list = masters[kind] = await api('/api/masters/' + kind);
  A.tab = d => go('masters', { kind: d.kind });
  A.new = () => masterForm(kind); A.edit = d => masterForm(kind, list.find(r => r.key === d.key));
  A.import = () => modal({ title: `${m.label} CSV取込`, submit: '取込む', body: `<p class="small">1行目は列名（${m.fields.map(f => f.label).join('、')}）です。<b>1件でもエラーがあれば全件取消</b>します。既存コードは更新、新規コードは登録します。</p>
      <input type="file" name="file" accept=".csv,text/csv" required><p class="muted small">UTF-8 / Shift_JIS のCSVに対応。<a href="/api/export/master-${kind}" download>現在のデータをCSVで出力</a>してテンプレートとして使えます。</p>`,
    onSubmit: async (v, f) => { const file = f.file.files[0]; if (!file) throw Error('ファイルを選択してください'); const buf = await file.arrayBuffer();
      let csv; try { csv = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { csv = new TextDecoder('shift_jis').decode(buf); }
      const r = await post(`/api/masters/${kind}/import`, { csv }); toast(`登録 ${r.created}件・更新 ${r.updated}件`); await loadMasters(); render(); } });
  const show = f => r => f.type === 'bool' ? (r[f.name] ? '有効' : '無効') : f.type === 'ref' ? `${r[f.name]} ${nameOf(f.ref, r[f.name])}` : f.type === 'select' ? (f.options.find(o => o[0] === String(r[f.name]))?.[1] || r[f.name]) : f.type === 'int' ? yen(r[f.name]) : r[f.name];
  return page('マスタ管理', '8種類のマスタを業務テーブルで直接管理します。登録後のコード・所属は変更できません（新規登録して旧マスタを無効化）。', `${csvLink('master-' + kind)}${canWrite() ? '<button data-act="import">⇧ CSV取込</button><button class="primary" data-act="new">＋ 新規登録</button>' : ''}`,
    `<div class="tabs">${Object.entries(meta.masters).map(([k, x]) => `<button class="${k === kind ? 'active' : ''}" data-act="tab" data-kind="${k}">${esc(x.label)}</button>`).join('')}</div>
    <section class="card glass">${table([...m.fields.filter(f => f.type !== 'bool').map(f => ({ label: f.label, num: f.type === 'int', value: show(f) })), { label: '状態', html: r => r.active ? badge('有効', 'green') : badge('無効', 'gray') },
      { label: '', html: r => canWrite() ? `<button class="mini" data-act="edit" data-key="${esc(r.key)}">編集</button>` : '' }], list, { rowClass: r => r.active ? '' : 'muted' })}</section>`);
};
function masterInput(f, r, isNew) {
  const v = r?.[f.name] ?? (f.type === 'bool' ? true : ''), dis = f.key && !isNew ? 'disabled' : '';
  if (f.type === 'bool') return `<label class="field"><span>${esc(f.label)}</span><span><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> 有効</span></label>`;
  let input;
  if (f.type === 'ref') input = `<select name="${f.name}" ${dis}>${options(isNew ? active(f.ref) : masters[f.ref], v, { blank: '選択してください' })}</select>`;
  else if (f.type === 'site') input = `<select name="${f.name}" ${dis}>${siteOptions(r?.customer || '', v, '（得意先共通）')}</select>`;
  else if (f.type === 'select') input = `<select name="${f.name}">${options(f.options.map(([code, name]) => ({ code, name })), v || f.options[0][0], { label: x => x.name })}</select>`;
  else input = `<input name="${f.name}" type="${f.type === 'date' ? 'date' : 'text'}" class="${f.type === 'int' ? 'num' : ''}" value="${esc(v)}" ${f.max ? `maxlength="${f.max}"` : ''} ${dis}>`;
  return field(f.label, input, { req: !f.optional, hint: f.hint });
}
function masterForm(kind, r) {
  const m = meta.masters[kind];
  modal({ title: `${m.label}の${r ? '編集' : '新規登録'}`, submit: r ? '更新する' : '登録する', body: `<div class="form-grid">${m.fields.map(f => masterInput(f, r, !r)).join('')}</div>${r?.system ? '<p class="note small">自動仕訳で使用する科目のため無効化できません。</p>' : ''}`,
    onOpen: f => { if (f.site && f.customer) f.customer.onchange = () => (f.site.innerHTML = siteOptions(f.customer.value, '', '（得意先共通）')); },
    onSubmit: async (v, f) => {
      const rec = { ...(r || {}), ...v }; for (const x of m.fields) if (x.type === 'bool') rec[x.name] = f[x.name].checked;
      await post('/api/masters/' + kind, { mode: r ? 'update' : 'create', record: rec }); toast(r ? '更新しました' : '登録しました'); await loadMasters(); render();
    } });
}

// ----- 移行・確認事項 -----
VIEWS.migration = async () => {
  const A = actions;
  const [cov, req] = await Promise.all([api('/api/coverage'), fetch('/requirements.json').then(r => r.json())]);
  const used = cov.filter(t => t.use === '使用').length;
  return page('移行・確認事項', 'AS400 業務の Web 移行における本システムの前提と、確認が必要な事項です。', '', `
    <div class="grid2"><section class="card glass"><div class="card-head"><h2>本システムの前提（仮決定）</h2></div><ol class="list small">
      <li>出荷1件＝1商品＝売上1行（sales_trn.order_suffix=1）。請求明細（billing_detail）は売上No単位で作成し、請求ヘッダとは得意先・請求年月・締日で結び付けます。<b>billing_detail と sales_trn 枝番の正式な関係は確認待ち</b>です。</li><li>出荷伝票訂正（NO11）は元伝票を変更せず、マイナス数量を含む訂正伝票（伝票区分2、sales_no=元売上No）を起票し、次回の請求締めに含めます。</li>
      <li>請求は<b>得意先×締日の単位</b>（NO6：現場単位から得意先単位へ変更、2026-10-15決定）。現場は明細に保持し、請求書では現場ごとに小計します。掛売のみ対象とし、現金・カード売上は請求対象外（Q16/Q17）。値引（伝票区分9）は未対応（Q18）。</li>
      <li>消費税は請求書単位で税率ごとに合計し、円未満切り捨て。支払期日は締日の翌月末（仮）。</li>
      <li>入金は振込・現金・手形・振込手数料・協力会費等・預り金充当・値引の内訳で記録し、得意先×請求年月の請求へ消込できます（仕訳 B-01〜B-06）。協力会費の処税率は141で仮置き（Q04）、預り金の受入は開始残高のみ（Q11）。</li>
      <li>仕訳パターン A01〜F01 は仕訳パターン分析の科目名を用いた仮パターンです。会計システムの受入形式は未確定（Q14/Q19）。</li>
      <li>銀行マスタ（code_m BANK）は当座預金 1112 の内訳科目として同期します。支払の振込手数料・相殺は未対応（Q03）。</li>
      <li>月次確定はアプリ用テーブル app_period_close で管理。利用者・権限は users / roles / menus の既存定義を使用（管理者・担当者・参照者）。</li>
      <li>原本の業務データは移行していません。表示中のデータはすべて架空です。</li></ol></section>
    <section class="card glass"><div class="card-head"><h2>テーブル使用状況</h2>${badge(`${used} / ${cov.length} 表を使用`, 'green')}</div>${table([{ label: 'テーブル', value: r => r.table }, { label: '内容', value: r => r.label }, { label: '区分', value: r => r.origin }, { label: '本システム', html: r => r.use === '使用' ? badge('使用', 'green') : badge(r.use, 'gray') }, { label: '件数', num: 1, value: r => yen(r.rows) }], cov)}</section></div>
    <section class="card glass"><div class="card-head"><h2>確認待ちの事項（${req.questions.length}件）</h2></div>${table([{ label: 'No', value: r => r.id }, { label: '確認事項', value: r => r.question }, { label: '影響', value: r => r.impact }], req.questions)}</section>`);
};

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

// ---------- boot ----------
async function boot() {
  try { session = await api('/api/session'); meta = await api('/api/meta'); await loadMasters(); }
  catch (e) { $('#content').innerHTML = `<div class="card glass"><h2>接続できません</h2><p class="check-ng">${esc(e.message)}</p></div>`; return; }
  nav(); $('#user-name').textContent = session.user.name; $('#user-role').textContent = session.user.roleName; $('#avatar').textContent = (session.user.name || 'A').slice(0, 1); $('#app-version').textContent = 'v' + meta.version;
  $('#logout').onclick = async () => { await post('/api/logout', {}).catch(() => {}); location.replace('/login'); };
  $('#refresh').onclick = async () => { await loadMasters(); await render(); toast('最新の状態を読み込みました'); };
  $('#menu-toggle').onclick = () => document.body.classList.toggle('nav-open');
  $('#change-password').onclick = () => modal({ title: 'パスワード変更', submit: '変更する', body: `<div class="form-grid">${field('現在のパスワード', '<input type="password" name="current" autocomplete="current-password">', { req: 1, wide: 1 })}${field('新しいパスワード', '<input type="password" name="password" autocomplete="new-password">', { req: 1, wide: 1, hint: '12文字以上' })}</div>`,
    onSubmit: async v => { await post('/api/password', v); toast('パスワードを変更しました'); } });
  window.addEventListener('hashchange', render);
  await render();
}
boot();
