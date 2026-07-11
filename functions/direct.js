import {
  json, getShare, parseRange, getUser, planLimits, storageUsage,
  getUploadTicket, consumeUploadTicket, moderateStoredImage, fireWebhook,
} from '../lib/api.js';

/* content types that are safe to render inline without a sandbox */
const SAFE_INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf)/;
const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;

/* GET /f/<token> — raw bytes of a public, unprotected file share.
   Stable hotlink for embedding on other sites; Range supported. */
export async function handleDirect(request, env, token) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ success: false, error: 'method-not-allowed' }, 405);
  }
  const share = await getShare(env, token);
  /* only fully public links serve raw bytes without the share page */
  if (!share || share.folder || share.hash || share.access === 'restricted') {
    return json({ success: false, error: 'not-found' }, 404);
  }

  const key = `u/${share.email}/${share.path}`;
  const name = share.path.split('/').pop();
  const head = await env.KILIW_FILES.head(key);
  if (!head) return json({ success: false, error: 'not-found' }, 404);

  const range = parseRange(request, head.size);
  if (range?.invalid) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}` },
    });
  }

  const headers = new Headers();
  head.writeHttpMetadata?.(headers);
  const type = headers.get('Content-Type') || 'application/octet-stream';
  if (!headers.get('Content-Type')) headers.set('Content-Type', type);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  /* short cache keeps hotlinks fast without delaying revocation much */
  headers.set('Cache-Control', 'public, max-age=300');
  if (SAFE_INLINE.test(type)) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  } else {
    /* html/svg/… must not run scripts on our origin */
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    headers.set('Content-Security-Policy', 'sandbox');
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${head.size}`);
    headers.set('Content-Length', String(range.length));
  } else {
    headers.set('Content-Length', String(head.size));
  }

  if (request.method === 'HEAD') return new Response(null, { headers });

  const object = await env.KILIW_FILES.get(
    key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!object) return json({ success: false, error: 'not-found' }, 404);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/* PUT /up/<token> — presigned single-use upload (created via the API).
   The uploader needs no credentials: possession of the URL is enough. */
export async function handlePresignedUpload(request, env, token, waitUntil) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'PUT') {
    return json({ success: false, error: 'method-not-allowed' }, 405, CORS);
  }

  const ticket = await getUploadTicket(env, token);
  if (!ticket) return json({ success: false, error: 'not-found' }, 404, CORS);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (ticket.maxBytes && length > ticket.maxBytes) {
    return json({ success: false, error: 'too-large', maxBytes: ticket.maxBytes }, 413, CORS);
  }

  /* the ticket owner's plan limits still apply */
  const user = await getUser(env, ticket.email);
  if (!user) return json({ success: false, error: 'not-found' }, 404, CORS);
  const limits = planLimits(user, env);
  if (length > limits.maxFile) {
    return json({ success: false, error: 'too-large', maxBytes: limits.maxFile }, 413, CORS);
  }
  const usage = await storageUsage(env, ticket.email);
  if (usage + length > limits.quota) {
    return json({ success: false, error: 'quota' }, 413, CORS);
  }

  await env.KILIW_FILES.put(`u/${ticket.email}/${ticket.path}`, request.body, {
    httpMetadata: {
      contentType: request.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
  await consumeUploadTicket(env, token); // single use

  if (waitUntil && IMG_EXT.test(ticket.path)) {
    waitUntil(moderateStoredImage(env, ticket.email, ticket.path));
  }
  fireWebhook(env, waitUntil, ticket.email, 'upload', { path: ticket.path, size: length });

  return json({ success: true, path: ticket.path, size: length }, 200, CORS);
}
