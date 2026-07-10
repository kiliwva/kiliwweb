/* Kiliw Cloud — files, folders, previews, plan/billing, profile. */

const fileInput = document.getElementById('file-input');
const drop = document.getElementById('drop');
const statusEl = document.getElementById('upload-status');
const listEl = document.getElementById('file-list');
const emptyEl = document.getElementById('files-empty');
const errorEl = document.getElementById('files-error');
const countEl = document.getElementById('file-count');
const breadcrumbEl = document.getElementById('breadcrumb');

const PART_SIZE = 64 * 1024 * 1024; // multipart chunk (Workers request limit is 100 MB)

let currentPath = [];
let me = null; // /api/me payload: plan, usage, billing

const t = (key, vars) => KiliwUI.t(key, vars);
const pathStr = () => currentPath.join('/');
const fullPath = (name) => (pathStr() ? `${pathStr()}/${name}` : name);
const fileUrl = (name, inline) => `/api/file?p=${encodeURIComponent(fullPath(name))}${inline ? '&inline=1' : ''}`;

/* ---------- session / plan ---------- */

async function refreshMe() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/';
    return false;
  }
  me = await res.json();
  document.getElementById('profile-email').textContent = me.email;
  renderAvatar();
  renderTotpState(Boolean(me.totp));
  renderPlan();
  renderUsage();
  return true;
}

/* ---------- avatar ---------- */

function renderAvatar() {
  const initial = (me.email || '?')[0].toUpperCase();
  for (const suffix of ['', '-big']) {
    const img = document.getElementById(`avatar-img${suffix}`);
    const letter = document.getElementById(`avatar-initial${suffix}`);
    letter.textContent = initial;
    if (me.avatar) {
      img.onerror = () => {
        /* the image request failed: fall back to the letter and say so */
        img.hidden = true;
        letter.hidden = false;
        showStatus('avatar-status', t('avatar.loadFail'));
      };
      img.src = `/api/avatar?v=${me.avatar}`;
      img.hidden = false;
      letter.hidden = true;
    } else {
      img.hidden = true;
      letter.hidden = false;
    }
  }
}

/** Decode an image file; falls back to <img> for formats
    createImageBitmap can't handle (e.g. HEIC photos on iPhone). */
async function decodeImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, url };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
}

/** Downscale to a 256px square JPEG so uploads stay tiny. */
async function shrinkAvatar(file) {
  const { source, width, height, url } = await decodeImage(file);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const scale = Math.max(size / width, size / height);
  canvas.getContext('2d').drawImage(
    source,
    (size - width * scale) / 2,
    (size - height * scale) / 2,
    width * scale,
    height * scale,
  );
  if (url) URL.revokeObjectURL(url);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/jpeg', 0.85);
  });
}

const avatarInput = document.getElementById('avatar-input');
document.getElementById('avatar-change').addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files[0];
  avatarInput.value = '';
  if (!file) return;
  showStatus('avatar-status', t('avatar.uploading'), true);
  let blob;
  try {
    blob = await shrinkAvatar(file);
  } catch {
    showStatus('avatar-status', t('avatar.badImage'));
    return;
  }
  try {
    const res = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `http-${res.status}`);
    showStatus('avatar-status', '');
    /* re-read the profile from the server: the authoritative state */
    await refreshMe();
  } catch (err) {
    showStatus('avatar-status', `${t('avatar.fail')} [${err.message}]`);
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  const res = await fetch('/api/logout', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  window.location.href = data.redirect || '/';
});

/* ---------- helpers ---------- */

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function showStatus(id, message, ok = false) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('ok', ok);
}

function iconSvg(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('file-icon');
  if (kind === 'folder') {
    svg.classList.add('folder');
    svg.innerHTML = '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  } else {
    svg.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  }
  return svg;
}

const ACTION_ICONS = {
  download: '<path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
  delete: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};

function actionButton(kind, title) {
  const btn = document.createElement(kind === 'download' ? 'a' : 'button');
  if (kind !== 'download') btn.type = 'button';
  btn.className = `icon-btn${kind === 'delete' ? ' danger' : ''}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[kind]}</svg>`;
  return btn;
}

