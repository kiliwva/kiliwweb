/* Kiliw Cloud — file storage + profile frontend. */

const fileInput = document.getElementById('file-input');
const drop = document.getElementById('drop');
const browseBtn = document.getElementById('browse');
const statusEl = document.getElementById('upload-status');
const listEl = document.getElementById('file-list');
const emptyEl = document.getElementById('files-empty');
const errorEl = document.getElementById('files-error');
const countEl = document.getElementById('file-count');
const emailEl = document.getElementById('user-email');

const MAX_SIZE = 100 * 1024 * 1024;

/* ---------- session ---------- */

let totpEnabled = false;

async function loadMe() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/';
    return false;
  }
  const data = await res.json();
  emailEl.textContent = data.email;
  document.getElementById('profile-email').textContent = data.email;
  totpEnabled = Boolean(data.totp);
  renderTotpState();
  return true;
}

document.getElementById('logout').addEventListener('click', async () => {
  const res = await fetch('/api/logout', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  window.location.href = data.redirect || '/';
});

/* ---------- helpers ---------- */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  const d = new Date(iso);
  const locale = KiliwUI.lang === 'ru' ? 'ru-RU' : 'en-GB';
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/* re-render dynamic texts when the language changes */
KiliwUI.onLang(() => {
  renderTotpState();
  loadFiles();
});

/* ---------- file list ---------- */

async function loadFiles() {
  const res = await fetch('/api/files');
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showError(KiliwUI.t(data.error === 'not-configured' ? 'files.notConfigured' : 'files.loadError'));
    return;
  }
  showError('');
  renderFiles(data.files);
}

function renderFiles(files) {
  listEl.innerHTML = '';
  emptyEl.hidden = files.length > 0;
  countEl.textContent = files.length ? KiliwUI.filesCount(files.length) : '';

  for (const file of files) {
    const li = document.createElement('li');
    li.className = 'file-row';

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.classList.add('file-icon');
    icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';

    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${formatSize(file.size)} · ${formatDate(file.uploaded)}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const download = document.createElement('a');
    download.className = 'icon-btn';
    download.href = `/api/files/${encodeURIComponent(file.name)}`;
    download.title = KiliwUI.t('file.download');
    download.setAttribute('aria-label', `${KiliwUI.t('file.download')} ${file.name}`);
    download.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn danger';
    del.title = KiliwUI.t('file.delete');
    del.setAttribute('aria-label', `${KiliwUI.t('file.delete')} ${file.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(KiliwUI.t('file.deleteConfirm', { name: file.name }))) return;
      const res = await fetch(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
      if (res.ok) loadFiles();
    });

    actions.append(download, del);
    li.append(icon, info, actions);
    listEl.appendChild(li);
  }
}

/* ---------- upload ---------- */

async function uploadFiles(files) {
  const queue = [...files];
  if (!queue.length) return;

  let done = 0;
  const failed = [];
  statusEl.hidden = false;

  for (const file of queue) {
    statusEl.textContent = KiliwUI.t('drop.uploading', { name: file.name, i: done + 1, n: queue.length });
    if (file.size > MAX_SIZE) {
      failed.push(`${file.name} (${KiliwUI.t('drop.tooLarge')})`);
      done++;
      continue;
    }
    try {
      const res = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) failed.push(file.name);
    } catch {
      failed.push(file.name);
    }
    done++;
  }

  statusEl.textContent = failed.length
    ? KiliwUI.t('drop.failed', { list: failed.join(', ') })
    : KiliwUI.t('drop.uploaded', { files: KiliwUI.filesCount(done) });
  setTimeout(() => { statusEl.hidden = true; }, 4000);
  loadFiles();
}

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  uploadFiles(fileInput.files);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach((type) => {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
  });
});
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

/* ---------- profile popup ---------- */

const modal = document.getElementById('profile-modal');
const totpBadge = document.getElementById('totp-badge');
const totpOff = document.getElementById('totp-off');
const totpOn = document.getElementById('totp-on');
const totpSetupBox = document.getElementById('totp-setup-box');

function renderTotpState() {
  totpBadge.textContent = KiliwUI.t(totpEnabled ? 'badge.on' : 'badge.off');
  totpBadge.classList.toggle('on', totpEnabled);
  totpOn.hidden = !totpEnabled;
  totpOff.hidden = totpEnabled;
  totpSetupBox.hidden = true;
}

function showStatus(id, message, ok = false) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('ok', ok);
}

document.getElementById('profile-open').addEventListener('click', () => {
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
});

function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
  ['password-status', 'totp-enable-status', 'totp-disable-status'].forEach((id) => showStatus(id, ''));
  document.getElementById('password-form').reset();
  renderTotpState();
}

document.getElementById('profile-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

/* --- change password --- */

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pw-current').value;
  const next = document.getElementById('pw-next').value;
  if (next.length < 8) {
    showStatus('password-status', KiliwUI.t('profile.pw.short'));
    return;
  }
  const res = await fetch('/api/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current, next }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    showStatus('password-status', KiliwUI.t('profile.pw.ok'), true);
    e.target.reset();
  } else {
    showStatus('password-status', KiliwUI.t(data.error === 'wrong-password' ? 'profile.pw.wrong' : 'profile.pw.fail'));
  }
});

/* --- 2FA --- */

document.getElementById('totp-setup').addEventListener('click', async () => {
  const res = await fetch('/api/2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setup' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return;

  totpOff.hidden = true;
  totpSetupBox.hidden = false;
  document.getElementById('totp-secret').textContent = data.secret;

  const qrHolder = document.getElementById('totp-qr');
  qrHolder.innerHTML = '';
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(data.uri);
    qr.make();
    qrHolder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } else {
    const link = document.createElement('a');
    link.className = 'link';
    link.href = data.uri;
    link.textContent = 'Open in authenticator app';
    qrHolder.appendChild(link);
  }
  document.getElementById('totp-enable-code').focus();
});

document.getElementById('totp-enable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('totp-enable-code').value.trim();
  const res = await fetch('/api/2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enable', code }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    totpEnabled = true;
    renderTotpState();
    e.target.reset();
  } else {
    showStatus('totp-enable-status', KiliwUI.t(data.error === 'totp-invalid' ? 'profile.2fa.wrongCode' : 'profile.2fa.enableFail'));
  }
});

document.getElementById('totp-disable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('totp-disable-code').value.trim();
  const res = await fetch('/api/2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'disable', code }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    totpEnabled = false;
    renderTotpState();
    e.target.reset();
  } else {
    showStatus('totp-disable-status', KiliwUI.t(data.error === 'totp-invalid' ? 'profile.2fa.wrongCode' : 'profile.2fa.disableFail'));
  }
});

/* ---------- init ---------- */

loadMe().then((ok) => {
  if (ok) loadFiles();
});
