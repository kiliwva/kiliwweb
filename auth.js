/* Synestix — auth page logic: Cloudflare Turnstile + form validation. */

/**
 * Cloudflare Turnstile site key.
 * This is Cloudflare's test key ("always passes") — it works on any
 * domain including localhost. For production, create a widget in the
 * Cloudflare dashboard (Turnstile → Add site) and put your site key here.
 */
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

/** Server-side token verification endpoint (see functions/api/verify.js). */
const VERIFY_ENDPOINT = '/api/verify';

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
  const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.querySelectorAll('[data-turnstile]').forEach((slot) => {
    const form = slot.closest('form');
    const widgetId = turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      theme,
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
  valueMissing: 'This field is required',
  typeMismatch: 'Enter a valid email address',
  tooShort: 'At least 8 characters',
};

function validateField(input) {
  const field = input.closest('.field');
  const errorEl = field.querySelector('.field-error');
  let message = '';
  if (input.validity.valueMissing) message = MESSAGES.valueMissing;
  else if (input.validity.typeMismatch) message = MESSAGES.typeMismatch;
  else if (input.validity.tooShort) message = MESSAGES.tooShort;

  field.classList.toggle('invalid', Boolean(message));
  errorEl.textContent = message;
  return !message;
}

document.querySelectorAll('.form input').forEach((input) => {
  input.addEventListener('input', () => {
    if (input.closest('.field').classList.contains('invalid')) validateField(input);
  });
});

/* ---------- Submit ---------- */

async function handleSubmit(form, kind) {
  let valid = true;
  form.querySelectorAll('.field input').forEach((input) => {
    if (!validateField(input)) valid = false;
  });
  if (!valid) return;

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
      alert('Captcha verification failed. Please try again.');
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
    : 'Account created. Welcome!';
  successPanel.hidden = false;
}

document.getElementById('success-back').addEventListener('click', () => {
  successPanel.hidden = true;
  switchTo('login');
});
