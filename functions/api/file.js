import { json, getSession, storageReady, parsePath } from '../../lib/api.js';

/* content types that are safe to render inline without a sandbox */
const SAFE_INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf)/;

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

function fullPath(request) {
  const p = parsePath(new URL(request.url).searchParams.get('p'));
  return p || null; // must contain at least the file name
}

/* GET /api/file?p=folder/name.ext[&inline=1] — download or preview */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const p = fullPath(request);
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  const object = await env.KILIW_FILES.get(`u/${session.email}/${p}`);
  if (!object) return json({ success: false, error: 'not-found' }, 404);

  const name = p.split('/').pop();
  const inline = new URL(request.url).searchParams.get('inline') === '1';

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const type = headers.get('Content-Type') || 'application/octet-stream';
  headers.set('Content-Length', String(object.size));

  if (inline) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    /* user-supplied markup (html/svg/…) must not run scripts on our origin */
    if (!SAFE_INLINE.test(type)) headers.set('Content-Security-Policy', 'sandbox');
  } else {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(object.body, { headers });
}

/* DELETE /api/file?p=folder/name.ext */
export async function onRequestDelete({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const p = fullPath(request);
  if (!p) return json({ success: false, error: 'bad-name' }, 400);

  await env.KILIW_FILES.delete(`u/${session.email}/${p}`);
  return json({ success: true });
}
