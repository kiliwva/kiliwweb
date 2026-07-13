import {
  json, hashPassword, timingSafeEqualHex, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser, putUser, verifyTotp, wipeAccount,
  createCaptchaTicket, checkCaptchaTicket, deleteCaptchaTicket,
  mailReady, sendEmail, sixDigitCode, buildCodeEmail,
} from '../../lib/api.js';

const LOGIN_CODE_TTL = 10 * 60 * 1000;
const LOGIN_CODE_COOLDOWN = 60 * 1000;
const LOGIN_CODE_ATTEMPTS = 5;

function loginCodeEmail(code) {
  const { subject, html } = buildCodeEmail({
    subject: `${code} — your K-ID sign-in code`,
    intro: 'Someone is signing in to your Kiliw account. Enter this code to finish signing in.',
    note: "If this wasn't you, someone knows your password — change it right away.",
    code,
  });
  const text = `Your K-ID sign-in code: ${code}\n\nIt expires in 10 minutes. If this wasn't you, change your password.`;
  return { subject, text, html };
}

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

  /* second factor: TOTP if enabled, otherwise an emailed code; a passkey
     (offered by the client first) skips both */
  if (user.totp) {
    const code = String(body?.code || '');
    if (!code) {
      return json({
        success: false,
        error: 'totp-required',
        ctx: ticketOk ? ctx : await createCaptchaTicket(env, email),
        passkey: Boolean(user.passkeys && user.passkeys.length),
      }, 401);
    }
    if (!(await verifyTotp(user.totp, code))) {
      return json({ success: false, error: 'totp-invalid' }, 401);
    }
  } else if (mailReady(env)) {
    const code = String(body?.code || '').replace(/\s/g, '');
    if (!code) {
      const now = Date.now();
      if (!user.loginCode || now - (user.loginCode.lastSent || 0) >= LOGIN_CODE_COOLDOWN
        || user.loginCode.expires < now) {
        user.loginCode = {
          code: sixDigitCode(),
          expires: now + LOGIN_CODE_TTL,
          attempts: 0,
          lastSent: now,
        };
        await putUser(env, user);
        const mail = loginCodeEmail(user.loginCode.code);
        await sendEmail(env, email, mail.subject, mail.text, mail.html);
      }
      const payload = {
        success: false,
        error: 'email-code-required',
        ctx: ticketOk ? ctx : await createCaptchaTicket(env, email),
        passkey: Boolean(user.passkeys && user.passkeys.length),
      };
      if (env.MAIL_DEBUG === '1') payload.debugCode = user.loginCode.code;
      return json(payload, 401);
    }
    const lc = user.loginCode;
    if (!lc || lc.expires < Date.now()) {
      return json({ success: false, error: 'code-expired' }, 403);
    }
    if (lc.attempts >= LOGIN_CODE_ATTEMPTS) {
      delete user.loginCode;
      await putUser(env, user);
      return json({ success: false, error: 'too-many' }, 429);
    }
    if (!/^\d{6}$/.test(code) || !timingSafeEqualHex(lc.code, code)) {
      lc.attempts += 1;
      await putUser(env, user);
      return json({ success: false, error: 'code-invalid' }, 403);
    }
    delete user.loginCode;
    await putUser(env, user);
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
