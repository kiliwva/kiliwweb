import { json, getSession } from '../../../lib/api.js';

const MAX_NAME = 180;
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB — Workers request body limit

function cleanName(raw) {
  const name = String(raw || '')
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (!name || name === '.' || name === '..' || name.length > MAX_NAME) return null;
  return name;
}

async function requireSession(request, env) {
  if (!env.KILIW_KV || !env.KILIW_FILES) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/files — list the user's files */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const prefix = `u/${session.email}/`;
  const files = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      files.push({
        name: obj.key.slice(prefix.length),
        size: obj.size,
        uploaded: obj.uploaded,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return json({ success: true, files });
}

/* POST /api/files?name=<filename> — upload (body = file contents) */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const name = cleanName(new URL(request.url).searchParams.get('name'));
  if (!name) return json({ success: false, error: 'bad-name' }, 400);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_SIZE) return json({ success: false, error: 'too-large' }, 413);

  await env.KILIW_FILES.put(`u/${session.email}/${name}`, request.body, {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
  return json({ success: true, name });
}
