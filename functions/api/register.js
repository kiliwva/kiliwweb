import {
  json, randomHex, hashPassword, createSession, verifyTurnstile, afterAuthRedirect,
} from '../../lib/api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  if (!env.KILIW_KV) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ success: false, error: 'invalid-email' }, 400);
  }
  if (password.length < 8 || password.length > 256) {
    return json({ success: false, error: 'invalid-password' }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body?.token, ip))) {
    return json({ success: false, error: 'captcha' }, 403);
  }

  if (await env.KILIW_KV.get(`user:${email}`)) {
    return json({ success: false, error: 'user-exists' }, 409);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.KILIW_KV.put(
    `user:${email}`,
    JSON.stringify({ email, salt, hash, created: Date.now() }),
  );

  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
