import {
  json, getSession, storageReady, getUser, putUser, randomHex,
  yookassaReady, yookassaRequest, applyPayment, proPrice, planLimits,
  PRO_DAYS,
} from '../../lib/api.js';

/* POST /api/billing
   { action: "create", gb }  → YooKassa payment, returns confirmation url
   { action: "check" }       → checks the user's pending payment */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  if (!yookassaReady(env)) return json({ success: false, error: 'billing-not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const user = await getUser(env, session.email);
  if (!user) return json({ success: false, error: 'unauthorized' }, 401);

  const action = String(body?.action || '');

  if (action === 'create') {
    const gb = Math.round(Number(body?.gb));
    const price = proPrice(gb);
    if (!price) return json({ success: false, error: 'bad-request' }, 400);
    const origin = new URL(request.url).origin;

    const { ok, data } = await yookassaRequest(env, 'POST', '/payments', {
      amount: { value: price.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: `${origin}/?payment=return` },
      description: `Kiliw Cloud Pro — ${gb} GB, ${PRO_DAYS} days (${session.email})`,
      metadata: { email: session.email, gb: String(gb) },
    }, randomHex(16));

    if (!ok || !data?.confirmation?.confirmation_url) {
      return json({ success: false, error: 'payment-failed' }, 502);
    }

    user.pendingPayment = data.id;
    await putUser(env, user);
    return json({ success: true, url: data.confirmation.confirmation_url });
  }

  if (action === 'check') {
    if (!user.pendingPayment) {
      return json({ success: true, state: 'none', plan: planLimits(user) });
    }
    const { ok, data } = await yookassaRequest(env, 'GET', `/payments/${user.pendingPayment}`);
    if (!ok || !data) return json({ success: false, error: 'payment-failed' }, 502);

    if (data.status === 'succeeded') {
      await applyPayment(env, data);
      const fresh = await getUser(env, session.email);
      return json({ success: true, state: 'succeeded', plan: planLimits(fresh) });
    }
    if (data.status === 'canceled') {
      delete user.pendingPayment;
      await putUser(env, user);
      return json({ success: true, state: 'canceled', plan: planLimits(user) });
    }
    return json({ success: true, state: 'pending', plan: planLimits(user) });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
