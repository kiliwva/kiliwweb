import {
  json, getSession, storageReady, getUser, putUser, randomHex,
  yookassaReady, yookassaRequest, applyPayment, applyProPurchase,
  heleketReady, heleketRequest, heleketOutcome,
  proPrice, planLimits, PRO_DAYS, PRO_TIERS, DEV_GB, DEV_PRICE,
  usdRubRate, validatePromo, bumpPromoUse, discountedPrice, normPromoCode,
} from '../../lib/api.js';

/** Tier + base price for a quote/create request: Pro by GB, or DEV. */
function pickTier(body) {
  if (body?.plan === 'dev') return { plan: 'dev', gb: DEV_GB, base: DEV_PRICE };
  const gb = Math.round(Number(body?.gb));
  const base = proPrice(gb);
  return base ? { plan: 'pro', gb, base } : null;
}

/* POST /api/billing
   { action: "quote", gb, promo? }          → price, live rate, methods
   { action: "create", gb, method, promo? } → payment url
   { action: "check" }                      → pending payment state */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const user = await getUser(env, session.email);
  if (!user) return json({ success: false, error: 'unauthorized' }, 401);

  const action = String(body?.action || '');
  const origin = new URL(request.url).origin;

  /* price + live exchange rate + promo validation for the checkout page */
  if (action === 'quote') {
    const tier = pickTier(body);
    if (!tier) return json({ success: false, error: 'bad-request' }, 400);
    const { plan, gb, base } = tier;

    const promoCode = normPromoCode(body?.promo);
    let promo = null;
    if (promoCode) {
      promo = await validatePromo(env, promoCode);
      if (!promo) return json({ success: false, error: 'promo-invalid' }, 400);
    }
    const price = discountedPrice(base, promo);
    const rate = await usdRubRate(env);

    return json({
      success: true,
      plan,
      gb,
      base,
      price,
      percent: promo?.percent || 0,
      promo: promo?.code || null,
      rate: Math.round(rate * 100) / 100,
      rub: Math.ceil(price * rate),
      days: PRO_DAYS,
      methods: { yookassa: yookassaReady(env), heleket: heleketReady(env) },
      tiers: Object.entries(PRO_TIERS).map(([g, p]) => ({ gb: Number(g), price: p })),
    });
  }

  if (action === 'create') {
    const tier = pickTier(body);
    if (!tier) return json({ success: false, error: 'bad-request' }, 400);
    const { plan, gb, base } = tier;

    /* promo discounts are recomputed server-side, never trusted from the client */
    const promoCode = normPromoCode(body?.promo);
    let promo = null;
    if (promoCode) {
      promo = await validatePromo(env, promoCode);
      if (!promo) return json({ success: false, error: 'promo-invalid' }, 400);
    }
    const price = discountedPrice(base, promo);
    const promoNote = promo ? ` (promo ${promo.code} −${promo.percent}%)` : '';

    const method = String(body?.method || 'yookassa');

    if (method === 'yookassa') {
      if (!yookassaReady(env)) return json({ success: false, error: 'billing-not-configured' }, 503);

      const rate = await usdRubRate(env);
      const rub = Math.ceil(price * rate);
      const { ok, data } = await yookassaRequest(env, 'POST', '/payments', {
        amount: { value: rub.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${origin}/?payment=return` },
        description: `Kiliw Cloud ${plan === 'dev' ? 'DEV' : 'Pro'} — ${gb} GB, ${PRO_DAYS} days ($${price}${promoNote}) — ${session.email}`,
        metadata: { email: session.email, gb: String(gb), plan },
      }, randomHex(16));

      if (!ok || !data?.confirmation?.confirmation_url) {
        return json({ success: false, error: 'payment-failed' }, 502);
      }
      user.pendingPayment = { provider: 'yookassa', id: data.id, gb, plan };
      await putUser(env, user);
      if (promo) await bumpPromoUse(env, promo.code);
      return json({ success: true, url: data.confirmation.confirmation_url });
    }

    if (method === 'heleket') {
      if (!heleketReady(env)) return json({ success: false, error: 'billing-not-configured' }, 503);

      const { ok, data } = await heleketRequest(env, '/payment', {
        amount: price.toFixed(2),
        currency: 'USD',
        order_id: `kiliw-${randomHex(10)}`,
        url_return: `${origin}/?payment=return`,
        url_callback: `${origin}/api/heleket`,
        additional_data: JSON.stringify({ email: session.email, gb, plan }),
      });

      if (!ok || !data?.result?.url) {
        return json({ success: false, error: 'payment-failed' }, 502);
      }
      user.pendingPayment = { provider: 'heleket', id: data.result.uuid, gb, plan };
      await putUser(env, user);
      if (promo) await bumpPromoUse(env, promo.code);
      return json({ success: true, url: data.result.url });
    }

    return json({ success: false, error: 'bad-request' }, 400);
  }

  if (action === 'check') {
    const pending = typeof user.pendingPayment === 'string'
      ? { provider: 'yookassa', id: user.pendingPayment }
      : user.pendingPayment;
    if (!pending?.id) {
      return json({ success: true, state: 'none', plan: planLimits(user, env) });
    }

    let state = 'pending';
    if (pending.provider === 'heleket') {
      const { ok, data } = await heleketRequest(env, '/payment/info', { uuid: pending.id });
      if (!ok || !data?.result) return json({ success: false, error: 'payment-failed' }, 502);
      state = heleketOutcome(data.result.payment_status);
      if (state === 'succeeded') {
        await applyProPurchase(env, session.email, pending.gb, pending.id, pending.plan);
      }
    } else {
      const { ok, data } = await yookassaRequest(env, 'GET', `/payments/${pending.id}`);
      if (!ok || !data) return json({ success: false, error: 'payment-failed' }, 502);
      if (data.status === 'succeeded') {
        state = 'succeeded';
        await applyPayment(env, data);
      } else if (data.status === 'canceled') {
        state = 'canceled';
      }
    }

    if (state === 'canceled') {
      delete user.pendingPayment;
      await putUser(env, user);
    }
    const fresh = await getUser(env, session.email);
    return json({ success: true, state, plan: planLimits(fresh, env) });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
