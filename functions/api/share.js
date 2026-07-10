import {
  json, getSession, storageReady, parsePath,
  createShare, deleteShareForFile, shareTokenForFile, getShare, shareUrl,
} from '../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/share?p=folder/name.ext — the file's share state */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const p = parsePath(new URL(request.url).searchParams.get('p'));
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const token = await shareTokenForFile(env, session.email, p);
  const share = token ? await getShare(env, token) : null;
  if (!share) return json({ success: true, shared: false });
  return json({
    success: true,
    shared: true,
    url: shareUrl(request, share.token),
    protected: Boolean(share.hash),
  });
}

/* POST /api/share
   { action: "create", p, password? } → public link (replaces an existing one)
   { action: "remove", p }            → delete the link */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const p = parsePath(body?.p);
  if (!p) return json({ success: false, error: 'bad-name' }, 400);
  const action = String(body?.action || '');

  if (action === 'create') {
    const object = await env.KILIW_FILES.head(`u/${session.email}/${p}`);
    if (!object) return json({ success: false, error: 'not-found' }, 404);

    const password = typeof body?.password === 'string' ? body.password : '';
    if (password && password.length < 4) {
      return json({ success: false, error: 'password-short' }, 400);
    }
    const share = await createShare(env, session.email, p, password || null);
    return json({
      success: true,
      url: shareUrl(request, share.token),
      protected: Boolean(share.hash),
    });
  }

  if (action === 'remove') {
    await deleteShareForFile(env, session.email, p);
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
