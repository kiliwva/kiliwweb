import {
  json, getSession, storageReady, parsePath, cleanSegment,
  deleteShareForFile, moveShare, resolveScope, scopedPath,
  moveModVerdict, deleteModVerdict, trashFile, moveStar,
  getStars, saveStars,
} from '../../lib/api.js';
import { zipResponse, ZIP_MAX_BYTES } from '../../lib/zip.js';

const MAX_ITEMS = 200;
const CHUNK = 10; // parallel R2 operations per wave

/* POST /api/batch[?scope=..] — bulk actions on files in one folder.
   JSON: { action: 'delete'|'move', path, items: [names], dest? }
   Form (action=zip): so the browser can save the streamed archive. */
export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);
  const scope = await resolveScope(env, session, request);
  if (!scope) return json({ success: false, error: 'no-access' }, 403);

  let body;
  try {
    const type = request.headers.get('Content-Type') || '';
    if (type.includes('form')) {
      const form = await request.formData();
      body = {
        action: form.get('action'),
        path: form.get('path'),
        items: JSON.parse(form.get('items') || '[]'),
      };
    } else {
      body = await request.json();
    }
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const action = String(body?.action || '');
  const path = parsePath(typeof body?.path === 'string' ? body.path : '');
  const names = Array.isArray(body?.items)
    ? [...new Set(body.items.map((n) => cleanSegment(n)).filter(Boolean))]
    : [];
  if (path === null || !names.length || names.length > MAX_ITEMS) {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const base = scopedPath(scope, path);
  const fullOf = (name) => (base ? `${base}/${name}` : name);
  const keyOf = (full) => `u/${scope.email}/${full}`;

  if (action === 'delete') {
    for (let i = 0; i < names.length; i += CHUNK) {
      await Promise.all(names.slice(i, i + CHUNK).map(async (name) => {
        const full = fullOf(name);
        await trashFile(env, scope.email, full); // recycle bin, not gone
        await Promise.all([
          deleteShareForFile(env, scope.email, full),
          deleteModVerdict(env, scope.email, full),
        ]);
      }));
    }
    /* one pass over the star list: parallel updates would race */
    const gone = new Set(names.map(fullOf));
    const stars = await getStars(env, scope.email);
    const kept = stars.filter((p) => !gone.has(p));
    if (kept.length !== stars.length) await saveStars(env, scope.email, kept);
    return json({ success: true, deleted: names.length });
  }

  if (action === 'move') {
    const dest = parsePath(typeof body?.dest === 'string' ? body.dest : '');
    if (dest === null) return json({ success: false, error: 'bad-path' }, 400);
    if (dest === path) return json({ success: false, error: 'same-folder' }, 400);

    let moved = 0;
    const skipped = [];
    /* R2 has no server-side rename: stream-copy, then delete (one by
       one — each copy holds a body stream open) */
    for (const name of names) {
      const fullOld = fullOf(name);
      const fullNew = scopedPath(scope, dest, name);
      if (await env.KILIW_FILES.head(keyOf(fullNew))) {
        skipped.push(name);
        continue;
      }
      const object = await env.KILIW_FILES.get(keyOf(fullOld));
      if (!object) {
        skipped.push(name);
        continue;
      }
      await env.KILIW_FILES.put(keyOf(fullNew), object.body, {
        httpMetadata: object.httpMetadata,
      });
      await env.KILIW_FILES.delete(keyOf(fullOld));
      await Promise.all([
        moveShare(env, scope.email, fullOld, fullNew),
        moveModVerdict(env, scope.email, fullOld, fullNew),
      ]);
      await moveStar(env, scope.email, fullOld, fullNew);
      moved++;
    }
    return json({ success: true, moved, skipped });
  }

  if (action === 'zip') {
    const heads = await Promise.all(
      names.map((name) => env.KILIW_FILES.head(keyOf(fullOf(name)))),
    );
    const entries = [];
    let total = 0;
    names.forEach((name, i) => {
      const head = heads[i];
      if (!head) return;
      total += head.size;
      entries.push({
        name,
        mtime: head.uploaded ? new Date(head.uploaded) : new Date(),
        open: async () => {
          const object = await env.KILIW_FILES.get(keyOf(fullOf(name)));
          if (!object) throw new Error(`object vanished: ${name}`);
          return object.body;
        },
      });
    });
    if (!entries.length) return json({ success: false, error: 'not-found' }, 404);
    if (total >= ZIP_MAX_BYTES) return json({ success: false, error: 'too-large' }, 413);
    return zipResponse(entries, 'kiliwcloud-files.zip');
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
