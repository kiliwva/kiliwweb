import { json, storageReady, yookassaReady, yookassaRequest, applyPayment } from '../../lib/api.js';

/* POST /api/yookassa — YooKassa webhook (payment.succeeded).
   The event body is untrusted: we re-fetch the payment from the
   YooKassa API by id and only then apply it. */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env) || !yookassaReady(env)) {
    return json({ success: false, error: 'not-configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const id = body?.object?.id;
  if (!id || typeof id !== 'string') return json({ success: false, error: 'bad-request' }, 400);

  const { ok, data } = await yookassaRequest(env, 'GET', `/payments/${encodeURIComponent(id)}`);
  if (!ok || !data) return json({ success: false, error: 'payment-failed' }, 502);

  await applyPayment(env, data);
  /* always 200 so YooKassa stops retrying once we have processed it */
  return json({ success: true });
}
