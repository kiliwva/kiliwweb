import {
  json, getSession, storageReady, getUser, putUser,
  generateTotpSecret, verifyTotp, otpauthUri,
} from '../../lib/api.js';

/* POST /api/2fa — manage two-factor auth.
   { action: "setup" }                  → new pending secret + otpauth URI
   { action: "enable", code }           → confirm pending secret, turn 2FA on
   { action: "disable", code }          → verify code, turn 2FA off */
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

  if (action === 'setup') {
    if (user.totp) return json({ success: false, error: 'already-enabled' }, 409);
    user.totpPending = generateTotpSecret();
    await putUser(env, user);
    return json({
      success: true,
      secret: user.totpPending,
      uri: otpauthUri(user.email, user.totpPending),
    });
  }

  if (action === 'enable') {
    if (user.totp) return json({ success: false, error: 'already-enabled' }, 409);
    if (!user.totpPending) return json({ success: false, error: 'no-setup' }, 400);
    if (!(await verifyTotp(user.totpPending, body?.code))) {
      return json({ success: false, error: 'totp-invalid' }, 403);
    }
    user.totp = user.totpPending;
    delete user.totpPending;
    await putUser(env, user);
    return json({ success: true });
  }

  if (action === 'disable') {
    if (!user.totp) return json({ success: false, error: 'not-enabled' }, 400);
    if (!(await verifyTotp(user.totp, body?.code))) {
      return json({ success: false, error: 'totp-invalid' }, 403);
    }
    delete user.totp;
    delete user.totpPending;
    await putUser(env, user);
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
