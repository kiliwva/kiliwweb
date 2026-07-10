import { json, getSession, storageReady } from '../../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* Path params arrive percent-encoded. */
function decodeName(params) {
  try {
    return decodeURIComponent(String(params.name || ''));
  } catch {
    return '';
  }
}

/* GET /api/files/<name> — download */
export async function onRequestGet({ request, env, params }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const name = decodeName(params);
  if (!name) return json({ success: false, error: 'bad-name' }, 400);
  const object = await env.KILIW_FILES.get(`u/${session.email}/${name}`);
  if (!object) return json({ success: false, error: 'not-found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  return new Response(object.body, { headers });
}

/* DELETE /api/files/<name> */
export async function onRequestDelete({ request, env, params }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const name = decodeName(params);
  if (!name) return json({ success: false, error: 'bad-name' }, 400);
  await env.KILIW_FILES.delete(`u/${session.email}/${name}`);
  return json({ success: true });
}
