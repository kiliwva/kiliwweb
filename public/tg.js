/* Mini app inside the Telegram bot: approve Minecraft sign-ins
   (via the deep link or the QR scanner). Telegram-only — no site
   account is involved. */

(() => {
  const $ = (id) => document.getElementById(id);
  const PANES = ['tg-loading', 'tg-outside', 'tg-home', 'tg-ask',
    'tg-done', 'tg-denied', 'tg-taken', 'tg-bad', 'tg-stats'];
  const show = (id) => PANES.forEach((p) => { $(p).hidden = p !== id; });

  const SVG_HEAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const META_ICONS = {
    geo: `${SVG_HEAD}<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
    ip: `${SVG_HEAD}<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/></svg>`,
    session: `${SVG_HEAD}<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v14"/></svg>`,
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg && tg.initData;
  if (!initData) { show('tg-outside'); return; }
  tg.ready();
  tg.expand();
  /* go full screen where supported (Bot API 8.0+) */
  try {
    if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen) {
      tg.requestFullscreen();
    }
  } catch (e) { /* not supported: stay expanded */ }

  /* haptic feedback (no-op where unsupported) */
  const hf = tg.HapticFeedback;
  const haptic = {
    impact(style) { try { if (hf) hf.impactOccurred(style); } catch (e) { /* ignore */ } },
    notify(type) { try { if (hf) hf.notificationOccurred(type); } catch (e) { /* ignore */ } },
  };

  const api = async (payload) => {
    try {
      const res = await fetch('/api/tg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, ...payload }),
      });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, data: {} };
    }
  };

  const home = () => show('tg-home');

  /* --- approving one join --- */

  async function openToken(token) {
    show('tg-loading');
    const { data } = await api({ action: 'info', token });
    if (!data.success || data.status !== 'pending') { show('tg-bad'); return; }
    $('tg-server').textContent = data.server;
    $('tg-ask-nick').textContent = data.nick;
    const metaEl = $('tg-meta');
    if (Array.isArray(data.meta) && data.meta.length) {
      metaEl.innerHTML = '';
      for (const m of data.meta) {
        const line = document.createElement('span');
        line.className = 'meta-line';
        if (m.icon === 'geo' && m.flag) {
          const flag = document.createElement('span');
          flag.className = 'flag';
          flag.textContent = m.flag;
          line.appendChild(flag);
        } else {
          line.innerHTML = META_ICONS[m.icon] || '';
        }
        const txt = document.createElement('span');
        txt.textContent = m.text;
        line.appendChild(txt);
        metaEl.appendChild(line);
      }
      metaEl.hidden = false;
    } else {
      metaEl.hidden = true;
    }
    show('tg-ask');

    $('tg-approve').onclick = async () => {
      $('tg-approve').disabled = true;
      const r = await api({ action: 'approve', token });
      $('tg-approve').disabled = false;
      if (r.ok && r.data.success) { haptic.notify('success'); show('tg-done'); }
      else if (r.data.error === 'nick-taken') { haptic.notify('error'); show('tg-taken'); }
      else { haptic.notify('error'); show('tg-bad'); }
    };
    $('tg-deny').onclick = async () => {
      await api({ action: 'deny', token });
      haptic.notify('warning');
      show('tg-denied');
    };
  }

  const tokenFrom = (text) => {
    const m = String(text || '').match(/(?:start=mc_|startapp=mc_|\/mc#)([0-9a-f]{24})/);
    return m ? m[1] : null;
  };

  /* --- QR from a picture (decoded right here with jsQR) --- */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
  }

  /* returns { token } for our code, { invalid: true } for some other QR,
     or null when no QR is found at all */
  async function decodeImage(file) {
    if (!window.jsQR) return null;
    let sawQr = false;
    try {
      const im = await loadImage(file);
      /* try a big and a small render: photos decode better downscaled,
         tiny screenshots better at native size */
      for (const target of [1100, 500]) {
        const k = Math.min(1, target / Math.max(im.naturalWidth, im.naturalHeight));
        const w = Math.max(1, Math.round(im.naturalWidth * k));
        const h = Math.max(1, Math.round(im.naturalHeight * k));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const hit = window.jsQR(img.data, w, h);
        if (hit) {
          sawQr = true;
          const token = tokenFrom(hit.data);
          if (token) return { token };
        }
      }
    } catch (e) { /* not an image */ }
    return sawQr ? { invalid: true } : null;
  }

  /* --- the in-app scanner: our own camera view + file picker --- */

  function wireScan() {
    const overlay = $('scan-overlay');
    const video = $('scan-video');
    const frame = $('scan-frame');
    const statusEl = $('scan-status');
    const torchBtn = $('scan-torch');
    const input = $('tg-file');
    let stream = null;
    let track = null;
    let scanning = false;
    let locked = false;
    let torchOn = false;

    const BASE = 220; /* the frame's intrinsic size in CSS px */
    let cur = null; /* current {x,y,a,s} */
    let tgt = null; /* target  {x,y,a,s} */
    let raf = 0;

    const applyFrame = (st) => {
      frame.style.transform =
        `translate(${st.x - BASE / 2}px, ${st.y - BASE / 2}px) rotate(${st.a}deg) scale(${st.s / BASE})`;
    };

    /* continuously ease the frame toward its target for buttery motion */
    const tick = () => {
      if (!cur || !tgt) { raf = 0; return; }
      const k = 0.24;
      let da = tgt.a - cur.a;
      da = ((da + 180) % 360 + 360) % 360 - 180; /* shortest rotation */
      const settled = Math.abs(tgt.x - cur.x) + Math.abs(tgt.y - cur.y)
        + Math.abs(da) + Math.abs(tgt.s - cur.s) < 0.4;
      if (settled) { cur = { ...tgt }; applyFrame(cur); raf = 0; return; }
      cur = {
        x: cur.x + (tgt.x - cur.x) * k,
        y: cur.y + (tgt.y - cur.y) * k,
        a: cur.a + da * k,
        s: cur.s + (tgt.s - cur.s) * k,
      };
      applyFrame(cur);
      raf = requestAnimationFrame(tick);
    };

    /* move/rotate/scale the whole rigid frame as one unit (eased) */
    const setFrame = (cx, cy, angleDeg, size, valid) => {
      frame.classList.toggle('invalid', !valid);
      tgt = { x: cx, y: cy, a: angleDeg, s: size };
      if (!cur) { cur = { ...tgt }; applyFrame(cur); }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      scanning = false;
      locked = false;
      overlay.hidden = true;
      torchBtn.hidden = true;
      torchBtn.classList.remove('on');
      torchOn = false;
      frame.classList.remove('invalid');
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      cur = null; tgt = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      track = null;
      video.srcObject = null;
    };

    /* the frame rests centered and upright until a code is found */
    const centerFrame = () => {
      const size = Math.min(window.innerWidth * 0.5, 200);
      setFrame(window.innerWidth / 2, window.innerHeight / 2, 0, size, true);
    };

    /* map native video corner points to on-screen pixels (object-fit: cover) */
    const toScreen = (corners) => {
      const cw = overlay.clientWidth;
      const ch = overlay.clientHeight;
      const vw = video.videoWidth || cw;
      const vh = video.videoHeight || ch;
      const coverScale = Math.max(cw / vw, ch / vh);
      const dx = (cw - vw * coverScale) / 2;
      const dy = (ch - vh * coverScale) / 2;
      return corners.map((p) => ({ x: p.x * coverScale + dx, y: p.y * coverScale + dy }));
    };

    /* the frame flies onto the code as a whole: its centre, tilt and size */
    const aimAt = (corners, valid) => {
      const pts = toScreen(corners); /* TL, TR, BR, BL */
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI;
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const size = (dist(pts[0], pts[1]) + dist(pts[1], pts[2])
        + dist(pts[2], pts[3]) + dist(pts[3], pts[0])) / 4 + 26;
      setFrame(cx, cy, angle, size, valid);
    };

    /* found our code: the corners snap onto it, then open confirmation */
    const lockOnto = (token, corners) => {
      locked = true;
      scanning = false;
      if (corners) aimAt(corners, true);
      haptic.impact('medium');
      statusEl.textContent = 'Found it';
      setTimeout(() => {
        stop();
        openToken(token);
      }, 460);
    };

    /* some other QR: corners turn red, say invalid, then keep scanning */
    let coolUntil = 0;
    const showInvalid = (corners) => {
      if (corners) aimAt(corners, false);
      haptic.notify('error');
      statusEl.textContent = 'Invalid QR code';
      coolUntil = Date.now() + 1400;
      setTimeout(() => {
        if (scanning && Date.now() >= coolUntil - 20) {
          centerFrame();
          statusEl.textContent = 'Point at the code';
        }
      }, 1400);
    };

    async function scanLoop() {
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
      let detector = null;
      if ('BarcodeDetector' in window) {
        try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
      }
      while (scanning) {
        if (video.readyState >= 2 && Date.now() >= coolUntil) {
          try {
            let hit = null; /* { text, corners(native px) } */
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length) {
                hit = { text: codes[0].rawValue, corners: codes[0].cornerPoints };
              }
            } else if (window.jsQR) {
              /* keep the live decode light so it doesn't starve the
                 animation frames; 640px reads screen codes fine */
              const w = Math.min(video.videoWidth, 640);
              const h = Math.round(video.videoHeight * (w / video.videoWidth));
              canvas.width = w;
              canvas.height = h;
              ctx2d.drawImage(video, 0, 0, w, h);
              const img = ctx2d.getImageData(0, 0, w, h);
              const q = window.jsQR(img.data, w, h);
              if (q) {
                const sc = w / video.videoWidth; /* scaled / native */
                const L = q.location;
                hit = {
                  text: q.data,
                  corners: [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner]
                    .map((p) => ({ x: p.x / sc, y: p.y / sc })),
                };
              }
            }
            if (hit) {
              const token = tokenFrom(hit.text);
              if (token) { lockOnto(token, hit.corners); return; }
              showInvalid(hit.corners);
            }
          } catch (e) { /* keep scanning */ }
        }
        await new Promise((r) => setTimeout(r, 140));
      }
    }

    const setupTorch = async () => {
      torchOn = false;
      torchBtn.classList.remove('on');
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        torchBtn.hidden = !caps.torch;
      } catch (e) {
        torchBtn.hidden = true;
      }
    };

    torchBtn.addEventListener('click', async () => {
      if (!track) return;
      torchOn = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        torchBtn.classList.toggle('on', torchOn);
      } catch (e) {
        torchOn = false;
        torchBtn.classList.remove('on');
      }
    });

    $('tg-scan').addEventListener('click', async () => {
      statusEl.textContent = 'Point at the code';
      overlay.hidden = false;
      centerFrame();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        [track] = stream.getVideoTracks();
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          }
        } catch (e) { /* optional */ }
        await setupTorch();
        video.srcObject = stream;
        await video.play();
        scanning = true;
        scanLoop();
      } catch (e) {
        statusEl.textContent = 'Camera unavailable — pick an image instead';
      }
    });

    $('scan-close').addEventListener('click', stop);
    $('scan-file').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      statusEl.textContent = 'Scanning the image…';
      const res = await decodeImage(file);
      if (res && res.token) {
        haptic.impact('medium');
        stop();
        openToken(res.token);
      } else if (res && res.invalid) {
        haptic.notify('error');
        statusEl.textContent = 'Invalid QR code';
      } else {
        statusEl.textContent = 'No code found in that image — try another';
      }
    });
  }

  $('tg-back').addEventListener('click', home);

  /* --- linked Minecraft nickname --- */

  function setNick(nick) {
    const unlink = $('tg-unlink');
    if (nick) {
      $('tg-nick').textContent = nick;
      $('tg-nick-sub').textContent = 'Minecraft nickname';
      unlink.hidden = false;
      $('tg-stats-btn').hidden = false;
    } else {
      $('tg-nick').textContent = 'Not linked';
      $('tg-nick-sub').textContent = 'Join a server to link a nickname';
      unlink.hidden = true;
      $('tg-stats-btn').hidden = true;
    }
  }

  /* --- player statistics --- */

  const pretty = (id) => String(id || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

  const fmtTime = (min) => {
    const m = Math.max(0, Math.round(min || 0));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };

  const fmtAgo = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  const tile = (k, v) => `<div class="st-tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  const HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
  const FOOD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.45 15.4c-2.13.65-4.3.32-5.7-1.1-2.29-2.27-1.76-6.5 1.17-9.42 2.93-2.93 7.15-3.46 9.43-1.18 1.41 1.41 1.74 3.57 1.1 5.71-1.4-.51-2.93-.27-4.11.91-1.18 1.18-1.42 2.71-.91 4.11z"/><path d="m11.25 15.6-2.16 2.16a2.5 2.5 0 1 1-4.56 1.73 2.49 2.49 0 0 1-1.41-4.24 2.5 2.5 0 0 1 3.14-.32l2.16-2.16"/></svg>';

  /* a row of half-fillable pips (hearts / drumsticks) */
  const pipRow = (kind, svg, value, max) => {
    const pips = Math.ceil(max / 2);
    let out = '';
    for (let i = 0; i < pips; i += 1) {
      const fill = Math.max(0, Math.min(1, (value - i * 2) / 2));
      out += `<span class="st-pip ${kind}"><span class="bg">${svg}</span>`
        + `<span class="fg" style="width:${fill * 100}%">${svg}</span></span>`;
    }
    return `<div class="st-icons">${out}</div>`;
  };

  /* stable pastel color from an item id, as a stand-in icon */
  const hashColor = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360} 55% 62%)`;
  };

  const accordion = (title, arr, unit) => {
    if (!Array.isArray(arr) || !arr.length) return '';
    const total = arr.reduce((s, e) => s + Number(e.count || 0), 0);
    const rows = arr.map((e) => `<div class="acc-row"><span>${pretty(e.type)}</span>`
      + `<span class="rc">${fmtNum(e.count)}${unit ? ` ${unit}` : ''}</span></div>`).join('');
    return `<div class="acc"><button type="button" class="acc-head">${title}`
      + `<span class="cnt">${fmtNum(total)}${unit ? ` ${unit}` : ''}</span>`
      + '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
      + `</button><div class="acc-body">${rows}</div></div>`;
  };

  function renderStats(nick, st) {
    $('st-name').textContent = st?.nick || nick;
    const skin = $('st-skin');
    const id = (st && (st.uuid || st.nick)) || nick;
    skin.src = `https://mc-heads.net/avatar/${encodeURIComponent(id)}/72`;
    skin.onerror = () => { skin.onerror = null; skin.src = `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/72`; };

    const online = Boolean(st && st.online);
    $('st-status').innerHTML = st
      ? `<span class="dot ${online ? 'on' : 'off'}"></span>${online ? 'Online' : `Offline · ${fmtAgo(st.updated)}`}`
      : '<span class="dot off"></span>No data yet';

    /* hearts / food / xp */
    const vis = $('st-vis');
    if (st) {
      const maxHp = st.maxHealth || 20;
      vis.innerHTML = pipRow('st-heart', HEART, st.health, maxHp)
        + pipRow('st-food', FOOD, st.food, 20)
        + `<div class="st-xp"><div class="bar"><i style="width:${Math.round((st.xpProgress || 0) * 100)}%"></i></div>`
        + `<span class="lvl">Level ${st.level || 0}</span></div>`;
      vis.hidden = false;
    } else {
      vis.hidden = true;
    }

    const loc = $('st-loc');
    if (st && online) {
      loc.innerHTML = `📍 X ${fmtNum(st.x)} · Y ${fmtNum(st.y)} · Z ${fmtNum(st.z)} · ${pretty(st.world)}`;
      loc.hidden = false;
    } else {
      loc.hidden = true;
    }

    const game = $('st-game');
    if (st) {
      game.innerHTML = [
        tile('Playtime', fmtTime(st.playMinutes)),
        online ? tile('Ping', `${st.ping} ms`) : tile('Mode', pretty(st.gamemode)),
        tile('Deaths', fmtNum(st.deaths)),
        tile('Player kills', fmtNum(st.playerKills)),
        tile('Mob kills', fmtNum(st.mobKills)),
        tile('Sessions', fmtNum(st.sessions)),
      ].join('');
      game.hidden = false;
    } else {
      game.hidden = true;
    }

    /* expandable categories */
    $('st-acc').innerHTML = st
      ? accordion('Distance travelled', st.distances, 'blocks')
        + accordion('Blocks broken', st.blocksBroken)
        + accordion('Mobs killed', st.mobsKilled)
        + accordion('Items used', st.itemsUsed)
      : '';

    const inv = $('st-inv');
    const items = (st && Array.isArray(st.inventory)) ? st.inventory : [];
    if (!st) {
      inv.className = 'st-inv-msg';
      inv.innerHTML = '<span class="st-empty">Join the server once so it can collect your stats.</span>';
    } else if (!items.length) {
      inv.className = 'st-inv-msg';
      inv.innerHTML = '<span class="st-empty">Inventory is empty.</span>';
    } else {
      inv.className = 'st-inv';
      inv.innerHTML = items.map((it) => {
        const name = pretty(it.type);
        const initials = name.replace(/[^A-Za-z ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
        return `<div class="st-slot"><span class="ic" style="background:${hashColor(it.type)}">${initials}</span>`
          + `<span class="nm">${name}</span>${it.amount > 1 ? `<span class="amt">${it.amount}</span>` : ''}</div>`;
      }).join('');
    }
    $('st-inv-cap').hidden = false;
  }

  $('st-acc').addEventListener('click', (e) => {
    const head = e.target.closest('.acc-head');
    if (head) head.parentElement.classList.toggle('open');
  });

  async function loadStats() {
    show('tg-stats');
    $('st-name').textContent = '…';
    $('st-status').textContent = '';
    ['st-vis', 'st-loc', 'st-game'].forEach((i) => { $(i).hidden = true; });
    $('st-acc').innerHTML = '';
    $('st-inv').innerHTML = '';
    const { data } = await api({ action: 'stats' });
    if (!data.success) { home(); return; }
    renderStats(data.nick, data.stats);
  }

  $('tg-stats-btn').addEventListener('click', loadStats);
  $('st-back').addEventListener('click', home);

  $('tg-unlink').addEventListener('click', async () => {
    const doUnlink = async () => {
      $('tg-unlink').disabled = true;
      const r = await api({ action: 'unlink' });
      $('tg-unlink').disabled = false;
      if (r.ok && r.data.success) { haptic.notify('success'); setNick(null); }
    };
    if (tg.showConfirm) {
      tg.showConfirm('Unlink this nickname? Anyone will be able to claim it again.',
        (ok) => { if (ok) doUnlink(); });
    } else {
      doUnlink();
    }
  });

  /* --- boot --- */

  (async () => {
    const { data } = await api({ action: 'auth' });
    if (!data.success) { show('tg-outside'); return; }
    $('tg-mail').textContent = data.tgName || 'Telegram';
    setNick(data.mcNick || null);
    wireScan();

    /* opened from a startapp deep link or a web_app button (#mc_<token>) */
    const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    const hashParam = (window.location.hash || '').slice(1);
    const token = tokenFrom(`startapp=${startParam}`) || tokenFrom(`startapp=${hashParam}`);
    if (token) { openToken(token); return; }
    home();
  })();
})();
