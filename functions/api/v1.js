import {
  json, storageReady, getUser, planLimits, storageUsage,
  apiKeyUser, parsePath, cleanSegment, randomHex,
  deleteShareForFile, deleteSharesUnder, deleteModVerdict, removeCollabsUnder,
  moderateStoredImage, createShare, getShare, shareTokenForFile, shareUrl, directUrl,
  getWebhook, saveWebhook, deleteWebhook, fireWebhook,
  createUploadTicket,
} from '../../lib/api.js';

/* Developer REST API (DEV plan): Authorization: Bearer kw_<40 hex>

   GET    /api/v1/usage            → plan + storage usage
   GET    /api/v1/files?path=a/b   → list folders and files
   GET    /api/v1/files/<path>     → download a file (HEAD for metadata)
   PUT    /api/v1/files/<path>     → upload (body = contents, ≤ 100 MB)
   DELETE /api/v1/files/<path>     → delete a file
   POST   /api/v1/folders          → {path} create a folder
   DELETE /api/v1/folders?path=a/b → delete a folder recursively
   GET/POST/DELETE /api/v1/links   → direct (hotlink) URLs for a file
   POST   /api/v1/uploads          → presigned single-use upload URL
   GET/POST/DELETE /api/v1/webhook → event notifications (HMAC-signed) */

const IMG_EXT = /\.(jpe?g|png|webp|gif)$/i;
const MAX_PUT = 100 * 1024 * 1024; // Workers request body limit

async function requireApi(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const email = await apiKeyUser(env, request);
  if (!email) {
    return {
      error: json({ success: false, error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer realm="kiliw-api"',
      }),
    };
  }
  const user = await getUser(env, email);
  if (user?.banned) return { error: json({ success: false, error: 'banned' }, 403) };
  const limits = planLimits(user, env);
  if (!limits.api) return { error: json({ success: false, error: 'plan-required' }, 403) };
  return { email, limits };
}

/** Full object path from /api/v1/files/<...>, or null. */
function filePath(pathname) {
  const raw = decodeURIComponent(pathname.slice('/api/v1/files/'.length));
  return parsePath(raw);
}

