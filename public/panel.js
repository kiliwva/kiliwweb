/* mcid.<domain> panel. Telegram web-login (via the bot), then either a
   player cabinet or the moderation view depending on who you are. */

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

  const VIEWS = ['view-loading', 'view-login', 'view-wait', 'view-cabinet', 'view-mod'];
  const show = (id) => VIEWS.forEach((v) => { $(v).hidden = v !== id; });

  const getJSON = async (url) => {
    try { return await (await fetch(url)).json(); } catch { return {}; }
  };
  const post = async (path, payload) => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json().catch(() => ({}));
    } catch { return {}; }
  };

  /* ---------- login handshake ---------- */

  let loginToken = null;
  let loginPoll = null;

  async function startLogin() {
    $('login-status').textContent = 'Opening the bot…';
    const r = await post('/api/mclogin', { action: 'start' });
    if (!r.success) {
      $('login-status').textContent = r.error === 'not-configured'
        ? 'The bot is not configured yet.' : 'Could not start. Try again.';
      return;
    }
    loginToken = r.token;
    loginPoll = r.poll;
    $('bot-link').href = r.botUrl;
    show('view-wait');
    $('wait-status').textContent = '';
    window.open(r.botUrl, '_blank', 'noopener');
    pollLogin();
  }

  async function pollLogin() {
    if (!loginToken) return;
    const d = await getJSON(`/api/mclogin?token=${loginToken}&poll=${loginPoll}`);
    if (d.status === 'ok') { window.location.reload(); return; }
    if (d.status === 'expired' || d.success === false) {
      loginToken = null;
      $('login-status').textContent = 'Sign-in expired. Try again.';
      show('view-login');
      return;
    }
    setTimeout(pollLogin, 2000);
  }

  /* ---------- player cabinet ---------- */

  function renderCabinet(me) {
    if (me.nick) {
      $('cab-nick').textContent = me.nick;
      $('cab-sub').textContent = 'Minecraft nickname';
      $('cab-unlink').hidden = false;
    } else {
      $('cab-nick').textContent = 'Not linked';
      $('cab-sub').textContent = 'Join a server and confirm in the bot to link a nickname';
      $('cab-unlink').hidden = true;
    }
    $('cab-tgid').textContent = String(me.tgId);
    $('cab-unlink').onclick = async () => {
      if (!window.confirm('Unlink your nickname? The name becomes free to claim again.')) return;
      $('cab-unlink').disabled = true;
      const r = await post('/api/mclogin', { action: 'my-unlink' });
      $('cab-unlink').disabled = false;
      if (r.success) renderCabinet({ ...me, nick: null });
    };
  }

  /* ---------- moderation ---------- */

  let modState = { nicks: [], devices: [], bans: [] };
  const tgLabel = (n) => (n.tgUsername ? `@${n.tgUsername}` : (n.tgId ? `tg:${n.tgId}` : (n.email || 'unlinked')));
  const rowHtml = (name, meta, acts) => `<li class="mc-row"><div class="main">`
    + `<div class="name">${name}</div><div class="meta">${meta}</div></div>`
    + `<div class="mc-acts">${acts}</div></li>`;
  const emptyHtml = (m) => `<li class="mc-empty">${m}</li>`;

  function renderMod() {
    $('mc-tiles').innerHTML = `<div class="mc-tile"><b>${modState.nicks.length}</b><span>Nicknames</span></div>`
      + `<div class="mc-tile"><b>${modState.devices.length}</b><span>Computers</span></div>`
      + `<div class="mc-tile"><b>${modState.bans.length}</b><span>Banned</span></div>`;
    $('c-nicks').textContent = modState.nicks.length;
    $('c-devices').textContent = modState.devices.length;
    $('c-bans').textContent = modState.bans.length;

    $('list-bans').innerHTML = modState.bans.length
      ? modState.bans.map((b) => rowHtml(esc(b.nick),
        (b.reason ? `${esc(b.reason)} · ` : '') + `banned ${ago(b.created)}`,
        `<button class="mc-act" data-act="unban" data-nick="${esc(b.nick)}">Unban</button>`)).join('')
      : emptyHtml('No banned nicknames.');

    const q = $('search-nicks').value.trim().toLowerCase();
    const nicks = q ? modState.nicks.filter((n) => n.nick.toLowerCase().includes(q)
      || tgLabel(n).toLowerCase().includes(q)) : modState.nicks;
    $('list-nicks').innerHTML = nicks.length
      ? nicks.map((n) => rowHtml(esc(n.nick), `${esc(tgLabel(n))} · linked ${ago(n.created)}`,
        `<button class="mc-act ghost" data-act="ban" data-nick="${esc(n.nick)}">Ban</button>`
        + `<button class="mc-act" data-act="unlink" data-nick="${esc(n.nick)}">Unlink</button>`)).join('')
      : emptyHtml(q ? 'No matches.' : 'No linked nicknames yet.');

    $('list-devices').innerHTML = modState.devices.length
      ? modState.devices.map((d) => rowHtml(esc(d.nick || '(unclaimed)'),
        (d.ip ? `${esc(d.ip)} · ` : '') + `sig ${esc(String(d.sig).slice(0, 10))} · ${ago(d.created)}`,
        `<button class="mc-act" data-act="free" data-sig="${esc(d.sig)}">Free</button>`)).join('')
      : emptyHtml('No computers registered yet.');
  }

  const applyMod = (r) => {
    if (r && r.success && r.nicks) {
      modState = { nicks: r.nicks, devices: r.devices, bans: r.bans };
      renderMod();
      return true;
    }
    return false;
  };

  async function loadMod() {
    const d = await getJSON('/api/mc?admin=1');
    if (d.success) { modState = { nicks: d.nicks, devices: d.devices, bans: d.bans }; renderMod(); }
  }

  function wireMod() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('#view-mod .mc-act[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      let payload = null;
      if (act === 'unban') payload = { action: 'admin-unban', nick: btn.dataset.nick };
      else if (act === 'ban') {
        const reason = window.prompt(`Ban "${btn.dataset.nick}"? Optional reason:`, '');
        if (reason === null) return;
        payload = { action: 'admin-ban', nick: btn.dataset.nick, reason };
      } else if (act === 'unlink') {
        if (!window.confirm(`Unlink "${btn.dataset.nick}"? The name becomes free again.`)) return;
        payload = { action: 'admin-unlink', nick: btn.dataset.nick };
      } else if (act === 'free') {
        if (!window.confirm('Free this computer? It can create a new account again.')) return;
        payload = { action: 'admin-free-device', sig: btn.dataset.sig };
      }
      if (!payload) return;
      btn.disabled = true;
      const r = await post('/api/mc', payload);
      if (!applyMod(r)) { btn.disabled = false; window.alert((r && r.error) || 'Action failed.'); }
    });

    $('ban-btn').addEventListener('click', async () => {
      const nick = $('ban-nick').value.trim();
      if (!nick) { $('ban-status').textContent = 'Enter a nickname.'; return; }
      $('ban-btn').disabled = true;
      const r = await post('/api/mc', { action: 'admin-ban', nick, reason: $('ban-reason').value.trim() });
      $('ban-btn').disabled = false;
      if (applyMod(r)) { $('ban-nick').value = ''; $('ban-reason').value = ''; $('ban-status').textContent = `Banned ${nick}.`; }
      else $('ban-status').textContent = r && r.error === 'bad-nick' ? 'Invalid nickname.' : ((r && r.error) || 'Failed.');
    });

    $('search-nicks').addEventListener('input', renderMod);
  }

  /* ---------- boot ---------- */

  $('btn-login').addEventListener('click', startLogin);
  $('pnl-logout').addEventListener('click', async () => {
    await post('/api/mclogin', { action: 'logout' });
    window.location.reload();
  });
  wireMod();

  (async () => {
    const me = await getJSON('/api/mclogin?me=1');
    if (!me.authed) { show('view-login'); return; }
    $('pnl-user').hidden = false;
    $('pnl-username').textContent = me.tgUsername ? `@${me.tgUsername}` : `id ${me.tgId}`;
    if (me.admin) { show('view-mod'); loadMod(); }
    else { renderCabinet(me); show('view-cabinet'); }
  })();
})();
