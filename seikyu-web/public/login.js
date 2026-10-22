// ブラウザの必須入力メッセージを日本語にする（ブラウザが韓国語等でも日本語で表示）
document.addEventListener('invalid', e => { const el = e.target, l = el.closest('label')?.childNodes[0]?.textContent.trim() || ''; el.setCustomValidity(el.validity.valueMissing ? `${l || 'この項目'}を入力してください` : '入力内容を確認してください'); }, true);
document.addEventListener('input', e => e.target.setCustomValidity?.(''), true);
document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button'), error = document.querySelector('#login-error');
  button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: form.elements.loginId.value.trim(), password: form.elements.password.value }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'ログインできませんでした');
    location.replace('/' + location.hash);
  } catch (e) {
    error.textContent = e.message; form.elements.password.value = ''; form.elements.password.focus();
  } finally { button.disabled = false; }
});
