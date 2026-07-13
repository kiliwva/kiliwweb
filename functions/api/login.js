import {
  json, hashPassword, timingSafeEqualHex, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser, putUser, verifyTotp, wipeAccount,
  createCaptchaTicket, checkCaptchaTicket, deleteCaptchaTicket,
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

  /* a 2FA retry carries the ticket issued below instead of a fresh
     captcha token (Turnstile tokens are single-use) */
  const ctx = String(body?.ctx || '');
  const ticketOk = ctx ? await checkCaptchaTicket(env, ctx, email) : false;
  if (!ticketOk) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const captcha = await verifyTurnstile(env, body?.token, ip);
    if (!captcha.ok) {
      return json({ success: false, error: 'captcha', detail: captcha.codes }, 403);
    }
  }

  const user = email ? await getUser(env, email) : null;
  if (!user) return json({ success: false, error: 'invalid-credentials' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqualHex(hash, user.hash)) {
    return json({ success: false, error: 'invalid-credentials' }, 401);
  }
  if (user.banned) return json({ success: false, error: 'banned' }, 403);

  /* second factor */
  if (user.totp) {
    const code = String(body?.code || '');
    if (!code) {
      return json({
        success: false,
        error: 'totp-required',
        ctx: ticketOk ? ctx : await createCaptchaTicket(env, email),
        /* a passkey outranks the code: the client offers it first */
        passkey: Boolean(user.passkeys && user.passkeys.length),
      }, 401);
    }
    if (!(await verifyTotp(user.totp, code))) {
      return json({ success: false, error: 'totp-invalid' }, 401);
    }
  }
  if (ticketOk) await deleteCaptchaTicket(env, ctx);

  /* account scheduled for deletion: expired → gone; within the grace
     period a successful sign-in cancels the deletion */
  let restored = false;
  if (user.deleteAt) {
    if (user.deleteAt <= Date.now()) {
      await wipeAccount(env, email);
      return json({ success: false, error: 'invalid-credentials' }, 401);
    }
    delete user.deleteAt;
    await putUser(env, user);
    restored = true;
  }

  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: afterAuthRedirect(request), restored },
    200,
    { 'Set-Cookie': cookie },
  );
}