/* ---------- browser ---------- */

async function loadFiles() {
  const res = await fetch(`/api/files?path=${encodeURIComponent(pathStr())}`);
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showError(t(data.error === 'not-configured' ? 'files.notConfigured' : 'files.loadError'));
    return;
  }
  showError('');
  renderBreadcrumb();
  renderList(data.folders, data.files);
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = '';
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb';
  root.textContent = t('files.title');
  root.addEventListener('click', () => {
    currentPath = [];
    loadFiles();
  });
  breadcrumbEl.appendChild(root);

  currentPath.forEach((segment, index) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    breadcrumbEl.appendChild(sep);

    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb';
    if (index === currentPath.length - 1) crumb.classList.add('current');
    crumb.textContent = segment;
    crumb.addEventListener('click', () => {
      currentPath = currentPath.slice(0, index + 1);
      loadFiles();
    });
    breadcrumbEl.appendChild(crumb);
  });
}

function renderList(folders, files) {
  listEl.innerHTML = '';
  emptyEl.hidden = folders.length > 0 || files.length > 0;
  countEl.textContent = files.length ? KiliwUI.filesCount(files.length) : '';

  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'file-row folder-row';

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'file-info folder-open';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = folder;
    info.appendChild(name);
    info.addEventListener('click', () => {
      currentPath.push(folder);
      loadFiles();
    });

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const del = actionButton('delete', t('file.delete'));
    del.addEventListener('click', async () => {
      if (!confirm(t('folder.deleteConfirm', { name: folder }))) return;
      const res = await fetch(`/api/folders?p=${encodeURIComponent(fullPath(folder))}`, { method: 'DELETE' });
      if (res.ok) {
        loadFiles();
        refreshMe();
      }
    });
    actions.appendChild(del);

    li.append(iconSvg('folder'), info, actions);
    listEl.appendChild(li);
  }

  for (const file of files) {
    const li = document.createElement('li');
    li.className = 'file-row';

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'file-info';
    info.title = t('file.preview');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${formatSize(file.size)} · ${formatDate(file.uploaded)}`;
    info.append(name, meta);
    info.addEventListener('click', () => openPreview(file));

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const share = actionButton('share', t('file.share'));
    share.addEventListener('click', () => openShare(file));
    const rename = actionButton('rename', t('file.rename'));
    rename.addEventListener('click', () => renameFile(file));
    const download = actionButton('download', t('file.download'));
    download.href = fileUrl(file.name, false);
    const del = actionButton('delete', t('file.delete'));
    del.addEventListener('click', async () => {
      if (!confirm(t('file.deleteConfirm', { name: file.name }))) return;
      const res = await fetch(fileUrl(file.name, false), { method: 'DELETE' });
      if (res.ok) {
        loadFiles();
        refreshMe();
      }
    });
    actions.append(share, rename, download, del);

    li.append(iconSvg('file'), info, actions);
    listEl.appendChild(li);
  }
}

document.getElementById('new-folder').addEventListener('click', async () => {
  const name = prompt(t('folder.prompt'));
  if (!name || !name.trim()) return;
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: pathStr(), name: name.trim() }),
  });
  if (res.ok) loadFiles();
});

/* ---------- usage / plan ---------- */

function renderUsage() {
  if (!me) return;
  const fill = document.getElementById('usage-fill');
  const pct = Math.min(100, (me.usage / me.plan.quota) * 100);
  fill.style.width = `${pct}%`;
  fill.classList.toggle('full', pct > 90);
  document.getElementById('usage-text').textContent = t('usage.text', {
    used: formatSize(me.usage),
    total: formatSize(me.plan.quota),
  });
  document.getElementById('drop-hint').textContent = t('drop.hint', {
    limit: formatSize(me.plan.maxFile),
  });
}

function renderPlan() {
  if (!me) return;
  const badge = document.getElementById('plan-badge');
  const isPro = me.plan.type === 'pro';
  badge.textContent = isPro ? 'Pro' : t('plan.free');
  badge.classList.toggle('on', isPro);

  const desc = document.getElementById('plan-desc');
  if (isPro) {
    desc.textContent = t('plan.proDesc', {
      gb: me.plan.gb,
      date: new Date(me.plan.until).toLocaleDateString('en-GB'),
    });
  } else {
    desc.textContent = t('plan.freeDesc');
  }
}

/* --- Pro plan picker --- */

const planModal = document.getElementById('plan-modal');
const DEFAULT_TIERS = [
  { gb: 250, price: 4.99 },
  { gb: 500, price: 8.99 },
  { gb: 1024, price: 17.99 },
];
let selectedTier = null;

function tierLabel(gb) {
  return gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`;
}

