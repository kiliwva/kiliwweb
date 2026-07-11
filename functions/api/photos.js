import { json, getSession, storageReady } from '../../lib/api.js';
import { flaggedPaths } from './search.js';

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const MAX_PHOTOS = 300;

/* GET /api/photos — every image across all folders, newest first */
export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  const prefix = `u/${session.email}/`;
  const [photos, flagged] = await Promise.all([
    (async () => {
      const found = [];
      let cursor;
      do {
        const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
        for (const obj of page.objects) {
          const path = obj.key.slice(prefix.length);
          if (IMG_EXT.test(path)) {
            found.push({ path, size: obj.size, uploaded: obj.uploaded });
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return found;
    })(),
    flaggedPaths(env, session.email),
  ]);

  photos.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  const trimmed = photos.slice(0, MAX_PHOTOS);
  for (const photo of trimmed) {
    if (flagged.has(photo.path)) photo.sensitive = true;
  }
  return json({ success: true, photos: trimmed, total: photos.length });
}
