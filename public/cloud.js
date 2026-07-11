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
let currentScope = null; // grant id while browsing a folder shared with me
let scopeInfo = null; // {id, owner, path} of that grant

let selectMode = false;
const selected = new Set(); // file names picked in the current folder
let lastListing = { folders: [], files: [], shared: [] };

let currentView = 'files'; // files | photos | starred | trash | search
let starSet = new Set(); // full paths of starred files (own root only)
let sortMode = localStorage.getItem('kw.sort') || 'date';

const t = (key, vars) => KiliwUI.t(key, vars);
const pathStr = () => currentPath.join('/');
const fullPath = (name) => (pathStr() ? `${pathStr()}/${name}` : name);
const scopeQ = () => (currentScope ? `&scope=${currentScope}` : '');
const fileUrl = (name, inline) => `/api/file?p=${encodeURIComponent(fullPath(name))}${inline ? '&inline=1' : ''}${scopeQ()}`;

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

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const SENSITIVE_RE = /porn|nsfw|xxx/i;
const THUMB_MAX = 8 * 1024 * 1024; // don't pull huge originals for a 40px thumb

const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/* per-family colors for the extension badge on file icons */
const EXT_COLORS = (() => {
  const families = [
    ['#E5484D', 'pdf'],
    ['#4E86E8', 'doc docx rtf odt pages'],
    ['#E06B2B', 'ppt pptx key odp'],
    ['#38A169', 'xls xlsx csv ods numbers'],
    ['#7C7C85', 'txt md log'],
    ['#2E9FE6', 'psd'],
    ['#E8930C', 'ai eps'],
    ['#E5397D', 'indd'],
    ['#C13BD6', 'xd'],
    ['#7D7DE8', 'aep prproj'],
    ['#9B59F5', 'fig sketch'],
    ['#C0932B', 'zip rar 7z tar gz bz2 xz'],
    ['#8B5CF6', 'mp3 wav flac ogg m4a aac'],
    ['#D6409F', 'mp4 mov mkv webm avi m4v'],
    ['#2AA189', 'js ts jsx tsx json py rb go rs java c cpp cs php sh yml yaml sql html css scss xml'],
    ['#6C7BE0', 'ttf otf woff woff2'],
    ['#64748B', 'exe msi apk dmg pkg deb rpm iso'],
    ['#B0813C', 'epub mobi'],
    ['#D97757', 'png jpg jpeg gif webp avif bmp heic svg'],
  ];
  const map = {};
  for (const [color, exts] of families) for (const e of exts.split(' ')) map[e] = color;
  return map;
})();

function fileExt(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Small image preview for the row; falls back to the generic icon. */
function fileVisual(file) {
  if (!IMG_EXT.test(file.name) || file.size > THUMB_MAX) return iconSvg('file', file.name);

  const wrap = document.createElement('span');
  wrap.className = 'thumb';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  /* rows outside the browser (search/starred) carry a full path */
  img.src = file.path
    ? `/api/file?p=${encodeURIComponent(file.path)}&inline=1`
    : fileUrl(file.name, true);
  img.onerror = () => wrap.replaceWith(iconSvg('file', file.name));
  wrap.appendChild(img);

  if (file.sensitive || SENSITIVE_RE.test(file.name)) {
    wrap.classList.add('censored');
    const badge = document.createElement('span');
    badge.className = 'thumb-lock';
    badge.innerHTML = LOCK_SVG;
    wrap.appendChild(badge);
  }
  return wrap;
}

function iconSvg(kind, name = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('file-icon');
  if (kind === 'folder') {
    svg.classList.add('folder');
    svg.innerHTML = '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  } else {
    const ext = fileExt(name);
    const color = EXT_COLORS[ext];
    let badge = '';
    if (color) {
      svg.classList.add('typed');
      badge = `<rect x="1" y="12" width="16" height="8.5" rx="2.2" fill="${color}" stroke="none"/>`
        + `<text x="9" y="18.4" text-anchor="middle" font-family="Manrope, system-ui, sans-serif" font-size="5.2" font-weight="800" letter-spacing="0.02em" fill="#fff" stroke="none">${ext.toUpperCase().slice(0, 4)}</text>`;
    }
    svg.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' + badge;
  }
  return svg;
}

const ACTION_ICONS = {
  download: '<path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
  delete: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  preview: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  menu: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  open: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9Z"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};

function actionButton(kind, title) {
  const btn = document.createElement(kind === 'download' ? 'a' : 'button');
  if (kind !== 'download') btn.type = 'button';
  btn.className = `icon-btn${kind === 'delete' ? ' danger' : ''}${kind === 'menu' ? ' menu-anchor' : ''}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[kind]}</svg>`;
  return btn;
}

/* ---------- floating row menu (⋯) ---------- */

const rowMenu = document.getElementById('row-menu');

function closeRowMenu() {
  rowMenu.hidden = true;
  rowMenu.classList.remove('open');
}

function openRowMenu(anchor, items) {
  rowMenu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement(item.href ? 'a' : 'button');
    if (item.href) {
      el.href = item.href;
      el.setAttribute('download', '');
    } else {
      el.type = 'button';
    }
    el.className = `row-menu-item${item.danger ? ' danger' : ''}`;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[item.icon]}</svg><span></span>`;
    el.querySelector('span').textContent = item.label;
    el.addEventListener('click', () => {
      closeRowMenu();
      if (item.onClick) item.onClick();
    });
    rowMenu.appendChild(el);
  }

  rowMenu.hidden = false;
  rowMenu.style.visibility = 'hidden';
  const rect = anchor.getBoundingClientRect();
  const mw = rowMenu.offsetWidth;
  const mh = rowMenu.offsetHeight;
  let x = Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8));
  let y = rect.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
  rowMenu.style.left = `${x}px`;
  rowMenu.style.top = `${y}px`;
  rowMenu.style.visibility = '';
  rowMenu.classList.add('open');
}

document.addEventListener('click', (e) => {
  if (rowMenu.hidden) return;
  if (!rowMenu.contains(e.target) && !e.target.closest('.menu-anchor')) closeRowMenu();
});
window.addEventListener('scroll', closeRowMenu, true);
window.addEventListener('resize', closeRowMenu);

/* ---------- multi-select & bulk actions ---------- */

const bulkBar = document.getElementById('bulk-bar');
const moveModal = document.getElementById('move-modal');

function updateBulkBar() {
  bulkBar.hidden = !selectMode;
  if (!selectMode) return;
  document.getElementById('bulk-count').textContent = t('sel.count', { n: selected.size });
  const none = selected.size === 0;
  ['bulk-move', 'bulk-zip', 'bulk-delete'].forEach((id) => {
    document.getElementById(id).disabled = none;
  });
}

function setSelectMode(on) {
  selectMode = on;
  selected.clear();
  document.getElementById('select-toggle').classList.toggle('active', on);
  updateBulkBar();
  renderList(lastListing.folders, lastListing.files, lastListing.shared);
}

document.getElementById('select-toggle').addEventListener('click', () => setSelectMode(!selectMode));
document.getElementById('bulk-cancel').addEventListener('click', () => setSelectMode(false));

document.getElementById('bulk-all').addEventListener('click', () => {
  const all = lastListing.files.map((f) => f.name);
  const everything = all.every((n) => selected.has(n));
  selected.clear();
  if (!everything) all.forEach((n) => selected.add(n));
  updateBulkBar();
  renderList(lastListing.folders, lastListing.files, lastListing.shared);
});

document.getElementById('bulk-delete').addEventListener('click', async () => {
  if (!selected.size) return;
  if (!confirm(t('sel.deleteConfirm', { n: selected.size }))) return;
  const res = await fetch(`/api/batch${currentScope ? `?scope=${encodeURIComponent(currentScope)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', path: pathStr(), items: [...selected] }),
  });
  if (res.ok) {
    setSelectMode(false);
    loadFiles();
    refreshMe();
  }
});

/* download the picked files as one archive: a form POST lets the
   browser stream the response straight to disk */
document.getElementById('bulk-zip').addEventListener('click', () => {
  if (!selected.size) return;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/batch${currentScope ? `?scope=${encodeURIComponent(currentScope)}` : ''}`;
  form.style.display = 'none';
  const add = (name, value) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };
  add('action', 'zip');
  add('path', pathStr());
  add('items', JSON.stringify([...selected]));
  document.body.appendChild(form);
  form.submit();
  form.remove();
});