function renderTiers() {
  const tiers = me?.billing?.tiers?.length ? me.billing.tiers : DEFAULT_TIERS;
  if (!selectedTier || !tiers.some((tier) => tier.gb === selectedTier)) {
    selectedTier = tiers[0].gb;
  }
  const grid = document.getElementById('tier-grid');
  grid.innerHTML = '';
  for (const tier of tiers) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tier';
    card.classList.toggle('selected', tier.gb === selectedTier);
    if (me?.plan?.type === 'pro' && me.plan.gb === tier.gb) card.classList.add('current');

    const gbEl = document.createElement('span');
    gbEl.className = 'tier-gb';
    gbEl.textContent = tierLabel(tier.gb);
    const priceEl = document.createElement('span');
    priceEl.className = 'tier-price';
    priceEl.textContent = `$${tier.price}`;
    const periodEl = document.createElement('span');
    periodEl.className = 'tier-period';
    periodEl.textContent = t('plan.perMonth');

    card.append(gbEl, priceEl, periodEl);
    card.addEventListener('click', () => {
      selectedTier = tier.gb;
      renderTiers();
    });
    grid.appendChild(card);
  }
}

function openPlanModal() {
  renderTiers();
  showStatus('plan-modal-status', '');
  planModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePlanModal() {
  planModal.hidden = true;
  if (modal.hidden) document.body.style.overflow = '';
}

document.getElementById('plan-open').addEventListener('click', openPlanModal);
document.getElementById('plan-close').addEventListener('click', closePlanModal);
planModal.addEventListener('click', (e) => {
  if (e.target === planModal) closePlanModal();
});

async function startPayment(method) {
  if (!me?.billing?.[method]) {
    showStatus('plan-modal-status', t('plan.notConfigured'));
    return;
  }
  const res = await fetch('/api/billing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', gb: selectedTier, method }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success && data.url) {
    window.location.href = data.url;
  } else {
    showStatus('plan-modal-status', t(data.error === 'billing-not-configured' ? 'plan.notConfigured' : 'plan.fail'));
  }
}

document.getElementById('pay-yookassa').addEventListener('click', () => startPayment('yookassa'));
document.getElementById('pay-heleket').addEventListener('click', () => startPayment('heleket'));

async function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('payment') !== 'return') return;
  window.history.replaceState({}, '', window.location.pathname);

  const res = await fetch('/api/billing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check' }),
  });
  const data = await res.json().catch(() => ({}));
  openProfile();
  if (data.success && data.state === 'succeeded') {
    await refreshMe();
    showStatus('plan-status', t('plan.success'), true);
  } else if (data.state === 'pending') {
    showStatus('plan-status', t('plan.pending'));
  } else {
    showStatus('plan-status', t('plan.fail'));
  }
}

/* ---------- upload ---------- */

/** XHR upload so we get byte-level progress (fetch can't report it). */
function xhrUpload(method, url, body, contentType, onBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onBytes) onBytes(e.loaded);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(body);
  });
}

