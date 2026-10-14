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
