import {
  json, getSession, storageReady, parsePath, cleanSegment,
  deleteShareForFile, moveShare, resolveScope, scopedPath,
  moveModVerdict, deleteModVerdict, trashFile, moveStar, removeStar,
  parseRange, fireWebhook,
} from '../../lib/api.js';

/* content types that are safe to render inline without a sandbox */
const SAFE_INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf)/;

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

function relPath(request) {
  const p = parsePath(new URL(request.url).searchParams.get('p'));
  return p || null; // must contain at least the file name
}

/* GET /api/file?p=folder/name.ext[&inline=1][&scope=..] — download or preview */
export async function onRequestGet({ request, env }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  const p = relPath(request);
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const key = `u/${scope.email}/${scopedPath(scope, p)}`;
  const head = await env.KILIW_FILES.head(key);
  if (!head) return json({ success: false, error: 'not-found' }, 404);

  /* Range support: video row thumbnails and player seeking fetch only
     the bytes they need instead of the whole file */
  const range = parseRange(request, head.size);
  if (range?.invalid) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}` },
    });
  }
  const object = await env.KILIW_FILES.get(
    key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!object) return json({ success: false, error: 'not-found' }, 404);

  const name = p.split('/').pop();
  const inline = new URL(request.url).searchParams.get('inline') === '1';

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const type = headers.get('Content-Type') || 'application/octet-stream';
  headers.set('Accept-Ranges', 'bytes');
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${head.size}`);
    headers.set('Content-Length', String(range.length));
  } else {
    headers.set('Content-Length', String(head.size));
  }

  if (inline) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    /* user-supplied markup (html/svg/…) must not run scripts on our origin */
    if (!SAFE_INLINE.test(type)) headers.set('Content-Security-Policy', 'sandbox');
  } else {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

/* PUT /api/file { p, newName } [?scope=..] — rename a file (same folder) */
export async function onRequestPut({ request, env }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const p = parsePath(body?.p);
  let newName = cleanSegment(body?.newName);
  if (!p || !newName) return json({ success: false, error: 'bad-name' }, 400);

  /* renaming must not change the file's extension */
  const oldName = p.split('/').pop();
  const dot = oldName.lastIndexOf('.');
  const ext = dot > 0 ? oldName.slice(dot).toLowerCase() : '';
  if (ext && !newName.toLowerCase().endsWith(ext)) {
    newName = cleanSegment(newName + ext);
    if (!newName) return json({ success: false, error: 'bad-name' }, 400);
  }

  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  const newPath = `${dir}${newName}`;
  if (newPath === p) return json({ success: true, name: newName });

  const fullOld = scopedPath(scope, p);
  const fullNew = scopedPath(scope, newPath);
  const oldKey = `u/${scope.email}/${fullOld}`;
  const newKey = `u/${scope.email}/${fullNew}`;
  if (await env.KILIW_FILES.head(newKey)) {
    return json({ success: false, error: 'exists' }, 409);
  }

  const object = await env.KILIW_FILES.get(oldKey);
  if (!object) return json({ success: false, error: 'not-found' }, 404);

  /* R2 has no server-side rename: stream-copy, then delete the original */
  await env.KILIW_FILES.put(newKey, object.body, {
    httpMetadata: object.httpMetadata,
  });
  await env.KILIW_FILES.delete(oldKey);
  await Promise.all([
    moveShare(env, scope.email, fullOld, fullNew),
    moveModVerdict(env, scope.email, fullOld, fullNew),
    moveStar(env, scope.email, fullOld, fullNew),
  ]);
  return json({ success: true, name: newName });
}

/* DELETE /api/file?p=folder/name.ext[&scope=..] */
export async function onRequestDelete({ request, env, waitUntil }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  const p = relPath(request);
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const full = scopedPath(scope, p);
  /* into the owner's recycle bin, not gone for good */
  await trashFile(env, scope.email, full);
  await Promise.all([
    deleteShareForFile(env, scope.email, full),
    deleteModVerdict(env, scope.email, full),
    removeStar(env, scope.email, full),
  ]);
  fireWebhook(env, waitUntil, scope.email, 'delete', { paths: [full] });
  return json({ success: true });
}
