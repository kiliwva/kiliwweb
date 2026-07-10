/* Kiliw Cloud — checkout page: /checkout.html?gb=<tier>
   Shows the live price (USD + RUB at the current rate), applies promo
   codes and redirects to the chosen payment provider. */

const t = (key, vars) => KiliwUI.t(key, vars);

const gb = Math.round(Number(new URLSearchParams(window.location.search).get('gb'))) || 250;
let quote = null;
let promo = ''; // applied promo code
let method = null;

const tierLabel = (n) => (n >= 1024 ? `${n / 1024} TB` : `${n} GB`);

function showStatus(id, message, ok = false) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = !message;
  el.classList.toggle('ok', ok);
}

function render() {
  document.getElementById('co-title').textContent = `${tierLabel(quote.gb)} — Kiliw Cloud Pro`;
  document.title = `${tierLabel(quote.gb)} — ${t('title.checkout')}`;

  const priceEl = document.getElementById('co-price');
  priceEl.textContent = `$${quote.base}`;
  priceEl.classList.toggle('struck', quote.percent > 0);
  document.getElementById('co-discount-row').hidden = !quote.percent;
  if (quote.percent) {
    document.getElementById('co-discount').textContent = `−${quote.percent}% (${quote.promo})`;
  }
  document.getElementById('co-total').textContent = `$${quote.price}`;
  const rub = document.getElementById('co-rub');
  rub.hidden = false;
  rub.textContent = t('checkout.rub', { rub: quote.rub.toLocaleString('en-US'), rate: quote.rate });

  /* payment methods availability */
  const cards = { yookassa: document.getElementById('pm-yookassa'), heleket: document.getElementById('pm-heleket') };
  for (const [name, el] of Object.entries(cards)) {
    el.classList.toggle('disabled', !quote.methods[name]);
  }
  if (!method || !quote.methods[method]) {
    method = quote.methods.yookassa ? 'yookassa' : quote.methods.heleket ? 'heleket' : null;
  }
  for (const [name, el] of Object.entries(cards)) {
    el.classList.toggle('selected', method === name);
  }
  document.getElementById('co-pay').disabled = !method;
  if (!quote.methods.yookassa && !quote.methods.heleket) {
    showStatus('co-status', t('plan.notConfigured'));
  }
}

async function loadQuote(promoCode) {
  const res = await fetch('/api/billing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'quote', gb, promo: promoCode || '' }),
  });
  if (res.status === 401) {
    window.location.href = '/';
    return false;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    if (data.error === 'promo-invalid') {
      showStatus('promo-status', t('checkout.promoInvalid'));
      return false;
    }
    window.location.href = '/'; // unknown tier or server trouble
    return false;
  }
  quote = data;
  promo = data.promo || '';
  render();
  return true;
}

document.getElementById('promo-apply').addEventListener('click', async () => {
  const code = document.getElementById('promo-input').value.trim();
  showStatus('promo-status', '');
  if (!code) return;
  if (await loadQuote(code)) {
    showStatus('promo-status', t('checkout.promoApplied', { percent: quote.percent }), true);
  }
});
document.getElementById('promo-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('promo-apply').click();
  }
});

['yookassa', 'heleket'].forEach((name) => {
  document.getElementById(`pm-${name}`).addEventListener('click', () => {
    if (!quote?.methods[name]) return;
    method = name;
    render();
  });
});

document.getElementById('co-pay').addEventListener('click', async () => {
  if (!method) return;
  const btn = document.getElementById('co-pay');
  btn.classList.add('loading');
  showStatus('co-status', '');
  try {
    const res = await fetch('/api/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', gb, method, promo }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success && data.url) {
      window.location.href = data.url;
      return;
    }
    showStatus('co-status', t(data.error === 'billing-not-configured' ? 'plan.notConfigured' : 'plan.fail'));
  } catch {
    showStatus('co-status', t('plan.fail'));
  } finally {
    btn.classList.remove('loading');
  }
});

loadQuote('');
