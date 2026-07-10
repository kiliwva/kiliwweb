import {
  json, getSession, storageReady, parsePath, getUser,
  addCollab, removeCollab, listCollabMembers, listSharedWithMe,
} from '../../lib/api.js';

const MAX_MEMBERS = 20;

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/collab?shared=1      — folders shared with me
   GET /api/collab?p=<folder>    — who can edit my folder */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const url = new URL(request.url);
  if (url.searchParams.get('shared') === '1') {
    return json({ success: true, folders: await listSharedWithMe(env, session.email) });
  }

  const p = parsePath(url.searchParams.get('p'));
  if (!p) return json({ success: false, error: 'bad-name' }, 400);
  return json({ success: true, members: await listCollabMembers(env, session.email, p) });
}

/* POST /api/collab
   { action: "add", p, email }    — grant edit access on my folder
   { action: "remove", p, email } — revoke it */
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
  const email = String(body?.email || '').trim().toLowerCase();
  const action = String(body?.action || '');
  if (!p || !email) return json({ success: false, error: 'bad-request' }, 400);

  if (action === 'add') {
    if (email === session.email) return json({ success: false, error: 'self' }, 400);
    if (!(await getUser(env, email))) return json({ success: false, error: 'no-user' }, 404);

    /* the folder must actually exist */
    const page = await env.KILIW_FILES.list({ prefix: `u/${session.email}/${p}/`, limit: 1 });
    if (!page.objects.length) return json({ success: false, error: 'not-found' }, 404);

    const members = await listCollabMembers(env, session.email, p);
    if (members.length >= MAX_MEMBERS && !members.includes(email)) {
      return json({ success: false, error: 'too-many' }, 400);
    }
    await addCollab(env, session.email, p, email);
    return json({ success: true, members: await listCollabMembers(env, session.email, p) });
  }

  if (action === 'remove') {
    await removeCollab(env, session.email, p, email);
    return json({ success: true, members: await listCollabMembers(env, session.email, p) });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
