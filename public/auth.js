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
      appearance: 'interaction-only',
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

/* the visible switch lives in the subtitles now */
document.getElementById('go-register')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTo('register');
});
document.getElementById('go-login')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTo('login');
});

/* password visibility */
document.querySelectorAll('.rl-eye').forEach((eye) => {
  eye.addEventListener('click', () => {
    const input = eye.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.classList.toggle('on', show);
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

/* remember the last sign-in method for the "Last used" chip */
try {
  const last = localStorage.getItem('kwLastLogin');
  document.querySelectorAll('.rl-social').forEach((a) => {
    const chip = a.querySelector('.rl-last');
    if (chip) chip.hidden = a.dataset.provider !== last;
    a.addEventListener('click', () => {
      try { localStorage.setItem('kwLastLogin', a.dataset.provider); } catch (err) {}
    });
  });
} catch (err) { /* private mode */ }

/* ---------- Validation ---------- */

const API_ERROR_KEYS = [
  'invalid-credentials', 'user-exists', 'invalid-email', 'invalid-password', 'banned',
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

let captchaCtx = null; /* 2FA ticket: code retries skip the captcha */

async function handleSubmit(form, kind) {
  if (!validateForm(form)) return;

  const token = window.turnstile ? turnstile.getResponse(widgets.get(form)) : '';
  if (!token && !captchaCtx) {
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
    if (kind === 'login' && captchaCtx) payload.ctx = captchaCtx;
    const totpInput = form.querySelector('#login-totp');
    if (totpInput && totpInput.value.trim()) payload.code = totpInput.value.trim();

    const res = await fetch(kind === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data && data.success) {
      try { localStorage.setItem('kwLastLogin', 'password'); } catch (err) {}
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
    if (data.error === 'totp-required' || data.error === 'email-code-required') {
      /* the server ticket lets code attempts skip the captcha */
      captchaCtx = data.ctx || null;
      const emailCode = data.error === 'email-code-required';
      const showCode = () => {
        document.getElementById('login-totp-group').hidden = false;
        document.querySelector('#login-totp-group .otp-label').textContent =
          KiliwUI.t(emailCode ? 'label.emailCode' : 'label.totp');
        showFormError(form, KiliwUI.t(emailCode ? 'auth.emailCodePrompt' : 'auth.totpPrompt'));
        KiliwUI.otpClear('login-totp-otp');
        KiliwUI.otpFocus('login-totp-otp');
      };
      if (data.passkey && passkeyAssert) {
        /* a passkey outranks any code: the field only appears if the
           passkey prompt is dismissed or fails */
        const ok = await passkeyAssert();
        if (!ok) showCode();
      } else {
        showCode();
      }
      return;
    }
    if (data.error === 'totp-invalid' && captchaCtx) {
      /* wrong code: the ticket still stands, no captcha round-trip */
      showFormError(form, KiliwUI.t('api.totp-invalid'));
      KiliwUI.otpClear('login-totp-otp');
      KiliwUI.otpFocus('login-totp-otp');
      return;
    }
    if (data.error === 'captcha') captchaCtx = null;
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
    /* mid-2FA the ticket replaces the captcha: leave the widget alone */
    if (!captchaCtx) resetTurnstile(form);
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

/* ---------- progressive password field ---------- */

function wirePwReveal(emailId, wrapId) {
  const email = document.getElementById(emailId);
  const wrap = document.getElementById(wrapId);
  if (!email || !wrap) return;
  const maybeReveal = () => {
    if (!wrap.hidden) return;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) {
      wrap.hidden = false;
    }
  };
  email.addEventListener('input', maybeReveal);
  email.addEventListener('change', maybeReveal);
  email.addEventListener('blur', maybeReveal);
  maybeReveal();
}
wirePwReveal('login-email', 'login-pw-wrap');
wirePwReveal('reg-email', 'reg-pw-wrap');

/* ---------- QR sign-in (computer side) ---------- */

/* Branded QR: rounded modules, rounded finder eyes and the mosaic K
   on a dark tile in the middle (error level H absorbs the knockout). */
function prettyQr(text) {
  const qr = window.qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const S = 8;
  const Q = 2 * S; /* quiet zone */
  const size = n * S + Q * 2;
  const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  /* center knockout for the logo */
  const hole = Math.floor(n * 0.24);
  const h0 = Math.floor((n - hole) / 2);
  const h1 = h0 + hole - 1;

  const ink = '#F2F2F2'; /* light modules on the dark page */
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`;
  out += '<defs><linearGradient id="qrg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F2A47B"/><stop offset=".55" stop-color="#D97757"/><stop offset="1" stop-color="#B4552F"/></linearGradient></defs>';

  const d = S - 1.6;
  const rx = d * 0.44;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inFinder(r, c)) continue;
      if (r >= h0 && r <= h1 && c >= h0 && c <= h1) continue;
      out += `<rect x="${(Q + c * S + 0.8).toFixed(1)}" y="${(Q + r * S + 0.8).toFixed(1)}" width="${d}" height="${d}" rx="${rx.toFixed(1)}" fill="${ink}"/>`;
    }
  }

  /* finder eyes: ring + pupil, rounded */
  const roundedRectPath = (x, y, w, h, r) => (
    `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 -${r} -${r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} -${r}Z`
  );
  const eye = (x, y) => {
    const o = 7 * S;
    const i = 5 * S;
    const p = 3 * S;
    return `<path fill-rule="evenodd" fill="${ink}" d="`
      + roundedRectPath(x, y, o, o, 2.4 * S)
      + roundedRectPath(x + S, y + S, i, i, 1.7 * S)
      + `"/><rect x="${x + 2 * S}" y="${y + 2 * S}" width="${p}" height="${p}" rx="${1.1 * S}" fill="url(#qrg)"/>`;
  };
  out += eye(Q, Q);
  out += eye(Q + (n - 7) * S, Q);
  out += eye(Q, Q + (n - 7) * S);

  /* center tile with the mosaic K */
  const tile = hole * S;
  const tx = Q + h0 * S;
  const ty = Q + h0 * S;
  out += `<rect x="${tx}" y="${ty}" width="${tile}" height="${tile}" rx="${tile * 0.26}" fill="#151515" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>`;
  /* mark content: x 5.7-18.3, y 3.45-20.55 in 24-units → scale into the tile */
  const mScale = (tile * 0.62) / 17.1;
  const mw = 12.6 * mScale;
  const ox = tx + (tile - mw) / 2 - 5.7 * mScale;
  const oy = ty + tile * 0.19 - 3.45 * mScale;
  const cell = (cx, cy, grad) => {
    const px = (ox + cx * mScale).toFixed(1);
    const py = (oy + cy * mScale).toFixed(1);
    const wl = (3.6 * mScale).toFixed(1);
    const rr = (1.1 * mScale).toFixed(1);
    return `<rect x="${px}" y="${py}" width="${wl}" height="${wl}" rx="${rr}" fill="${grad ? 'url(#qrg)' : '#F2F2F2'}"/>`;
  };
  out += cell(5.7, 3.45) + cell(5.7, 7.95) + cell(5.7, 12.45) + cell(5.7, 16.95);
  out += cell(10.2, 7.95, 1) + cell(14.7, 3.45, 1) + cell(10.2, 12.45, 1) + cell(14.7, 16.95, 1);
  out += '</svg>';
  return out;
}


(() => {
  const link = document.getElementById('qr-link');
  const panel = document.getElementById('qr-panel');
  if (!link || !panel) return;
  const stateEl = document.getElementById('qr-state');
  const refreshBtn = document.getElementById('qr-refresh');
  let pollTimer = null;

  const stopPolling = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const showPanel = (on) => {
    panel.hidden = !on;
    panel.classList.toggle('active', on);
    formLogin.hidden = on;
    formLogin.classList.toggle('active', !on);
    if (!on) stopPolling();
  };

  async function startQr() {
    stopPolling();
    refreshBtn.hidden = true;
    stateEl.textContent = 'Waiting for the scan…';
    const box = document.getElementById('qr-code');
    box.innerHTML = '';
    let data;
    try {
      const res = await fetch('/api/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      });
      data = await res.json();
      if (!res.ok || !data.success) throw new Error('create failed');
    } catch {
      stateEl.textContent = 'Could not get a code. Try again.';
      refreshBtn.hidden = false;
      return;
    }
    if (window.qrcode) {
      box.innerHTML = prettyQr(`${window.location.origin}/qr#${data.token}`);
    }
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/qr?token=${data.token}&poll=${data.poll}`);
        const st = await res.json();
        if (st.status === 'ok') {
          stopPolling();
          stateEl.textContent = 'Signed in ✓';
          window.location.href = st.redirect || '/dash';
        } else if (st.status === 'expired') {
          stopPolling();
          stateEl.textContent = 'The code expired.';
          refreshBtn.hidden = false;
        }
      } catch { /* transient network hiccup: keep polling */ }
    }, 2000);
  }

  link.addEventListener('click', () => { showPanel(true); startQr(); });
  refreshBtn.addEventListener('click', () => startQr());
  document.getElementById('qr-back').addEventListener('click', () => showPanel(false));
})();

/* ---------- social sign-in feedback ---------- */

{
  const reason = new URLSearchParams(window.location.search).get('oauth');
  if (reason) {
    const keys = { unavailable: 'auth.oauthUnavailable', failed: 'auth.oauthFailed', banned: 'api.banned' };
    showFormError(formLogin, KiliwUI.t(keys[reason] || 'auth.oauthFailed'));
    window.history.replaceState(null, '', window.location.pathname);
  }
}

/* ---------- passkey sign-in (WebAuthn) ---------- */

let passkeyAssert = null; /* set below when WebAuthn is available */

(() => {
  if (!window.PublicKeyCredential) return;
  const pkLink = document.getElementById('passkey-link');
  if (pkLink) pkLink.hidden = false;
  let condAbort = null;

  const b64uToBuf = (s) => Uint8Array.from(
    atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0),
  ).buffer;
  const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const status = (msg) => {
    const el = document.getElementById('passkey-login-status');
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  };

  const passkeyRun = async (conditional) => {
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
        return false;
      }
      const options = optData.options;
      options.challenge = b64uToBuf(options.challenge);

      const getOpts = { publicKey: options };
      if (conditional) {
        condAbort = new AbortController();
        getOpts.mediation = 'conditional';
        getOpts.signal = condAbort.signal;
      }
      const cred = await navigator.credentials.get(getOpts);
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
        try { localStorage.setItem('kwLastLogin', 'passkey'); } catch (e) {}
        if (data.restored) alert(KiliwUI.t('auth.restored'));
        window.location.href = data.redirect || '/dash';
        return true;
      }
      status(KiliwUI.t('pk.loginFail'));
      return false;
    } catch (err) {
      /* the user closed the passkey prompt (or we aborted the
         background request): stay quiet */
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError' && !conditional) {
        status(KiliwUI.t('pk.loginFail'));
      }
      return false;
    }
  };

  passkeyAssert = () => {
    /* the modal prompt replaces the pending autofill request */
    if (condAbort) { try { condAbort.abort(); } catch (e) {} condAbort = null; }
    return passkeyRun(false);
  };

  pkLink?.addEventListener('click', () => passkeyAssert());

  /* browser autofill offers saved passkeys right in the email field */
  if (PublicKeyCredential.isConditionalMediationAvailable) {
    PublicKeyCredential.isConditionalMediationAvailable().then((yes) => {
      if (yes) passkeyRun(true);
    }).catch(() => {});
  }
})();
