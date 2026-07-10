import {
  json, getSession, storageReady, getUser, planLimits,
  createApiKey, listApiKeys, revokeApiKey,
} from '../../lib/api.js';

const MAX_KEYS = 5;

async function requireDev(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  const user = await getUser(env, session.email);
  const limits = planLimits(user, env);
  if (!limits.api) return { error: json({ success: false, error: 'plan-required' }, 403) };
  return { session };
}

const publicKey = (k) => ({ id: k.hash, name: k.name, prefix: k.prefix, created: k.created });

/* GET /api/apikeys — list keys (never the secrets) */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireDev(request, env);
  if (error) return error;
  const keys = await listApiKeys(env, session.email);
  return json({ success: true, keys: keys.map(publicKey) });
}

/* POST /api/apikeys
   { action: "create", name } → the secret, shown exactly once
   { action: "revoke", id }   */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireDev(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');

  if (action === 'create') {
    const existing = await listApiKeys(env, session.email);
    if (existing.length >= MAX_KEYS) return json({ success: false, error: 'too-many' }, 400);
    const key = await createApiKey(env, session.email, body?.name);
    return json({
      success: true,
      secret: key.secret,
      key: publicKey(key),
      keys: [...existing, key].map(publicKey),
    });
  }

  if (action === 'revoke') {
    await revokeApiKey(env, session.email, String(body?.id || ''));
    const keys = await listApiKeys(env, session.email);
    return json({ success: true, keys: keys.map(publicKey) });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
