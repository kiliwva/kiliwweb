import {
  json, storageReady, getSession, getUser, createSession, randomHex,
  afterAuthRedirect,
} from '../../lib/api.js';

/* QR sign-in: a computer shows a QR, a signed-in phone scans and
   approves, the computer's poll turns into a session.

   POST /api/qr { action: "create" }            → { token, poll } (computer)
   POST /api/qr { action: "approve", token }    → approve (signed-in phone)
   GET  /api/qr?token=..&poll=..                → pending | ok + cookie

   The QR encodes <origin>/qr#<token>; the poll key never leaves the
   computer, so watching someone's QR gives you nothing. */

const QR_TTL = 3 * 60 * 1000;

const key = (token) => `_auth/qr/${token}.json`;
const TOKEN_RE = /^[0-9a-f]{24,64}$/;

async function load(env, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const obj = await env.KILIW_FILES.get(key(token));
  if (!obj) return null;
  const data = await obj.json().catch(() => null);
  if (!data || data.expires < Date.now()) {
    await env.KILIW_FILES.delete(key(token)).catch(() => {});
    return null;
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');

  if (action === 'create') {
    /* a short channel token keeps the QR at a low version, so the
       center logo never covers an alignment pattern */
    const token = randomHex(12);
    const poll = randomHex(32);
    await env.KILIW_FILES.put(key(token), JSON.stringify({
      poll,
      status: 'pending',
      expires: Date.now() + QR_TTL,
    }));
    return json({ success: true, token, poll, ttl: QR_TTL });
  }

  if (action === 'approve') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const data = await load(env, body?.token);
    if (!data || data.status !== 'pending') {
      return json({ success: false, error: 'qr-expired' }, 410);
    }
    data.status = 'approved';
    data.email = session.email;
    await env.KILIW_FILES.put(key(body.token), JSON.stringify(data));
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const poll = String(url.searchParams.get('poll') || '');

  const data = await load(env, token);
  if (!data) return json({ success: true, status: 'expired' });
  if (data.poll !== poll) return json({ success: false, error: 'bad-request' }, 403);

  if (data.status !== 'approved') return json({ success: true, status: 'pending' });

  /* single use: the approval turns into a session exactly once */
  await env.KILIW_FILES.delete(key(token)).catch(() => {});
  const user = await getUser(env, data.email);
  if (!user || user.banned) return json({ success: true, status: 'expired' });

  const { cookie } = await createSession(env, data.email, request);
  return json(
    { success: true, status: 'ok', redirect: afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
