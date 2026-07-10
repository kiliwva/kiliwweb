import {
  json, getSession, storageReady, parsePath, getUser,
  createShare, deleteShareForFile, shareTokenForFile, getShare, shareUrl,
  moderateShare, saveShare,
} from '../../lib/api.js';

const MAX_ALLOWED = 50;

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
    access: share.access === 'restricted' ? 'restricted' : 'public',
    allowed: share.allowed || [],
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
    const folder = body?.folder === true;
    if (folder) {
      /* the folder must actually exist */
      const page = await env.KILIW_FILES.list({ prefix: `u/${session.email}/${p}/`, limit: 1 });
      if (!page.objects.length) return json({ success: false, error: 'not-found' }, 404);
    } else {
      const object = await env.KILIW_FILES.head(`u/${session.email}/${p}`);
      if (!object) return json({ success: false, error: 'not-found' }, 404);
    }

    const access = body?.access === 'restricted' ? 'restricted' : 'public';
    const password = access === 'public' && typeof body?.password === 'string' ? body.password : '';
    if (password && password.length < 4) {
      return json({ success: false, error: 'password-short' }, 400);
    }
    const share = await createShare(env, session.email, p, password || null, folder, access);
    /* content-based 18+ check for images, remembered on the record */
    if (!folder) await moderateShare(env, share);
    return json({
      success: true,
      url: shareUrl(request, share.token),
      protected: Boolean(share.hash),
      access,
      allowed: share.allowed || [],
      sensitive: share.sensitive === true,
    });
  }

  if (action === 'remove') {
    await deleteShareForFile(env, session.email, p);
    return json({ success: true });
  }

  /* manage who can open a restricted link */
  if (action === 'allow-add' || action === 'allow-remove') {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return json({ success: false, error: 'bad-request' }, 400);

    const token = await shareTokenForFile(env, session.email, p);
    const share = token ? await getShare(env, token) : null;
    if (!share || share.access !== 'restricted') {
      return json({ success: false, error: 'not-found' }, 404);
    }
    const allowed = share.allowed || [];

    if (action === 'allow-add') {
      if (email === session.email) return json({ success: false, error: 'self' }, 400);
      if (!(await getUser(env, email))) return json({ success: false, error: 'no-user' }, 404);
      if (allowed.length >= MAX_ALLOWED && !allowed.includes(email)) {
        return json({ success: false, error: 'too-many' }, 400);
      }
      if (!allowed.includes(email)) allowed.push(email);
    } else {
      const at = allowed.indexOf(email);
      if (at >= 0) allowed.splice(at, 1);
    }
    share.allowed = allowed.sort();
    await saveShare(env, share);
    return json({ success: true, allowed: share.allowed });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