export async function handle({ request, env, waitUntil }) {
  const { email, limits, error } = await requireApi(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const sub = url.pathname;
  const method = request.method;

  /* --- usage --- */
  if (sub === '/api/v1/usage' && method === 'GET') {
    const usage = await storageUsage(env, email);
    return json({
      success: true,
      email,
      plan: { type: limits.type, maxFile: limits.maxFile, quota: limits.quota, until: limits.until },
      usage,
    });
  }

  /* --- listing --- */
  if (sub === '/api/v1/files' && method === 'GET') {
    const path = parsePath(url.searchParams.get('path'));
    if (path === null) return json({ success: false, error: 'bad-path' }, 400);
    const prefix = `u/${email}/${path ? `${path}/` : ''}`;
    const folders = new Set();
    const files = [];
    let cursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix, delimiter: '/', cursor, limit: 1000 });
      for (const dp of page.delimitedPrefixes) folders.add(dp.slice(prefix.length).replace(/\/$/, ''));
      for (const obj of page.objects) {
        const name = obj.key.slice(prefix.length);
        if (name === '.keep' || !name) continue;
        files.push({ name, size: obj.size, uploaded: obj.uploaded });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ success: true, path, folders: [...folders].sort(), files });
  }

  /* --- single file --- */
  if (sub.startsWith('/api/v1/files/')) {
    const p = filePath(sub);
    if (!p) return json({ success: false, error: 'bad-path' }, 400);
    const key = `u/${email}/${p}`;

    if (method === 'GET' || method === 'HEAD') {
      const object = method === 'HEAD'
        ? await env.KILIW_FILES.head(key)
        : await env.KILIW_FILES.get(key);
      if (!object) return json({ success: false, error: 'not-found' }, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (!headers.get('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Length', String(object.size));
      headers.set('Last-Modified', new Date(object.uploaded).toUTCString());
      headers.set('Cache-Control', 'no-store');
      if (method === 'HEAD') return new Response(null, { headers });
      return new Response(object.body, { headers });
    }

    if (method === 'PUT') {
      const name = cleanSegment(p.split('/').pop());
      if (!name) return json({ success: false, error: 'bad-path' }, 400);
      const length = Number(request.headers.get('Content-Length') || 0);
      if (length > Math.min(limits.maxFile, MAX_PUT)) {
        return json({ success: false, error: 'too-large', maxBytes: Math.min(limits.maxFile, MAX_PUT) }, 413);
      }
      const usage = await storageUsage(env, email);
      if (usage + length > limits.quota) return json({ success: false, error: 'quota' }, 413);
      await env.KILIW_FILES.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
      });
      if (waitUntil && IMG_EXT.test(name)) waitUntil(moderateStoredImage(env, email, p));
      fireWebhook(env, waitUntil, email, 'upload', { path: p, size: length });
      return json({ success: true, path: p, size: length });
    }

    if (method === 'DELETE') {
      await env.KILIW_FILES.delete(key);
      await Promise.all([
        deleteShareForFile(env, email, p),
        deleteModVerdict(env, email, p),
      ]);
      fireWebhook(env, waitUntil, email, 'delete', { paths: [p] });
      return json({ success: true });
    }

    return json({ success: false, error: 'method-not-allowed' }, 405);
  }

  /* --- folders --- */
  if (sub === '/api/v1/folders' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'bad-request' }, 400);
    }
    const path = parsePath(body?.path);
    if (!path) return json({ success: false, error: 'bad-path' }, 400);
    await env.KILIW_FILES.put(`u/${email}/${path}/.keep`, new Uint8Array(0));
    return json({ success: true, path });
  }

  if (sub === '/api/v1/folders' && method === 'DELETE') {
    const path = parsePath(url.searchParams.get('path'));
    if (!path) return json({ success: false, error: 'bad-path' }, 400);
    const prefix = `u/${email}/${path}/`;
    let cursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await env.KILIW_FILES.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await Promise.all([
      deleteSharesUnder(env, email, path),
      deleteShareForFile(env, email, path),
      removeCollabsUnder(env, email, path),
    ]);
    fireWebhook(env, waitUntil, email, 'delete', { paths: [`${path}/`] });
    return json({ success: true });
  }

  /* --- direct links (hotlink): raw-bytes URLs for embedding --- */
  if (sub === '/api/v1/links') {
    if (method === 'GET') {
      const path = parsePath(url.searchParams.get('path'));
      if (!path) return json({ success: false, error: 'bad-path' }, 400);
      const token = await shareTokenForFile(env, email, path);
      const share = token ? await getShare(env, token) : null;
      if (!share || share.folder || share.hash || share.access === 'restricted') {
        return json({ success: true, linked: false });
      }
      return json({
        success: true,
        linked: true,
        direct: directUrl(request, share.token),
        page: shareUrl(request, share.token),
      });
    }
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: 'bad-request' }, 400);
      }
      const path = parsePath(body?.path);
      if (!path) return json({ success: false, error: 'bad-path' }, 400);
      if (!(await env.KILIW_FILES.head(`u/${email}/${path}`))) {
        return json({ success: false, error: 'not-found' }, 404);
      }
      /* one link per file: this replaces any existing share settings */
      const share = await createShare(env, email, path, null, false, 'public');
      return json({
        success: true,
        direct: directUrl(request, share.token),
        page: shareUrl(request, share.token),
      });
    }
    if (method === 'DELETE') {
      const path = parsePath(url.searchParams.get('path'));
      if (!path) return json({ success: false, error: 'bad-path' }, 400);
      await deleteShareForFile(env, email, path);
      return json({ success: true });
    }
    return json({ success: false, error: 'method-not-allowed' }, 405);
  }

  /* --- presigned uploads: hand a browser a one-shot PUT URL --- */
  if (sub === '/api/v1/uploads' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'bad-request' }, 400);
    }
    const path = parsePath(body?.path);
    if (!path || !cleanSegment(path.split('/').pop())) {
      return json({ success: false, error: 'bad-path' }, 400);
    }
    const maxBytes = Math.min(
      Math.max(Math.round(Number(body?.maxBytes)) || 0, 0),
      Math.min(limits.maxFile, MAX_PUT),
    ) || Math.min(limits.maxFile, MAX_PUT);
    const ttlMs = Math.round(Number(body?.ttl)) * 1000 || 0; // seconds in, ms out
    const ticket = await createUploadTicket(env, email, path, maxBytes, ttlMs);
    const origin = new URL(request.url).origin;
    return json({
      success: true,
      url: `${origin}/up/${ticket.token}`,
      path,
      maxBytes,
      expires: ticket.expires,
    });
  }

  /* --- webhook: one endpoint per account, HMAC-signed deliveries --- */
  if (sub === '/api/v1/webhook') {
    if (method === 'GET') {
      const hook = await getWebhook(env, email);
      if (!hook) return json({ success: true, configured: false });
      return json({
        success: true,
        configured: true,
        url: hook.url,
        events: hook.events || ['upload', 'delete'],
        secret: hook.secret,
      });
    }
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: 'bad-request' }, 400);
      }
      let target;
      try {
        target = new URL(String(body?.url || ''));
      } catch {
        return json({ success: false, error: 'bad-url' }, 400);
      }
      if (target.protocol !== 'https:') return json({ success: false, error: 'https-required' }, 400);
      const allowed = ['upload', 'delete'];
      const events = Array.isArray(body?.events)
        ? body.events.filter((e) => allowed.includes(e))
        : allowed;
      if (!events.length) return json({ success: false, error: 'bad-request' }, 400);
      const existing = await getWebhook(env, email);
      const hook = {
        url: target.toString(),
        events,
        secret: existing?.secret || `whsec_${randomHex(16)}`,
        created: existing?.created || Date.now(),
      };
      await saveWebhook(env, email, hook);
      return json({ success: true, url: hook.url, events, secret: hook.secret });
    }
    if (method === 'DELETE') {
      await deleteWebhook(env, email);
      return json({ success: true });
    }
    return json({ success: false, error: 'method-not-allowed' }, 405);
  }

  return json({ success: false, error: 'not-found' }, 404);
}
