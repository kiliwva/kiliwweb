import {
  json, createSession, verifyTurnstile, afterAuthRedirect,
  storageReady, getUser, putUser, verifyTotp, wipeAccount,
  createCaptchaTicket, checkCaptchaTicket, deleteCaptchaTicket,
  mailReady, sendEmail, sixDigitCode, buildCodeEmail, getCookie, timingSafeEqualHex,
} from '../../lib/api.js';

/* a Minecraft join link parks its token here so login returns to /mc */
function mcNextRedirect(request) {
  const t = getCookie(request, 'kiliw_next');
  return t && /^[0-9a-f]{24,64}$/.test(t) ? `/mc#${t}` : null;
}

const LOGIN_CODE_TTL = 10 * 60 * 1000;
const LOGIN_CODE_COOLDOWN = 60 * 1000;
const LOGIN_CODE_ATTEMPTS = 5;

function loginCodeEmail(code) {
  const { subject, html } = buildCodeEmail({
    subject: `${code} — your K-ID sign-in code`,
    intro: 'Someone is signing in to your Kiliw account. Enter this code to finish signing in.',
    note: "If this wasn't you, just ignore this email — nobody can sign in without the code.",
    code,
  });
  const text = `Your K-ID sign-in code: ${code}\n\nIt expires in 10 minutes. If this wasn't you, ignore this email.`;
  return { subject, text, html };
}

/* email a fresh sign-in code, respecting the resend cooldown */
async function sendLoginCode(env, user, email) {
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
}

/* Passwordless sign-in. There is no password: the account proves itself
   with a passkey (handled by /api/passkeys), a code from an authenticator
   app, or a one-time code emailed to the address.

   Step 1  POST { email, token }               → email a code, or ask for
                                                  the authenticator code
           POST { email, token, wantEmail:1 }  → force the emailed code
   Step 2  POST { email, code, ctx }           → verify and sign in */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '').replace(/\s/g, '');
  const wantEmail = Boolean(body?.wantEmail);

  /* a code retry carries the ticket issued below instead of a fresh
     captcha token (Turnstile tokens are single-use) */
  const ctx = String(body?.ctx || '');
  const ticketOk = ctx ? await checkCaptchaTicket(env, ctx, email) : false;
  /* Turnstile is best-effort: reject a token that fails, but let requests
     through where the widget could not load (some regions / hosts) so
     sign-in is never wedged. A bad code still gets nobody in. */
  if (!ticketOk && body?.token) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const captcha = await verifyTurnstile(env, body.token, ip);
    if (!captcha.ok) {
      return json({ success: false, error: 'captcha', detail: captcha.codes }, 403);
    }
  }

  const user = email ? await getUser(env, email) : null;
  if (!user) return json({ success: false, error: 'invalid-credentials' }, 401);
  if (user.banned) return json({ success: false, error: 'banned' }, 403);

  const hasTotp = Boolean(user.totp);
  const hasPasskey = Boolean(user.passkeys && user.passkeys.length);
  const canMail = mailReady(env);

  /* step 1: no code yet — pick the challenge */
  if (!code) {
    /* an authenticator app is the primary factor when set up; the emailed
       code is offered as a fallback the client can ask for */
    if (hasTotp && !wantEmail) {
      return json({
        success: false,
        error: 'totp-required',
        ctx: ticketOk ? ctx : await createCaptchaTicket(env, email),
        passkey: hasPasskey,
        canEmail: canMail,
      }, 401);
    }
    if (canMail) {
      await sendLoginCode(env, user, email);
      const payload = {
        success: false,
        error: 'email-code-required',
        ctx: ticketOk ? ctx : await createCaptchaTicket(env, email),
        passkey: hasPasskey,
      };
      if (env.MAIL_DEBUG === '1') payload.debugCode = user.loginCode.code;
      return json(payload, 401);
    }
    /* no mail and no authenticator: a passkey is the only way in */
    return json({ success: false, error: 'no-factor', passkey: hasPasskey }, 401);
  }

  /* step 2: verify the code — accept the authenticator code or the
     emailed one, whichever the account can produce */
  let verified = false;
  if (hasTotp && /^\d{6}$/.test(code) && await verifyTotp(user.totp, code)) {
    verified = true;
  }
  if (!verified) {
    const lc = user.loginCode;
    if (lc && lc.expires >= Date.now()) {
      if (lc.attempts >= LOGIN_CODE_ATTEMPTS) {
        delete user.loginCode;
        await putUser(env, user);
        return json({ success: false, error: 'too-many' }, 429);
      }
      if (/^\d{6}$/.test(code) && timingSafeEqualHex(lc.code, code)) {
        verified = true;
        delete user.loginCode;
        await putUser(env, user);
      } else {
        lc.attempts += 1;
        await putUser(env, user);
      }
    }
  }
  if (!verified) return json({ success: false, error: 'code-invalid' }, 403);

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
    { success: true, redirect: mcNextRedirect(request) || afterAuthRedirect(request), restored },
    200,
    { 'Set-Cookie': cookie },
  );
}
