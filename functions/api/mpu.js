import {
  json, getSession, storageReady, getUser,
  cleanSegment, parsePath, planLimits, storageUsage,
  resolveScope, scopedPath, moderateStoredImage,
} from '../../lib/api.js';

const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;

/* Multipart upload for files above the per-request limit.
   The client splits the file into 64 MiB parts:
     POST /api/mpu?action=create&name=..&path=..&size=..   → { uploadId }
     PUT  /api/mpu?action=part&name=..&path=..&id=..&part=N (body = chunk) → { etag }
     POST /api/mpu?action=complete { name, path, id, parts: [{partNumber, etag}] }
     POST /api/mpu?action=abort    { name, path, id }
   All calls accept ?scope=<grant id> for folders shared for editing. */

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

function keyFor(scope, path, name) {
  return `u/${scope.email}/${scopedPath(scope, path, name)}`;
}

export async function onRequestPost({ request, env, waitUntil }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'create') {
    const name = cleanSegment(url.searchParams.get('name'));
    const path = parsePath(url.searchParams.get('path'));
    const size = Number(url.searchParams.get('size') || 0);
    if (!name || path === null) return json({ success: false, error: 'bad-name' }, 400);

    /* limits and usage belong to the storage owner (fetched in parallel) */
    const [user, usage] = await Promise.all([
      getUser(env, scope.email),
      storageUsage(env, scope.email),
    ]);
    const limits = planLimits(user, env);
    if (size > limits.maxFile) return json({ success: false, error: 'too-large' }, 413);
    if (usage + size > limits.quota) return json({ success: false, error: 'quota' }, 413);

    const mpu = await env.KILIW_FILES.createMultipartUpload(keyFor(scope, path, name), {
      httpMetadata: {
        contentType: url.searchParams.get('type') || 'application/octet-stream',
      },
    });
    return json({ success: true, uploadId: mpu.uploadId });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const name = cleanSegment(body?.name);
  const path = parsePath(body?.path);
  const id = String(body?.id || '');
  if (!name || path === null || !id) return json({ success: false, error: 'bad-request' }, 400);
  const mpu = env.KILIW_FILES.resumeMultipartUpload(keyFor(scope, path, name), id);

  if (action === 'complete') {
    const parts = Array.isArray(body?.parts) ? body.parts : [];
    let object;
    try {
      object = await mpu.complete(parts);
    } catch {
      return json({ success: false, error: 'mpu-failed' }, 400);
    }
    /* re-check limits against the real size; declared size is client-supplied */
    const [user, usage] = await Promise.all([
      getUser(env, scope.email),
      storageUsage(env, scope.email),
    ]);
    const limits = planLimits(user, env);
    if (object.size > limits.maxFile || usage > limits.quota) {
      await env.KILIW_FILES.delete(object.key);
      return json({ success: false, error: object.size > limits.maxFile ? 'too-large' : 'quota' }, 413);
    }
    /* photos are checked for 18+ content in the background */
    if (waitUntil && IMG_EXT.test(name)) {
      waitUntil(moderateStoredImage(env, scope.email, scopedPath(scope, path, name)));
    }
    return json({ success: true, name });
  }

  if (action === 'abort') {
    try {
      await mpu.abort();
    } catch { /* already gone */ }
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestPut({ request, env }) {
  const { scope, error } = await requireAccess(request, env);
  if (error) return error;

  const url = new URL(request.url);
  if (url.searchParams.get('action') !== 'part') {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const name = cleanSegment(url.searchParams.get('name'));
  const path = parsePath(url.searchParams.get('path'));
  const id = String(url.searchParams.get('id') || '');
  const partNumber = Number(url.searchParams.get('part') || 0);
  if (!name || path === null || !id || !Number.isInteger(partNumber) || partNumber < 1) {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const mpu = env.KILIW_FILES.resumeMultipartUpload(keyFor(scope, path, name), id);
  try {
    const part = await mpu.uploadPart(partNumber, request.body);
    return json({ success: true, partNumber: part.partNumber, etag: part.etag });
  } catch {
    return json({ success: false, error: 'mpu-failed' }, 400);
  }
}
