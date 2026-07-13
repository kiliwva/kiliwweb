/* K-ID — the shared account hub (id.<domain>): profile, password,
   2FA, passkeys and devices, backed by the same APIs as the cloud app. */

const $ = (id) => document.getElementById(id);

function setStatus(el, ok, message) {
  el.textContent = message;
  el.style.color = ok ? '#7FBF8E' : 'var(--error)';
  if (message) setTimeout(() => { el.textContent = ''; }, 4000);
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  return { ok: res.ok && data.success !== false, data };
}

/* ---------- base64url helpers (WebAuthn) ---------- */

const b64uToBuf = (s) => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0),
).buffer;
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- products ---------- */

const ICONS = {
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
  api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>',
};

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function renderProducts(data) {
  const plan = data.plan || {};
  const paid = plan.type && plan.type !== 'free';
  const planLine = paid
    ? `${plan.gb >= 1024 ? `${plan.gb / 1024} TB` : `${plan.gb} GB`}${plan.until ? ` · until ${formatDate(plan.until)}` : ''}`
    : '10 GB free storage';
  const products = [
    {
      icon: 'cloud',
      name: 'Kiliw Cloud',
      badge: paid ? plan.type.toUpperCase() : 'Free',
      badgeOn: paid,
      status: `${planLine}\n${formatSize(data.usage)} used`,
      href: '/dash',
    },
    {
      icon: 'api',
      name: 'Developer API',
      status: plan.api ? 'Active — included in your plan' : 'Requires the DEV plan',
      href: '/docs',
    },
  ];
  if (data.owner) {
    products.push({
      icon: 'admin',
      name: 'Admin',
      status: 'Site owner tools',
      href: '/admin',
    });
  }
  const wrap = $('id-products');
  wrap.innerHTML = '';
  for (const p of products) {
    const a = document.createElement('a');
    a.className = 'id-prod';
    a.href = p.href;
    const ico = document.createElement('span');
    ico.className = 'id-prod-ico';
    ico.innerHTML = ICONS[p.icon];
    const b = document.createElement('b');
    b.textContent = p.name;
    if (p.badge) {
      const badge = document.createElement('span');
      badge.className = `badge${p.badgeOn ? ' on' : ''}`;
      badge.textContent = p.badge;
      b.appendChild(badge);
    }
    a.append(ico, b);
    for (const line of p.status.split('\n')) {
      const span = document.createElement('span');
      span.className = 'id-prod-line';
      span.textContent = line;
      a.appendChild(span);
    }
    wrap.appendChild(a);
  }
}

/* ---------- profile ---------- */

let me = null;

async function loadMe() {
  const { data } = await api('/api/me');
  me = data;
  $('id-mail').textContent = data.email;
  const ava = $('id-ava');
  ava.innerHTML = '';
  if (data.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `/api/avatar?v=${data.avatar}`;
    img.onerror = () => { img.remove(); ava.textContent = data.email[0].toUpperCase(); };
    ava.appendChild(img);
  } else {
    ava.textContent = data.email[0].toUpperCase();
  }
  renderTotp(Boolean(data.totp));
  renderProducts(data);
}

/* ---------- password ---------- */

$('pass-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = $('pass-current').value;
  const next = $('pass-next').value;
  if (next.length < 8) {
    setStatus($('pass-status'), false, 'New password is too short.');
    return;
  }
  const { ok, data } = await api('/api/password', { current, next });
  if (ok) {
    $('pass-current').value = '';
    $('pass-next').value = '';
    setStatus($('pass-status'), true, '✓ Password changed');
  } else {
    setStatus($('pass-status'), false, data.error === 'wrong-password'
      ? 'Current password is wrong.' : 'Something went wrong.');
  }
});

/* ---------- 2FA ---------- */

function renderTotp(on) {
  $('totp-state').textContent = on ? 'ON' : 'OFF';
  $('totp-state').style.color = on ? '#7FBF8E' : 'var(--muted)';
  const btn = $('totp-btn');
  btn.hidden = false;
  btn.textContent = on ? 'Turn off 2FA' : 'Turn on 2FA';
  btn.dataset.mode = on ? 'disable' : 'setup';
  $('totp-setup').hidden = true;
  $('totp-code').value = '';
}

$('totp-btn').addEventListener('click', async () => {
  const mode = $('totp-btn').dataset.mode;
  if (mode === 'setup') {
    const { ok, data } = await api('/api/2fa', { action: 'setup' });
    if (!ok) { setStatus($('totp-status'), false, 'Could not start setup.'); return; }
    const holder = $('totp-qr');
    holder.innerHTML = '';
    if (window.qrcode) {
      const qr = window.qrcode(0, 'M');
      qr.addData(data.uri);
      qr.make();
      holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }
    $('totp-secret').textContent = data.secret;
    $('totp-setup').hidden = false;
    $('totp-confirm').dataset.mode = 'enable';
    $('totp-code').focus();
  } else {
    /* turning off asks for a current code */
    $('totp-qr').innerHTML = '';
    $('totp-secret').textContent = 'Enter a code from your authenticator to turn 2FA off.';
    $('totp-setup').hidden = false;
    $('totp-confirm').dataset.mode = 'disable';
    $('totp-code').focus();
  }
});

