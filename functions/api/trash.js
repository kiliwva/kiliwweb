import {
  json, getSession, storageReady,
  listTrash, restoreTrash, purgeTrashItem, emptyTrash,
} from '../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/trash — the recycle bin, newest first */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  const items = await listTrash(env, session.email);
  return json({ success: true, items });
}

/* POST /api/trash { action: 'restore'|'purge', id } | { action: 'empty' } */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');
  const id = String(body?.id || '');

  if (action === 'restore') {
    if (!/^[\d]+-[0-9a-f]+$/.test(id)) return json({ success: false, error: 'bad-request' }, 400);
    const path = await restoreTrash(env, session.email, id);
    if (!path) return json({ success: false, error: 'not-found' }, 404);
    return json({ success: true, path });
  }
  if (action === 'purge') {
    if (!/^[\d]+-[0-9a-f]+$/.test(id)) return json({ success: false, error: 'bad-request' }, 400);
    await purgeTrashItem(env, session.email, id);
    return json({ success: true });
  }
  if (action === 'empty') {
    await emptyTrash(env, session.email);
    return json({ success: true });
  }
  return json({ success: false, error: 'bad-request' }, 400);
}
