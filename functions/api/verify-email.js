import {
  json, storageReady, createSession, afterAuthRedirect, putUser, getUser,
  getPending, putPending, deletePending, sendEmail, verificationEmail, sixDigitCode,
  timingSafeEqualHex, getCookie,
} from '../../lib/api.js';

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 60 * 1000;

/* a Minecraft join link parks its token here so sign-up returns to /mc */
function mcNextRedirect(request) {
  const t = getCookie(request, 'kiliw_next');
  return t && /^[0-9a-f]{24,64}$/.test(t) ? `/mc#${t}` : null;
}

/* POST /api/verify-email
   { email, code }         → verify the code, create the account, sign in
   { email, resend: true } → send a fresh code (60 s cooldown) */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const pending = email ? await getPending(env, email) : null;
  if (!pending) return json({ success: false, error: 'no-pending' }, 400);

  if (body?.resend) {
    if (Date.now() - pending.lastSent < RESEND_COOLDOWN) {
      return json({ success: false, error: 'too-soon' }, 429);
    }
    pending.code = sixDigitCode();
    pending.lastSent = Date.now();
    pending.attempts = 0;
    await putPending(env, pending);
    const mail = verificationEmail(pending.code);
    const sent = await sendEmail(env, email, mail.subject, mail.text, mail.html);
    if (!sent) return json({ success: false, error: 'mail-failed' }, 502);
    const payload = { success: true, resent: true };
    if (env.MAIL_DEBUG === '1') payload.debugCode = pending.code;
    return json(payload);
  }

  const code = String(body?.code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return json({ success: false, error: 'code-invalid' }, 400);

  if (pending.attempts >= MAX_ATTEMPTS) {
    await deletePending(env, email);
    return json({ success: false, error: 'too-many' }, 429);
  }
  if (!timingSafeEqualHex(pending.code, code)) {
    pending.attempts += 1;
    await putPending(env, pending);
    return json({ success: false, error: 'code-invalid' }, 403);
  }

  /* verified: create the account (unless a race already did) and sign in.
     Passwordless accounts carry no salt/hash; a legacy pending that still
     has one keeps it so an in-flight sign-up survives the deploy. */
  if (!(await getUser(env, email))) {
    const record = { email, created: Date.now() };
    if (pending.hash) { record.salt = pending.salt; record.hash = pending.hash; }
    await putUser(env, record);
  }
  await deletePending(env, email);
  const { cookie } = await createSession(env, email, request);
  return json(
    { success: true, redirect: mcNextRedirect(request) || afterAuthRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
