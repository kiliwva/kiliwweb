import {
  json, getSession, storageReady, parsePath, getStars, setStar, saveStars,
} from '../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/stars — starred files that still exist, with live size/date */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const stars = await getStars(env, session.email);
  const heads = await Promise.all(
    stars.map((p) => env.KILIW_FILES.head(`u/${session.email}/${p}`)),
  );
  const files = [];
  const alive = [];
  stars.forEach((path, i) => {
    if (!heads[i]) return; // gone: dropped from the list below
    alive.push(path);
    files.push({ path, size: heads[i].size, uploaded: heads[i].uploaded });
  });
  if (alive.length !== stars.length) await saveStars(env, session.email, alive);
  return json({ success: true, files });
}

/* POST /api/stars { path, on } — star or unstar one file */
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
  if (!path) return json({ success: false, error: 'bad-name' }, 400);
  await setStar(env, session.email, path, Boolean(body?.on));
  return json({ success: true });
}
