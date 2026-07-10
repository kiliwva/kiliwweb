/* Auth page logic: Cloudflare Turnstile + real sign-in / sign-up. */

/**
 * Cloudflare Turnstile site key.
 * This is Cloudflare's test key ("always passes") — it works on any
 * domain including localhost. For production, create a widget in the
 * Cloudflare dashboard (Turnstile → Add site) and put your site key here.
 */
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

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
      theme: 'light',
      callback: () => setSubmitEnabled(form, true),
      'expired-callback': () => setSubmitEnabled(form, false),
      'error-callback': () => setSubmitEnabled(form, false),
    });
    widgets.set(form, widgetId);
  });
};

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

const MESSAGES = {
  emailMissing: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  passwordMissing: 'Enter your password.',
  passwordShort: 'Password must be at least 8 characters.',
};

const API_ERRORS = {
  'invalid-credentials': 'Incorrect email or password.',
  'user-exists': 'An account with this email already exists. Try signing in.',
  'invalid-email': 'Enter a valid email address.',
  'invalid-password': 'Password must be at least 8 characters.',
  captcha: 'Captcha verification failed. Please try again.',
  'not-configured': 'Server storage is not configured yet. Contact the site owner.',
};

function fieldMessage(input) {
  if (input.validity.valueMissing) {
    return input.type === 'email' ? MESSAGES.emailMissing : MESSAGES.passwordMissing;
  }
  if (input.validity.typeMismatch) return MESSAGES.emailInvalid;
  if (input.validity.tooShort) return MESSAGES.passwordShort;
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
    const res = await fetch(kind === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.querySelector('input[type="email"]').value.trim(),
        password: form.querySelector('input[type="password"]').value,
        token,
      }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data && data.success) {
      window.location.href = data.redirect || '/';
      return;
    }
    if (!data) {
      /* HTML instead of JSON: the Pages Functions are not deployed */
      showFormError(form,
        'Server API is unavailable: Pages Functions are not deployed. '
        + 'Deploy with git integration or "wrangler pages deploy" (see README).');
      return;
    }
    showFormError(form, API_ERRORS[data.error] || 'Something went wrong. Please try again.');
  } catch {
    showFormError(form, 'Network error. Check your connection and try again.');
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