async function uploadOne(file, onBytes) {
  const query = `name=${encodeURIComponent(file.name)}&path=${encodeURIComponent(pathStr())}`;
  const type = file.type || 'application/octet-stream';

  if (file.size <= PART_SIZE) {
    const { ok, data } = await xhrUpload('POST', `/api/files?${query}`, file, type, onBytes);
    if (!ok || !data.success) throw new Error(data.error || 'upload');
    return;
  }

  /* multipart: 64 MiB chunks through the Worker into R2 */
  const createRes = await fetch(`/api/mpu?action=create&${query}&size=${file.size}&type=${encodeURIComponent(type)}`, { method: 'POST' });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !created.success) throw new Error(created.error || 'upload');
  const id = created.uploadId;

  const parts = [];
  const total = Math.ceil(file.size / PART_SIZE);
  try {
    for (let i = 0; i < total; i++) {
      const offset = i * PART_SIZE;
      const chunk = file.slice(offset, Math.min(offset + PART_SIZE, file.size));
      const { ok, data } = await xhrUpload(
        'PUT',
        `/api/mpu?action=part&${query}&id=${encodeURIComponent(id)}&part=${i + 1}`,
        chunk,
        'application/octet-stream',
        (loaded) => onBytes(offset + loaded),
      );
      if (!ok || !data.success) throw new Error(data.error || 'upload');
      parts.push({ partNumber: data.partNumber, etag: data.etag });
      onBytes(offset + chunk.size);
    }
    const doneRes = await fetch('/api/mpu?action=complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, path: pathStr(), id, parts }),
    });
    const done = await doneRes.json().catch(() => ({}));
    if (!doneRes.ok || !done.success) throw new Error(done.error || 'upload');
  } catch (err) {
    await fetch('/api/mpu?action=abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, path: pathStr(), id }),
    }).catch(() => {});
    throw err;
  }
}

async function uploadFiles(files) {
  const queue = [...files];
  if (!queue.length) return;

  let done = 0;
  const failed = [];
  statusEl.hidden = false;

  for (const file of queue) {
    const prefix = queue.length > 1 ? `(${done + 1}/${queue.length}) ` : '';
    let lastShown = 0;
    const label = (bytes) => {
      const now = Date.now();
      if (bytes !== undefined && now - lastShown < 150 && bytes < file.size) return;
      lastShown = now;
      statusEl.textContent = prefix + t('drop.progress', {
        name: file.name,
        done: formatSize(Math.min(bytes || 0, file.size)),
        total: formatSize(file.size),
        pct: Math.min(100, Math.round(((bytes || 0) / file.size) * 100)),
      });
    };
    label(0);
    if (me && file.size > me.plan.maxFile) {
      failed.push(`${file.name} (${t('drop.tooLarge')})`);
      done++;
      continue;
    }
    try {
      await uploadOne(file, label);
    } catch (err) {
      failed.push(`${file.name}${err.message === 'quota' ? ` (${t('drop.quota')})` : ''}`);
    }
    done++;
  }

  statusEl.textContent = failed.length
    ? t('drop.failed', { list: failed.join(', ') })
    : t('drop.uploaded', { files: KiliwUI.filesCount(done) });
  setTimeout(() => { statusEl.hidden = true; }, 5000);
  loadFiles();
  refreshMe();
}

document.getElementById('browse').addEventListener('click', () => fileInput.click());
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

/* ---------- rename ---------- */

async function renameFile(file) {
  const name = prompt(t('rename.prompt'), file.name);
  if (!name || !name.trim() || name.trim() === file.name) return;
  const res = await fetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: fullPath(file.name), newName: name.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    loadFiles();
  } else {
    alert(t(data.error === 'exists' ? 'rename.exists' : 'rename.fail'));
  }
}

/* ---------- share ---------- */

const shareModal = document.getElementById('share-modal');
const shareOff = document.getElementById('share-off');
const shareOn = document.getElementById('share-on');
let sharePath = null;

function renderShareState(data) {
  shareOff.hidden = Boolean(data.shared);
  shareOn.hidden = !data.shared;
  if (data.shared) {
    document.getElementById('share-url').value = data.url;
    document.getElementById('share-protected-hint').textContent = t(
      data.protected ? 'share.protectedOn' : 'share.protectedOff',
    );
  }
}

