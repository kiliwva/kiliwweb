import {
  json, getSession, storageReady, getUser, putUser,
  hashPassword, timingSafeEqualHex, randomHex, notifyAccountEvent,
} from '../../lib/api.js';

/* POST /api/password — change password { current, next } */
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

  const current = String(body?.current || '');
  const next = String(body?.next || '');
  if (next.length < 8 || next.length > 256) {
    return json({ success: false, error: 'invalid-password' }, 400);
  }

  const user = await getUser(env, session.email);
  if (!user) return json({ success: false, error: 'unauthorized' }, 401);

  const currentHash = await hashPassword(current, user.salt);
  if (!timingSafeEqualHex(currentHash, user.hash)) {
    return json({ success: false, error: 'wrong-password' }, 403);
  }

  user.salt = randomHex(16);
  user.hash = await hashPassword(next, user.salt);
  await putUser(env, user);

  /* sign out every other session of this account */
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: '_auth/sessions/', cursor, limit: 1000 });
    for (const obj of page.objects) {
      if (obj.key === `_auth/sessions/${session.token}.json`) continue;
      const record = await env.KILIW_FILES.get(obj.key);
      if (!record) continue;
      try {
        if (JSON.parse(await record.text()).email === session.email) {
          await env.KILIW_FILES.delete(obj.key);
        }
      } catch { /* skip unreadable records */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await notifyAccountEvent(env, session.email, 'password-changed');
  return json({ success: true });
}