/* --- move-to-folder picker --- */

let movePath = []; // destination the picker is currently looking at

async function renderMovePicker() {
  const listBox = document.getElementById('move-list');
  document.getElementById('move-title').textContent = t('sel.moveTitle', { n: selected.size });
  const rootLabel = scopeInfo ? scopeInfo.path.split('/').pop() : t('files.title');
  document.getElementById('move-where').textContent = `${rootLabel}${movePath.length ? ' / ' + movePath.join(' / ') : ''}`;
  showStatus('move-status', '');

  const res = await fetch(`/api/files?path=${encodeURIComponent(movePath.join('/'))}${scopeQ()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return;

  listBox.innerHTML = '';
  if (movePath.length) {
    const up = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span>..</span>';
    btn.addEventListener('click', () => {
      movePath.pop();
      renderMovePicker();
    });
    up.appendChild(btn);
    listBox.appendChild(up);
  }
  for (const folder of data.folders) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg><span></span>';
    btn.querySelector('span').textContent = folder;
    btn.addEventListener('click', () => {
      movePath.push(folder);
      renderMovePicker();
    });
    li.appendChild(btn);
    listBox.appendChild(li);
  }
  if (!data.folders.length && !movePath.length) {
    const li = document.createElement('li');
    li.className = 'move-empty';
    li.textContent = t('sel.noFolders');
    listBox.appendChild(li);
  }
}

document.getElementById('bulk-move').addEventListener('click', () => {
  if (!selected.size) return;
  movePath = [...currentPath];
  moveModal.hidden = false;
  renderMovePicker();
});

function closeMoveModal() {
  moveModal.hidden = true;
}
document.getElementById('move-close').addEventListener('click', closeMoveModal);
moveModal.addEventListener('click', (e) => {
  if (e.target === moveModal) closeMoveModal();
});

document.getElementById('move-here').addEventListener('click', async () => {
  const dest = movePath.join('/');
  if (dest === pathStr()) {
    showStatus('move-status', t('sel.moveSame'));
    return;
  }
  const res = await fetch(`/api/batch${currentScope ? `?scope=${encodeURIComponent(currentScope)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'move', path: pathStr(), items: [...selected], dest }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showStatus('move-status', t('sel.moveFail'));
    return;
  }
  if (data.skipped?.length) {
    showStatus('move-status', t('sel.moveSkipped', { names: data.skipped.join(', ') }));
    setSelectMode(false);
    loadFiles();
    return; // leave the note visible until the modal is closed
  }
  closeMoveModal();
  setSelectMode(false);
  loadFiles();
});

/* ---------- views: files / photos / starred / trash / search ---------- */

const searchInput = document.getElementById('file-search');
const sortSel = document.getElementById('sort-sel');
sortSel.value = sortMode;

const fileUrlAt = (path, inline) => `/api/file?p=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`;

/* --- drag & drop moving --- */

let dragName = null; // file being dragged (files view only)

async function moveFilesTo(dest, names) {
  if (dest === pathStr()) return;
  const res = await fetch(`/api/batch${currentScope ? `?scope=${encodeURIComponent(currentScope)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'move', path: pathStr(), items: names, dest }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    if (data.skipped?.length) showError(t('sel.moveSkipped', { names: data.skipped.join(', ') }));
    loadFiles();
  }
}

function updateTools() {
  const files = currentView === 'files';
  document.getElementById('breadcrumb').style.display = files ? '' : 'none';
  sortSel.hidden = !files;
  document.getElementById('select-toggle').hidden = !files;
  document.getElementById('new-folder').hidden = !files;
  document.getElementById('trash-empty').hidden = currentView !== 'trash';
  document.querySelectorAll('#view-tabs .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
  });
}

function switchView(view) {
  currentView = view;
  if (view !== 'search') searchInput.value = '';
  if (selectMode) setSelectMode(false);
  updateTools();
  if (view === 'files') loadFiles();
  else if (view === 'photos') loadPhotos();
  else if (view === 'starred') loadStarred();
  else if (view === 'trash') loadTrash();
}

document.querySelectorAll('#view-tabs .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

sortSel.addEventListener('change', () => {
  sortMode = sortSel.value;
  localStorage.setItem('kw.sort', sortMode);
  renderList(lastListing.folders, lastListing.files, lastListing.shared);
});

/* --- starred set (own files only) --- */

async function refreshStars() {
  try {
    const res = await fetch('/api/stars');
    const data = await res.json();
    if (res.ok && data.success) starSet = new Set(data.files.map((f) => f.path));
  } catch { /* keep the old set */ }
}

async function toggleStar(path) {
  const on = !starSet.has(path);
  if (on) starSet.add(path);
  else starSet.delete(path);
  await fetch('/api/stars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, on }),
  });
}

/* --- rows for files identified by full path (search / starred) --- */

function pathRow(file) {
  const name = file.path.split('/').pop();
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const li = document.createElement('li');
  li.className = 'file-row';

  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'file-info';
  const nameEl = document.createElement('span');
  nameEl.className = 'file-name';
  nameEl.textContent = name;
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = `${dir ? `${dir} · ` : ''}${formatSize(file.size)}`;
  info.append(nameEl, meta);
  info.addEventListener('click', () => openPreview({ name, path: file.path, size: file.size, sensitive: file.sensitive }));

  const actions = document.createElement('div');
  actions.className = 'file-actions';
  const download = actionButton('download', t('file.download'));
  download.href = fileUrlAt(file.path, false);
  const menu = actionButton('menu', 'More');
  menu.addEventListener('click', () => {
    openRowMenu(menu, [
      { icon: 'preview', label: t('file.preview'), onClick: () => openPreview({ name, path: file.path, size: file.size, sensitive: file.sensitive }) },
      ...(canEdit({ name, size: file.size })
        ? [{ icon: 'edit', label: t('note.edit'), onClick: () => openEditor({ path: file.path, name, size: file.size }) }]
        : []),
      {
        icon: 'star',
        label: starSet.has(file.path) ? t('star.remove') : t('star.add'),
        onClick: async () => {
          await toggleStar(file.path);
          if (currentView === 'starred') loadStarred();
        },
      },
      { icon: 'download', label: t('file.download'), href: fileUrlAt(file.path, false) },
      {
        icon: 'delete',
        label: t('file.delete'),
        danger: true,
        onClick: async () => {
          if (!confirm(t('file.deleteConfirm', { name }))) return;
          await fetch(fileUrlAt(file.path, false), { method: 'DELETE' });
          switchView(currentView === 'starred' ? 'starred' : 'files');
          refreshMe();
        },
      },
    ]);
  });
  actions.append(download, menu);

  li.append(fileVisual({ name, path: file.path, size: file.size, sensitive: file.sensitive }), info, actions);
  return li;
}

function renderPathRows(files, emptyText) {
  listEl.className = 'file-list';
  listEl.innerHTML = '';
  countEl.textContent = files.length ? KiliwUI.filesCount(files.length) : '';
  emptyEl.textContent = emptyText;
  emptyEl.hidden = files.length > 0;
  for (const file of files) listEl.appendChild(pathRow(file));
}

async function loadStarred() {
  const res = await fetch('/api/stars');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return;
  starSet = new Set(data.files.map((f) => f.path));
  if (currentView !== 'starred') return;
  renderPathRows(data.files, t('starred.empty'));
}

/* --- search --- */

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    if (currentView === 'search') switchView('files');
    return;
  }
  searchTimer = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return;
    if (searchInput.value.trim() !== q) return; // stale response
    currentView = 'search';
    updateTools();
    renderPathRows(data.files, t('search.none', { q }));
  }, 300);
});

/* --- photos grid --- */

async function loadPhotos() {
  const res = await fetch('/api/photos');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || currentView !== 'photos') return;

  listEl.className = 'file-list photo-grid';
  listEl.innerHTML = '';
  countEl.textContent = data.photos.length ? KiliwUI.filesCount(data.photos.length) : '';
  emptyEl.textContent = t('photos.empty');
  emptyEl.hidden = data.photos.length > 0;

  for (const photo of data.photos) {
    const name = photo.path.split('/').pop();
    const li = document.createElement('li');
    li.className = 'photo-tile';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = name;
    const censored = photo.sensitive || SENSITIVE_RE.test(name);
    if (photo.size <= THUMB_MAX) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = name;
      img.src = fileUrlAt(photo.path, true);
      btn.appendChild(img);
    } else {
      btn.appendChild(iconSvg('file', name));
    }
    if (censored) {
      btn.classList.add('censored');
      const badge = document.createElement('span');
      badge.className = 'thumb-lock';
      badge.innerHTML = LOCK_SVG;
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => openPreview({ name, path: photo.path, size: photo.size, sensitive: photo.sensitive }));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

/* --- trash --- */

async function loadTrash() {
  const res = await fetch('/api/trash');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || currentView !== 'trash') return;

  listEl.className = 'file-list';
  listEl.innerHTML = '';
  countEl.textContent = t('trash.hint');
  emptyEl.textContent = t('trash.none');
  emptyEl.hidden = data.items.length > 0;
  document.getElementById('trash-empty').hidden = data.items.length === 0;

  for (const item of data.items) {
    const name = item.path.split('/').pop();
    const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    const li = document.createElement('li');
    li.className = 'file-row trash-row';

    const info = document.createElement('div');
    info.className = 'file-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${dir ? `${dir} · ` : ''}${formatSize(item.size)} · ${t('trash.deletedOn', { date: formatDate(new Date(item.deleted).toISOString()) })}`;
    info.append(nameEl, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const restore = actionButton('menu', t('trash.restore'));
    restore.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS.restore}</svg>`;
    restore.className = 'icon-btn';
    restore.title = t('trash.restore');
    restore.addEventListener('click', async () => {
      await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', id: item.id }),
      });
      loadTrash();
      refreshMe();
    });
    const purge = actionButton('delete', t('trash.forever'));
    purge.addEventListener('click', async () => {
      if (!confirm(t('trash.foreverConfirm', { name }))) return;
      await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'purge', id: item.id }),
      });
      loadTrash();
    });
    actions.append(restore, purge);

    li.append(iconSvg('file', name), info, actions);
    listEl.appendChild(li);
  }
}

document.getElementById('trash-empty').addEventListener('click', async () => {
  if (!confirm(t('trash.emptyConfirm'))) return;
  await fetch('/api/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'empty' }),
  });
  loadTrash();
});

/* ---------- file editor (opens on its own page) ---------- */

/* plain-text formats that open in the editor (≤ 2 MB), plus .docx (≤ 10 MB) */
const EDITABLE_RE = /\.(md|markdown|txt|text|log|csv|tsv|json|xml|yml|yaml|ini|conf|env|htm|html|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|sql|sh|bat)$/i;
const EDITABLE_MAX = 2 * 1024 * 1024;
const DOCX_RE = /\.docx$/i;
const DOCX_MAX = 10 * 1024 * 1024;

function canEdit(file) {
  return (EDITABLE_RE.test(file.name) && file.size <= EDITABLE_MAX)
    || (DOCX_RE.test(file.name) && file.size <= DOCX_MAX);
}

/** The editor lives on its own page, in a new tab. */
function openEditor(file) {
  const p = file.path || fullPath(file.name);
  /* full-path rows (search/starred) are always in the own root */
  const q = file.path ? '' : (currentScope ? `&scope=${encodeURIComponent(currentScope)}` : '');
  window.open(`/editor.html?p=${encodeURIComponent(p)}${q}`, '_blank');
}

/* ---------- browser ---------- */

async function loadFiles() {
  /* the listing and the shared-with-me list load in parallel */
  const atOwnRoot = !currentScope && !currentPath.length;
  const [res, shRes] = await Promise.all([
    fetch(`/api/files?path=${encodeURIComponent(pathStr())}${scopeQ()}`),
    atOwnRoot ? fetch('/api/collab?shared=1') : Promise.resolve(null),
  ]);
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }
  if (res.status === 403 && currentScope) {
    /* access was revoked: fall back to the own root */
    currentScope = null;
    scopeInfo = null;
    currentPath = [];
    showError(t('shared.gone'));
    loadFiles();
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showError(t(data.error === 'not-configured' ? 'files.notConfigured' : 'files.loadError'));
    return;
  }

  let shared = [];
  if (shRes) {
    const shData = await shRes.json().catch(() => ({}));
    if (shRes.ok && shData.success) shared = shData.folders || [];
  }

  showError('');
  renderBreadcrumb();
  lastListing = { folders: data.folders, files: data.files, shared };
  /* the listing changed under the selection: drop stale names */
  selected.clear();
  updateBulkBar();
  renderList(data.folders, data.files, shared);
}

/* crumbs double as drop targets: drag a file up the tree */
function crumbDropTarget(el, destPath) {
  el.addEventListener('dragover', (e) => {
    if (!dragName) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (dragName) moveFilesTo(destPath, [dragName]);
  });
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = '';
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb';
  root.textContent = t('files.title');
  root.addEventListener('click', () => {
    currentScope = null;
    scopeInfo = null;
    currentPath = [];
    loadFiles();
  });
  if (!currentScope) crumbDropTarget(root, '');
  breadcrumbEl.appendChild(root);

  if (scopeInfo) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    breadcrumbEl.appendChild(sep);

    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb';
    if (!currentPath.length) crumb.classList.add('current');
    crumb.textContent = scopeInfo.path.split('/').pop();
    crumb.addEventListener('click', () => {
      currentPath = [];
      loadFiles();
    });
    breadcrumbEl.appendChild(crumb);
  }

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
    crumbDropTarget(crumb, currentPath.slice(0, index + 1).join('/'));
    breadcrumbEl.appendChild(crumb);
  });
}

function renderList(folders, files, shared = []) {
  listEl.className = 'file-list';
  listEl.innerHTML = '';
  emptyEl.textContent = t('files.empty');
  emptyEl.hidden = folders.length > 0 || files.length > 0 || shared.length > 0;
  countEl.textContent = files.length ? KiliwUI.filesCount(files.length) : '';

  /* remembered sort order (folders stay alphabetical) */
  files = [...files];
  if (sortMode === 'name') files.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortMode === 'size') files.sort((a, b) => b.size - a.size);
  else files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

  for (const grant of shared) {
    const li = document.createElement('li');
    li.className = 'file-row folder-row';

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'file-info folder-open';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = grant.path.split('/').pop();
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = t('shared.byOwner', { email: grant.owner });
    info.append(name, meta);
    const openGrant = () => {
      currentScope = grant.id;
      scopeInfo = grant;
      currentPath = [];
      loadFiles();
    };
    info.addEventListener('click', openGrant);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const menu = actionButton('menu', 'More');
    menu.addEventListener('click', () => openRowMenu(menu, [
      { icon: 'open', label: t('menu.open'), onClick: openGrant },
      { icon: 'download', label: t('file.download'), href: `/api/folder-zip?scope=${encodeURIComponent(grant.id)}` },
    ]));
    actions.appendChild(menu);

    li.append(iconSvg('folder'), info, actions);
    listEl.appendChild(li);
  }

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
    const menu = actionButton('menu', 'More');
    menu.addEventListener('click', () => {
      const items = [
        { icon: 'open', label: t('menu.open'), onClick: () => { currentPath.push(folder); loadFiles(); } },
      ];
      if (!currentScope) {
        items.push({ icon: 'share', label: t('file.share'), onClick: () => openFolderShare(folder) });
      }
      items.push({
        icon: 'download',
        label: t('file.download'),
        href: `/api/folder-zip?p=${encodeURIComponent(fullPath(folder))}${scopeQ()}`,
      });
      items.push({
        icon: 'delete',
        label: t('file.delete'),
        danger: true,
        onClick: async () => {
          if (!confirm(t('folder.deleteConfirm', { name: folder }))) return;
          const res = await fetch(`/api/folders?p=${encodeURIComponent(fullPath(folder))}${scopeQ()}`, { method: 'DELETE' });
          if (res.ok) {
            loadFiles();
            refreshMe();
          }
        },
      });
      openRowMenu(menu, items);
    });
    actions.appendChild(menu);

    /* folders accept files dragged onto them */
    li.addEventListener('dragover', (e) => {
      if (!dragName) return;
      e.preventDefault();
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      if (dragName) moveFilesTo(fullPath(folder), [dragName]);
    });

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

    /* selection mode: rows toggle instead of opening the preview */
    if (selectMode) {
      const box = document.createElement('span');
      box.className = 'row-check';
      box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 12.5 4 4 9-9"/></svg>';
      const sync = () => {
        const on = selected.has(file.name);
        li.classList.toggle('selected', on);
        box.classList.toggle('on', on);
      };
      /* the whole row toggles — checkbox, thumbnail and name alike */
      li.addEventListener('click', () => {
        if (selected.has(file.name)) selected.delete(file.name);
        else selected.add(file.name);
        sync();
        updateBulkBar();
      });
      sync();
      li.append(box, fileVisual(file), info);
      li.classList.add('selectable');
      listEl.appendChild(li);
      continue;
    }

    info.addEventListener('click', () => openPreview(file));

    /* star marker next to the name */
    if (!currentScope && starSet.has(fullPath(file.name))) {
      const mark = document.createElement('span');
      mark.className = 'star-mark';
      mark.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">${ACTION_ICONS.star}</svg>`;
      name.appendChild(mark);
    }

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const download = actionButton('download', t('file.download'));
    download.href = fileUrl(file.name, false);
    const menu = actionButton('menu', 'More');
    menu.addEventListener('click', () => {
      const items = [
        { icon: 'preview', label: t('file.preview'), onClick: () => openPreview(file) },
      ];
      if (canEdit(file)) {
        items.push({ icon: 'edit', label: t('note.edit'), onClick: () => openEditor(file) });
      }
      if (!currentScope) {
        const path = fullPath(file.name);
        items.push({
          icon: 'star',
          label: starSet.has(path) ? t('star.remove') : t('star.add'),
          onClick: async () => {
            await toggleStar(path);
            renderList(lastListing.folders, lastListing.files, lastListing.shared);
          },
        });
        /* public links can only be managed by the file's owner */
        items.push({ icon: 'share', label: t('file.share'), onClick: () => openShare(file) });
      }
      items.push(
        { icon: 'rename', label: t('file.rename'), onClick: () => renameFile(file) },
        { icon: 'download', label: t('file.download'), href: fileUrl(file.name, false) },
        {
          icon: 'delete',
          label: t('file.delete'),
          danger: true,
          onClick: async () => {
            if (!confirm(t('file.deleteConfirm', { name: file.name }))) return;
            const res = await fetch(fileUrl(file.name, false), { method: 'DELETE' });
            if (res.ok) {
              loadFiles();
              refreshMe();
            }
          },
        },
      );
      openRowMenu(menu, items);
    });
    actions.append(download, menu);

    /* rows can be dragged onto a folder or a breadcrumb */
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      dragName = file.name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', file.name);
    });
    li.addEventListener('dragend', () => { dragName = null; });

    li.append(fileVisual(file), info, actions);
    listEl.appendChild(li);
  }

  /* gentle staggered entrance */
  [...listEl.children].forEach((li, index) => {
    li.style.animationDelay = `${Math.min(index * 24, 260)}ms`;
  });
}

