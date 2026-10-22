// 財務会計（勘定奉行相当）の画面。app.js の共通部品を受け取り VIEWS に登録する。
// 仕訳入力（振替伝票）／仕訳帳・伝票検索／元帳／残高試算表・月次推移表／決算書・消費税集計表／仕訳受入・書出／会計設定
export function installKb(h) {
  const { VIEWS, api, post, page, table, esc, yen, badge, modal, confirmBox, toast, today, addMonths, qs, go, $, $$, canWrite, isAdmin, acts, route, masters, render } = h;
  let K = null;
  const kb = async (force = false) => (K && !force ? K : (K = await api('/api/kb/meta')));
  const ACC = code => K.accounts.find(a => a.code === code);
  const GRP = code => K.groups.find(g => g.code === code);
  // 処税率（server/taxcode.mjs と同じ規則）。一覧にない組合せも桁から解釈する。
  function TAX(v) {
    const hit = K.taxes.find(t => t.code === v); if (hit) return hit;
    const s = String(v || ''); if (!/^[012]\d\d$/.test(s) || !K.taxKinds[s[1]] || !(s[2] in K.taxRates)) return null;
    const k = +s[1], rate = K.taxRates[s[2]], taxable = rate > 0 && [1, 4, 5, 6].includes(k) && (s[0] !== '0' || k === 1);
    return { code: s, name: `${K.taxKinds[k]}${taxable ? ' ' + rate + '%' : ''}`, rate, taxable, excl: taxable && (s[0] === '2' || (s[0] === '0' && k === 1)) };
  }
  const money = v => `<span class="${v < 0 ? 'kb-neg' : ''}">${yen(v)}</span>`;
  // 会計月度（自社情報の締日：20＝21日〜20日、31＝暦月）。ラベル YYYY-MM＝締日の属する月
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const closeOf = m => { const y = +m.slice(0, 4), mm = +m.slice(5, 7); return `${m}-${String(Math.min(K.fiscal.closingDay || 31, lastDay(y, mm))).padStart(2, '0')}`; };
  const monthEnd = m => closeOf(m);
  const monthStart = m => { const d = new Date(closeOf(addMonths(m, -1)) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const labelOf = iso => (iso <= closeOf(iso.slice(0, 7)) ? iso.slice(0, 7) : addMonths(iso.slice(0, 7), 1));
  const thisMonth = () => labelOf(today());
  const tabs = (cur, list) => `<div class="tabs">${list.map(([k, label]) => `<button class="${cur === k ? 'active' : ''}" data-act="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</div>`;
  const dateInput = (name, value, label) => `<label class="kb-inline">${esc(label)}<input type="date" name="${name}" value="${esc(value)}" data-filter></label>`;
  const xlsxLink = (path, q) => `<a class="button" href="/api/kb/${path}?${qs({ ...q, format: 'xlsx' })}" download>⇩ Excel</a>`;
  const printBtn = '<button data-act="print">⎙ 印刷</button>';
  const doPrint = (title, sub, html) => { $('#print-area').innerHTML = `<section class="invoice-doc report-doc journal-doc kb-print"><h2>${esc(title)}</h2><p>${esc(sub)} ／ 出力日 ${today()}</p>${html}</section>`; setTimeout(() => window.print(), 200); };
  const accLabel = a => `${a.code} ${a.name}`;
  function accOptions(value, { blank = '（科目を選択）', filter = () => true, all = false } = {}) {
    let html = `<option value="">${esc(blank)}</option>`;
    for (const g of K.groups) {
      const list = K.accounts.filter(a => a.grp === g.code && (all || a.active || a.code === value) && filter(a)); if (!list.length) continue;
      html += `<optgroup label="${esc(g.name)}">${list.map(a => `<option value="${esc(a.code)}" ${a.code === value ? 'selected' : ''}>${esc(accLabel(a))}</option>`).join('')}</optgroup>`;
    }
    return html;
  }
  function subList(code) {
    const a = ACC(code), m = masters(); if (!a) return [];
    if (a.sub === 'CUST') return (m.customers || []).map(r => ({ code: r.code, name: r.name, active: r.active }));
    if (a.sub === 'VEND') return (m.vendors || []).map(r => ({ code: r.code, name: r.name, active: r.active }));
    return (m.subaccounts || []).filter(r => r.account === code).map(r => ({ code: r.code, name: r.name, active: r.active }));
  }
  const subOptions = (code, value, blank = '（補助なし）') => `<option value="">${esc(blank)}</option>` + subList(code).filter(s => s.active || s.code === value).map(s => `<option value="${esc(s.code)}" ${s.code === value ? 'selected' : ''}>${esc(s.code + ' ' + s.name)}</option>`).join('');
  const deptOptions = (value, blank = '（部門なし）') => `<option value="">${esc(blank)}</option>` + (masters().depts || []).filter(d => d.active || d.code === value).map(d => `<option value="${esc(d.code)}" ${d.code === value ? 'selected' : ''}>${esc(d.code + ' ' + d.name)}</option>`).join('');
  const taxOptions = value => (value && !K.taxes.some(t => t.code === value) && TAX(value) ? [TAX(value), ...K.taxes] : K.taxes).map(t => `<option value="${t.code}" ${t.code === value ? 'selected' : ''}>${esc(t.code + ' ' + t.name)}</option>`).join('');
  const fyOptions = value => K.fiscal.years.map(y => `<option value="${y.fy}" ${Number(value) === y.fy ? 'selected' : ''}>${esc(y.label)}</option>`).join('');
  const fyOf = iso => (iso > closeOf(`${iso.slice(0, 4)}-${String(K.fiscal.closingMonth).padStart(2, '0')}`) ? +iso.slice(0, 4) : +iso.slice(0, 4) - 1);
  const fyRange = fy => K.fiscal.years.find(y => y.fy === fy) || { from: monthStart(addMonths(`${fy}-${String(K.fiscal.closingMonth).padStart(2, '0')}`, 1)), to: closeOf(`${fy + 1}-${String(K.fiscal.closingMonth).padStart(2, '0')}`) };
  // 期間：指定がなければ当月度。プリセット（前月度・単月度・期首から当月度・年度）を data-act で切替。
  const periodOf = q => ({ from: q.from || monthStart(thisMonth()), to: q.to || monthEnd(thisMonth()) });
  // プリセットはドキュメントで受ける（periodBar は await の後に呼ばれるため、画面ごとの actions に登録すると前画面に付いてしまう）
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-kbp]'); if (!b) return;
    e.preventDefault();
    const q = route().q, p = b.dataset.kbp, base = labelOf(q.to || today()), m = p === 'prev' ? addMonths(base, -1) : p === 'next' ? addMonths(base, 1) : base;
    if (p === 'cum') { const r = fyRange(fyOf(monthEnd(base))); return go(route().name, { ...q, from: r.from, to: monthEnd(base) }); }
    if (p === 'fy') { const r = fyRange(fyOf(monthEnd(base))); return go(route().name, { ...q, from: r.from, to: r.to }); }
    go(route().name, { ...q, from: monthStart(m), to: monthEnd(m) });
  });
  function periodBar(q, { presets = true } = {}) {
    const p = periodOf(q);
    return `${dateInput('from', p.from, '自')}${dateInput('to', p.to, '至')}${presets ? `<span class="kb-presets"><button class="mini quiet" data-kbp="prev">◀ 前月</button><button class="mini quiet" data-kbp="month">単月</button><button class="mini quiet" data-kbp="next">翌月 ▶</button><button class="mini quiet" data-kbp="cum">期首〜当月</button><button class="mini quiet" data-kbp="fy">年度</button></span>` : ''}`;
  }
  const deptFilter = value => `<select name="dept" data-filter>${deptOptions(value, 'すべての部門')}</select>`;

  // ================= 仕訳入力（振替伝票） =================
  const sideHtml = (side, x = {}) => {
    const acc = x.account || '', tax = x.tax || ACC(acc)?.tax || '090';
    return `<div class="kb-side" data-side="${side}" data-excl="${x.taxExcl ? 1 : ''}">
      <select data-kb="account" aria-label="${side === 'D' ? '借方' : '貸方'}科目">${accOptions(acc)}</select>
      <div class="kb-side-2"><select data-kb="sub" aria-label="補助">${subOptions(acc, x.sub || '')}</select><select data-kb="dept" aria-label="部門">${deptOptions(x.dept || '')}</select></div>
      <div class="kb-side-3"><select data-kb="tax" aria-label="税区分">${taxOptions(tax)}</select>
        <input data-kb="amount" class="num" inputmode="numeric" placeholder="金額" value="${x.amount ? esc(x.amount) : ''}" aria-label="金額">
        <input data-kb="taxAmount" class="num kb-taxamt" inputmode="numeric" placeholder="税額" value="${x.amount ? esc(x.taxAmount ?? '') : ''}" ${x.amount ? 'data-manual="1"' : ''} title="消費税額（${x.taxExcl ? '外税' : '内税'}）" aria-label="消費税額"></div></div>`;
  };
  const rowHtml = (r = {}, i = 0) => `<div class="kb-row"><div class="kb-rowno">${i + 1}</div>${sideHtml('D', r.dr || {})}<div class="kb-memo"><textarea data-kb="memo" rows="3" placeholder="摘要" aria-label="摘要">${esc(r.memo || '')}</textarea></div>${sideHtml('C', r.cr || {})}<button type="button" class="mini quiet kb-delrow" data-kbrow="del" title="行を削除" aria-label="行を削除">×</button></div>`;
  const num = v => Number(String(v || '').replace(/[,\s]/g, '')) || 0;
  // 定型仕訳（現行 仕訳帳 AC2205 の手入力伝票で繰り返し現れる組合せ）。金額・業者補助は入力時に指定。
  const S = (account, sub = '', tax = '', dept = '') => ({ account, sub, tax, dept });
  const TEMPLATES = [
    ['振込手数料（普通預金）', [[S('8330', '101', '141', '063'), S('1113', '041')]]],
    ['振込手数料（当座預金）', [[S('8330', '101', '141', '063'), S('1112', '041')]]],
    ['小口現金の補充（普通預金→現金）', [[S('1111'), S('1113', '041')]]],
    ['現金売上の預入（現金→当座預金）', [[S('1112', '041'), S('1111')]]],
    ['普通預金→当座預金 振替', [[S('1112', '041'), S('1113', '042')]]],
    ['受取手形 期日入金', [[S('1113', '042'), S('1120')]]],
    ['受取利息', [[S('1113', '041'), S('8610')]]],
    ['雑収入（鉄くず売却等）', [[S('1112', '041'), S('8790', '030', '111', '063')]]],
    ['JV 出資金の請求（未収入金／構成員出資金）', [[S('1450'), S('4199')]]],
    ['JV 出資金の入金', [[S('1112', '041'), S('1450')]]],
    ['JV 分配金の確定', [[S('1480'), S('4140')], [{}, S('4199')]]],
    ['JV 分配金の支払', [[S('4140'), S('1112', '041')]]],
    ['消費税の精算（仮受／仮払・差額）', [[S('4415'), S('1465')], [{}, S('7322')]]],
    ['前払費用の振替（保険料）', [[S('8329', '110', '070', '063'), S('1420')]]],
  ];
  function autoTax(sideEl) {
    const t = TAX($('[data-kb=tax]', sideEl).value), amt = num($('[data-kb=amount]', sideEl).value), ti = $('[data-kb=taxAmount]', sideEl);
    if (ti.dataset.manual) return;
    const r = t?.taxable ? Math.round(t.rate * 10) : 0;
    ti.value = amt ? Math.floor(amt * r / (t?.excl ? 1000 : 1000 + r)) : '';
  }
  function slipTotals() {
    const f = $('#kb-slip'); if (!f) return;
    let dr = 0, cr = 0;
    for (const s of $$('.kb-side', f)) { const v = num($('[data-kb=amount]', s).value); if (s.dataset.side === 'D') dr += v; else cr += v; }
    $('#kb-dr').textContent = yen(dr); $('#kb-cr').textContent = yen(cr);
    const d = $('#kb-diff'); d.textContent = yen(dr - cr); d.className = dr === cr ? 'check-ok' : 'check-ng';
  }
  function readSlip() {
    const f = $('#kb-slip'), side = s => ({ account: $('[data-kb=account]', s).value, sub: $('[data-kb=sub]', s).value, dept: $('[data-kb=dept]', s).value, tax: $('[data-kb=tax]', s).value,
      amount: String(num($('[data-kb=amount]', s).value) || ''), taxAmount: $('[data-kb=taxAmount]', s).value === '' ? '' : String(num($('[data-kb=taxAmount]', s).value)), taxExcl: !!s.dataset.excl });
    return { id: f.dataset.id ? Number(f.dataset.id) : undefined, version: f.dataset.version ? Number(f.dataset.version) : undefined, date: f.date.value, memo: f.memo.value,
      rows: $$('.kb-row', f).map(r => ({ dr: side($('[data-side=D]', r)), cr: side($('[data-side=C]', r)), memo: $('[data-kb=memo]', r).value })) };
  }
  // 入力欄のイベントはドキュメントで一括して受ける（画面は innerHTML で描画されるため）
  document.addEventListener('change', e => {
    const s = e.target.closest('#kb-slip .kb-side'); if (!s) return;
    if (e.target.dataset.kb === 'account') { const a = ACC(e.target.value); $('[data-kb=sub]', s).innerHTML = subOptions(e.target.value, ''); if (a) $('[data-kb=tax]', s).value = a.tax; delete $('[data-kb=taxAmount]', s).dataset.manual; }
    if (e.target.dataset.kb === 'tax') delete $('[data-kb=taxAmount]', s).dataset.manual;
    autoTax(s); slipTotals();
  });
  document.addEventListener('input', e => {
    const s = e.target.closest('#kb-slip .kb-side'); if (!s) return;
    if (e.target.dataset.kb === 'taxAmount') e.target.dataset.manual = '1';
    if (e.target.dataset.kb === 'amount') autoTax(s);
    slipTotals();
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('#kb-slip [data-kbrow]'); if (!b) return;
    e.preventDefault();
    const box = $('#kb-rows');
    if (b.dataset.kbrow === 'del') { if ($$('.kb-row', box).length > 1) b.closest('.kb-row').remove(); }
    if (b.dataset.kbrow === 'add') box.insertAdjacentHTML('beforeend', rowHtml({}, $$('.kb-row', box).length));
    if (b.dataset.kbrow === 'balance') { // 貸借差額を、空いている側の最後の行に補完
      let dr = 0, cr = 0; for (const s of $$('.kb-side', box)) { const v = num($('[data-kb=amount]', s).value); if (s.dataset.side === 'D') dr += v; else cr += v; }
      if (dr !== cr) {
        const side = dr > cr ? 'C' : 'D', empty = $$(`.kb-side[data-side=${side}]`, box).find(s => !num($('[data-kb=amount]', s).value));
        const target = empty || (box.insertAdjacentHTML('beforeend', rowHtml({}, $$('.kb-row', box).length)), $(`.kb-row:last-child .kb-side[data-side=${side}]`, box));
        $('[data-kb=amount]', target).value = Math.abs(dr - cr); autoTax(target);
      }
    }
    $$('.kb-row', box).forEach((r, i) => ($('.kb-rowno', r).textContent = i + 1));
    slipTotals();
  });

  VIEWS['kb-entry'] = async q => {
    const A = acts(); await kb();
    const s = q.id ? await api('/api/kb/slips/' + Number(q.id)) : null;
    const locked = s && K.fiscal.lockDate && s.date <= K.fiscal.lockDate;
    const date = s?.date || q.date || today();
    const list = s ? s.rows : [{}, {}, {}, {}];
    A.save = async (_, btn) => {
      btn.disabled = true;
      try {
        const r = await post('/api/kb/slips', readSlip());
        toast(`伝票No ${r.no} を${s ? '修正' : '登録'}しました`);
        if (s) go('kb-journal', { from: q.back_from || '', to: q.back_to || '' }); else go('kb-entry', { date: $('#kb-slip').date.value, t: Date.now() });
      } catch (e) { $('#kb-err').textContent = e.message; toast(e.message, true); } finally { btn.disabled = false; }
    };
    A.clear = () => go('kb-entry', { date: $('#kb-slip').date.value, t: Date.now() });
    A.tpl = () => {
      const t = TEMPLATES[Number($('#kb-tpl').value)]; if (!t) return;
      $('#kb-rows').innerHTML = t[1].map(([dr, cr], i) => rowHtml({ dr, cr, memo: t[0] }, i)).join('');
      if (!$('#kb-slip').memo.value) $('#kb-slip').memo.value = t[0];
      slipTotals(); $('#kb-rows [data-kb=amount]')?.focus();
    };
    A.del = () => confirmBox('伝票の削除', `伝票No ${s.no}（${s.date}）を削除します。操作履歴には残ります。`, () => post('/api/kb/slips/delete', { id: s.id, version: s.version }).then(() => { toast('削除しました'); go('kb-journal', {}); }), '削除する');
    A.back = () => history.back();
    const head = s ? `伝票No <b>${s.no}</b> ／ ${badge(s.sourceName, s.source === 'MANUAL' ? '' : 'amber')} ${s.sourceRef ? `<span class="muted small">元仕訳 #${esc(s.sourceRef)}</span>` : ''} <span class="muted small">更新 ${esc(s.updatedBy)}</span>` : '<span class="muted">新規伝票（伝票No は登録時に年度内連番で採番）</span>';
    return page(s ? '仕訳入力（伝票修正）' : '仕訳入力（振替伝票）', '借方・貸方を同じ行に入力します。科目を選ぶと補助・既定税区分が切り替わり、消費税額は税込金額から自動計算します（手入力で上書き可）。',
      `${s ? '<button data-act="back">← 戻る</button>' : ''}<a class="button" href="#kb-journal">仕訳帳へ</a>`,
      `<section class="card glass"><form id="kb-slip" data-id="${s?.id || ''}" data-version="${s?.version || ''}">
        <div class="kb-slip-head"><label class="field req"><span>伝票日付</span><input type="date" name="date" value="${esc(date)}" required></label>
          <label class="field wide"><span>伝票摘要</span><input name="memo" maxlength="100" value="${esc(s?.memo || '')}" placeholder="例）3月分 事務所家賃"></label><div class="kb-slip-info">${head}</div></div>
        ${s ? '' : `<div class="filters"><label class="kb-inline">定型仕訳<select id="kb-tpl"><option value="">（選択）</option>${TEMPLATES.map((t, i) => `<option value="${i}">${esc(t[0])}</option>`).join('')}</select></label><button type="button" class="mini" data-act="tpl">明細に展開</button><span class="muted small">金額と業者などの補助を入力してください</span></div>`}
        <div class="kb-grid-head"><div></div><div>借方（科目・補助・部門／税区分・金額・税額）</div><div>摘要</div><div>貸方（科目・補助・部門／税区分・金額・税額）</div><div></div></div>
        <div id="kb-rows">${list.map(rowHtml).join('')}</div>
        <div class="kb-foot"><div class="filters"><button type="button" data-kbrow="add">＋ 行追加</button><button type="button" data-kbrow="balance" title="借方・貸方の差額を空欄側に入れます">貸借差額を補完</button></div>
          <div class="kb-totals"><span>借方合計 <b id="kb-dr">0</b></span><span>貸方合計 <b id="kb-cr">0</b></span><span>差額 <b id="kb-diff" class="check-ok">0</b></span></div></div>
        <p class="form-error" id="kb-err"></p>
        <div class="filters right">${locked ? '<span class="check-ng">入力制限日以前の伝票のため変更できません</span>' : canWrite() ? `${s ? '<button type="button" class="danger" data-act="del">削除</button>' : '<button type="button" data-act="clear">クリア</button>'}<button type="button" class="primary" data-act="save">${s ? '修正を保存' : '登録'}</button>` : '<span class="muted">参照者は登録できません</span>'}</div>
      </form></section>
      <div class="note">入力制限日：${esc(K.fiscal.lockDate || '設定なし')} ／ 導入期首：${esc(K.fiscal.startDate)} ／ 合計額が一致しない伝票は登録できません。</div>`);
  };
  // 描画後に合計欄を初期化する（app.js の render が view:rendered を通知）
  document.addEventListener('view:rendered', () => { slipTotals(); openingTotals(); });

  // ================= 仕訳帳・伝票検索 =================
  const sideCell = x => (x ? `<div>${esc(x.account)} ${esc(x.accountName)}</div><div class="small muted">${x.sub ? esc(x.sub + ' ' + x.subName) : ''}${x.dept ? ' ／' + esc(x.dept) : ''}${x.tax !== '090' ? ` ／${esc(x.taxName)}${x.taxAmount ? ' 税' + yen(x.taxAmount) + (x.taxExcl ? '(外)' : '') : ''}` : ''}</div>` : '');
  function journalTable(d, { edit = true } = {}) {
    if (!d.slips.length) return '<div class="empty">条件に合う伝票がありません</div>';
    const lock = K.fiscal.lockDate;
    return `<div class="table-wrap"><table class="kb-journal"><thead><tr><th>日付／No</th><th>借方科目</th><th class="num">借方金額</th><th>摘要</th><th>貸方科目</th><th class="num">貸方金額</th><th></th></tr></thead><tbody>${d.slips.map(s => s.rows.map((r, i) => `<tr class="${i ? '' : 'kb-slip-first'}">
      ${i ? '' : `<td rowspan="${s.rows.length}" class="kb-slipno"><b>${esc(s.date)}</b><br>No ${s.no} ${s.source !== 'MANUAL' ? badge(s.sourceName, 'amber') : ''}${s.memo ? `<div class="small muted">${esc(s.memo)}</div>` : ''}</td>`}
      <td>${sideCell(r.dr)}</td><td class="num">${r.dr ? yen(r.dr.amount) : ''}</td><td class="small">${esc(r.memo)}</td><td>${sideCell(r.cr)}</td><td class="num">${r.cr ? yen(r.cr.amount) : ''}</td>
      ${i ? '' : `<td rowspan="${s.rows.length}" class="kb-ops">${edit && canWrite() && !(lock && s.date <= lock) ? `<button class="mini" data-act="edit" data-id="${s.id}">修正</button><button class="mini danger" data-act="del" data-id="${s.id}" data-version="${s.version}" data-no="${s.no}" data-date="${esc(s.date)}">削除</button>` : `<button class="mini" data-act="edit" data-id="${s.id}">表示</button>`}</td>`}</tr>`).join('')).join('')}</tbody>
      <tfoot><tr><td>${d.slips.length} 伝票</td><td class="right">合計</td><td class="num">${yen(d.total)}</td><td></td><td></td><td class="num">${yen(d.total)}</td><td></td></tr></tfoot></table></div>${d.truncated ? '<p class="check-ng small">表示は1,000伝票までです。期間を絞ってください。</p>' : ''}`;
  }
  VIEWS['kb-journal'] = async q => {
    const A = acts(); await kb();
    const p = periodOf(q), f = { ...p, account: q.account, source: q.source, text: q.text, amount: q.amount };
    const d = await api('/api/kb/journal?' + qs(f));
    A.edit = x => go('kb-entry', { id: x.id, back_from: p.from, back_to: p.to });
    A.del = x => confirmBox('伝票の削除', `伝票No ${x.no}（${x.date}）を削除します。`, () => post('/api/kb/slips/delete', { id: Number(x.id), version: Number(x.version) }).then(() => { toast('削除しました'); render(); }), '削除する');
    A.search = () => go('kb-journal', { ...route().q, text: $('#kb-text').value, amount: $('#kb-amount').value });
    A.print = () => doPrint('仕訳帳', `${p.from} 〜 ${p.to}`, $('#kb-body').innerHTML);
    return page('仕訳帳・伝票検索', '期間・科目・入力区分・摘要・金額で伝票を検索し、修正・削除します。請求システムから受け入れた伝票も同じように扱えます。',
      `${periodBar(q)}<select name="account" data-filter>${accOptions(q.account || '', { blank: 'すべての科目', all: true })}</select>
       <select name="source" data-filter><option value="">すべての入力区分</option>${Object.entries(K.sources).map(([k, v]) => `<option value="${k}" ${q.source === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
       <input id="kb-text" placeholder="摘要" value="${esc(q.text || '')}" style="width:140px"><input id="kb-amount" placeholder="金額" class="num" value="${esc(q.amount || '')}" style="width:110px"><button data-act="search">検索</button>
       ${xlsxLink('journal', f)}<a class="button" href="/api/kb/journal-csv?${qs(f)}" download>⇩ 仕訳CSV</a>${printBtn}${canWrite() ? '<a class="button primary" href="#kb-entry">＋ 伝票入力</a>' : ''}`,
      `<section class="card glass" id="kb-body">${journalTable(d)}</section>`);
  };

  // ================= 元帳 =================
  VIEWS['kb-ledger'] = async q => {
    const A = acts(); await kb();
    const tab = q.tab === 'subs' ? 'subs' : 'ledger', p = periodOf(q);
    const accounts = K.accounts.filter(a => a.active || a.code === q.account), account = ACC(q.account) ? q.account : accounts[0]?.code;
    A.tab = d => go('kb-ledger', { ...route().q, tab: d.tab });
    A.move = d => { const i = accounts.findIndex(a => a.code === account), n = accounts[i + Number(d.dir)]; if (n) go('kb-ledger', { ...route().q, account: n.code, sub: '' }); };
    A.edit = d => go('kb-entry', { id: d.id });
    A.sub = d => go('kb-ledger', { ...route().q, tab: 'ledger', sub: d.sub });
    const acc = ACC(account), hasSub = acc && (acc.sub || subList(account).length);
    const filters = `${periodBar(q)}<button class="mini quiet" data-act="move" data-dir="-1" title="前の科目">▲</button><select name="account" data-filter>${accOptions(account, { all: true })}</select><button class="mini quiet" data-act="move" data-dir="1" title="次の科目">▼</button>
      ${tab === 'ledger' && hasSub ? `<select name="sub" data-filter>${subOptions(account, q.sub || '', '（補助：すべて＝総勘定元帳）')}</select>` : ''}${tab === 'ledger' ? deptFilter(q.dept) : ''}`;
    let body, title;
    if (tab === 'subs') {
      const d = await api('/api/kb/sub-balances?' + qs({ ...p, account }));
      title = `補助残高一覧表 ${d.account} ${d.accountName}`;
      body = table([{ label: '補助コード', value: r => r.sub || '-' }, { label: '補助名', value: r => r.name }, { label: '前期繰越', num: 1, html: r => money(r.opening) }, { label: '借方', num: 1, value: r => yen(r.dr) }, { label: '貸方', num: 1, value: r => yen(r.cr) }, { label: '残高', num: 1, html: r => money(r.closing) },
        { label: '', html: r => `<button class="mini" data-act="sub" data-sub="${esc(r.sub)}">元帳</button>` }], d.rows, { empty: '残高・取引のある補助はありません',
        foot: ['合計', '', yen(d.rows.reduce((n, r) => n + r.opening, 0)), yen(d.rows.reduce((n, r) => n + r.dr, 0)), yen(d.rows.reduce((n, r) => n + r.cr, 0)), yen(d.rows.reduce((n, r) => n + r.closing, 0)), ''] });
      A.print = () => doPrint(title, `${p.from} 〜 ${p.to}`, $('#kb-body').innerHTML);
    } else {
      const lq = { ...p, account, sub: q.sub || undefined, dept: q.dept || undefined };
      const d = await api('/api/kb/ledger?' + qs(lq));
      title = d.sub !== null ? `補助元帳 ${d.account} ${d.accountName} ／ ${d.sub} ${d.subName}` : `総勘定元帳 ${d.account} ${d.accountName}`;
      let html = `<tr class="kb-carry"><td>${esc(d.from)}</td><td></td><td></td><td></td><td>前期より繰越</td><td></td><td></td><td class="num">${money(d.opening)}</td></tr>`, last = null;
      // 月計は月度（締日基準：10/20締めなら 9/21〜10/20 が 10月度）。サーバの月度ラベルで区切る
      const monthRow = m => { const x = d.months.find(v => v.month === m) || { dr: 0, cr: 0 }; return `<tr class="kb-month"><td colspan="5" class="right">${esc(m)} 月度計</td><td class="num">${yen(x.dr)}</td><td class="num">${yen(x.cr)}</td><td></td></tr>`; };
      for (const l of d.lines) {
        const m = l.month || String(l.date).slice(0, 7); if (last && m !== last) html += monthRow(last); last = m;
        html += `<tr><td>${esc(l.date)}</td><td><a href="#kb-entry?id=${l.slipId}">${l.no}</a></td><td class="small">${esc(l.counter)}</td><td class="small">${esc(l.sub ? l.sub + ' ' + l.subName : '')}</td><td class="small">${esc(l.memo)}${l.tax !== '090' ? ` <span class="muted">${esc(TAX(l.tax)?.name || l.tax)}${l.taxAmount ? ' 税' + yen(l.taxAmount) : ''}</span>` : ''}</td>
          <td class="num">${l.dr ? yen(l.dr) : ''}</td><td class="num">${l.cr ? yen(l.cr) : ''}</td><td class="num">${money(l.balance)}</td></tr>`;
      }
      if (last) html += monthRow(last);
      body = `<p class="small muted">正残高：${d.side === 'D' ? '借方' : '貸方'}　${d.dept ? '部門 ' + esc(d.dept) + '（部門指定時は期首残高を含みません）' : ''}</p><div class="table-wrap"><table class="kb-ledger"><thead><tr><th>日付</th><th>伝票No</th><th>相手科目</th><th>補助</th><th>摘要</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead><tbody>${html}</tbody>
        <tfoot><tr><td colspan="5" class="right">期間合計（${d.lines.length}件）</td><td class="num">${yen(d.dr)}</td><td class="num">${yen(d.cr)}</td><td class="num">${money(d.closing)}</td></tr></tfoot></table></div>${d.truncated ? '<p class="check-ng small">5,000行で打ち切りました。期間を絞ってください。</p>' : ''}`;
      A.print = () => doPrint(title, `${d.from} 〜 ${d.to}`, $('#kb-body').innerHTML);
      body = `<div class="filters" style="margin-bottom:8px">${xlsxLink('ledger', lq)}${printBtn}</div>` + body;
    }
    return page('元帳', '総勘定元帳・補助元帳・補助残高一覧。伝票No をクリックすると伝票を開きます。期間が会計年度を跨ぐ場合、損益科目は期首で0から集計します。', filters,
      `${tabs(tab, [['ledger', '総勘定元帳／補助元帳'], ['subs', '補助残高一覧表']])}<section class="card glass"><h2>${esc(title)}</h2><div id="kb-body">${body}</div></section>`);
  };

  // ================= 残高試算表・月次推移表 =================
  function tbRows(list, { from, to }) {
    return list.map(r => {
      if (r.type === 'section') return `<tr class="kb-section"><td colspan="6">${esc(r.label)}</td></tr>`;
      if (r.type === 'group') return `<tr class="kb-group"><td></td><td colspan="5">${esc(r.label)}</td></tr>`;
      if (r.type === 'acct') return `<tr><td>${esc(r.code)}</td><td><a href="#kb-ledger?${qs({ account: r.code, from, to })}">${esc(r.label)}</a>${r.guessed ? ' ' + badge('区分推定', 'amber') : ''}</td><td class="num">${money(r.opening)}</td><td class="num">${yen(r.dr)}</td><td class="num">${yen(r.cr)}</td><td class="num">${money(r.closing)}</td></tr>`;
      if (r.type === 'calc') return `<tr class="kb-calc"><td></td><td>${esc(r.label)}</td><td class="num">${money(r.opening)}</td><td></td><td></td><td class="num">${money(r.closing)}</td></tr>`;
      return `<tr class="${r.type === 'grand' ? 'kb-grand' : 'kb-total'}"><td></td><td>${esc(r.label)}</td><td class="num">${money(r.opening)}</td><td class="num">${yen(r.dr ?? 0)}</td><td class="num">${yen(r.cr ?? 0)}</td><td class="num">${money(r.closing)}</td></tr>`;
    }).join('');
  }
  const tbTable = (title, list, p) => `<h3 class="kb-h3">${esc(title)}</h3><div class="table-wrap"><table class="kb-tb"><thead><tr><th>コード</th><th>勘定科目</th><th class="num">前期繰越</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead><tbody>${tbRows(list, p)}</tbody></table></div>`;
  VIEWS['kb-trial'] = async q => {
    const A = acts(); await kb();
    const tab = q.tab === 'monthly' ? 'monthly' : 'tb';
    A.tab = d => go('kb-trial', { ...route().q, tab: d.tab });
    if (tab === 'monthly') {
      const fy = Number(q.fy) || K.fiscal.currentFy, kind = q.kind === 'bs' ? 'bs' : 'pl', mq = { fy, kind, dept: q.dept || undefined };
      const d = await api('/api/kb/monthly?' + qs(mq));
      A.print = () => doPrint(`月次推移表（${kind === 'bs' ? '貸借対照表' : '損益計算書'}）`, d.fyLabel, $('#kb-body').innerHTML);
      const head = `<tr><th>コード</th><th>勘定科目</th>${d.months.map(m => `<th class="num">${esc(m.slice(5))}月</th>`).join('')}<th class="num">${kind === 'bs' ? '期末' : '合計'}</th></tr>`;
      const body = d.rows.map(r => r.type === 'group' ? `<tr class="kb-group"><td></td><td colspan="${d.months.length + 1}">${esc(r.label)}</td></tr>`
        : `<tr class="${r.type === 'acct' ? '' : r.type === 'calc' ? 'kb-calc' : 'kb-total'}"><td>${esc(r.code && r.type === 'acct' ? r.code : '')}</td><td>${esc(r.label)}</td>${r.values.map(v => `<td class="num">${v ? money(v) : ''}</td>`).join('')}<td class="num"><b>${money(r.total)}</b></td></tr>`).join('');
      return page('残高試算表', '月次推移表：損益は月別の発生額、貸借は各月末の残高を表示します。',
        `<select name="fy" data-filter>${fyOptions(fy)}</select><select name="kind" data-filter><option value="pl" ${kind === 'pl' ? 'selected' : ''}>損益計算書（発生額）</option><option value="bs" ${kind === 'bs' ? 'selected' : ''}>貸借対照表（月末残高）</option></select>${deptFilter(q.dept)}${xlsxLink('monthly', mq)}${printBtn}`,
        `${tabs(tab, [['tb', '合計残高試算表'], ['monthly', '月次推移表']])}<section class="card glass" id="kb-body"><div class="table-wrap"><table class="kb-tb kb-monthly"><thead>${head}</thead><tbody>${body || ''}</tbody></table></div>${d.rows.some(r => r.type === 'acct') ? '' : '<div class="empty">この年度の仕訳がありません</div>'}</section>`);
    }
    const p = periodOf(q), tq = { ...p, dept: q.dept || undefined, all: q.all || undefined };
    const d = await api('/api/kb/trial?' + qs(tq));
    A.print = () => doPrint('合計残高試算表', `${d.fyLabel} ${d.from} 〜 ${d.to}${d.dept ? ' 部門 ' + d.dept : ''}`, $('#kb-body').innerHTML);
    A.all = () => go('kb-trial', { ...route().q, all: q.all ? '' : '1' });
    const ck = d.check, chk = (ok, label) => `<span class="${ok ? 'check-ok' : 'check-ng'}">${ok ? '✓' : '✕'} ${esc(label)}</span>`;
    return page('残高試算表', '合計残高試算表（貸借対照表・損益計算書）。前期繰越は、貸借科目は導入期首から、損益科目は当期首からの累計です。科目名から元帳へ移動できます。',
      `${periodBar(q)}${deptFilter(q.dept)}<button class="mini quiet" data-act="all">${q.all ? '残高のある科目のみ' : '全科目を表示'}</button>${xlsxLink('trial', tq)}${printBtn}`,
      `${tabs(tab, [['tb', '合計残高試算表'], ['monthly', '月次推移表']])}
      <div class="kb-checks card glass">${esc(d.fyLabel)}　${chk(ck.balanced, `借方合計 ${yen(ck.dr)} ＝ 貸方合計 ${yen(ck.cr)}`)}　${d.dept ? '' : chk(ck.bsBalanced, `資産 ${yen(ck.assets)} ＝ 負債・純資産 ${yen(ck.liabEq)}`)}　${d.dept ? '' : chk(!ck.openingDiff, `期首残高の貸借差額 ${yen(ck.openingDiff)}`)}
        ${d.guessed.length ? `<div class="small check-ng">区分が推定の科目があります（${esc(d.guessed.join(', '))}）。会計設定で確認してください。</div>` : ''}</div>
      <section class="card glass" id="kb-body">${tbTable('貸借対照表', d.BS, d)}${tbTable('損益計算書', d.PL, d)}</section>`);
  };

  // ================= 決算書・消費税 =================
  function fsTable(list, { pct, base, from, to }) {
    return `<table class="kb-fs-table"><tbody>${list.map(r => {
      if (r.type === 'section') return `<tr class="kb-section"><td colspan="${pct ? 3 : 2}">${esc(r.label)}</td></tr>`;
      if (r.type === 'group') return `<tr class="kb-group"><td colspan="${pct ? 3 : 2}">【${esc(r.label)}】</td></tr>`;
      const v = r.closing, cls = r.type === 'acct' ? '' : r.type === 'calc' ? 'kb-calc' : r.type === 'grand' ? 'kb-grand' : 'kb-total';
      if (r.type === 'acct' && !v) return '';
      return `<tr class="${cls}"><td class="${r.type === 'acct' ? 'kb-indent' : ''}">${r.type === 'acct' ? `<a href="#kb-ledger?${qs({ account: r.code, from, to })}">${esc(r.label)}</a>` : esc(r.label)}</td><td class="num">${money(v)}</td>${pct ? `<td class="num small muted">${base ? (v / base * 100).toFixed(1) + '%' : ''}</td>` : ''}</tr>`;
    }).join('')}</tbody></table>`;
  }
  VIEWS['kb-fs'] = async q => {
    const A = acts(); await kb();
    const tab = ['bs', 'pl', 'tax'].includes(q.tab) ? q.tab : 'bs';
    A.tab = d => go('kb-fs', { ...route().q, tab: d.tab });
    if (tab === 'tax') {
      const p = periodOf(q), d = await api('/api/kb/tax?' + qs(p));
      A.print = () => doPrint('消費税集計表', `${d.from} 〜 ${d.to}`, $('#kb-body').innerHTML);
      const body = table([{ label: '処税率', value: r => r.display }, { label: '名称', value: r => r.name }, { label: '税率', value: r => (r.rate ? r.rate + '%' : '') }, { label: '税込金額', num: 1, html: r => money(r.gross) }, { label: '税抜金額', num: 1, html: r => money(r.net) }, { label: '消費税額', num: 1, html: r => money(r.tax) }, { label: '件数', num: 1, value: r => r.count }],
        d.rows, { empty: '期間内の仕訳がありません' });
      return page('決算書・消費税', '消費税集計表：税区分ごとの税込・税抜・税額。外税（仮受・仮払消費税を別行計上）の伝票は税額を課税行へ按分しています。',
        `${periodBar(q)}${xlsxLink('tax', p)}${printBtn}`,
        `${tabs(tab, [['bs', '貸借対照表'], ['pl', '損益計算書'], ['tax', '消費税集計表']])}<section class="card glass" id="kb-body">${body}
        <div class="kb-taxsum"><div class="sum-line"><span>売上に係る消費税額</span><b>${yen(d.salesTax)}</b></div><div class="sum-line"><span>仕入に係る消費税額</span><b>${yen(d.purchaseTax)}</b></div><div class="sum-line"><span>差引税額（概算）</span><b>${money(d.payable)}</b></div>
          <div class="sum-line small muted"><span>参考：仮受消費税（4415）期間計上額 ／ 仮払消費税（1465）期間計上額</span><span>${yen(d.received)} ／ ${yen(d.paid)}</span></div></div>
        <p class="small muted">概算です。簡易課税・控除対象外仕入税額・端数調整は考慮していません。</p></section>`);
    }
    const to = q.to || monthEnd(thisMonth()), r = fyRange(fyOf(to)), fq = { from: r.from, to };
    const d = await api('/api/kb/fs?' + qs(fq));
    A.print = () => doPrint(tab === 'bs' ? '貸借対照表' : '損益計算書', `${d.fyLabel} ${tab === 'bs' ? d.to + ' 現在' : d.from + ' 〜 ' + d.to}`, $('#kb-body').innerHTML);
    let body;
    if (tab === 'bs') {
      const sec = s => { const i = d.BS.findIndex(x => x.type === 'section' && x.label === s); const j = d.BS.findIndex((x, k) => k > i && x.type === 'grand'); return d.BS.slice(i, j + 1); };
      const assets = sec('資産の部'), right = [...sec('負債の部'), ...sec('純資産の部'), d.BS[d.BS.length - 1]];
      body = `<div class="kb-fs-head">${esc(d.to)} 現在 ／ ${esc(d.fyLabel)}</div><div class="kb-fs-two"><div>${fsTable(assets, { ...d })}</div><div>${fsTable(right, { ...d })}</div></div>
        <p class="${d.check.bsBalanced ? 'check-ok' : 'check-ng'} small">${d.check.bsBalanced ? '✓ 資産合計と負債・純資産合計が一致しています' : `✕ 資産合計 ${yen(d.check.assets)} と負債・純資産合計 ${yen(d.check.liabEq)} が一致しません（期首残高を確認してください）`}</p>`;
    } else {
      const sales = d.PL.find(x => x.type === 'total' && x.code === 'P1')?.closing || 0;
      body = `<div class="kb-fs-head">${esc(d.from)} 〜 ${esc(d.to)} ／ ${esc(d.fyLabel)}</div><div class="kb-fs-one">${fsTable(d.PL.filter(x => x.type !== 'group' || true), { ...d, pct: 1, base: sales })}</div>`;
    }
    return page('決算書・消費税', '貸借対照表は基準日現在の残高、損益計算書は期首から基準日までの累計です（勘定科目の区分に従い集計）。',
      `<label class="kb-inline">基準日<input type="date" name="to" value="${esc(to)}" data-filter></label>${xlsxLink('fs', fq)}${printBtn}`,
      `${tabs(tab, [['bs', '貸借対照表'], ['pl', '損益計算書'], ['tax', '消費税集計表']])}<section class="card glass kb-fs" id="kb-body">${body}</section>`);
  };

  // ================= 仕訳受入・書出 =================
  const importSample = d => d.sample?.length ? `<details><summary>受入イメージ（先頭 ${d.sample.length} 伝票）</summary>${journalTable({ slips: d.sample.map((s, i) => ({ id: 0, no: '—', date: s.date, memo: s.memo, source: 'SEIKYU', sourceName: '請求', version: 0,
    rows: s.rows.map(r => ({ dr: r.dr && { ...r.dr, sub: '', taxName: TAX(r.dr.tax)?.name, taxExcl: false }, cr: r.cr && { ...r.cr, sub: '', taxName: TAX(r.cr.tax)?.name, taxExcl: false }, memo: r.memo })), total: s.rows.reduce((n, r) => n + (r.dr?.amount || 0), 0) })), total: d.amount, truncated: false }, { edit: false })}</details>` : '';
  const summaryHtml = d => `<div class="kb-sum"><span>対象 <b>${d.slips}</b> 伝票</span><span>金額 <b>${yen(d.amount)}</b> 円</span>${d.candidates !== undefined ? `<span class="muted">未受入の仕訳 ${d.candidates} 件</span>` : ''}</div>
    ${d.patterns?.length ? `<p class="small">${d.patterns.map(x => badge(`${x.code} ${x.name} ${x.n}件`)).join(' ')}</p>` : ''}${d.errors?.length ? `<div class="note warn"><b>受入できない行（${d.errors.length}件）</b><br>${d.errors.slice(0, 20).map(esc).join('<br>')}</div>` : ''}`;
  VIEWS['kb-import'] = async q => {
    const A = acts(); await kb();
    const imports = await api('/api/kb/imports'), p = periodOf(q);
    const seikyuArgs = () => ({ from: $('#ki-from').value, to: $('#ki-to').value });
    A.preview = async () => { try { const d = await post('/api/kb/import/seikyu', { ...seikyuArgs(), dry: true }); $('#ki-result').innerHTML = summaryHtml(d) + importSample(d) + (d.slips && !d.errors.length && canWrite() ? '<div class="filters right"><button class="primary" data-act="run">この内容で受け入れる</button></div>' : ''); } catch (e) { toast(e.message, true); } };
    A.run = async (_, b) => { b.disabled = true; try { const d = await post('/api/kb/import/seikyu', seikyuArgs()); toast(`${d.slips} 伝票を受け入れました（受入No ${d.importId}）`); render(); } catch (e) { toast(e.message, true); b.disabled = false; } };
    const readFile = async () => {
      const f = $('#kc-file').files[0]; if (!f) throw Error('CSVファイルを選択してください');
      const buf = await f.arrayBuffer(); return { name: f.name, csv: new TextDecoder($('#kc-enc').value).decode(buf) };
    };
    A.csvCheck = async () => { try { const d = await post('/api/kb/import/csv', { ...(await readFile()), dry: true }); $('#kc-result').innerHTML = summaryHtml(d) + (d.slips && !d.errors.length && canWrite() ? '<div class="filters right"><button class="primary" data-act="csvRun">取り込む</button></div>' : ''); } catch (e) { toast(e.message, true); } };
    A.csvRun = async (_, b) => { b.disabled = true; try { const d = await post('/api/kb/import/csv', await readFile()); toast(`${d.slips} 伝票を取り込みました（受入No ${d.importId}）`); render(); } catch (e) { toast(e.message, true); b.disabled = false; } };
    A.cancel = d => confirmBox('受入の取消', `受入No ${d.id} で作成した伝票（${d.n}件）をすべて削除します。`, () => post('/api/kb/import/cancel', { id: Number(d.id) }).then(r => { toast(`${r.slips} 伝票を削除しました`); render(); }), '取消する');
    return page('仕訳受入・書出', '請求システムの自動仕訳や、汎用CSV（借貸併記）を伝票として受け入れます。受入は1回ごとに記録され、まとめて取り消せます。', '',
      `<div class="grid2">
      <section class="card glass"><div class="card-head"><h2>請求システムから受入</h2></div>
        <p class="small muted">「仕訳・会計連携」の自動仕訳（売掛金計上・入金・在庫・定時請求・小口現金・支払）を 1仕訳＝1伝票で受け入れます。受入済みの仕訳は対象外です。処税率は変換せずそのまま受け入れます（011 課税売上は仮受消費税行から税額を按分＝外税）。</p>
        <div class="filters"><label class="kb-inline">自<input type="date" id="ki-from" value="${esc(K.fiscal.startDate > p.from ? K.fiscal.startDate : fyRange(fyOf(p.from)).from)}"></label><label class="kb-inline">至<input type="date" id="ki-to" value="${esc(today())}"></label><button data-act="preview">内容を確認</button></div>
        <div id="ki-result"></div></section>
      <section class="card glass"><div class="card-head"><h2>CSV受入（汎用・借貸併記）</h2></div>
        <p class="small muted">見出し行に「伝票日付・伝票番号・借方科目CD・借方金額・貸方科目CD・貸方金額」が必要です（任意：部門・補助CD・税区分・税額・外税・摘要1/2）。請求システムの「会計連携データ（汎用）」と本画面の「仕訳データ書出」をそのまま取り込めます。1行でも誤りがあれば全件取り込みません。</p>
        <div class="filters"><input type="file" id="kc-file" accept=".csv,text/csv" style="max-width:260px"><select id="kc-enc" style="width:auto"><option value="utf-8">UTF-8</option><option value="shift_jis">Shift_JIS</option></select><button data-act="csvCheck">チェック</button></div>
        <div id="kc-result"></div></section>
      <section class="card glass"><div class="card-head"><h2>仕訳データ書出</h2></div>
        <p class="small muted">期間内の伝票を汎用CSV（UTF-8・借貸併記）または仕訳帳 Excel で出力します。</p>
        <div class="filters">${periodBar(q, { presets: false })}<a class="button" href="/api/kb/journal-csv?${qs(p)}" download>⇩ 仕訳CSV</a><a class="button" href="/api/kb/journal-csv?${qs({ ...p, format: 'bugyo' })}" download>⇩ 勘定奉行CSV</a>${xlsxLink('journal', p)}</div></section>
      <section class="card glass"><div class="card-head"><h2>受入履歴</h2></div>
        ${table([{ label: 'No', value: r => r.id }, { label: '区分', value: r => r.sourceName }, { label: '内容', value: r => r.label }, { label: '伝票', num: 1, value: r => `${r.live}/${r.slips}` }, { label: '金額', num: 1, value: r => yen(r.amount) },
          { label: '実行', value: r => `${h.jst(r.at, 16)} ${r.by}` }, { label: '', html: r => r.status === 'ACTIVE' ? (canWrite() ? `<button class="mini danger" data-act="cancel" data-id="${r.id}" data-n="${r.live}">取消</button>` : '') : badge('取消済', 'gray') }], imports, { empty: '受入履歴はありません' })}</section>
      </div>`);
  };

  // ================= 会計設定 =================
  function accountForm(a) {
    const isNew = !a; a = a || { code: '', name: '', grp: 'P3', side: '', sub: '', tax: '090', active: true, sort: '' };
    modal({ title: isNew ? '勘定科目の追加' : `勘定科目の編集（${a.code}）`, submit: '保存', body: `<div class="form-grid">
      <label class="field req"><span>科目コード</span><input name="code" value="${esc(a.code)}" ${isNew ? '' : 'readonly'} maxlength="20"></label>
      <label class="field req"><span>科目名</span><input name="name" value="${esc(a.name)}" maxlength="100"></label>
      <label class="field req"><span>区分（決算書の表示位置）</span><select name="grp">${K.groups.map(g => `<option value="${g.code}" ${g.code === a.grp ? 'selected' : ''}>${esc(g.code + ' ' + g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>正残高（貸借）</span><select name="side"><option value="">区分に従う</option><option value="D" ${a.side === 'D' && !isNew ? 'selected' : ''}>借方</option><option value="C" ${a.side === 'C' && !isNew ? 'selected' : ''}>貸方</option></select><small>評価勘定（期末棚卸高等）も区分の正残高のまま、反対側計上で減算されます</small></label>
      <label class="field"><span>補助区分</span><select name="sub">${Object.entries(K.subKinds).map(([k, v]) => `<option value="${k}" ${k === a.sub ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><small>内訳科目はマスタ管理「内訳科目」で登録</small></label>
      <label class="field"><span>既定処税率</span><select name="tax">${taxOptions(a.tax)}</select></label>
      <label class="field"><span>表示順</span><input name="sort" class="num" value="${esc(a.sort ?? '')}"></label>
      <label class="field"><span>状態</span><span><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> 有効</span></label></div>`,
      onSubmit: async (v, f) => { await post('/api/kb/accounts', { ...v, active: f.active.checked, mode: isNew ? 'create' : 'update' }); await kb(true); await h.loadMasters(); toast('保存しました'); render(); } });
  }
  const openingRow = (r = {}) => `<tr class="kb-op-row"><td><select data-op="account">${accOptions(r.account || '', { filter: a => !a.grp.startsWith('P') })}</select></td><td><select data-op="sub">${subOptions(r.account || '', r.sub || '')}</select></td>
    <td class="small muted" data-op="side">${r.account ? (ACC(r.account)?.side === 'D' ? '借方' : '貸方') : ''}</td><td><input data-op="amount" class="num" value="${r.amount ? esc(r.amount) : ''}" inputmode="numeric"></td><td><button type="button" class="mini quiet" data-oprow="del" aria-label="行を削除">×</button></td></tr>`;
  function openingTotals() {
    const t = $('#kb-op'); if (!t) return;
    let dr = 0, cr = 0;
    for (const r of $$('.kb-op-row', t)) { const a = ACC($('[data-op=account]', r).value), v = num($('[data-op=amount]', r).value); if (!a) continue; if (a.side === 'D') dr += v; else cr += v; }
    $('#op-dr').textContent = yen(dr); $('#op-cr').textContent = yen(cr); const d = $('#op-diff'); d.textContent = yen(dr - cr); d.className = dr === cr ? 'check-ok' : 'check-ng';
  }
  document.addEventListener('change', e => {
    const r = e.target.closest('#kb-op .kb-op-row'); if (!r) return;
    if (e.target.dataset.op === 'account') { $('[data-op=sub]', r).innerHTML = subOptions(e.target.value, ''); $('[data-op=side]', r).textContent = ACC(e.target.value) ? (ACC(e.target.value).side === 'D' ? '借方' : '貸方') : ''; }
    openingTotals();
  });
  document.addEventListener('input', e => { if (e.target.closest('#kb-op')) openingTotals(); });
  document.addEventListener('click', e => {
    const b = e.target.closest('#kb-op [data-oprow], [data-oprow=add]'); if (!b) return; e.preventDefault();
    if (b.dataset.oprow === 'del') b.closest('tr').remove(); else $('#kb-op tbody').insertAdjacentHTML('beforeend', openingRow());
    openingTotals();
  });
  VIEWS['kb-setup'] = async q => {
    const A = acts(); await kb(true);
    const tab = ['accounts', 'opening', 'period', 'tax', 'bugyo'].includes(q.tab) ? q.tab : 'accounts';
    A.tab = d => go('kb-setup', { tab: d.tab });
    let body = '', actions = '';
    if (tab === 'accounts') {
      A.newAcc = () => accountForm(); A.editAcc = d => accountForm(ACC(d.code));
      actions = canWrite() ? '<button class="primary" data-act="newAcc">＋ 科目追加</button>' : '';
      body = K.groups.map(g => { const list = K.accounts.filter(a => a.grp === g.code); return `<h3 class="kb-h3">${esc(g.code)} ${esc(g.name)} <span class="muted small">（${esc(K.sections[g.section])}・正残高 ${g.side === 'D' ? '借方' : '貸方'}）</span></h3>` +
        table([{ label: 'コード', value: a => a.code }, { label: '科目名', value: a => a.name }, { label: '貸借', value: a => (a.side === 'D' ? '借方' : '貸方') }, { label: '補助', value: a => K.subKinds[a.sub] }, { label: '既定処税率', value: a => `${a.tax} ${TAX(a.tax)?.name || ''}` },
          { label: '状態', html: a => (a.active ? badge('有効', 'green') : badge('無効', 'gray')) + (a.guessed ? ' ' + badge('区分推定', 'amber') : '') }, { label: '', html: a => canWrite() ? `<button class="mini" data-act="editAcc" data-code="${esc(a.code)}">編集</button>` : '' }], list, { empty: '科目なし' }); }).join('');
      body = `<p class="small muted">科目コード・名称は請求システムの勘定科目マスタと共通です。初期値は顧客の「勘定科目マスター一覧」（2026-06-26）から転記しています。</p>${body}`;
    } else if (tab === 'opening') {
      const d = await api('/api/kb/opening');
      A.saveOpening = async (_, b) => {
        b.disabled = true;
        try { const rowsIn = $$('#kb-op .kb-op-row').map(r => ({ account: $('[data-op=account]', r).value, sub: $('[data-op=sub]', r).value, amount: String(num($('[data-op=amount]', r).value)) })); const r = await post('/api/kb/opening', { rows: rowsIn }); toast(`期首残高を保存しました${r.diff ? `（貸借差額 ${yen(r.diff)}）` : ''}`); render(); }
        catch (e) { toast(e.message, true); } finally { b.disabled = false; }
      };
      body = `<p class="small muted">導入期首 <b>${esc(d.startDate)}</b> 時点の貸借科目の残高を、科目の正残高側でプラス入力します（補助ごとに分けて入力可）。2年度目以降の繰越は自動計算します（損益は前期繰越利益 7350 へ）。</p>
        <div class="table-wrap"><table id="kb-op"><thead><tr><th>勘定科目</th><th>補助</th><th>正残高</th><th class="num">金額</th><th></th></tr></thead><tbody>${(d.rows.length ? d.rows : [{}, {}, {}]).map(openingRow).join('')}</tbody></table></div>
        <div class="kb-foot"><div class="filters"><button type="button" data-oprow="add">＋ 行追加</button></div><div class="kb-totals"><span>借方 <b id="op-dr">${yen(d.dr)}</b></span><span>貸方 <b id="op-cr">${yen(d.cr)}</b></span><span>差額 <b id="op-diff" class="${d.diff ? 'check-ng' : 'check-ok'}">${yen(d.diff)}</b></span></div></div>
        ${canWrite() ? '<div class="filters right"><button class="primary" data-act="saveOpening">期首残高を保存</button></div>' : ''}`;
    } else if (tab === 'period') {
      A.saveSettings = async (_, b) => { b.disabled = true; try { await post('/api/kb/settings', { startFy: $('#ks-fy').value, lockDate: $('#ks-lock').value }); await kb(true); toast('保存しました'); render(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; } };
      const years = []; for (let y = K.fiscal.currentFy - 5; y <= K.fiscal.currentFy + 1; y++) years.push(y);
      body = `<div class="form-grid" style="max-width:720px">
        <label class="field"><span>決算月・月度</span><input value="${K.fiscal.closingMonth}月決算・${K.fiscal.closingDay >= 31 ? '暦月（末締）' : `月度 ${K.fiscal.closingDay + 1}日〜${K.fiscal.closingDay}日`}" readonly><small>マスタ管理「自社情報」の決算月・月度締日に従います</small></label>
        <label class="field"><span>導入年度（期首残高の基準）</span><select id="ks-fy" ${isAdmin() ? '' : 'disabled'}>${years.map(y => `<option value="${y}" ${y === K.fiscal.startFy ? 'selected' : ''}>${y}年度（${fyRange(y).from}〜）</option>`).join('')}</select><small>導入期首より前の日付の伝票は入力できません</small></label>
        <label class="field"><span>入力制限日</span><input type="date" id="ks-lock" value="${esc(K.fiscal.lockDate)}" ${isAdmin() ? '' : 'disabled'}><small>この日以前の伝票は登録・修正・削除・受入できません（月次締め）。空欄で制限なし</small></label></div>
        ${isAdmin() ? '<div class="filters"><button class="primary" data-act="saveSettings">保存</button></div>' : '<p class="muted small">変更は管理者のみです。</p>'}`;
    } else if (tab === 'bugyo') {
      const b = await api('/api/kb/bugyo');
      A.saveBugyo = async (_, btn) => {
        btn.disabled = true;
        try {
          const symbols = Object.fromEntries($$('[data-sym]').map(el => [el.dataset.sym, el.value])), taxMap = Object.fromEntries($$('[data-otax]').map(el => [el.dataset.otax, el.value]));
          await post('/api/kb/bugyo', { symbols, taxMap, encoding: $('#ob-enc').value }); toast('保存しました'); render();
        } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
      };
      const dis = isAdmin() ? '' : 'disabled';
      body = `<p class="small muted">QA回答（オービック 2026-10-08）：勘定奉行（奉行クラウド, Azure）の受入は CSV／Excel。見出しに「OBC受入記号」を付ければ列順は自由、または奉行側でマッピング。受入記号と税区分コードは「データ受入形式一覧表」（OBC サポートサイト）で確定してから登録してください。未登録の項目は項目名、税区分は処税率のまま出力します。</p>
        <div class="grid2"><div>${table([{ label: '項目', value: r => r[1] }, { label: 'OBC受入記号', html: r => `<input data-sym="${r[0]}" value="${esc(b.symbols[r[0]] || '')}" maxlength="40" ${dis} placeholder="（未登録）">` }], b.items)}</div>
        <div>${table([{ label: '処税率', value: t => `${t.code} ${t.name}` }, { label: '奉行の税区分コード', html: t => `<input data-otax="${t.code}" value="${esc(b.taxMap[t.code] || '')}" maxlength="20" ${dis} placeholder="（処税率のまま）">` }], K.taxes)}
        <label class="field" style="margin-top:10px"><span>文字コード</span><select id="ob-enc" ${dis}><option value="shift_jis" ${b.encoding !== 'utf-8' ? 'selected' : ''}>Shift_JIS</option><option value="utf-8" ${b.encoding === 'utf-8' ? 'selected' : ''}>UTF-8（BOM付）</option></select></label></div></div>
        ${isAdmin() ? '<div class="filters right"><button class="primary" data-act="saveBugyo">保存</button></div>' : '<p class="muted small">変更は管理者のみです。</p>'}
        <p class="small muted">出力：「会計・管理 → 仕訳・会計連携 → 会計連携データ」の［勘定奉行 受入CSV］（請求システムの自動仕訳）、または「仕訳受入・書出」の［勘定奉行CSV］（本会計モジュールの伝票）。</p>`;
    } else {
      const digits = (title, obj, fmt) => `<h3 class="kb-h3">${esc(title)}</h3>` + table([{ label: 'コード', value: r => r[0] }, { label: '意味', value: r => fmt(r[1]) }], Object.entries(obj));
      body = `<p class="small muted">税区分は現行システムの処税率（3桁）をそのまま使います（顧客資料「消費税区分.xlsx」）。1桁目＝税込区分、2桁目＝税区分、3桁目＝税率区分。保存は空白を 0 にした3桁（例「 41」→ 041、「 9 」→ 090）。</p>` +
        table([{ label: '処税率', value: t => t.code }, { label: '現行表記', value: t => t.display }, { label: '内容', value: t => t.name }, { label: '消費税', value: t => (t.taxable ? (t.excl ? '外税（金額×税率）' : '内税（税込金額から計算）') : 'なし') }], K.taxes) +
        digits('1桁目（税込区分）', { 0: '空白＝外税（2 と同じ意味・10/21 打合せ）', 1: '税込み（内税）', 2: '外税（10/21 打合せ）' }, v => v) +
        digits('2桁目（税区分）', K.taxKinds, v => v) + digits('3桁目（税率区分）', K.taxRates, v => (v ? v + '%' : '0%（空白）'));
    }
    return page('会計設定', '勘定科目（区分・補助・既定処税率）、期首残高、会計期間・入力制限、処税率の一覧です。', actions,
      `${tabs(tab, [['accounts', '勘定科目'], ['opening', '期首残高'], ['period', '会計期間・入力制限'], ['tax', '処税率'], ['bugyo', '勘定奉行連携']])}<section class="card glass">${body}</section>`);
  };
}
