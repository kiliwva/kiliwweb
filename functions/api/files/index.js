import {
  json, getSession, storageReady, getUser,
  cleanSegment, parsePath, planLimits, storageUsage,
  resolveScope, scopedPath, moderateStoredImage, modVerdictsAt,
} from '../../../lib/api.js';

const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;
const BACKFILL_PER_LIST = 4; // lazily analyze a few unchecked images per listing

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
export async function onRequestGet({ request, env, waitUntil }) {
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

  /* the file listing and the cached-verdict listing run in parallel */
  const [, verdicts] = await Promise.all([
    (async () => {
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
    })(),
    modVerdictsAt(env, scope.email, full),
  ]);

  files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  for (const file of files) {
    if (verdicts.flagged.has(file.name)) file.sensitive = true;
  }

  /* analyze a few not-yet-checked images in the background: over time
     every photo gets a stored verdict without slowing any request */
  if (waitUntil) {
    const pending = files
      .filter((f) => IMG_EXT.test(f.name) && !verdicts.checked.has(f.name))
      .slice(0, BACKFILL_PER_LIST);
    for (const file of pending) {
      waitUntil(moderateStoredImage(env, scope.email, full ? `${full}/${file.name}` : file.name));
    }
  }

  return json({ success: true, path, folders: [...folders].sort(), files });
}

/* POST /api/files?name=<filename>&path=a/b[&scope=..] — small upload (body = contents) */
export async function onRequestPost({ request, env, waitUntil }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  const { scope, error: scopeError } = await requireScope(request, env, session);
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const name = cleanSegment(url.searchParams.get('name'));
  const path = parsePath(url.searchParams.get('path'));
  if (!name || path === null) return json({ success: false, error: 'bad-name' }, 400);

  /* limits and usage belong to the storage owner (fetched in parallel) */
  const length = Number(request.headers.get('Content-Length') || 0);
  const [user, usage] = await Promise.all([
    getUser(env, scope.email),
    storageUsage(env, scope.email),
  ]);
  const limits = planLimits(user, env);
  if (length > limits.maxFile) return json({ success: false, error: 'too-large' }, 413);
  if (usage + length > limits.quota) return json({ success: false, error: 'quota' }, 413);

  const fullPath = scopedPath(scope, path, name);
  await env.KILIW_FILES.put(`u/${scope.email}/${fullPath}`, request.body, {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
  /* photos are checked for 18+ content right away, in the background */
  if (waitUntil && IMG_EXT.test(name)) {
    waitUntil(moderateStoredImage(env, scope.email, fullPath));
  }
  return json({ success: true, name });
}