async function openShare(file) {
  sharePath = fullPath(file.name);
  document.getElementById('share-file-name').textContent = file.name;
  document.getElementById('share-password').value = '';
  showStatus('share-status', '');
  shareOff.hidden = true;
  shareOn.hidden = true;
  shareModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const res = await fetch(`/api/share?p=${encodeURIComponent(sharePath)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showStatus('share-status', t('share.fail'));
    return;
  }
  renderShareState(data);
}

function closeShareModal() {
  shareModal.hidden = true;
  document.body.style.overflow = '';
}

document.getElementById('share-close').addEventListener('click', closeShareModal);
shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) closeShareModal();
});

document.getElementById('share-create').addEventListener('click', async () => {
  const password = document.getElementById('share-password').value;
  if (password && password.length < 4) {
    showStatus('share-status', t('share.passwordShort'));
    return;
  }
  showStatus('share-status', '');
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', p: sharePath, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    renderShareState({ shared: true, url: data.url, protected: data.protected });
  } else {
    showStatus('share-status', t(data.error === 'password-short' ? 'share.passwordShort' : 'share.fail'));
  }
});

document.getElementById('share-copy').addEventListener('click', async () => {
  const input = document.getElementById('share-url');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  showStatus('share-status', t('share.copied'), true);
});

document.getElementById('share-remove').addEventListener('click', async () => {
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', p: sharePath }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    showStatus('share-status', '');
    renderShareState({ shared: false });
  } else {
    showStatus('share-status', t('share.fail'));
  }
});

/* ---------- preview ---------- */

const previewModal = document.getElementById('preview-modal');
const previewBody = document.getElementById('preview-body');

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', ico: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', m4v: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  pdf: 'pdf',
  txt: 'text', md: 'text', json: 'text', js: 'text', ts: 'text', css: 'text', html: 'text', htm: 'text',
  csv: 'text', log: 'text', xml: 'text', yml: 'text', yaml: 'text', ini: 'text', conf: 'text', sh: 'text', py: 'text',
};

function openPreview(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const kind = EXT_KIND[ext];
  const url = fileUrl(file.name, true);

  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-download').href = fileUrl(file.name, false);
  previewBody.innerHTML = '';

  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    previewBody.appendChild(img);
  } else if (kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    previewBody.appendChild(video);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    previewBody.appendChild(audio);
  } else if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.className = 'preview-frame';
    previewBody.appendChild(frame);
  } else if (kind === 'text' && file.size <= 2 * 1024 * 1024) {
    const pre = document.createElement('pre');
    pre.textContent = '…';
    previewBody.appendChild(pre);
    fetch(url).then((r) => r.text()).then((text) => { pre.textContent = text; });
  } else {
    const p = document.createElement('p');
    p.className = 'preview-na';
    p.textContent = t('preview.na');
    previewBody.appendChild(p);
  }

  previewModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePreview() {
  previewModal.hidden = true;
  previewBody.innerHTML = '';
  document.body.style.overflow = '';
}

document.getElementById('preview-close').addEventListener('click', closePreview);
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) closePreview();
});

/* ---------- profile popup ---------- */

const modal = document.getElementById('profile-modal');
const totpBadge = document.getElementById('totp-badge');
const totpOff = document.getElementById('totp-off');
const totpOn = document.getElementById('totp-on');
const totpSetupBox = document.getElementById('totp-setup-box');

let totpEnabled = false;

function renderTotpState(enabled) {
  if (enabled !== undefined) totpEnabled = enabled;
  totpBadge.textContent = t(totpEnabled ? 'badge.on' : 'badge.off');
  totpBadge.classList.toggle('on', totpEnabled);
  totpOn.hidden = !totpEnabled;
  totpOff.hidden = totpEnabled;
  totpSetupBox.hidden = true;
}

function openProfile() {
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

document.getElementById('profile-open').addEventListener('click', openProfile);

function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
  ['password-status', 'totp-enable-status', 'totp-disable-status', 'plan-status', 'delete-start-status'].forEach((id) => showStatus(id, ''));
  document.getElementById('password-form').reset();
  renderTotpState();
}

document.getElementById('profile-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!previewModal.hidden) closePreview();
  else if (!shareModal.hidden) closeShareModal();
  else if (!deleteModal.hidden) closeDeleteModal();
  else if (!planModal.hidden) closePlanModal();
  else if (!modal.hidden) closeModal();
});

/* --- change password --- */

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pw-current').value;
  const next = document.getElementById('pw-next').value;
  if (next.length < 8) {
    showStatus('password-status', t('profile.pw.short'));
    return;
  }
  const res = await fetch('/api/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current, next }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    showStatus('password-status', t('profile.pw.ok'), true);
    e.target.reset();
  } else {
    showStatus('password-status', t(data.error === 'wrong-password' ? 'profile.pw.wrong' : 'profile.pw.fail'));
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
  KiliwUI.otpClear('totp-enable-otp');
  KiliwUI.otpFocus('totp-enable-otp');
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
    renderTotpState(true);
    KiliwUI.otpClear('totp-enable-otp');
  } else {
    showStatus('totp-enable-status', t(data.error === 'totp-invalid' ? 'profile.2fa.wrongCode' : 'profile.2fa.enableFail'));
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
    renderTotpState(false);
    KiliwUI.otpClear('totp-disable-otp');
  } else {
    showStatus('totp-disable-status', t(data.error === 'totp-invalid' ? 'profile.2fa.wrongCode' : 'profile.2fa.disableFail'));
  }
});

/* ---------- delete account ---------- */

const deleteModal = document.getElementById('delete-modal');
let deleteMethod = null;

function closeDeleteModal() {
  deleteModal.hidden = true;
  showStatus('delete-status', '');
  document.getElementById('delete-password').value = '';
  KiliwUI.otpClear('delete-otp');
  if (modal.hidden) document.body.style.overflow = '';
}

document.getElementById('delete-close').addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('click', (e) => {
  if (e.target === deleteModal) closeDeleteModal();
});

document.getElementById('delete-start').addEventListener('click', async () => {
  if (!confirm(t('delete.prompt'))) return;
  showStatus('delete-start-status', '');
  const res = await fetch('/api/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showStatus('delete-start-status', t(data.error === 'mail-failed' ? 'api.mail-failed' : 'delete.fail'));
    return;
  }
  deleteMethod = data.method;
  const isPassword = deleteMethod === 'password';
  document.getElementById('delete-otp-wrap').hidden = isPassword;
  document.getElementById('delete-pw-wrap').hidden = !isPassword;
  document.getElementById('delete-method-hint').textContent = t(
    deleteMethod === 'totp' ? 'delete.methodTotp'
      : deleteMethod === 'email' ? 'delete.methodEmail'
        : 'delete.methodPassword',
  );
  showStatus('delete-status', '');
  document.getElementById('delete-password').value = '';
  deleteModal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (isPassword) {
    document.getElementById('delete-password').focus();
  } else {
    KiliwUI.otpClear('delete-otp');
    KiliwUI.otpFocus('delete-otp');
  }
});

document.getElementById('delete-confirm').addEventListener('click', async () => {
  const payload = { action: 'confirm' };
  if (deleteMethod === 'password') {
    payload.password = document.getElementById('delete-password').value;
    if (!payload.password) return;
  } else {
    payload.code = document.getElementById('delete-code').value.trim();
    if (!/^\d{6}$/.test(payload.code)) {
      showStatus('delete-status', t('api.code-invalid'));
      return;
    }
  }
  const btn = document.getElementById('delete-confirm');
  btn.classList.add('loading');
  try {
    const res = await fetch('/api/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      window.location.href = data.redirect || '/';
      return;
    }
    const KEYS = { 'totp-invalid': 'api.totp-invalid', 'code-invalid': 'api.code-invalid', 'code-expired': 'api.code-expired', 'too-many': 'api.too-many', 'wrong-password': 'profile.pw.wrong', 'mail-failed': 'api.mail-failed' };
    showStatus('delete-status', t(KEYS[data.error] || 'delete.fail'));
  } catch {
    showStatus('delete-status', t('delete.fail'));
  } finally {
    btn.classList.remove('loading');
  }
});

/* ---------- support diagnostics ---------- */

document.getElementById('app-build').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/debug');
    const text = await res.text();
    alert(text);
  } catch (err) {
    alert('debug failed: ' + err.message);
  }
});

/* ---------- init ---------- */

refreshMe().then(async (ok) => {
  if (!ok) return;
  await loadFiles();
  document.querySelector('.cloud').classList.add('ready');
  checkPaymentReturn();
});
