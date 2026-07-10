import {
  json, randomHex, hashPassword, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser, putUser,
  mailReady, sendEmail, newPending, putPending, verificationEmail,
} from '../../lib/api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ success: false, error: 'invalid-email' }, 400);
  }
  if (password.length < 8 || password.length > 256) {
    return json({ success: false, error: 'invalid-password' }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const captcha = await verifyTurnstile(env, body?.token, ip);
  if (!captcha.ok) {
    return json({ success: false, error: 'captcha', detail: captcha.codes }, 403);
  }

  if (await getUser(env, email)) {
    return json({ success: false, error: 'user-exists' }, 409);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);

  /* email verification: park the registration until the code is entered */
  if (mailReady(env)) {
    const pending = newPending(email, salt, hash);
    await putPending(env, pending);
    const mail = verificationEmail(pending.code);
    const sent = await sendEmail(env, email, mail.subject, mail.text, mail.html);
    if (!sent) return json({ success: false, error: 'mail-failed' }, 502);
    const payload = { success: true, verify: true };
    if (env.MAIL_DEBUG === '1') payload.debugCode = pending.code;
    return json(payload);
  }

  /* mail not configured: register directly */
  await putUser(env, { email, salt, hash, created: Date.now() });
  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
