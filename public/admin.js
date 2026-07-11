/* Kiliw Cloud — owner admin page: searchable user directory. */

let users = [];

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

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderTiles(stats) {
  const paid = users.filter((u) => u.plan !== 'free').length;
  const tiles = [
    [stats.users, 'Users'],
    [stats.files, 'Files'],
    [formatSize(stats.bytes), 'Stored'],
    [paid, 'Paid plans'],
  ];
  const wrap = document.getElementById('adm-tiles');
  wrap.innerHTML = '';
  tiles.forEach(([value, label], index) => {
    const tile = document.createElement('div');
    tile.className = 'adm-tile';
    tile.style.animationDelay = `${index * 50}ms`;
    const b = document.createElement('b');
    b.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    tile.append(b, span);
    wrap.appendChild(tile);
  });
}

function userRow(user, index) {
  const li = document.createElement('li');
  li.className = 'adm-row';
  li.style.animationDelay = `${Math.min(index * 20, 220)}ms`;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'adm-row-head';

  const ava = document.createElement('span');
  ava.className = 'admin-ava';
  if (user.avatar) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = `/api/admin?avatar=${encodeURIComponent(user.email)}&v=${user.avatar}`;
    img.onerror = () => { img.remove(); ava.textContent = user.email[0].toUpperCase(); };
    ava.appendChild(img);
  } else {
    ava.textContent = user.email[0].toUpperCase();
  }

  const info = document.createElement('div');
  info.className = 'admin-user-info';
  const mail = document.createElement('p');
  mail.className = 'admin-user-mail';
  mail.textContent = user.email;
  const meta = document.createElement('p');
  meta.className = 'file-meta';
  meta.textContent = `${formatSize(user.usage)} · ${user.files} file${user.files === 1 ? '' : 's'}${user.totp ? ' · 2FA ✓' : ''}`;
  info.append(mail, meta);

  const badge = document.createElement('span');
  badge.className = `badge${user.plan !== 'free' ? ' on' : ''}`;
  badge.textContent = user.plan === 'free' ? 'Free' : user.plan.toUpperCase();

  head.append(ava, info, badge);
  head.addEventListener('click', () => li.classList.toggle('open'));

  /* expandable details */
  const detail = document.createElement('div');
  detail.className = 'adm-detail';

  const usage = document.createElement('div');
  usage.className = 'usage';
  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('span');
  const pct = Math.min(100, (user.usage / user.quota) * 100);
  fill.style.cssText = `display:block;height:100%;border-radius:3px;background:var(--accent);width:${pct.toFixed(1)}%`;
  if (pct > 90) fill.style.background = 'var(--error)';
  bar.appendChild(fill);
  const usageText = document.createElement('span');
  usageText.className = 'usage-text';
  usageText.textContent = `${formatSize(user.usage)} of ${formatSize(user.quota)} (${pct.toFixed(1)}%)`;
  usage.append(bar, usageText);

  const facts = document.createElement('div');
  facts.className = 'adm-facts';
  const factList = [
    ['Plan', user.plan === 'free' ? 'Free' : `${user.plan.toUpperCase()} · ${user.gb} GB`],
    ['Active until', user.until ? formatDate(user.until) : '—'],
    ['API access', user.api ? 'yes' : 'no'],
    ['2FA', user.totp ? 'on' : 'off'],
    ['Files', String(user.files)],
    ['Registered', formatDate(user.created)],
  ];
  /* the record says paid but it resolves to free → expired or broken */
  if (user.planRaw && user.plan === 'free') {
    factList.push(['⚠ Record', `${user.planRaw.toUpperCase()} expired ${user.planUntilRaw ? formatDate(user.planUntilRaw) : '(no end date)'}`]);
  }
  for (const [label, value] of factList) {
    const p = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = `${label}: `;
    p.append(b, document.createTextNode(value));
    facts.appendChild(p);
  }

  /* support tool: grant / change the user's plan by hand */
  const grant = document.createElement('div');
  grant.className = 'adm-grant';
  const sel = document.createElement('select');
  sel.innerHTML = `
    <option value="free">Free</option>
    <option value="pro:250">Pro · 250 GB</option>
    <option value="pro:500">Pro · 500 GB</option>
    <option value="pro:1024">Pro · 1 TB</option>
    <option value="dev">DEV · 500 GB + API</option>`;
  sel.value = user.plan === 'free' ? 'free' : user.plan === 'dev' ? 'dev' : `pro:${user.gb}`;
  if (user.plan === 'pro' && ![250, 500, 1024].includes(user.gb)) sel.value = 'pro:250';
  const days = document.createElement('input');
  days.type = 'number';
  days.min = '1';
  days.max = '3650';
  days.value = '30';
  days.title = 'Days';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'ghost-btn';
  apply.textContent = 'Set plan';
  const status = document.createElement('span');
  status.className = 'adm-grant-status';
  apply.addEventListener('click', async () => {
    const [plan, gb] = sel.value.split(':');
    apply.disabled = true;
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'set-plan',
        email: user.email,
        plan,
        gb: gb ? Number(gb) : undefined,
        days: Number(days.value) || 30,
      }),
    });
    const data = await res.json().catch(() => ({}));
    apply.disabled = false;
    status.textContent = res.ok && data.success ? '✓ applied — refresh to see' : 'failed';
    status.style.color = res.ok && data.success ? '#7FBF8E' : 'var(--error)';
  });
  grant.append(sel, days, apply, status);

  detail.append(usage, facts, grant);
  li.append(head, detail);
  return li;
}

function renderList(filter = '') {
  const list = document.getElementById('adm-list');
  list.innerHTML = '';
  const query = filter.trim().toLowerCase();
  const matched = query ? users.filter((u) => u.email.includes(query)) : users;
  document.getElementById('adm-empty').hidden = matched.length > 0;
  matched.forEach((user, index) => list.appendChild(userRow(user, index)));
}

document.getElementById('adm-search').addEventListener('input', (e) => {
  renderList(e.target.value);
});

(async () => {
  const [meRes, statsRes, usersRes] = await Promise.all([
    fetch('/api/me'),
    fetch('/api/admin'),
    fetch('/api/admin?view=users'),
  ]);
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok || !me.owner) {
    window.location.href = '/dash';
    return;
  }
  const stats = await statsRes.json().catch(() => ({}));
  const data = await usersRes.json().catch(() => ({}));
  users = data.users || [];
  if (stats.success) renderTiles(stats.stats);
  renderList();
})();
