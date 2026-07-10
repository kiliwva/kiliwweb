/* Auth page logic: Cloudflare Turnstile + real sign-in / sign-up. */

/** Cloudflare Turnstile site key (public by design). */
const TURNSTILE_SITE_KEY = '0x4AAAAAADzEB5uAu6K8lY2o';

const tabsBar = document.querySelector('.tabs');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

/* Turnstile widget id per form */
const widgets = new Map();

/* ---------- Turnstile ---------- */

window.onTurnstileLoad = function () {
  document.querySelectorAll('[data-turnstile]').forEach((slot) => {
    const form = slot.closest('form');
    const widgetId = turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: KiliwUI.theme,
      language: KiliwUI.lang,
      callback: () => setSubmitEnabled(form, true),
      'expired-callback': () => setSubmitEnabled(form, false),
      'error-callback': () => setSubmitEnabled(form, false),
    });
    widgets.set(form, widgetId);
  });
};

/* re-render the widgets when theme or language changes */
function rerenderTurnstile() {
  if (!window.turnstile) return;
  widgets.forEach((id, form) => {
    turnstile.remove(id);
    setSubmitEnabled(form, false);
  });
  widgets.clear();
  window.onTurnstileLoad();
}
KiliwUI.onTheme(rerenderTurnstile);
KiliwUI.onLang(rerenderTurnstile);

function setSubmitEnabled(form, enabled) {
  form.querySelector('.submit').disabled = !enabled;
}

function resetTurnstile(form) {
  const id = widgets.get(form);
  if (id !== undefined && window.turnstile) {
    turnstile.reset(id);
    setSubmitEnabled(form, false);
  }
}

/* ---------- Tabs ---------- */

function switchTo(name) {
  const isLogin = name === 'login';
  tabsBar.classList.toggle('register', !isLogin);
  tabLogin.classList.toggle('active', isLogin);
  tabRegister.classList.toggle('active', !isLogin);
  tabLogin.setAttribute('aria-selected', String(isLogin));
  tabRegister.setAttribute('aria-selected', String(!isLogin));

  formLogin.classList.toggle('active', isLogin);
  formRegister.classList.toggle('active', !isLogin);
  formLogin.hidden = !isLogin;
  formRegister.hidden = isLogin;
}

tabLogin.addEventListener('click', () => switchTo('login'));
tabRegister.addEventListener('click', () => switchTo('register'));

/* ---------- Validation ---------- */

const API_ERROR_KEYS = [
  'invalid-credentials', 'user-exists', 'invalid-email', 'invalid-password',
  'totp-invalid', 'captcha', 'not-configured',
];

function fieldMessage(input) {
  if (input.validity.valueMissing) {
    return KiliwUI.t(input.type === 'email' ? 'err.emailMissing' : 'err.passwordMissing');
  }
  if (input.validity.typeMismatch) return KiliwUI.t('err.emailInvalid');
  if (input.validity.tooShort) return KiliwUI.t('err.passwordShort');
  return '';
}

function showFormError(form, message) {
  const errorEl = form.querySelector('[data-error]');
  errorEl.textContent = message;
  errorEl.classList.toggle('visible', Boolean(message));
}

function validateForm(form) {
  let firstMessage = '';
  form.querySelectorAll('.field input').forEach((input) => {
    const message = fieldMessage(input);
    if (message && !firstMessage) firstMessage = message;
  });
  showFormError(form, firstMessage);
  return !firstMessage;
}

document.querySelectorAll('.form input').forEach((input) => {
  input.addEventListener('input', () => {
    const form = input.closest('form');
    if (form.querySelector('[data-error]').classList.contains('visible')) {
      validateForm(form);
    }
  });
});

/* ---------- Submit ---------- */

async function handleSubmit(form, kind) {
  if (!validateForm(form)) return;

  const token = window.turnstile ? turnstile.getResponse(widgets.get(form)) : '';
  if (!token) {
    setSubmitEnabled(form, false);
    return;
  }

  const submitBtn = form.querySelector('.submit');
  submitBtn.classList.add('loading');

  try {
    const payload = {
      email: form.querySelector('input[type="email"]').value.trim(),
      password: form.querySelector('input[type="password"]').value,
      token,
    };
    const totpInput = form.querySelector('#login-totp');
    if (totpInput && totpInput.value.trim()) payload.code = totpInput.value.trim();

    const res = await fetch(kind === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data && data.success) {
      window.location.href = data.redirect || '/';
      return;
    }
    if (!data) {
      /* HTML instead of JSON: the server code is not deployed */
      showFormError(form, KiliwUI.t('auth.serverDown'));
      return;
    }
    if (data.error === 'totp-required') {
      /* account has 2FA: reveal the code field and ask for it */
      document.getElementById('login-totp-group').hidden = false;
      showFormError(form, KiliwUI.t('auth.totpPrompt'));
      if (totpInput) totpInput.focus();
      return;
    }
    let message = API_ERROR_KEYS.includes(data.error)
      ? KiliwUI.t(`api.${data.error}`)
      : KiliwUI.t('auth.generic');
    if (data.error === 'captcha' && Array.isArray(data.detail) && data.detail.length) {
      message += ` [${data.detail.join(', ')}]`;
    }
    showFormError(form, message);
  } catch {
    showFormError(form, KiliwUI.t('auth.network'));
  } finally {
    submitBtn.classList.remove('loading');
    resetTurnstile(form);
  }
}

formLogin.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(formLogin, 'login');
});
formRegister.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(formRegister, 'register');
});
