/* Mini app inside the Telegram bot: approve Minecraft sign-ins
   (via the deep link or the QR scanner). Telegram-only — no site
   account is involved. */

(() => {
  const $ = (id) => document.getElementById(id);
  const PANES = ['tg-loading', 'tg-outside', 'tg-home', 'tg-ask',
    'tg-done', 'tg-denied', 'tg-taken', 'tg-bad'];
  const show = (id) => PANES.forEach((p) => { $(p).hidden = p !== id; });

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
      metaEl.textContent = data.meta.join('\n');
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
    const statusEl = $('scan-status');
    const input = $('tg-file');
    let stream = null;
    let scanning = false;

    const stop = () => {
      scanning = false;
      overlay.hidden = true;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      video.srcObject = null;
    };

    const found = (text) => {
      const token = tokenFrom(text);
      if (!token) {
        statusEl.textContent = 'Хм, это не код K-MCID 🤔';
        return false;
      }
      stop();
      openToken(token);
      return true;
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
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length && found(codes[0].rawValue)) return;
            } else if (window.jsQR) {
              const w = Math.min(video.videoWidth, 1280);
              const h = Math.round(video.videoHeight * (w / video.videoWidth));
              canvas.width = w;
              canvas.height = h;
              ctx2d.drawImage(video, 0, 0, w, h);
              const img = ctx2d.getImageData(0, 0, w, h);
              const hit = window.jsQR(img.data, w, h);
              if (hit && found(hit.data)) return;
            }
          } catch (e) { /* keep scanning */ }
        }
        await new Promise((r) => setTimeout(r, 160));
      }
    }

    $('tg-scan').addEventListener('click', async () => {
      statusEl.textContent = 'Наведи рамку на код 🎯';
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
        const [track] = stream.getVideoTracks();
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          }
        } catch (e) { /* optional */ }
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
