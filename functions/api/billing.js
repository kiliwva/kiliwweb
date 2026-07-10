import {
  json, getSession, storageReady, getUser, putUser, randomHex,
  yookassaReady, yookassaRequest, applyPayment, applyProPurchase,
  heleketReady, heleketRequest, heleketOutcome,
  proPrice, planLimits, PRO_DAYS, RUB_PER_USD,
} from '../../lib/api.js';

/* POST /api/billing
   { action: "create", gb, method: "yookassa" | "heleket" } → payment url
   { action: "check" }                                      → pending payment state */
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

  if (action === 'create') {
    const gb = Math.round(Number(body?.gb));
    const price = proPrice(gb);
    if (!price) return json({ success: false, error: 'bad-request' }, 400);

    const method = String(body?.method || 'yookassa');

    if (method === 'yookassa') {
      if (!yookassaReady(env)) return json({ success: false, error: 'billing-not-configured' }, 503);

      const rub = Math.round(price * RUB_PER_USD);
      const { ok, data } = await yookassaRequest(env, 'POST', '/payments', {
        amount: { value: rub.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${origin}/?payment=return` },
        description: `Kiliw Cloud Pro — ${gb} GB, ${PRO_DAYS} days ($${price}) — ${session.email}`,
        metadata: { email: session.email, gb: String(gb) },
      }, randomHex(16));

      if (!ok || !data?.confirmation?.confirmation_url) {
        return json({ success: false, error: 'payment-failed' }, 502);
      }
      user.pendingPayment = { provider: 'yookassa', id: data.id, gb };
      await putUser(env, user);
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
        additional_data: JSON.stringify({ email: session.email, gb }),
      });

      if (!ok || !data?.result?.url) {
        return json({ success: false, error: 'payment-failed' }, 502);
      }
      user.pendingPayment = { provider: 'heleket', id: data.result.uuid, gb };
      await putUser(env, user);
      return json({ success: true, url: data.result.url });
    }

    return json({ success: false, error: 'bad-request' }, 400);
  }

  if (action === 'check') {
    const pending = typeof user.pendingPayment === 'string'
      ? { provider: 'yookassa', id: user.pendingPayment }
      : user.pendingPayment;
    if (!pending?.id) {
      return json({ success: true, state: 'none', plan: planLimits(user) });
    }

    let state = 'pending';
    if (pending.provider === 'heleket') {
      const { ok, data } = await heleketRequest(env, '/payment/info', { uuid: pending.id });
      if (!ok || !data?.result) return json({ success: false, error: 'payment-failed' }, 502);
      state = heleketOutcome(data.result.payment_status);
      if (state === 'succeeded') {
        await applyProPurchase(env, session.email, pending.gb, pending.id);
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
    return json({ success: true, state, plan: planLimits(fresh) });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