$('totp-confirm').addEventListener('click', async () => {
  const code = $('totp-code').value.trim();
  if (!/^\d{6}$/.test(code)) { setStatus($('totp-status'), false, 'Enter the 6-digit code.'); return; }
  const action = $('totp-confirm').dataset.mode;
  const { ok, data } = await api('/api/2fa', { action, code });
  if (ok) {
    renderTotp(action === 'enable');
    setStatus($('totp-status'), true, action === 'enable' ? '✓ 2FA is on' : '✓ 2FA is off');
  } else {
    setStatus($('totp-status'), false, data.error === 'totp-invalid' ? 'Wrong code.' : 'Something went wrong.');
  }
});

/* ---------- passkeys ---------- */

const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadPasskeys() {
  const { ok, data } = await api('/api/passkeys');
  const list = $('pk-list');
  list.innerHTML = '';
  const passkeys = ok ? (data.passkeys || []) : [];
  if (!passkeys.length) {
    const li = document.createElement('li');
    li.className = 'id-empty';
    li.textContent = 'No passkeys yet.';
    list.appendChild(li);
    return;
  }
  for (const pk of passkeys) {
    const li = document.createElement('li');
    li.className = 'id-item';
    const info = document.createElement('div');
    info.className = 'id-item-info';
    const b = document.createElement('b');
    b.textContent = pk.name || 'Passkey';
    const span = document.createElement('span');
    span.textContent = `Added ${formatDate(pk.created)}`;
    info.append(b, span);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'id-x';
    del.innerHTML = X_SVG;
    del.title = 'Remove this passkey';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove passkey “${pk.name}”?`)) return;
      const r = await api('/api/passkeys', { action: 'remove', id: pk.id });
      if (r.ok) loadPasskeys();
    });
    li.append(info, del);
    list.appendChild(li);
  }
}

$('pk-add').addEventListener('click', async () => {
  if (!window.PublicKeyCredential) {
    setStatus($('pk-status'), false, 'This browser does not support passkeys.');
    return;
  }
  try {
    const opt = await api('/api/passkeys', { action: 'reg-options' });
    if (!opt.ok) { setStatus($('pk-status'), false, 'Could not start.'); return; }
    const options = opt.data.options;
    options.challenge = b64uToBuf(options.challenge);
    options.user.id = b64uToBuf(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || [])
      .map((c) => ({ ...c, id: b64uToBuf(c.id) }));
    const cred = await navigator.credentials.create({ publicKey: options });
    const payload = {
      action: 'reg-verify',
      ctx: opt.data.ctx,
      credential: {
        id: cred.id,
        rawId: bufToB64u(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          attestationObject: bufToB64u(cred.response.attestationObject),
        },
      },
    };
    const r = await api('/api/passkeys', payload);
    if (r.ok) {
      setStatus($('pk-status'), true, '✓ Passkey added');
      loadPasskeys();
    } else {
      setStatus($('pk-status'), false, 'Could not save the passkey.');
    }
  } catch {
    /* the user closed the system prompt: stay quiet */
  }
});

/* ---------- devices ---------- */

async function loadSessions() {
  const { ok, data } = await api('/api/sessions');
  const list = $('ses-list');
  list.innerHTML = '';
  if (!ok) return;
  for (const s of data.sessions || []) {
    const li = document.createElement('li');
    li.className = 'id-item';
    const info = document.createElement('div');
    info.className = 'id-item-info';
    const b = document.createElement('b');
    b.textContent = (s.device || 'Unknown device') + (s.current ? ' · this device' : '');
    const span = document.createElement('span');
    span.textContent = `Signed in ${formatDate(s.created)}`;
    info.append(b, span);
    li.appendChild(info);
    if (!s.current) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'id-x';
      del.innerHTML = X_SVG;
      del.title = 'Sign this device out';
      del.addEventListener('click', async () => {
        const r = await api('/api/sessions', { action: 'revoke', id: s.id });
        if (r.ok) loadSessions();
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  }
}

$('ses-others').addEventListener('click', async () => {
  const { ok } = await api('/api/sessions', { action: 'revoke-others' });
  setStatus($('ses-status'), ok, ok ? '✓ Other devices signed out' : 'Something went wrong.');
  if (ok) loadSessions();
});

/* ---------- logout ---------- */

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

/* ---------- tabs ---------- */

function showTab(name) {
  document.querySelectorAll('.id-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.id-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
  if (window.history.replaceState) {
    window.history.replaceState(null, '', name === 'products' ? window.location.pathname : `#${name}`);
  }
}

$('id-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.id-tab');
  if (btn) showTab(btn.dataset.tab);
});

{
  const initial = window.location.hash.slice(1);
  if (['security', 'devices'].includes(initial)) showTab(initial);
}

/* ---------- boot ---------- */

(async () => {
  try {
    await loadMe();
    await Promise.all([loadPasskeys(), loadSessions()]);
  } catch {
    /* redirected to /login */
  }
})();
