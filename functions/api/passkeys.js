import {
  json, getSession, storageReady, getUser, putUser, createSession,
  afterAuthRedirect, deviceLabel, wipeAccount, notifyAccountEvent,
} from '../../lib/api.js';
import {
  createChallenge, takeChallenge, rpIdFor, b64uEncode,
  verifyRegistration, verifyAssertion,
} from '../../lib/webauthn.js';

/* Passkeys (WebAuthn):
   GET  /api/passkeys                       → list (session)
   POST { action: "reg-options" }           → creation options (session)
   POST { action: "reg-verify", ctx, credential, name? } → store (session)
   POST { action: "remove", id }            → delete one (session)
   POST { action: "login-options" }         → assertion options (no session)
   POST { action: "login-verify", ctx, credential } → sign in (no session) */

const MAX_PASSKEYS = 5;

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);
  const user = await getUser(env, session.email);
  const passkeys = (user?.passkeys || []).map((pk) => ({
    id: pk.id, name: pk.name, created: pk.created,
  }));
  return json({ success: true, passkeys });
}

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');
  const rpId = rpIdFor(new URL(request.url).hostname);

  /* --- signed-in: manage passkeys --- */
  if (action === 'reg-options' || action === 'reg-verify' || action === 'remove') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const user = await getUser(env, session.email);
    if (!user) return json({ success: false, error: 'unauthorized' }, 401);

    if (action === 'reg-options') {
      const emailBytes = new TextEncoder().encode(session.email);
      if (emailBytes.length > 64) return json({ success: false, error: 'email-too-long' }, 400);
      if ((user.passkeys || []).length >= MAX_PASSKEYS) {
        return json({ success: false, error: 'too-many' }, 400);
      }
      const { ctx, challenge } = await createChallenge(env, 'reg', session.email);
      return json({
        success: true,
        ctx,
        options: {
          challenge,
          rp: { id: rpId, name: 'Kiliw Cloud' },
          user: { id: b64uEncode(emailBytes), name: session.email, displayName: session.email },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          excludeCredentials: (user.passkeys || []).map((pk) => ({ type: 'public-key', id: pk.id })),
        },
      });
    }

    if (action === 'reg-verify') {
      const ch = await takeChallenge(env, body?.ctx, 'reg');
      if (!ch || ch.email !== session.email) return json({ success: false, error: 'challenge-expired' }, 400);
      const result = await verifyRegistration(env, rpId, ch.challenge, body?.credential || {});
      if (result.error) return json({ success: false, error: result.error }, 400);

      user.passkeys = user.passkeys || [];
      if (user.passkeys.some((pk) => pk.id === result.id)) {
        return json({ success: false, error: 'exists' }, 409);
      }
      const name = String(body?.name || '').slice(0, 60) || deviceLabel(request);
      user.passkeys.push({ ...result, name, created: Date.now() });
      await putUser(env, user);
      await notifyAccountEvent(env, session.email, 'passkey-added', { name });
      return json({ success: true, id: result.id, name });
    }

    if (action === 'remove') {
      const id = String(body?.id || '');
      const before = (user.passkeys || []).length;
      const removed = (user.passkeys || []).find((pk) => pk.id === id);
      user.passkeys = (user.passkeys || []).filter((pk) => pk.id !== id);
      if (user.passkeys.length === before) return json({ success: false, error: 'not-found' }, 404);
      await putUser(env, user);
      await notifyAccountEvent(env, session.email, 'passkey-removed', { name: removed?.name || '' });
      return json({ success: true });
    }
  }

  /* --- signed-out: passkey sign-in --- */
  if (action === 'login-options') {
    const { ctx, challenge } = await createChallenge(env, 'login');
    return json({
      success: true,
      ctx,
      options: {
        challenge,
        rpId,
        timeout: 60000,
        userVerification: 'preferred',
        /* empty allowCredentials → the browser offers discoverable passkeys */
        allowCredentials: [],
      },
    });
  }

  if (action === 'login-verify') {
    const ch = await takeChallenge(env, body?.ctx, 'login');
    if (!ch) return json({ success: false, error: 'challenge-expired' }, 400);

    const credential = body?.credential || {};
    const userHandle = credential.response?.userHandle;
    if (!userHandle) return json({ success: false, error: 'no-user-handle' }, 400);
    let email;
    try {
      email = new TextDecoder().decode(
        Uint8Array.from(atob(String(userHandle).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ).toLowerCase();
    } catch {
      return json({ success: false, error: 'bad-request' }, 400);
    }

    const user = await getUser(env, email);
    const stored = user?.passkeys?.find((pk) => pk.id === credential.id);
    if (!user || !stored) return json({ success: false, error: 'unknown-passkey' }, 401);

    const result = await verifyAssertion(rpId, ch.challenge, stored, credential);
    if (result.error) return json({ success: false, error: result.error }, 401);

    /* account scheduled for deletion: same rules as password sign-in */
    let restored = false;
    if (user.deleteAt) {
      if (user.deleteAt <= Date.now()) {
        await wipeAccount(env, email);
        return json({ success: false, error: 'unknown-passkey' }, 401);
      }
      delete user.deleteAt;
      restored = true;
    }

    stored.counter = result.counter || stored.counter;
    await putUser(env, user);

    const { cookie } = await createSession(env, email, request);
    return json(
      { success: true, redirect: afterAuthRedirect(request), restored },
      200,
      { 'Set-Cookie': cookie },
    );
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
