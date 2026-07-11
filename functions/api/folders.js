import {
  json, getSession, storageReady, cleanSegment, parsePath,
  deleteSharesUnder, deleteShareForFile, removeCollabsUnder,
  resolveScope, scopedPath, trashFile, removeStarsUnder, fireWebhook,
} from '../../lib/api.js';

async function requireAccess(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  const scope = await resolveScope(env, session, request);
  if (!scope) return { error: json({ success: false, error: 'no-access' }, 403) };
  return { session, scope };
}

/* POST /api/folders { path, name } [?scope=..] — create a folder */
export async function onRequestPost({ request, env }) {
  const { scope, error } = await requireAccess(request, env);
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
  const key = `u/${scope.email}/${scopedPath(scope, path, name)}/.keep`;
  await env.KILIW_FILES.put(key, new Uint8Array(0));
  return json({ success: true, name });
}

/* DELETE /api/folders?p=a/b[&scope=..] — delete a folder with everything inside */
export async function onRequestDelete({ request, env, waitUntil }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  const p = parsePath(new URL(request.url).searchParams.get('p'));
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const full = scopedPath(scope, p);
  const prefix = `u/${scope.email}/${full}/`;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    /* real files go to the recycle bin; .keep markers just vanish */
    for (const obj of page.objects) {
      if (obj.key.endsWith('/.keep')) await env.KILIW_FILES.delete(obj.key);
      else await trashFile(env, scope.email, obj.key.slice(`u/${scope.email}/`.length));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  /* clean up share links, edit grants and cached verdicts inside */
  await Promise.all([
    deleteSharesUnder(env, scope.email, full),
    deleteShareForFile(env, scope.email, full),
    removeCollabsUnder(env, scope.email, full),
    removeStarsUnder(env, scope.email, full),
    (async () => {
      let modCursor;
      do {
        const page = await env.KILIW_FILES.list({ prefix: `_mod/${scope.email}/${full}/`, cursor: modCursor, limit: 1000 });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) await env.KILIW_FILES.delete(keys);
        modCursor = page.truncated ? page.cursor : undefined;
      } while (modCursor);
    })(),
  ]);
  fireWebhook(env, waitUntil, scope.email, 'delete', { paths: [`${full}/`] });
  return json({ success: true });
}
