/* K-MCID moderation panel (owner only). Talks to /api/mc admin actions:
   list (?admin=1), admin-ban, admin-unban, admin-unlink, admin-free-device. */

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ago = (ts) => {
    if (!ts) return 'unknown';
    const d = Date.now() - ts;
    if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))}m ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
    return `${Math.round(d / 86400000)}d ago`;
  };

  const tgLabel = (n) => (n.tgUsername ? `@${n.tgUsername}` : (n.tgId ? `tg:${n.tgId}` : (n.email || 'unlinked')));

  let state = { nicks: [], devices: [], bans: [] };

  const api = async (payload) => {
    try {
      const res = await fetch('/api/mc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json().catch(() => ({}));
    } catch {
      return {};
    }
  };

  const row = (name, meta, acts) => `<li class="mc-row"><div class="main">`
    + `<div class="name">${name}</div><div class="meta">${meta}</div></div>`
    + `<div class="mc-acts">${acts}</div></li>`;

  const tile = (label, n) => `<div class="mc-tile"><b>${n}</b><span>${label}</span></div>`;
  const empty = (msg) => `<li class="mc-empty">${msg}</li>`;

  function render() {
    $('mc-tiles').innerHTML = tile('Nicknames', state.nicks.length)
      + tile('Computers', state.devices.length)
      + tile('Banned', state.bans.length);
    $('c-nicks').textContent = state.nicks.length;
    $('c-devices').textContent = state.devices.length;
    $('c-bans').textContent = state.bans.length;

    $('list-bans').innerHTML = state.bans.length
      ? state.bans.map((b) => row(
        esc(b.nick),
        (b.reason ? `${esc(b.reason)} · ` : '') + `banned ${ago(b.created)}`,
        `<button class="mc-act" data-act="unban" data-nick="${esc(b.nick)}">Unban</button>`,
      )).join('')
      : empty('No banned nicknames.');

    const q = $('search-nicks').value.trim().toLowerCase();
    const nicks = q
      ? state.nicks.filter((n) => n.nick.toLowerCase().includes(q) || tgLabel(n).toLowerCase().includes(q))
      : state.nicks;
    $('list-nicks').innerHTML = nicks.length
      ? nicks.map((n) => row(
        esc(n.nick),
        `${esc(tgLabel(n))} · linked ${ago(n.created)}`,
        `<button class="mc-act ghost" data-act="ban" data-nick="${esc(n.nick)}">Ban</button>`
        + `<button class="mc-act" data-act="unlink" data-nick="${esc(n.nick)}">Unlink</button>`,
      )).join('')
      : empty(q ? 'No matches.' : 'No linked nicknames yet.');

    $('list-devices').innerHTML = state.devices.length
      ? state.devices.map((d) => row(
        esc(d.nick || '(unclaimed)'),
        (d.ip ? `${esc(d.ip)} · ` : '') + `sig ${esc(String(d.sig).slice(0, 10))} · ${ago(d.created)}`,
        `<button class="mc-act" data-act="free" data-sig="${esc(d.sig)}">Free</button>`,
      )).join('')
      : empty('No computers registered yet.');
  }

  const apply = (r) => {
    if (r && r.success && r.nicks) {
      state = { nicks: r.nicks, devices: r.devices, bans: r.bans };
      render();
      return true;
    }
    return false;
  };

  /* delegated actions on every list */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mc-act');
    if (!btn || btn.id === 'ban-btn') return;
    const act = btn.dataset.act;
    let payload = null;

    if (act === 'unban') {
      payload = { action: 'admin-unban', nick: btn.dataset.nick };
    } else if (act === 'ban') {
      const reason = window.prompt(`Ban "${btn.dataset.nick}"? Optional reason:`, '');
      if (reason === null) return;
      payload = { action: 'admin-ban', nick: btn.dataset.nick, reason };
    } else if (act === 'unlink') {
      if (!window.confirm(`Unlink "${btn.dataset.nick}"? The name becomes free to claim again.`)) return;
      payload = { action: 'admin-unlink', nick: btn.dataset.nick };
    } else if (act === 'free') {
      if (!window.confirm('Free this computer? It will be able to create a new account again.')) return;
      payload = { action: 'admin-free-device', sig: btn.dataset.sig };
    }
    if (!payload) return;

    btn.disabled = true;
    const r = await api(payload);
    if (!apply(r)) {
      btn.disabled = false;
      window.alert((r && r.error) || 'Action failed.');
    }
  });

  $('ban-btn').addEventListener('click', async () => {
    const nick = $('ban-nick').value.trim();
    if (!nick) { $('ban-status').textContent = 'Enter a nickname.'; return; }
    $('ban-btn').disabled = true;
    const r = await api({ action: 'admin-ban', nick, reason: $('ban-reason').value.trim() });
    $('ban-btn').disabled = false;
    if (apply(r)) {
      $('ban-nick').value = '';
      $('ban-reason').value = '';
      $('ban-status').textContent = `Banned ${nick}.`;
    } else {
      $('ban-status').textContent = r && r.error === 'bad-nick'
        ? 'Invalid nickname (3–16 letters, digits or _).'
        : ((r && r.error) || 'Failed.');
    }
  });

  $('search-nicks').addEventListener('input', render);

  /* boot */
  (async () => {
    let res;
    try {
      res = await fetch('/api/mc?admin=1');
    } catch {
      document.querySelector('.mc-wrap').innerHTML = '<p class="mc-empty">Network error.</p>';
      return;
    }
    if (res.status === 403 || res.status === 401) {
      document.querySelector('.mc-wrap').innerHTML = '<p class="mc-empty">Owner access only.</p>';
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!data.success) {
      document.querySelector('.mc-wrap').innerHTML = '<p class="mc-empty">Could not load — is storage configured?</p>';
      return;
    }
    state = { nicks: data.nicks, devices: data.devices, bans: data.bans };
    render();
  })();
})();
