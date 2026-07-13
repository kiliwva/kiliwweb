/* Mini app inside the Telegram bot: approve Minecraft sign-ins
   (via the deep link or the QR scanner). Telegram-only — no site
   account is involved. */

(() => {
  const $ = (id) => document.getElementById(id);
  const PANES = ['tg-loading', 'tg-outside', 'tg-home', 'tg-ask',
    'tg-done', 'tg-denied', 'tg-taken', 'tg-bad'];
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

    const stop = () => {
      scanning = false;
      locked = false;
      overlay.hidden = true;
      torchBtn.hidden = true;
      torchBtn.classList.remove('on');
      torchOn = false;
      frame.classList.remove('invalid');
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      track = null;
      video.srcObject = null;
    };

    const cornerEls = frame.querySelectorAll('.corner'); /* order TL, TR, BR, BL */

    /* place the four L-brackets on the given screen points (in TL,TR,BR,BL
       order); each rotates to follow the code's tilt */
    const placeCorners = (pts, valid) => {
      frame.classList.toggle('invalid', !valid);
      const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI;
      pts.forEach((p, i) => {
        const c = cornerEls[i];
        c.style.left = `${p.x}px`;
        c.style.top = `${p.y}px`;
        c.style.transform = `rotate(${ang + 90 * i}deg)`;
      });
    };

    /* the aiming corners rest as a square in the middle until a code is found */
    const centerFrame = () => {
      const s = Math.min(window.innerWidth * 0.6, 250);
      const x = (window.innerWidth - s) / 2;
      const y = (window.innerHeight - s) / 2;
      placeCorners([
        { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
      ], true);
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

    /* corners snap onto the code's real (possibly tilted) corners */
    const aimAt = (corners, valid) => {
      const pts = toScreen(corners);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      /* nudge each corner slightly outward so the brackets frame the code */
      const out = pts.map((p) => {
        const vx = p.x - cx;
        const vy = p.y - cy;
        const d = Math.hypot(vx, vy) || 1;
        const k = (d + 10) / d;
        return { x: cx + vx * k, y: cy + vy * k };
      });
      placeCorners(out, valid);
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
              const w = Math.min(video.videoWidth, 1280);
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
    } else {
      $('tg-nick').textContent = 'Not linked';
      $('tg-nick-sub').textContent = 'Join a server to link a nickname';
      unlink.hidden = true;
    }
  }

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
