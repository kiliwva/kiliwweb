/* Auth page logic: Cloudflare Turnstile + real sign-in / sign-up. */

/** Cloudflare Turnstile site key (public by design). */
const TURNSTILE_SITE_KEY = '0x4AAAAAADzEB5uAu6K8lY2o';

const tabsBar = document.querySelector('.tabs');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const formVerify = document.getElementById('form-verify');

let pendingEmail = '';

/* Turnstile widget id per form */
const widgets = new Map();

/* ---------- Turnstile ---------- */

window.onTurnstileLoad = function () {
  document.querySelectorAll('[data-turnstile]').forEach((slot) => {
    const form = slot.closest('form');
    const widgetId = turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'dark',
      language: 'en',
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

const API_ERROR_KEYS = [
  'invalid-credentials', 'user-exists', 'invalid-email', 'invalid-password',
  'totp-invalid', 'captcha', 'not-configured', 'mail-failed',
  'code-invalid', 'code-expired', 'too-many', 'too-soon', 'no-pending',
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
      if (data.verify) {
        showVerifyStep(payload.email);
        return;
      }
      if (data.restored) {
        /* the pending deletion was cancelled by this sign-in */
        alert(KiliwUI.t('auth.restored'));
      }
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
      KiliwUI.otpClear('login-totp-otp');
      KiliwUI.otpFocus('login-totp-otp');
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


/* ---------- email verification step ---------- */

function showVerifyStep(email) {
  pendingEmail = email;
  tabsBar.hidden = true;
  formLogin.hidden = true;
  formLogin.classList.remove('active');
  formRegister.hidden = true;
  formRegister.classList.remove('active');
  formVerify.hidden = false;
  formVerify.classList.add('active');
  document.getElementById('verify-sub').textContent = KiliwUI.t('verify.sub', { email });
  KiliwUI.otpClear('verify-otp');
  KiliwUI.otpFocus('verify-otp');
}

function hideVerifyStep() {
  formVerify.hidden = true;
  formVerify.classList.remove('active');
  tabsBar.hidden = false;
  switchTo('register');
}

formVerify.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('verify-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    showFormError(formVerify, KiliwUI.t('api.code-invalid'));
    return;
  }
  const submitBtn = formVerify.querySelector('.submit');
  submitBtn.classList.add('loading');
  try {
    const res = await fetch('/api/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      window.location.href = data.redirect || '/';
      return;
    }
    const key = data && API_ERROR_KEYS.includes(data.error) ? `api.${data.error}` : 'auth.generic';
    showFormError(formVerify, KiliwUI.t(key));
    if (data && (data.error === 'no-pending' || data.error === 'too-many' || data.error === 'code-expired')) {
      setTimeout(hideVerifyStep, 2500);
    }
  } catch {
    showFormError(formVerify, KiliwUI.t('auth.network'));
  } finally {
    submitBtn.classList.remove('loading');
  }
});

document.getElementById('verify-resend').addEventListener('click', async (e) => {
  e.preventDefault();
  const link = e.target;
  if (link.dataset.cooldown) return;
  try {
    const res = await fetch('/api/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, resend: true }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      showFormError(formVerify, '');
      document.getElementById('verify-sub').textContent = KiliwUI.t('verify.resent');
      link.dataset.cooldown = '1';
      link.style.opacity = '0.4';
      setTimeout(() => {
        delete link.dataset.cooldown;
        link.style.opacity = '';
      }, 60000);
    } else {
      const key = data && API_ERROR_KEYS.includes(data.error) ? `api.${data.error}` : 'auth.generic';
      showFormError(formVerify, KiliwUI.t(key));
    }
  } catch {
    showFormError(formVerify, KiliwUI.t('auth.network'));
  }
});

document.getElementById('verify-back').addEventListener('click', (e) => {
  e.preventDefault();
  hideVerifyStep();
});

/* ---------- passkey sign-in (WebAuthn) ---------- */

(() => {
  const btn = document.getElementById('passkey-login');
  if (!btn || !window.PublicKeyCredential) return;
  btn.hidden = false;

  const b64uToBuf = (s) => Uint8Array.from(
    atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0),
  ).buffer;
  const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const status = (msg) => {
    const el = document.getElementById('passkey-login-status');
    el.textContent = msg;
    el.hidden = !msg;
  };

  btn.addEventListener('click', async () => {
    status('');
    try {
      const optRes = await fetch('/api/passkeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login-options' }),
      });
      const optData = await optRes.json();
      if (!optRes.ok || !optData.success) {
        status(KiliwUI.t('pk.loginFail'));
        return;
      }
      const options = optData.options;
      options.challenge = b64uToBuf(options.challenge);

      const cred = await navigator.credentials.get({ publicKey: options });
      const res = await fetch('/api/passkeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login-verify',
          ctx: optData.ctx,
          credential: {
            id: cred.id,
            response: {
              clientDataJSON: bufToB64u(cred.response.clientDataJSON),
              authenticatorData: bufToB64u(cred.response.authenticatorData),
              signature: bufToB64u(cred.response.signature),
              userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null,
            },
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        if (data.restored) alert(KiliwUI.t('auth.restored'));
        window.location.href = data.redirect || '/dash';
      } else {
        status(KiliwUI.t('pk.loginFail'));
      }
    } catch (err) {
      /* the user closed the passkey prompt: stay quiet */
      if (err?.name !== 'NotAllowedError') status(KiliwUI.t('pk.loginFail'));
    }
  });
})();
