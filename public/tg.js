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

  /* --- approving one join --- */

  async function openToken(token) {
    show('tg-loading');
    const { data } = await api({ action: 'info', token });
    if (!data.success || data.status !== 'pending') { show('tg-bad'); return; }
    $('tg-server').textContent = data.server;
    $('tg-ask-nick').textContent = data.nick;
    show('tg-ask');

    $('tg-approve').onclick = async () => {
      $('tg-approve').disabled = true;
      const r = await api({ action: 'approve', token });
      $('tg-approve').disabled = false;
      if (r.ok && r.data.success) show('tg-done');
      else if (r.data.error === 'nick-taken') show('tg-taken');
      else show('tg-bad');
    };
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
        tg.showScanQrPopup({ text: 'Point at the sign-in code' }, onText);
      } catch (e) {
        $('tg-scan-note').hidden = false;
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

    /* opened straight from a t.me/...?startapp=mc_<token> link */
    const startParam = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
    const token = tokenFrom(`startapp=${startParam || ''}`);
    if (token) { openToken(token); return; }
    home();
  })();
})();