document.getElementById('new-folder').addEventListener('click', async () => {
  const name = prompt(t('folder.prompt'));
  if (!name || !name.trim()) return;
  const res = await fetch(`/api/folders?x=1${scopeQ()}`, {
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

const DEV_TIER = { id: 'dev', gb: 500, price: 12.99 };

function renderTiers() {
  const proTiers = (me?.billing?.tiers?.length ? me.billing.tiers : DEFAULT_TIERS)
    .map((tier) => ({ id: tier.gb, ...tier }));
  const tiers = [...proTiers, DEV_TIER];
  if (!selectedTier || !tiers.some((tier) => tier.id === selectedTier)) {
    selectedTier = tiers[0].id;
  }
  const grid = document.getElementById('tier-grid');
  grid.innerHTML = '';
  for (const tier of tiers) {
    const isDev = tier.id === 'dev';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `tier${isDev ? ' dev' : ''}`;
    card.classList.toggle('selected', tier.id === selectedTier);
    if (me?.plan?.gb === tier.gb
      && ((isDev && me.plan.type === 'dev') || (!isDev && me.plan.type === 'pro'))) {
      card.classList.add('current');
    }

    const gbEl = document.createElement('span');
    gbEl.className = 'tier-gb';
    gbEl.textContent = isDev ? 'DEV' : tierLabel(tier.gb);
    const priceEl = document.createElement('span');
    priceEl.className = 'tier-price';
    priceEl.textContent = `$${tier.price}`;
    const periodEl = document.createElement('span');
    periodEl.className = 'tier-period';
    periodEl.textContent = isDev ? t('plan.devSub') : t('plan.perMonth');

    card.append(gbEl, priceEl, periodEl);
    card.addEventListener('click', () => {
      selectedTier = tier.id;
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

/* the actual payment happens on a dedicated checkout page */
document.getElementById('plan-continue').addEventListener('click', () => {
  window.location.href = selectedTier === 'dev'
    ? '/checkout.html?plan=dev'
    : `/checkout.html?gb=${selectedTier}`;
});

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
  showPane('plan');
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
  const query = `name=${encodeURIComponent(file.name)}&path=${encodeURIComponent(pathStr())}${scopeQ()}`;
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
    const doneRes = await fetch(`/api/mpu?action=complete${scopeQ()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, path: pathStr(), id, parts }),
    });
    const done = await doneRes.json().catch(() => ({}));
    if (!doneRes.ok || !done.success) throw new Error(done.error || 'upload');
  } catch (err) {
    await fetch(`/api/mpu?action=abort${scopeQ()}`, {
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
  /* the extension stays: only the base name is editable */
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot) : '';
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;
  const input = prompt(ext ? t('rename.promptExt', { ext }) : t('rename.prompt'), base);
  if (!input || !input.trim()) return;
  let name = input.trim();
  if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
  if (name === file.name) return;
  const res = await fetch(`/api/file?x=1${scopeQ()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: fullPath(file.name), newName: name }),
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
const shareCollab = document.getElementById('share-collab');
let sharePath = null;
let shareIsFolder = false;
let shareAccess = 'public';

function setShareAccess(access) {
  shareAccess = access;
  document.getElementById('access-public').classList.toggle('active', access === 'public');
  document.getElementById('access-restricted').classList.toggle('active', access === 'restricted');
  document.getElementById('share-password-group').hidden = access !== 'public';
  document.getElementById('share-hint').textContent = access === 'restricted'
    ? t('share.restrictedHint')
    : t(shareIsFolder ? 'share.folderHint' : 'share.hint');
}

document.getElementById('access-public').addEventListener('click', () => setShareAccess('public'));
document.getElementById('access-restricted').addEventListener('click', () => setShareAccess('restricted'));

function renderShareState(data) {
  shareOff.hidden = Boolean(data.shared);
  shareOn.hidden = !data.shared;
  if (!data.shared) return;

  document.getElementById('share-url').value = data.url;
  const restricted = data.access === 'restricted';
  document.getElementById('share-protected-hint').textContent = restricted
    ? t('share.restrictedOn')
    : t(data.protected ? 'share.protectedOn' : 'share.protectedOff');
  document.getElementById('share-viewers').hidden = !restricted;
  if (restricted) renderEmailList('viewer-list', data.allowed || [], (email) => viewerAction('allow-remove', email));
}

async function openShareModal(name, isFolder) {
  sharePath = fullPath(name);
  shareIsFolder = isFolder;
  document.getElementById('share-title').textContent = t(isFolder ? 'share.folderTitle' : 'share.title');
  document.getElementById('share-file-name').textContent = name;
  document.getElementById('share-password').value = '';
  document.getElementById('collab-email').value = '';
  document.getElementById('viewer-email').value = '';
  setShareAccess('public');
  showStatus('share-status', '');
  showStatus('collab-status', '');
  showStatus('viewer-status', '');
  shareOff.hidden = true;
  shareOn.hidden = true;
  document.getElementById('share-viewers').hidden = true;
  shareCollab.hidden = !isFolder;
  if (isFolder) renderCollab(null);
  shareModal.hidden = false;
  document.body.style.overflow = 'hidden';

  const res = await fetch(`/api/share?p=${encodeURIComponent(sharePath)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showStatus('share-status', t('share.fail'));
  } else {
    renderShareState(data);
  }

  if (isFolder) {
    const cRes = await fetch(`/api/collab?p=${encodeURIComponent(sharePath)}`);
    const cData = await cRes.json().catch(() => ({}));
    renderCollab(cRes.ok && cData.success ? cData.members || [] : []);
  }
}

/* click the link field to copy it */
const shareUrlField = document.getElementById('share-url');
shareUrlField.addEventListener('click', async () => {
  shareUrlField.select();
  try {
    await navigator.clipboard.writeText(shareUrlField.value);
  } catch {
    document.execCommand('copy');
  }
  shareUrlField.classList.add('copied');
  setTimeout(() => shareUrlField.classList.remove('copied'), 900);
  showStatus('share-status', t('share.copied'), true);
});

/* --- restricted link: people with access --- */

async function viewerAction(action, email) {
  showStatus('viewer-status', '');
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, p: sharePath, email }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    renderEmailList('viewer-list', data.allowed || [], (em) => viewerAction('allow-remove', em));
    if (action === 'allow-add') document.getElementById('viewer-email').value = '';
  } else {
    const KEYS = { 'no-user': 'collab.noUser', self: 'collab.self' };
    showStatus('viewer-status', t(KEYS[data.error] || 'collab.fail'));
  }
}

document.getElementById('viewer-add').addEventListener('click', () => {
  const email = document.getElementById('viewer-email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    showStatus('viewer-status', t('collab.badEmail'));
    return;
  }
  viewerAction('allow-add', email);
});
document.getElementById('viewer-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('viewer-add').click();
  }
});

const openShare = (file) => openShareModal(file.name, false);
const openFolderShare = (folder) => openShareModal(folder, true);

/* --- folder editors (edit access by email) --- */

function renderEmailList(listId, members, onRemove) {
  const ul = document.getElementById(listId);
  ul.innerHTML = '';
  if (members === null) return; // still loading
  if (!members.length) {
    const li = document.createElement('li');
    li.className = 'collab-empty';
    li.textContent = t('collab.none');
    ul.appendChild(li);
    return;
  }
  for (const email of members) {
    const li = document.createElement('li');
    li.className = 'collab-row';
    const span = document.createElement('span');
    span.textContent = email;
    const rm = actionButton('delete', t('collab.remove'));
    rm.addEventListener('click', () => onRemove(email));
    li.append(span, rm);
    ul.appendChild(li);
  }
}

function renderCollab(members) {
  renderEmailList('collab-list', members, (email) => collabAction('remove', email));
}

async function collabAction(action, email) {
  showStatus('collab-status', '');
  const res = await fetch('/api/collab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, p: sharePath, email }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    renderCollab(data.members || []);
    if (action === 'add') document.getElementById('collab-email').value = '';
  } else {
    const KEYS = { 'no-user': 'collab.noUser', self: 'collab.self', 'too-many': 'collab.fail' };
    showStatus('collab-status', t(KEYS[data.error] || 'collab.fail'));
  }
}

document.getElementById('collab-add').addEventListener('click', () => {
  const email = document.getElementById('collab-email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    showStatus('collab-status', t('collab.badEmail'));
    return;
  }
  collabAction('add', email);
});
document.getElementById('collab-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('collab-add').click();
  }
});

function closeShareModal() {
  shareModal.hidden = true;
  document.body.style.overflow = '';
}

document.getElementById('share-close').addEventListener('click', closeShareModal);
shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) closeShareModal();
});

document.getElementById('share-create').addEventListener('click', async () => {
  const password = shareAccess === 'public' ? document.getElementById('share-password').value : '';
  if (password && password.length < 4) {
    showStatus('share-status', t('share.passwordShort'));
    return;
  }
  showStatus('share-status', '');
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create', p: sharePath, password, folder: shareIsFolder, access: shareAccess,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    renderShareState({
      shared: true, url: data.url, protected: data.protected, access: data.access, allowed: data.allowed,
    });
  } else {
    showStatus('share-status', t(data.error === 'password-short' ? 'share.passwordShort' : 'share.fail'));
  }
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
  /* photos / search / starred pass the full path; the browser uses currentPath */
  const url = file.path ? fileUrlAt(file.path, true) : fileUrl(file.name, true);

  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-download').href = file.path ? fileUrlAt(file.path, false) : fileUrl(file.name, false);
  previewBody.innerHTML = '';
  previewBody.classList.remove('censored');

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

  /* 18+ photos and videos start blurred behind a cover */
  if ((kind === 'image' || kind === 'video') && (file.sensitive || SENSITIVE_RE.test(file.name))) {
    previewBody.classList.add('censored');
    const cover = document.createElement('div');
    cover.className = 'preview-cover';
    const inner = document.createElement('div');
    const label = document.createElement('p');
    label.textContent = t('preview.sensitive');
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'submit small';
    show.textContent = t('preview.show');
    show.addEventListener('click', () => {
      previewBody.classList.remove('censored');
      cover.remove();
    });
    inner.append(label, show);
    cover.appendChild(inner);
    previewBody.appendChild(cover);
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

/* --- category menu (sidebar / burger on mobile) --- */

const profileNav = document.getElementById('profile-nav');

function showPane(name) {
  document.querySelectorAll('.pnav').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pane === name);
  });
  document.querySelectorAll('.profile-content .pane').forEach((pane) => {
    pane.hidden = pane.id !== `pane-${name}`;
  });
  profileNav.classList.remove('open');
  if (name === 'admin' && me?.owner && !adminLoaded) loadAdmin();
  if (name === 'devices') loadSessions();
  if (name === 'api') openApiPane();
}

/* --- developer API keys --- */

function openApiPane() {
  const hasApi = Boolean(me?.plan?.api);
  document.getElementById('api-locked').hidden = hasApi;
  document.getElementById('api-unlocked').hidden = !hasApi;
  document.getElementById('apikey-secret-wrap').hidden = true;
  document.getElementById('apikey-once').hidden = true;
  showStatus('api-status', '');
  if (hasApi) {
    document.getElementById('api-docs').textContent = [
      '# list files',
      `curl ${window.location.origin}/api/v1/files \\`,
      '  -H "Authorization: Bearer kw_..."',
      '',
      '# upload',
      `curl -X PUT ${window.location.origin}/api/v1/files/backup.zip \\`,
      '  -H "Authorization: Bearer kw_..." --data-binary @backup.zip',
    ].join('\n');
    loadApiKeys();
  }
}

function renderApiKeys(keys) {
  const ul = document.getElementById('apikey-list');
  ul.innerHTML = '';
  if (!keys.length) {
    const li = document.createElement('li');
    li.className = 'collab-empty';
    li.textContent = t('api.none');
    ul.appendChild(li);
    return;
  }
  for (const key of keys) {
    const li = document.createElement('li');
    li.className = 'collab-row';
    const span = document.createElement('span');
    span.textContent = `${key.name} · ${key.prefix}… · ${formatDate(new Date(key.created).toISOString())}`;
    const rm = actionButton('delete', t('api.revoke'));
    rm.addEventListener('click', async () => {
      const res = await fetch('/api/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', id: key.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) renderApiKeys(data.keys || []);
    });
    li.append(span, rm);
    ul.appendChild(li);
  }
}

async function loadApiKeys() {
  const res = await fetch('/api/apikeys');
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) renderApiKeys(data.keys || []);
  else showStatus('api-status', t('api.fail'));
}

document.getElementById('api-upgrade').addEventListener('click', () => {
  window.location.href = '/checkout.html?plan=dev';
});

document.getElementById('apikey-create').addEventListener('click', async () => {
  showStatus('api-status', '');
  const res = await fetch('/api/apikeys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', name: document.getElementById('apikey-name').value.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    document.getElementById('apikey-name').value = '';
    const wrap = document.getElementById('apikey-secret-wrap');
    wrap.hidden = false;
    document.getElementById('apikey-secret').value = data.secret;
    document.getElementById('apikey-once').hidden = false;
    renderApiKeys(data.keys || []);
  } else {
    showStatus('api-status', t(data.error === 'too-many' ? 'api.tooMany' : 'api.fail'));
  }
});

document.getElementById('apikey-secret').addEventListener('click', async (e) => {
  const input = e.target;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand('copy');
  }
  showStatus('api-status', t('share.copied'), true);
});

/* --- devices / sessions --- */

async function loadSessions() {
  const list = document.getElementById('session-list');
  showStatus('devices-status', '');
  const res = await fetch('/api/sessions');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    showStatus('devices-status', t('devices.fail'));
    return;
  }
  list.innerHTML = '';
  for (const s of data.sessions) {
    const li = document.createElement('li');
    li.className = 'collab-row';

    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = s.device || t('devices.unknown');
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = ` · ${formatDate(new Date(s.created).toISOString())}`;
    text.append(name, meta);

    li.appendChild(text);
    if (s.current) {
      const badge = document.createElement('span');
      badge.className = 'badge on';
      badge.textContent = t('devices.current');
      li.appendChild(badge);
    }
    const out = actionButton('delete', t(s.current ? 'cloud.logout' : 'devices.revoke'));
    out.addEventListener('click', async () => {
      const rev = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', id: s.id }),
      });
      const rdata = await rev.json().catch(() => ({}));
      if (rev.ok && rdata.success && rdata.loggedOut) {
        window.location.href = '/';
        return;
      }
      loadSessions();
    });
    li.appendChild(out);
    list.appendChild(li);
  }
}

document.getElementById('sessions-revoke-others').addEventListener('click', async () => {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'revoke-others' }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    showStatus('devices-status', t('devices.revoked', { n: data.removed }), true);
    loadSessions();
  } else {
    showStatus('devices-status', t('devices.fail'));
  }
});

document.querySelectorAll('.pnav').forEach((btn) => {
  btn.addEventListener('click', () => showPane(btn.dataset.pane));
});
document.getElementById('profile-burger').addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = !profileNav.classList.contains('open');
  profileNav.classList.toggle('open');
  /* the menu sits right under the header: bring it into view */
  if (opening) modal.querySelector('.modal').scrollTo({ top: 0, behavior: 'smooth' });
});
document.addEventListener('click', (e) => {
  if (profileNav.classList.contains('open')
    && !profileNav.contains(e.target) && !e.target.closest('#profile-burger')) {
    profileNav.classList.remove('open');
  }
});

function openProfile() {
  document.getElementById('pnav-admin').hidden = !me?.owner;
  showPane('account');
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
  if (!rowMenu.hidden) closeRowMenu();
  else if (!moveModal.hidden) closeMoveModal();
  else if (!previewModal.hidden) closePreview();
  else if (!notifModal.hidden) closeNotifModal();
  else if (!shareModal.hidden) closeShareModal();
  else if (!deleteModal.hidden) closeDeleteModal();
  else if (!planModal.hidden) closePlanModal();
  else if (!modal.hidden) closeModal();
  else if (selectMode) setSelectMode(false);
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

/* ---------- notifications ---------- */

const notifModal = document.getElementById('notif-modal');
const notifBadge = document.getElementById('notif-badge');
let notifs = [];

async function refreshNotifs() {
  const res = await fetch('/api/notifications');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return;
  notifs = data.notifications || [];
  notifBadge.hidden = !data.unread;
  notifBadge.textContent = data.unread > 9 ? '9+' : String(data.unread || '');
  if (!notifModal.hidden) renderNotifs();
}

function notifText(notif) {
  const name = (notif.path || '').split('/').pop();
  return t(notif.type === 'access-request' ? 'notif.request' : 'notif.granted', {
    from: notif.from,
    name,
  });
}

async function notifAction(action, id) {
  const res = await fetch('/api/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    /* stale request (link deleted): the server already dropped it */
  }
  await refreshNotifs();
  renderNotifs();
}

function renderNotifs() {
  const list = document.getElementById('notif-list');
  list.innerHTML = '';
  document.getElementById('notif-empty').hidden = notifs.length > 0;

  notifs.forEach((notif, index) => {
    const li = document.createElement('li');
    li.className = `notif-row${notif.read ? '' : ' unread'}`;
    li.style.animationDelay = `${Math.min(index * 24, 200)}ms`;

    const text = document.createElement('div');
    text.className = 'notif-text';
    const line = document.createElement('p');
    line.textContent = notifText(notif);
    const time = document.createElement('span');
    time.className = 'file-meta';
    time.textContent = formatDate(new Date(notif.created).toISOString());
    text.append(line, time);

    const actions = document.createElement('div');
    actions.className = 'notif-actions';
    if (notif.type === 'access-request') {
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'submit small';
      allow.textContent = t('notif.allow');
      allow.addEventListener('click', () => notifAction('grant', notif.id));
      actions.appendChild(allow);
    } else if (notif.type === 'access-granted' && notif.token) {
      const open = document.createElement('a');
      open.className = 'submit small alt notif-open-link';
      open.textContent = t('notif.openLink');
      open.href = `/share/${notif.token}`;
      actions.appendChild(open);
    }
    const dismiss = actionButton('delete', t('notif.dismiss'));
    dismiss.addEventListener('click', () => notifAction('dismiss', notif.id));
    actions.appendChild(dismiss);

    li.append(text, actions);
    list.appendChild(li);
  });
}

function closeNotifModal() {
  notifModal.hidden = true;
  document.body.style.overflow = '';
}

document.getElementById('notif-open').addEventListener('click', async () => {
  renderNotifs();
  notifModal.hidden = false;
  document.body.style.overflow = 'hidden';
  /* opening the panel marks everything read */
  if (!notifBadge.hidden) {
    notifBadge.hidden = true;
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read' }),
    }).catch(() => {});
    refreshNotifs();
  }
});
document.getElementById('notif-close').addEventListener('click', closeNotifModal);
notifModal.addEventListener('click', (e) => {
  if (e.target === notifModal) closeNotifModal();
});

/* ---------- owner admin panel ---------- */

let adminLoaded = false;

function renderPromos(promos) {
  const ul = document.getElementById('promo-list');
  ul.innerHTML = '';
  if (!promos.length) {
    const li = document.createElement('li');
    li.className = 'collab-empty';
    li.textContent = t('admin.noPromos');
    ul.appendChild(li);
    return;
  }
  for (const promo of promos) {
    const li = document.createElement('li');
    li.className = 'collab-row';
    const span = document.createElement('span');
    span.textContent = `${promo.code} · ${promo.percent >= 100 ? 'FREE' : `−${promo.percent}%`} · ${t('admin.used', {
      used: promo.uses || 0,
      max: promo.maxUses ? promo.maxUses : '∞',
    })}`;
    const rm = actionButton('delete', t('file.delete'));
    rm.addEventListener('click', () => adminAction('promo-remove', { code: promo.code }));
    li.append(span, rm);
    ul.appendChild(li);
  }
}

async function loadAdmin() {
  const res = await fetch('/api/admin');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return;
  adminLoaded = true;
  document.getElementById('admin-stats').textContent = t('admin.stats', {
    users: data.stats.users,
    files: data.stats.files,
    size: formatSize(data.stats.bytes),
  });
  renderPromos(data.promos || []);
}

async function adminAction(action, extra) {
  showStatus('admin-status', '');
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    renderPromos(data.promos || []);
    return true;
  }
  const KEYS = { 'bad-code': 'admin.badCode', 'bad-percent': 'admin.badPercent' };
  showStatus('admin-status', t(KEYS[data.error] || 'admin.fail'));
  return false;
}

document.getElementById('promo-add-btn').addEventListener('click', async () => {
  const code = document.getElementById('promo-code').value.trim();
  const percent = Number(document.getElementById('promo-percent').value);
  const maxUses = Number(document.getElementById('promo-max').value) || 0;
  if (await adminAction('promo-add', { code, percent, maxUses })) {
    document.getElementById('promo-code').value = '';
    document.getElementById('promo-percent').value = '';
    document.getElementById('promo-max').value = '';
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

/* profile, files, stars and notifications load in parallel */
updateTools();
Promise.all([refreshMe(), refreshStars().then(loadFiles), refreshNotifs()]).then(([ok]) => {
  if (!ok) return;
  document.querySelector('.cloud').classList.add('ready');
  checkPaymentReturn();
  setInterval(refreshNotifs, 60000);
});
