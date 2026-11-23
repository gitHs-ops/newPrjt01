// 日付・月・時刻の入力を日本語カレンダー（flatpickr ja）に置き換える（2026-10-22）。
// ブラウザ標準の date / month / time 入力は OS・ブラウザの言語で表示され、韓国語環境では「연도-월-일」等になるため。
// 値の形式は標準入力と同じ（YYYY-MM-DD / YYYY-MM / HH:MM）なので、画面・サーバの処理は変えない。
// 画面の描画やダイアログで追加される入力も MutationObserver で置き換え、削除された入力のカレンダーは破棄する。
// あわせて、ファイル選択を「ファイルを選択」ボタンに、ブラウザの必須入力メッセージを日本語にする。
(() => {
  const fp = window.flatpickr;
  if (fp) {
    fp.localize(fp.l10ns.ja);
    const pad = n => String(n).padStart(2, '0');
    // 手入力：2026-10-22 / 2026/10/22 / 20261022 / 2026年10月22日、2026-10 / 2026年10月、15:30 / 1530
    const parsers = {
      date: s => { const t = String(s).trim(), m = t.match(/^(\d{2})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/) || t.match(/^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})日?$/); return m ? new Date(m[1].length === 2 ? 2000 + +m[1] : +m[1], +m[2] - 1, +m[3]) : undefined; },   // 26/10/22・261022 も
      month: s => { const m = String(s).trim().match(/^(\d{4})[-/.年]?(\d{1,2})月?$/); return m ? new Date(+m[1], +m[2] - 1, 1) : undefined; },
      time: s => { const m = String(s).trim().match(/^(\d{1,2}):?(\d{2})$/); if (!m) return undefined; const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); return d; },
    };
    const KINDS = {
      date: { dateFormat: 'Y-m-d', placeholder: '年/月/日' },
      month: { dateFormat: 'Y-m', placeholder: '年/月', plugins: () => (window.monthSelectPlugin ? [new window.monthSelectPlugin({ shorthand: false, dateFormat: 'Y-m' })] : []) },
      time: { dateFormat: 'H:i', placeholder: '時:分', enableTime: true, noCalendar: true, time_24hr: true },
    };
    // カレンダーは popover（最上位レイヤー）で表示し、ダイアログの中でも隠れないよう入力の直下（入りきらなければ上）に置く
    const place = self => {
      const cal = self.calendarContainer, r = self._positionElement.getBoundingClientRect();
      const h = cal.offsetHeight, w = cal.offsetWidth, below = window.innerHeight - r.bottom;
      cal.style.top = `${below < h + 8 && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4}px`;
      cal.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    };
    // 日付の入力欄は画面・帳票と同じ yy/mm/dd で表示する（2026-11-23 ユーザー指示）。value は今までどおり YYYY-MM-DD で読み書きでき（画面のコードとサーバは変えない）、
    // 欄に見える文字だけ 26/11/20 にする。フォームの送信（FormData）も YYYY-MM-DD に戻す
    const VAL = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const toShow = v => { const m = String(v ?? '').trim().match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/); return m ? `${m[1]}/${m[2]}/${m[3]}` : v ?? ''; };
    const toIso = v => { const m = String(v).trim().match(/^(\d{2})\/(\d{1,2})\/(\d{1,2})$/); return m ? `20${m[1]}-${pad(m[2])}-${pad(m[3])}` : v; };
    const yyInput = el => { const v = el.value; Object.defineProperty(el, 'value', { configurable: true, get() { return toIso(VAL.get.call(this)); }, set(x) { VAL.set.call(this, toShow(x)); } }); el.value = v; };
    // 年月の入力欄は 2026/11 で表示（2026-11-24 ユーザー指示）。value・送信は今までどおり YYYY-MM
    const ymShow = v => { const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})$/); return m ? `${m[1]}/${m[2]}` : v ?? ''; };
    const ymIso = v => { const m = String(v).trim().match(/^(\d{4})\/(\d{1,2})$/); return m ? `${m[1]}-${pad(m[2])}` : v; };
    const ymInput = el => { const v = el.value; Object.defineProperty(el, 'value', { configurable: true, get() { return ymIso(VAL.get.call(this)); }, set(x) { VAL.set.call(this, ymShow(x)); } }); el.value = v; };
    document.addEventListener('formdata', e => {
      const names = new Set([...e.target.querySelectorAll('input.fp-date[name]')].map(el => el.name)), months = new Set([...e.target.querySelectorAll('input.fp-month[name]')].map(el => el.name));
      names.forEach(n => { const vs = e.formData.getAll(n); e.formData.delete(n); vs.forEach(v => e.formData.append(n, typeof v === 'string' ? toIso(v) : v)); });
      months.forEach(n => { const vs = e.formData.getAll(n); e.formData.delete(n); vs.forEach(v => e.formData.append(n, typeof v === 'string' ? ymIso(v) : v)); });
    }, true);
    const enhance = el => {
      const kind = el.type, k = KINDS[kind];
      if (!k || el.dataset.fp) return;
      el.dataset.fp = kind;
      const min = el.min, max = el.max;
      el.type = 'text'; el.autocomplete = 'off'; el.classList.add('fp-input', `fp-${kind}`);
      if (!el.placeholder) el.placeholder = k.placeholder;
      if (kind === 'date') yyInput(el); else if (kind === 'month') ymInput(el);
      fp(el, {
        dateFormat: k.dateFormat, enableTime: !!k.enableTime, noCalendar: !!k.noCalendar, time_24hr: !!k.time_24hr, plugins: k.plugins ? k.plugins() : [],
        allowInput: true, disableMobile: true, minDate: min || undefined, maxDate: max || undefined,
        parseDate: s => parsers[kind](s),
        appendTo: el.closest('dialog') || document.body, position: place,
        onReady: (_, __, self) => { self.calendarContainer.setAttribute('popover', 'manual'); },
        // 画面側のコードが value を直接書き換えるため、開くたびに入力欄の値から選択日を合わせる
        onOpen: (_, __, self) => {
          if (el.value) self.setDate(el.value, false); else self.clear(false);
          try { self.calendarContainer.showPopover?.(); } catch {}
          place(self);
        },
        onClose: (_, __, self) => { try { self.calendarContainer.hidePopover?.(); } catch {} },
      });
    };
    const SEL = 'input[type=date],input[type=month],input[type=time]';
    const scan = root => { if (root.matches?.(SEL)) enhance(root); root.querySelectorAll?.(SEL).forEach(enhance); };
    const drop = root => { const list = root.matches?.('.fp-input') ? [root] : [...(root.querySelectorAll?.('.fp-input') || [])]; list.forEach(el => { if (!el.isConnected) el._flatpickr?.destroy(); }); };
    new MutationObserver(ms => { for (const m of ms) { m.addedNodes.forEach(n => n.nodeType === 1 && scan(n)); m.removedNodes.forEach(n => n.nodeType === 1 && drop(n)); } })
      .observe(document.documentElement, { childList: true, subtree: true });
    scan(document);
  }

  // ファイル選択：ブラウザ標準の「파일 선택／선택된 파일 없음」を隠し、日本語のボタンとファイル名を表示
  const files = el => {
    if (el.dataset.fpFile) return; el.dataset.fpFile = '1'; el.classList.add('file-native');
    const box = document.createElement('span'); box.className = 'file-pick';
    box.innerHTML = '<button type="button" class="mini">ファイルを選択</button><span class="muted small">選択されていません</span>';
    el.after(box);
    box.querySelector('button').onclick = () => el.click();
    el.addEventListener('change', () => { box.lastChild.textContent = el.files?.length ? [...el.files].map(f => f.name).join('、') : '選択されていません'; });
  };
  const fscan = root => { if (root.matches?.('input[type=file]')) files(root); root.querySelectorAll?.('input[type=file]').forEach(files); };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && fscan(n)))).observe(document.documentElement, { childList: true, subtree: true });
  fscan(document);

  // ブラウザの必須入力メッセージ（「이 입력란을 작성하세요」等）を日本語にする
  const labelOf = el => (el.closest('label')?.querySelector('span')?.textContent || el.closest('label')?.childNodes[0]?.textContent || el.getAttribute('aria-label') || '').replace(/[*＊]/g, '').trim();
  document.addEventListener('invalid', e => { const el = e.target; if (!el.setCustomValidity) return; const l = labelOf(el);
    el.setCustomValidity(el.validity.valueMissing ? (el.type === 'file' ? 'ファイルを選択してください' : l ? `${l}を入力してください` : 'この項目を入力してください') : '入力内容を確認してください'); }, true);
  const reset = e => e.target.setCustomValidity?.('');
  document.addEventListener('input', reset, true); document.addEventListener('change', reset, true);
})();
