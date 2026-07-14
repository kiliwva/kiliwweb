import {
  json, storageReady, randomHex, hashPassword, timingSafeEqualHex,
  getMcAccUser, putMcAccUser, createMcAccSession, getMcAccSession, destroyMcAccSession,
} from '../../lib/api.js';

/* Stand-alone Minecraft account auth (email + password), separate from
   the main K-ID accounts. Used by the /mc join page on mcid.<domain>.

     POST /api/mcauth { action: "register", email, password }
     POST /api/mcauth { action: "login",    email, password }
     POST /api/mcauth { action: "logout" }
     GET  /api/mcauth?me=1  → { authed, email } */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (action === 'register') {
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return json({ success: false, error: 'invalid-email' }, 400);
    }
    if (password.length < 8 || password.length > 256) {
      return json({ success: false, error: 'invalid-password' }, 400);
    }
    if (await getMcAccUser(env, email)) {
      return json({ success: false, error: 'user-exists' }, 409);
    }
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    await putMcAccUser(env, { email, salt, hash, created: Date.now() });
    const { cookie } = await createMcAccSession(env, email, request);
    return json({ success: true, email }, 200, { 'Set-Cookie': cookie });
  }

  if (action === 'login') {
    const user = await getMcAccUser(env, email);
    if (!user) return json({ success: false, error: 'bad-credentials' }, 401);
    const hash = await hashPassword(password, user.salt);
    if (!timingSafeEqualHex(hash, user.hash)) {
      return json({ success: false, error: 'bad-credentials' }, 401);
    }
    const { cookie } = await createMcAccSession(env, email, request);
    return json({ success: true, email }, 200, { 'Set-Cookie': cookie });
  }

  if (action === 'logout') {
    const cookie = await destroyMcAccSession(request, env);
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);
  if (url.searchParams.get('me') === '1') {
    const s = await getMcAccSession(request, env);
    return json({ success: true, authed: Boolean(s), email: s ? s.email : null });
  }
  return json({ success: false, error: 'bad-request' }, 400);
}
