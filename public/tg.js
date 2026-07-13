/* Mini app inside the Telegram bot: approve Minecraft sign-ins
   (via the deep link or the QR scanner). Telegram-only — no site
   account is involved. */

(() => {
  const $ = (id) => document.getElementById(id);
  const PANES = ['tg-loading', 'tg-outside', 'tg-home', 'tg-ask',
    'tg-done', 'tg-denied', 'tg-taken', 'tg-bad'];
  const show = (id) => PANES.forEach((p) => { $(p).hidden = p !== id; });

  const META_ICONS = { geo: '#i-geo', ip: '#i-ip', session: '#i-ticket' };

  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg && tg.initData;
  if (!initData) { show('tg-outside'); return; }
  tg.ready();
  tg.expand();

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

  /* --- Face ID / Touch ID gate (Telegram BiometricManager, 7.2+) --- */

  const bio = tg.BiometricManager;
  const bioSupported = () => Boolean(bio) && tg.isVersionAtLeast && tg.isVersionAtLeast('7.2');

  function withBiometry(reason, go) {
    if (!bioSupported()) { go(); return; }
    const auth = () => bio.authenticate({ reason }, (ok) => { if (ok) go(); });
    const after = () => {
      if (!bio.isBiometricAvailable) { go(); return; }
      if (bio.isAccessGranted) { auth(); return; }
      bio.requestAccess({ reason: 'Подтверждение входа на серверы Minecraft' },
        (granted) => (granted ? auth() : go()));
    };
    if (bio.isInited) after();
    else bio.init(after);
  }

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
        const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', META_ICONS[m.icon] || '#i-help');
        ico.appendChild(use);
        const txt = document.createElement('span');
        txt.textContent = m.text;
        line.append(ico, txt);
        metaEl.appendChild(line);
      }
      metaEl.hidden = false;
    } else {
      metaEl.hidden = true;
    }
    if (bioSupported()) $('tg-bio-note').hidden = false;
    show('tg-ask');

    $('tg-approve').onclick = () => withBiometry('Подтверди, что это ты заходишь на сервер', async () => {
      $('tg-approve').disabled = true;
      const r = await api({ action: 'approve', token });
      $('tg-approve').disabled = false;
      if (r.ok && r.data.success) show('tg-done');
      else if (r.data.error === 'nick-taken') show('tg-taken');
      else show('tg-bad');
    });
    $('tg-deny').onclick = async () => {
      await api({ action: 'deny', token });
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

  async function decodeImage(file) {
    if (!window.jsQR) return null;
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
          const token = tokenFrom(hit.data);
          if (token) return token;
        }
      }
    } catch (e) { /* not an image */ }
    return null;
  }

  /* --- the in-app scanner: our own camera view + file picker --- */

  function wireScan() {
    const overlay = $('scan-overlay');
    const video = $('scan-video');
    const frame = $('scan-frame');
    const hl = $('scan-hl');
    const hlCtx = hl.getContext('2d');
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
      frame.hidden = false;
      hlCtx.clearRect(0, 0, hl.width, hl.height);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      track = null;
      video.srcObject = null;
    };

    /* map a point from native video pixels to on-screen pixels
       (the video is object-fit: cover) */
    const mapPoint = (p, coverScale, dx, dy) => ({
      x: p.x * coverScale + dx,
      y: p.y * coverScale + dy,
    });

    /* draw the "locked on" box over the detected QR */
    const drawBox = (corners) => {
      const cw = overlay.clientWidth;
      const ch = overlay.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      hl.width = cw * dpr;
      hl.height = ch * dpr;
      hlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hlCtx.clearRect(0, 0, cw, ch);
      const vw = video.videoWidth || cw;
      const vh = video.videoHeight || ch;
      const coverScale = Math.max(cw / vw, ch / vh);
      const dx = (cw - vw * coverScale) / 2;
      const dy = (ch - vh * coverScale) / 2;
      const pts = corners.map((p) => mapPoint(p, coverScale, dx, dy));
      hlCtx.beginPath();
      pts.forEach((p, i) => (i ? hlCtx.lineTo(p.x, p.y) : hlCtx.moveTo(p.x, p.y)));
      hlCtx.closePath();
      hlCtx.fillStyle = 'rgba(242, 164, 123, .25)';
      hlCtx.fill();
      hlCtx.lineWidth = 4;
      hlCtx.strokeStyle = '#F2A47B';
      hlCtx.lineJoin = 'round';
      hlCtx.stroke();
      /* corner dots */
      hlCtx.fillStyle = '#F2A47B';
      pts.forEach((p) => {
        hlCtx.beginPath();
        hlCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        hlCtx.fill();
      });
    };

    /* found a code: aim at it, then open the confirmation */
    const lockOnto = (token, corners) => {
      locked = true;
      scanning = false;
      frame.hidden = true;
      if (corners) drawBox(corners);
      statusEl.textContent = 'Нашёл! 🎯';
      setTimeout(() => {
        const s = stream;
        stop();
        if (!s) { /* already stopped */ }
        openToken(token);
      }, 420);
    };

    async function scanLoop() {
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
      let detector = null;
      if ('BarcodeDetector' in window) {
        try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
      }
      while (scanning) {
        if (video.readyState >= 2) {
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
              statusEl.textContent = 'Хм, это не код K-MCID 🤔';
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
      statusEl.textContent = 'Наведи на код 🎯';
      frame.hidden = false;
      overlay.hidden = false;
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
        statusEl.textContent = 'Камера недоступна 😔 — выбери фото с кодом';
      }
    });

    $('scan-close').addEventListener('click', stop);
    $('scan-file').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      statusEl.textContent = '🔎 Ищу код на картинке…';
      const token = await decodeImage(file);
      if (token) {
        stop();
        openToken(token);
      } else {
        statusEl.textContent = '😕 На этой картинке кода нет — попробуй другую';
      }
    });
  }

  $('tg-back').addEventListener('click', home);

  /* --- boot --- */

  (async () => {
    const { data } = await api({ action: 'auth' });
    if (!data.success) { show('tg-outside'); return; }
    $('tg-mail').textContent = data.tgName || 'Telegram';
    wireScan();

    /* opened from a startapp deep link or a web_app button (#mc_<token>) */
    const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    const hashParam = (window.location.hash || '').slice(1);
    const token = tokenFrom(`startapp=${startParam}`) || tokenFrom(`startapp=${hashParam}`);
    if (token) { openToken(token); return; }
    home();
  })();
})();
