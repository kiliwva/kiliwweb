import {
  json, getSession, storageReady, getUser,
  cleanSegment, parsePath, planLimits, storageUsage,
  resolveScope, scopedPath,
} from '../../../lib/api.js';

export async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* Own root, or a folder shared with the user via ?scope=<grant id>. */
export async function requireScope(request, env, session) {
  const scope = await resolveScope(env, session, request);
  if (!scope) return { error: json({ success: false, error: 'no-access' }, 403) };
  return { scope };
}

/* GET /api/files?path=a/b[&scope=..] — list folders and files at the path */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  const { scope, error: scopeError } = await requireScope(request, env, session);
  if (scopeError) return scopeError;

  const path = parsePath(new URL(request.url).searchParams.get('path'));
  if (path === null) return json({ success: false, error: 'bad-path' }, 400);

  const full = scopedPath(scope, path);
  const prefix = `u/${scope.email}/${full ? `${full}/` : ''}`;
  const folders = new Set();
  const files = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const dp of page.delimitedPrefixes) {
      folders.add(dp.slice(prefix.length).replace(/\/$/, ''));
    }
    for (const obj of page.objects) {
      const name = obj.key.slice(prefix.length);
      if (name === '.keep' || !name) continue;
      files.push({ name, size: obj.size, uploaded: obj.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return json({ success: true, path, folders: [...folders].sort(), files });
}

/* POST /api/files?name=<filename>&path=a/b[&scope=..] — small upload (body = contents) */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  const { scope, error: scopeError } = await requireScope(request, env, session);
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const name = cleanSegment(url.searchParams.get('name'));
  const path = parsePath(url.searchParams.get('path'));
  if (!name || path === null) return json({ success: false, error: 'bad-name' }, 400);

  /* limits and usage belong to the storage owner */
  const user = await getUser(env, scope.email);
  const limits = planLimits(user, env);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limits.maxFile) return json({ success: false, error: 'too-large' }, 413);

  const usage = await storageUsage(env, scope.email);
  if (usage + length > limits.quota) return json({ success: false, error: 'quota' }, 413);

  const key = `u/${scope.email}/${scopedPath(scope, path, name)}`;
  await env.KILIW_FILES.put(key, request.body, {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
  return json({ success: true, name });
}
