import { json, getSession, storageReady, getUser, putUser } from '../../lib/api.js';

const MAX_AVATAR = 3 * 1024 * 1024; // 3 MB (client downscales to 256px anyway)

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/avatar?v=<ts> — the current user's avatar image */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const object = await env.KILIW_FILES.get(`_auth/avatars/${session.email}`);
  if (!object) return json({ success: false, error: 'not-found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', 'image/jpeg');
  headers.set('Content-Length', String(object.size));
  /* the URL carries a version param, so the response can be cached hard */
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

/* POST /api/avatar — replace the avatar (body = image) */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('image/')) return json({ success: false, error: 'bad-type' }, 400);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_AVATAR) return json({ success: false, error: 'too-large' }, 413);

  await env.KILIW_FILES.put(`_auth/avatars/${session.email}`, request.body, {
    httpMetadata: { contentType: type },
  });

  const user = await getUser(env, session.email);
  if (!user) return json({ success: false, error: 'no-user' }, 500);
  user.avatar = Date.now();
  await putUser(env, user);
  return json({ success: true, avatar: user.avatar });
}
