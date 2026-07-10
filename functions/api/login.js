import {
  json, hashPassword, timingSafeEqualHex, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser,
} from '../../lib/api.js';

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body?.token, ip))) {
    return json({ success: false, error: 'captcha' }, 403);
  }

  const user = email ? await getUser(env, email) : null;
  if (!user) return json({ success: false, error: 'invalid-credentials' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqualHex(hash, user.hash)) {
    return json({ success: false, error: 'invalid-credentials' }, 401);
  }

  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
