// 文字の大きさ（要件 11-1・共通要件 9・D-075「画面全体の文字を大きくし、入力ミスを防ぐ」。2026-11-21）
// 画面全体を 標準 1.0／大 1.15／特大 1.3 倍で表示する。初期値は「大」。選んだ大きさはブラウザ（localStorage）に保存する
(() => {
  const SIZES = { m: '標準', l: '大', xl: '特大' }, KEY = 'fontSize';
  const get = () => { try { const v = localStorage.getItem(KEY); return SIZES[v] ? v : 'l'; } catch { return 'l'; } };
  const apply = v => { const h = document.documentElement; h.classList.remove('fs-m', 'fs-l', 'fs-xl'); h.classList.add('fs-' + v); document.querySelectorAll('[data-fs]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fs === v))); };
  apply(get());
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('font-size'); if (!box) return;
    box.innerHTML = '<span>文字</span>' + Object.entries(SIZES).map(([k, l]) => `<button type="button" class="mini" data-fs="${k}" title="文字の大きさ：${l}">${l}</button>`).join('');
    box.addEventListener('click', e => { const b = e.target.closest('[data-fs]'); if (!b) return; try { localStorage.setItem(KEY, b.dataset.fs); } catch {} apply(b.dataset.fs); });
    apply(get());
  });
})();
