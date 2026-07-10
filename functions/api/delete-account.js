import {
  json, getSession, storageReady, getUser, putUser, destroySession,
  authRedirect, verifyTotp, hashPassword, timingSafeEqualHex,
  mailReady, sendEmail, sixDigitCode, buildCodeEmail, wipeCollabForAccount,
} from '../../lib/api.js';

const CODE_TTL = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 60 * 1000;

function deletionEmail(code) {
  const { subject, html } = buildCodeEmail({
    subject: `${code} — confirm account deletion`,
    intro: 'Here is your account deletion code. Entering it will <span style="color:#FF7A5C;font-weight:700;">permanently delete your account and all files</span>.',
    note: "The code expires in 15 minutes. If you didn't request this, change your password immediately.",
    code,
  });
  const text = `Your Kiliw account deletion code: ${code}\n\nEntering it will permanently delete your account and all files. If you didn't request this, change your password immediately.`;
  return { subject, text, html };
}

async function wipePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.KILIW_FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function wipeAccount(env, email) {
  await wipePrefix(env, `u/${email}/`);

  /* public share links (records first, then the file index) */
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: `_share/f/${email}/`, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      const token = rec ? (await rec.text()).trim() : '';
      if (token) await env.KILIW_FILES.delete(`_share/t/${token}.json`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await wipePrefix(env, `_share/f/${email}/`);
  await wipePrefix(env, `_mod/${email}/`); // cached image-moderation verdicts

  /* folder edit grants, in both directions */
  await wipeCollabForAccount(env, email);

  /* every session of this account */
  cursor = undefined;
  do {
    const page = await env.KILIW_FILES.list({ prefix: '_auth/sessions/', cursor, limit: 1000 });
    for (const obj of page.objects) {
      const record = await env.KILIW_FILES.get(obj.key);
      if (!record) continue;
      try {
        if (JSON.parse(await record.text()).email === email) {
          await env.KILIW_FILES.delete(obj.key);
        }
      } catch { /* skip unreadable */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await env.KILIW_FILES.delete(`_auth/avatars/${email}`);
  await env.KILIW_FILES.delete(`_auth/pending/${email}.json`);
  await env.KILIW_FILES.delete(`_auth/users/${email}.json`);
}

/* POST /api/delete-account
   { action: "start" }                       → which confirmation method to use
   { action: "confirm", code? , password? }  → verify and wipe everything */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const user = await getUser(env, session.email);
  if (!user) return json({ success: false, error: 'unauthorized' }, 401);

  const action = String(body?.action || '');

  if (action === 'start') {
    if (user.totp) return json({ success: true, method: 'totp' });

    if (mailReady(env)) {
      const now = Date.now();
      if (!user.deleteCode || now - user.deleteCode.lastSent >= RESEND_COOLDOWN
        || user.deleteCode.expires < now) {
        user.deleteCode = {
          code: sixDigitCode(),
          expires: now + CODE_TTL,
          attempts: 0,
          lastSent: now,
        };
        await putUser(env, user);
        const mail = deletionEmail(user.deleteCode.code);
        const sent = await sendEmail(env, session.email, mail.subject, mail.text, mail.html);
        if (!sent) return json({ success: false, error: 'mail-failed' }, 502);
      }
      const payload = { success: true, method: 'email' };
      if (env.MAIL_DEBUG === '1') payload.debugCode = user.deleteCode.code;
      return json(payload);
    }

    return json({ success: true, method: 'password' });
  }

  if (action === 'confirm') {
    let ok = false;

    if (user.totp) {
      ok = await verifyTotp(user.totp, body?.code);
      if (!ok) return json({ success: false, error: 'totp-invalid' }, 403);
    } else if (mailReady(env)) {
      const dc = user.deleteCode;
      if (!dc || dc.expires < Date.now()) {
        delete user.deleteCode;
        await putUser(env, user);
        return json({ success: false, error: 'code-expired' }, 403);
      }
      if (dc.attempts >= MAX_ATTEMPTS) {
        delete user.deleteCode;
        await putUser(env, user);
        return json({ success: false, error: 'too-many' }, 429);
      }
      const code = String(body?.code || '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(code) || !timingSafeEqualHex(dc.code, code)) {
        dc.attempts += 1;
        await putUser(env, user);
        return json({ success: false, error: 'code-invalid' }, 403);
      }
      ok = true;
    } else {
      const hash = await hashPassword(String(body?.password || ''), user.salt);
      if (!timingSafeEqualHex(hash, user.hash)) {
        return json({ success: false, error: 'wrong-password' }, 403);
      }
      ok = true;
    }

    if (!ok) return json({ success: false, error: 'bad-request' }, 400);

    await wipeAccount(env, session.email);
    const cookie = await destroySession(request, env); // session file is gone; clears the cookie
    return json(
      { success: true, redirect: authRedirect(request) },
      200,
      { 'Set-Cookie': cookie },
    );
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
