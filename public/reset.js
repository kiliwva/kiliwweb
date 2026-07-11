/* Password reset page: email → 6-digit code → new password. */

const TURNSTILE_SITE_KEY = '0x4AAAAAADzEB5uAu6K8lY2o';

const formRequest = document.getElementById('form-request');
const formConfirm = document.getElementById('form-confirm');
let resetEmail = '';
let widgetId = null;

window.onTurnstileLoad = function () {
  const slot = formRequest.querySelector('[data-turnstile]');
  widgetId = turnstile.render(slot, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'dark',
    language: 'en',
    callback: () => { formRequest.querySelector('.submit').disabled = false; },
    'expired-callback': () => { formRequest.querySelector('.submit').disabled = true; },
    'error-callback': () => { formRequest.querySelector('.submit').disabled = true; },
  });
};

function showError(form, message) {
  const el = form.querySelector('[data-error]');
  el.textContent = message;
  el.classList.toggle('visible', Boolean(message));
}

const ERROR_KEYS = ['captcha', 'not-configured', 'code-invalid', 'code-expired', 'too-many', 'invalid-password'];

formRequest.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('reset-email').value.trim();
  if (!email || !email.includes('@')) {
    showError(formRequest, KiliwUI.t('err.emailInvalid'));
    return;
  }
  const token = window.turnstile && widgetId !== null ? turnstile.getResponse(widgetId) : '';
  if (!token) return;

  const btn = formRequest.querySelector('.submit');
  btn.classList.add('loading');
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', email, token }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      resetEmail = email;
      formRequest.hidden = true;
      formRequest.classList.remove('active');
      formConfirm.hidden = false;
      formConfirm.classList.add('active');
      document.getElementById('reset-sub').textContent = KiliwUI.t('reset.codeSub', { email });
      KiliwUI.otpClear('reset-otp');
      KiliwUI.otpFocus('reset-otp');
    } else if (data.error === 'mail-not-configured') {
      showError(formRequest, KiliwUI.t('reset.noMail'));
    } else {
      showError(formRequest, KiliwUI.t(ERROR_KEYS.includes(data.error) ? `api.${data.error}` : 'auth.generic'));
    }
  } catch {
    showError(formRequest, KiliwUI.t('auth.network'));
  } finally {
    btn.classList.remove('loading');
    if (window.turnstile && widgetId !== null) {
      turnstile.reset(widgetId);
      formRequest.querySelector('.submit').disabled = true;
    }
  }
});

formConfirm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('reset-code').value.trim();
  const password = document.getElementById('reset-password').value;
  if (!/^\d{6}$/.test(code)) {
    showError(formConfirm, KiliwUI.t('api.code-invalid'));
    return;
  }
  if (password.length < 8) {
    showError(formConfirm, KiliwUI.t('err.passwordShort'));
    return;
  }
  const btn = formConfirm.querySelector('.submit');
  btn.classList.add('loading');
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', email: resetEmail, code, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (data.restored) alert(KiliwUI.t('auth.restored'));
      window.location.href = data.redirect || '/dash';
      return;
    }
    showError(formConfirm, KiliwUI.t(ERROR_KEYS.includes(data.error) ? `api.${data.error}` : 'auth.generic'));
  } catch {
    showError(formConfirm, KiliwUI.t('auth.network'));
  } finally {
    btn.classList.remove('loading');
  }
});

document.getElementById('reset-again').addEventListener('click', (e) => {
  e.preventDefault();
  formConfirm.hidden = true;
  formConfirm.classList.remove('active');
  formRequest.hidden = false;
  formRequest.classList.add('active');
});
