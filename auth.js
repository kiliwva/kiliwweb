/* Auth page logic: Cloudflare Turnstile + form validation. */

/**
 * Cloudflare Turnstile site key.
 * This is Cloudflare's test key ("always passes") — it works on any
 * domain including localhost. For production, create a widget in the
 * Cloudflare dashboard (Turnstile → Add site) and put your site key here.
 */
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

/** Server-side token verification endpoint (see functions/api/verify.js). */
const VERIFY_ENDPOINT = '/api/verify';

const tabsBar = document.querySelector('.tabs');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const successPanel = document.getElementById('success-panel');
const successText = document.getElementById('success-text');

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
  successPanel.hidden = true;
}

tabLogin.addEventListener('click', () => switchTo('login'));
tabRegister.addEventListener('click', () => switchTo('register'));

/* ---------- Validation ---------- */

const MESSAGES = {
  name: 'Enter your name.',
  emailMissing: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  passwordMissing: 'Enter your password.',
  passwordShort: 'Password must be at least 8 characters.',
};

function fieldMessage(input) {
  const isEmail = input.type === 'email';
  const isPassword = input.type === 'password';
  if (input.validity.valueMissing) {
    if (isEmail) return MESSAGES.emailMissing;
    if (isPassword) return MESSAGES.passwordMissing;
    return MESSAGES.name;
  }
  if (input.validity.typeMismatch) return MESSAGES.emailInvalid;
  if (input.validity.tooShort) return MESSAGES.passwordShort;
  return '';
}

function validateForm(form) {
  const errorEl = form.querySelector('[data-error]');
  let firstMessage = '';
  form.querySelectorAll('.field input').forEach((input) => {
    const message = fieldMessage(input);
    if (message && !firstMessage) firstMessage = message;
  });
  errorEl.textContent = firstMessage;
  errorEl.classList.toggle('visible', Boolean(firstMessage));
  return !firstMessage;
}

document.querySelectorAll('.form input').forEach((input) => {
  input.addEventListener('input', () => {
    const form = input.closest('form');
    const errorEl = form.querySelector('[data-error]');
    if (errorEl.classList.contains('visible')) validateForm(form);
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
    /* Server-side Turnstile verification. If the backend is not
       deployed yet (page opened locally), fall back to demo mode. */
    let ok = true;
    try {
      const res = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, kind }),
      });
      if (res.ok) {
        const data = await res.json();
        ok = data.success === true;
      }
    } catch {
      /* endpoint unavailable — demo mode */
    }

    if (ok) {
      showSuccess(kind);
      form.reset();
    } else {
      const errorEl = form.querySelector('[data-error]');
      errorEl.textContent = 'Captcha verification failed. Please try again.';
      errorEl.classList.add('visible');
    }
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

/* ---------- Success ---------- */

function showSuccess(kind) {
  formLogin.classList.remove('active');
  formRegister.classList.remove('active');
  formLogin.hidden = true;
  formRegister.hidden = true;
  successText.textContent = kind === 'login'
    ? 'You are signed in.'
    : 'Your account is ready. Welcome!';
  successPanel.hidden = false;
}

document.getElementById('success-back').addEventListener('click', () => {
  successPanel.hidden = true;
  switchTo('login');
});
