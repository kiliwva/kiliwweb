import {
  json, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser, putUser,
  mailReady, sendEmail, newPending, putPending, verificationEmail,
} from '../../lib/api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Passwordless sign-up: the account is created once the emailed
   verification code is confirmed. There is no password — the account
   later secures itself with a passkey or an authenticator app. */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ success: false, error: 'invalid-email' }, 400);
  }

  /* Turnstile is best-effort: verify a token when the widget produced one,
     but do not wedge sign-up where the challenge could not load */
  if (body?.token) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const captcha = await verifyTurnstile(env, body.token, ip);
    if (!captcha.ok) {
      return json({ success: false, error: 'captcha', detail: captcha.codes }, 403);
    }
  }

  if (await getUser(env, email)) {
    return json({ success: false, error: 'user-exists' }, 409);
  }

  /* email verification: park the registration until the code is entered */
  if (mailReady(env)) {
    const pending = newPending(email, null, null);
    await putPending(env, pending);
    const mail = verificationEmail(pending.code);
    const sent = await sendEmail(env, email, mail.subject, mail.text, mail.html);
    if (!sent) return json({ success: false, error: 'mail-failed' }, 502);
    const payload = { success: true, verify: true };
    if (env.MAIL_DEBUG === '1') payload.debugCode = pending.code;
    return json(payload);
  }

  /* mail not configured: create the account directly */
  await putUser(env, { email, created: Date.now() });
  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
