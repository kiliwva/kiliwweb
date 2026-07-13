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

  /* --- scanner --- */

  function wireScan() {
    const canScan = tg.isVersionAtLeast && tg.isVersionAtLeast('6.4');
    if (!canScan) {
      $('tg-scan').hidden = true;
      $('tg-scan-note').hidden = false;
      return;
    }
    const onText = (text) => {
      const token = tokenFrom(text);
      if (!token) return false;
      try { tg.closeScanQrPopup(); } catch (e) { /* older clients */ }
      openToken(token);
      return true;
    };
    tg.onEvent('qrTextReceived', (e) => onText(e && e.data));
    $('tg-scan').addEventListener('click', () => {
      try {
        tg.showScanQrPopup({ text: 'Наведи на код на экране' }, onText);
      } catch (e) {
        $('tg-scan-note').hidden = false;
      }
    });
  }

  /* --- QR from a gallery picture (decoded right here with jsQR) --- */

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

  function wireGallery() {
    const input = $('tg-file');
    const status = $('tg-file-status');
    $('tg-gallery').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      status.hidden = false;
      status.textContent = '🔎 Ищу код на картинке…';
      const token = await decodeImage(file);
      if (token) {
        status.hidden = true;
        openToken(token);
      } else {
        status.textContent = '😕 Не нашёл код на этой картинке — попробуй другую.';
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
    wireGallery();

    /* opened from a startapp deep link or a web_app button (#mc_<token>) */
    const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    const hashParam = (window.location.hash || '').slice(1);
    const token = tokenFrom(`startapp=${startParam}`) || tokenFrom(`startapp=${hashParam}`);
    if (token) { openToken(token); return; }
    home();
  })();
})();
