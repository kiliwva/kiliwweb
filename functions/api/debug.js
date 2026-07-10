import { json, getSession, storageReady, getUser } from '../../lib/api.js';

/* GET /api/debug — session-protected server-state snapshot for support. */
export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);

  const user = await getUser(env, session.email);
  const head = await env.KILIW_FILES.head(`_auth/avatars/${session.email}`);

  return json({
    build: 25,
    email: session.email,
    userRecordFound: Boolean(user),
    avatarField: user?.avatar ?? null,
    totpEnabled: Boolean(user?.totp),
    plan: user?.plan ?? 'free',
    avatarObjectExists: Boolean(head),
    avatarObjectSize: head?.size ?? null,
    avatarObjectType: head?.httpMetadata?.contentType ?? null,
    avatarObjectUploaded: head?.uploaded ?? null,
  });
}
