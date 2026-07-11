import {
  json, storageReady, getUser, putUser, randomHex, hashPassword,
  mailReady, sendEmail, sixDigitCode, buildCodeEmail, timingSafeEqualHex,
  verifyTurnstile, wipeSessionsFor, createSession, afterAuthRedirect,
  notifyAccountEvent,
} from '../../lib/api.js';

const CODE_TTL = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 60 * 1000;

function resetEmail(code) {
  const { subject, html } = buildCodeEmail({
    subject: `${code} — reset your password`,
    intro: 'Here is your password reset code. Enter it on the reset page together with your new password.',
    note: "The code expires in 15 minutes. If you didn't request a reset, you can safely ignore this email — your password stays unchanged.",
    code,
  });
  const text = `Your Kiliw password reset code: ${code}\n\nIt expires in 15 minutes. If you didn't request a reset, ignore this email.`;
  return { subject, text, html };
}

/* POST /api/reset
   { action: "start", email, token }              → send a 6-digit code
   { action: "confirm", email, code, password }   → set the new password */
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
  if (!email) return json({ success: false, error: 'bad-request' }, 400);

  if (action === 'start') {
    if (!mailReady(env)) return json({ success: false, error: 'mail-not-configured' }, 503);

    /* the reset page is public: a captcha keeps it from becoming a
       free email-bombing endpoint */
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const captcha = await verifyTurnstile(env, body?.token, ip);
    if (!captcha.ok) return json({ success: false, error: 'captcha' }, 403);

    const user = await getUser(env, email);
    /* unknown address → the same success reply: account existence is
       not disclosed to strangers */
    if (user) {
      const now = Date.now();
      if (!user.resetCode || now - user.resetCode.lastSent >= RESEND_COOLDOWN
        || user.resetCode.expires < now) {
        user.resetCode = {
          code: sixDigitCode(),
          expires: now + CODE_TTL,
          attempts: 0,
          lastSent: now,
        };
        await putUser(env, user);
        const mail = resetEmail(user.resetCode.code);
        await sendEmail(env, email, mail.subject, mail.text, mail.html);
      }
    }
    const payload = { success: true };
    if (env.MAIL_DEBUG === '1' && user?.resetCode) payload.debugCode = user.resetCode.code;
    return json(payload);
  }

  if (action === 'confirm') {
    const password = String(body?.password || '');
    if (password.length < 8) return json({ success: false, error: 'invalid-password' }, 400);

    const user = await getUser(env, email);
    const rc = user?.resetCode;
    if (!user || !rc || rc.expires < Date.now()) {
      return json({ success: false, error: 'code-expired' }, 403);
    }
    if (rc.attempts >= MAX_ATTEMPTS) {
      delete user.resetCode;
      await putUser(env, user);
      return json({ success: false, error: 'too-many' }, 429);
    }
    const code = String(body?.code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code) || !timingSafeEqualHex(rc.code, code)) {
      rc.attempts += 1;
      await putUser(env, user);
      return json({ success: false, error: 'code-invalid' }, 403);
    }

    /* proven ownership: set the new password, drop every old session */
    user.salt = randomHex(16);
    user.hash = await hashPassword(password, user.salt);
    delete user.resetCode;
    /* a pending account deletion is cancelled by a successful reset */
    const restored = Boolean(user.deleteAt && user.deleteAt > Date.now());
    if (user.deleteAt && user.deleteAt <= Date.now()) {
      return json({ success: false, error: 'code-expired' }, 403);
    }
    delete user.deleteAt;
    await putUser(env, user);
    await wipeSessionsFor(env, email);
    await notifyAccountEvent(env, email, 'password-reset');

    const { cookie } = await createSession(env, email, request);
    return json(
      { success: true, redirect: afterAuthRedirect(request), restored },
      200,
      { 'Set-Cookie': cookie },
    );
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
