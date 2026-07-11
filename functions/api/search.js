import { json, getSession, storageReady, getStars } from '../../lib/api.js';

const MAX_RESULTS = 100;

/* GET /api/search?q=<text> — case-insensitive name search across all folders */
export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return json({ success: true, files: [] });

  const prefix = `u/${session.email}/`;
  const files = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const path = obj.key.slice(prefix.length);
      const name = path.split('/').pop();
      if (name === '.keep') continue;
      if (name.toLowerCase().includes(q)) {
        files.push({ path, size: obj.size, uploaded: obj.uploaded });
        if (files.length >= MAX_RESULTS) return json({ success: true, files, truncated: true });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return json({ success: true, files });
}

/* shared by the photos endpoint: every flagged path for the account */
export async function flaggedPaths(env, email) {
  const flagged = new Set();
  const prefix = `_mod/${email}/`;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      if (!rec) continue;
      try {
        if (JSON.parse(await rec.text()).sensitive === true) {
          flagged.add(obj.key.slice(prefix.length).replace(/\.json$/, ''));
        }
      } catch { /* skip unreadable */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return flagged;
}
