import {
  json, getSession, storageReady, cleanSegment, parsePath, deleteSharesUnder,
} from '../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* POST /api/folders { path, name } — create a folder */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const path = parsePath(body?.path);
  const name = cleanSegment(body?.name);
  if (!name || path === null) return json({ success: false, error: 'bad-name' }, 400);

  /* zero-byte marker keeps the empty folder visible in listings */
  const key = `u/${session.email}/${path ? `${path}/` : ''}${name}/.keep`;
  await env.KILIW_FILES.put(key, new Uint8Array(0));
  return json({ success: true, name });
}

/* DELETE /api/folders?p=a/b — delete a folder with everything inside */
export async function onRequestDelete({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const p = parsePath(new URL(request.url).searchParams.get('p'));
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const prefix = `u/${session.email}/${p}/`;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.KILIW_FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await deleteSharesUnder(env, session.email, p);
  return json({ success: true });
}
