import {
  json, storageReady, heleketReady, heleketRequest, heleketOutcome, applyProPurchase,
} from '../../lib/api.js';

/* POST /api/heleket — Heleket payment webhook.
   The callback body is untrusted: we re-fetch the invoice from the
   Heleket API by uuid and only then apply it. */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env) || !heleketReady(env)) {
    return json({ success: false, error: 'not-configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const uuid = body?.uuid || body?.result?.uuid;
  if (!uuid || typeof uuid !== 'string') return json({ success: false, error: 'bad-request' }, 400);

  const { ok, data } = await heleketRequest(env, '/payment/info', { uuid });
  if (!ok || !data?.result) return json({ success: false, error: 'payment-failed' }, 502);

  if (heleketOutcome(data.result.payment_status) === 'succeeded') {
    let meta = {};
    try {
      meta = JSON.parse(data.result.additional_data || '{}');
    } catch { /* no metadata */ }
    await applyProPurchase(env, meta.email, Number(meta.gb), uuid, meta.plan === 'dev' ? 'dev' : 'pro');
  }
  return json({ success: true });
}
