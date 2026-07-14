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
  let polling = false;

  /* a computer signs in only by QR (scanned with the bot's scanner); a
     phone gets a button that opens the bot directly */
  const isComputer = window.matchMedia('(pointer: fine)').matches
    && !window.matchMedia('(pointer: coarse)').matches;

  /* Branded QR (matches the id.<domain> login): rounded light modules,
     rounded finder eyes and the mosaic K on transparent background. */
  function prettyQr(text) {
    /* level Q (not H) → fewer modules → bigger, easier for the in-app
       scanner; a small logo hole stays inside Q's error budget */
    const qr = window.qrcode(0, 'Q');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const S = 8;
    const Q = 2 * S;
    const size = n * S + Q * 2;
    const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const hole = Math.floor(n * 0.16);
    const h0 = Math.floor((n - hole) / 2);
    const h1 = h0 + hole - 1;
    const ink = '#F2F2F2';
    let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`;
    out += '<defs><linearGradient id="qrg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F2A47B"/><stop offset=".55" stop-color="#D97757"/><stop offset="1" stop-color="#B4552F"/></linearGradient></defs>';
    const d = S - 0.35; /* fuller modules read better off a screen */
    const rx = d * 0.28;
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (!qr.isDark(r, c) || inFinder(r, c)) continue;
        if (r >= h0 && r <= h1 && c >= h0 && c <= h1) continue;
        out += `<rect x="${(Q + c * S + 0.35).toFixed(2)}" y="${(Q + r * S + 0.35).toFixed(2)}" width="${d}" height="${d}" rx="${rx.toFixed(1)}" fill="${ink}"/>`;
      }
    }
    const rr = (x, y, w, h, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 -${r} -${r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} -${r}Z`;
    const eye = (x, y) => {
      const o = 7 * S; const i = 5 * S; const p = 3 * S;
      return `<path fill-rule="evenodd" fill="${ink}" d="${rr(x, y, o, o, 2.4 * S)}${rr(x + S, y + S, i, i, 1.7 * S)}"/><rect x="${x + 2 * S}" y="${y + 2 * S}" width="${p}" height="${p}" rx="${1.1 * S}" fill="${ink}"/>`;
    };
    out += eye(Q, Q) + eye(Q + (n - 7) * S, Q) + eye(Q, Q + (n - 7) * S);
    const tile = hole * S;
    const tx = Q + h0 * S;
    const ty = Q + h0 * S;
    const mScale = (tile * 0.66) / 17.1;
    const mw = 12.6 * mScale;
    const ox = tx + (tile - mw) / 2 - 5.7 * mScale;
    const oy = ty + tile * 0.17 - 3.45 * mScale;
    const cell = (cx, cy, grad) => {
      const px = (ox + cx * mScale).toFixed(1);
      const py = (oy + cy * mScale).toFixed(1);
      const wl = (3.6 * mScale).toFixed(1);
      const cr = (1.1 * mScale).toFixed(1);
      return `<rect x="${px}" y="${py}" width="${wl}" height="${wl}" rx="${cr}" fill="${grad ? 'url(#qrg)' : '#F2F2F2'}"/>`;
    };
    out += cell(5.7, 3.45) + cell(5.7, 7.95) + cell(5.7, 12.45) + cell(5.7, 16.95);
    out += cell(10.2, 7.95, 1) + cell(14.7, 3.45, 1) + cell(10.2, 12.45, 1) + cell(14.7, 16.95, 1);
    out += '</svg>';
    return out;
  }

  function renderQr(url) {
    const box = $('qr-code');
    if (!box) return;
    /* drop the scheme so the QR carries less data (fewer, larger modules);
       the scanner still finds login_<token> inside it */
    const text = String(url).replace(/^https?:\/\//, '');
    try { box.innerHTML = window.qrcode ? prettyQr(text) : ''; } catch { box.innerHTML = ''; }
  }

  async function prepareLogin() {
    if (isComputer) { $('login-qr').hidden = false; $('login-mobile').hidden = true; } else { $('login-mobile').hidden = false; $('login-qr').hidden = true; }
    const statusEl = isComputer ? $('qr-status') : $('login-status');
    statusEl.textContent = 'Preparing…';
    const r = await post('/api/mclogin', { action: 'start' });
    if (!r.success) {
      statusEl.textContent = r.error === 'not-configured'
        ? 'The bot is not configured yet.' : 'Could not reach the bot — reload the page.';
      return;
    }
    loginToken = r.token;
    loginPoll = r.poll;
    if (isComputer) {
      renderQr(r.botUrl);
      $('login-bot-qr').textContent = r.bot ? `Bot: @${r.bot}` : '';
      $('qr-status').textContent = 'Waiting for the scan…';
    } else {
      /* primary button opens the Telegram app directly (tg://) — most
         reliable when t.me web is throttled; t.me is the fallback link */
      $('btn-login').href = r.tgUrl || r.botUrl;
      $('btn-login-web').href = r.botUrl;
      $('bot-link').href = r.botUrl;
      $('login-bot').textContent = r.bot ? `Bot: @${r.bot}` : '';
      $('login-status').textContent = 'Tap to open Telegram, then confirm there.';
    }
    if (!polling) { polling = true; pollLogin(); }
  }

  async function pollLogin() {
    if (!loginToken) { polling = false; return; }
    const d = await getJSON(`/api/mclogin?token=${loginToken}&poll=${loginPoll}`);
    if (d.status === 'ok') { window.location.reload(); return; }
    if (d.status === 'expired' || d.success === false) {
      /* token aged out — quietly get a fresh one and keep waiting */
      loginToken = null;
      polling = false;
      prepareLogin();
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

  /* tapping the link opens Telegram (native navigation); we just move to
     the waiting screen so the browser tab shows progress */
  $('btn-login').addEventListener('click', () => {
    if (loginToken) show('view-wait');
  });
  $('pnl-logout').addEventListener('click', async () => {
    await post('/api/mclogin', { action: 'logout' });
    window.location.reload();
  });
  wireMod();

  (async () => {
    const me = await getJSON('/api/mclogin?me=1');
    if (!me.authed) { show('view-login'); prepareLogin(); return; }
    $('pnl-user').hidden = false;
    $('pnl-username').textContent = me.tgUsername ? `@${me.tgUsername}` : `id ${me.tgId}`;
    if (me.admin) { show('view-mod'); loadMod(); }
    else { renderCabinet(me); show('view-cabinet'); }
  })();
})();
