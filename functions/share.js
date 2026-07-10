import { getShare, hashPassword, timingSafeEqualHex } from '../lib/api.js';

/* Public share pages: GET/POST /share/<token>
   - open link      → full-page branded view with a file preview (no account)
   - ?dl=1 / ?raw=1 → download / inline stream for the preview
   - protected links: password form first; a correct POST redirects to the
     preview page with a short-lived proof (?k=…&e=…) in the URL */

const PROOF_TTL = 60 * 60 * 1000; // unlocked links stay valid for an hour

/* content types that are safe to render inline without a sandbox */
const SAFE_INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf)/;

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', ico: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', m4v: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  pdf: 'pdf',
  txt: 'text', md: 'text', json: 'text', js: 'text', ts: 'text', css: 'text', html: 'text', htm: 'text',
  csv: 'text', log: 'text', xml: 'text', yml: 'text', yaml: 'text', ini: 'text', conf: 'text', sh: 'text', py: 'text',
};

function previewKind(name, size) {
  const kind = EXT_KIND[name.split('.').pop().toLowerCase()];
  if (kind === 'text' && size > 2 * 1024 * 1024) return null;
  return kind || null;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/* ---------- unlock proof for protected links ---------- */

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeProof(share) {
  const e = Date.now() + PROOF_TTL;
  return { e, k: await sha256Hex(`${share.hash}:${share.salt}:${e}`) };
}

async function proofValid(share, k, e) {
  const expires = Number(e);
  if (!k || !Number.isFinite(expires) || expires < Date.now()) return false;
  return timingSafeEqualHex(await sha256Hex(`${share.hash}:${share.salt}:${expires}`), String(k));
}

/* ---------- pages ---------- */

const CSS = `
    @font-face {
      font-family: 'Manrope';
      src: url('/fonts/manrope-latin.woff2') format('woff2');
      font-weight: 200 800;
      font-display: swap;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { max-width: 100%; overflow-x: hidden; }
    body {
      min-height: 100dvh;
      font-family: 'Manrope', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      background: radial-gradient(120% 120% at 20% 0%, #262626 0%, #161616 48%, #0C0C0C 100%);
      background-attachment: fixed;
      color: #F2F2F2;
    }
    body.center { display: grid; place-items: center; padding: 20px 14px; }
    body.full { display: flex; flex-direction: column; }
    .brand { font-size: 17px; font-weight: 800; letter-spacing: -0.3px; white-space: nowrap; }
    .brand em { font-style: normal; color: #D97757; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 13px 22px;
      font: inherit;
      font-size: 14.5px;
      font-weight: 800;
      text-align: center;
      text-decoration: none;
      color: #FFF;
      background: #D97757;
      border: 0;
      border-radius: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:hover { background: rgba(185, 84, 50, 0.9); }
    .btn:active { transform: scale(0.98); }
    .btn svg { width: 17px; height: 17px; }
    .foot {
      padding: 14px;
      font-size: 12px;
      font-weight: 600;
      color: #6C6C6C;
      text-align: center;
      flex: none;
    }
    .foot a { color: #9C9C9C; text-decoration: none; }
    .foot a:hover { color: #D97757; }

    /* centered card (password / not found) */
    .card {
      width: 100%;
      max-width: 400px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 24px;
      padding: 30px 26px 26px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(30px) saturate(1.4);
      -webkit-backdrop-filter: blur(30px) saturate(1.4);
    }
    .card .brand { margin-bottom: 22px; }
    .card .btn { display: flex; width: 100%; margin-top: 16px; padding: 15px 16px; }
    .card-title {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.4px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .card-meta { margin-top: 6px; font-size: 13px; font-weight: 600; color: #9C9C9C; }
    .hint { margin-top: 16px; font-size: 13.5px; font-weight: 600; line-height: 1.5; color: #B9B9B9; }
    .error { margin-top: 14px; font-size: 13.5px; font-weight: 700; color: #F28B70; }
    input[type="password"] {
      width: 100%;
      margin-top: 16px;
      padding: 14px 16px;
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      color: #F2F2F2;
      background: rgba(255, 255, 255, 0.06);
      border: 1.5px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      outline: none;
    }
    input[type="password"]:focus { border-color: #D97757; }

    /* full-page share view */
    .share-head {
      flex: none;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 22px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    .share-info { flex: 1; min-width: 0; }
    .share-name {
      max-width: 100%;
      font-size: 15.5px;
      font-weight: 800;
      letter-spacing: -0.2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .share-meta {
      max-width: 100%;
      margin-top: 1px;
      font-size: 12.5px;
      font-weight: 600;
      color: #9C9C9C;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .share-stage {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 22px;
      min-height: 0;
    }
    .preview-media {
      max-width: 100%;
      max-height: calc(100dvh - 150px);
      border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    }
    audio.preview-media { width: min(560px, 100%); box-shadow: none; }
    .preview-frame {
      width: min(1100px, 100%);
      height: calc(100dvh - 150px);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      background: #1E1E1E;
    }
    .na { text-align: center; max-width: 380px; }
    .na svg { width: 56px; height: 56px; color: #B05C40; }
    .na p { margin: 14px 0 20px; font-size: 14px; font-weight: 600; line-height: 1.5; color: #9C9C9C; }

    @media (max-width: 560px) {
      .share-head { flex-wrap: wrap; padding: 12px 16px; row-gap: 10px; }
      .share-info { order: 3; flex-basis: 100%; }
      .share-head .btn { margin-left: auto; padding: 10px 16px; font-size: 13.5px; }
      .share-stage { padding: 14px; }
      .preview-media, .preview-frame { max-height: calc(100dvh - 190px); }
      .preview-frame { height: calc(100dvh - 190px); }
    }`;

function page(title, bodyClass, inner, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <title>${esc(title)} — Kiliw Cloud</title>
  <style>${CSS}</style>
</head>
<body class="${bodyClass}">
${inner}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function notFoundPage() {
  return page('Link not found', 'center', `
  <main class="card">
    <p class="brand">Kiliw <em>Cloud</em></p>
    <h1 class="card-title">This link doesn't work anymore.</h1>
    <p class="hint">The file was removed or the share link was deleted by its owner.</p>
    <p class="foot"><a href="/">kiliw.com</a> — private cloud storage</p>
  </main>`, 404);
}

function passwordPage(share, size, { wrongPassword = false } = {}) {
  const name = share.path.split('/').pop();
  return page(name, 'center', `
  <main class="card">
    <p class="brand">Kiliw <em>Cloud</em></p>
    <h1 class="card-title">${esc(name)}</h1>
    <p class="card-meta">${formatSize(size)} · shared via Kiliw Cloud</p>
    <p class="hint">This file is protected. Enter the password to open it.</p>
    <form method="POST" action="/share/${share.token}">
      <input type="password" name="password" placeholder="Password" autocomplete="off" required autofocus>
      ${wrongPassword ? '<p class="error">Wrong password. Try again.</p>' : ''}
      <button class="btn" type="submit">Unlock</button>
    </form>
    <p class="foot"><a href="/">kiliw.com</a> — private cloud storage</p>
  </main>`);
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>';

function previewPage(share, size, proofQuery) {
  const name = share.path.split('/').pop();
  const base = `/share/${share.token}`;
  const rawUrl = `${base}?raw=1${proofQuery}`;
  const dlUrl = `${base}?dl=1${proofQuery}`;
  const kind = previewKind(name, size);

  let stage;
  if (kind === 'image') {
    stage = `<img class="preview-media" src="${rawUrl}" alt="${esc(name)}">`;
  } else if (kind === 'video') {
    stage = `<video class="preview-media" src="${rawUrl}" controls playsinline></video>`;
  } else if (kind === 'audio') {
    stage = `<audio class="preview-media" src="${rawUrl}" controls></audio>`;
  } else if (kind === 'pdf' || kind === 'text') {
    stage = `<iframe class="preview-frame" src="${rawUrl}" title="${esc(name)}"></iframe>`;
  } else {
    stage = `<div class="na">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/></svg>
      <p>Preview is not available for this file type.</p>
      <a class="btn" href="${dlUrl}" download>${DL_ICON}Download — ${formatSize(size)}</a>
    </div>`;
  }

  return page(name, 'full', `
  <header class="share-head">
    <span class="brand">Kiliw <em>Cloud</em></span>
    <div class="share-info">
      <p class="share-name">${esc(name)}</p>
      <p class="share-meta">${formatSize(size)} · shared via Kiliw Cloud</p>
    </div>
    <a class="btn" href="${dlUrl}" download>${DL_ICON}Download</a>
  </header>
  <main class="share-stage">${stage}</main>
  <p class="foot"><a href="/">kiliw.com</a> — private cloud storage</p>`);
}

/* ---------- streaming ---------- */

function streamFile(object, name, inline) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const type = headers.get('Content-Type') || 'application/octet-stream';
  if (!headers.get('Content-Type')) headers.set('Content-Type', type);
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'no-store');
  if (inline) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    /* user-supplied markup (html/svg/…) must not run scripts on our origin */
    if (!SAFE_INLINE.test(type)) headers.set('Content-Security-Policy', 'sandbox');
  } else {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(object.body, { headers });
}

/* ---------- handler ---------- */

export async function handleShare(request, env, token) {
  if (!env.KILIW_FILES) return notFoundPage();
  const share = await getShare(env, token);
  if (!share) return notFoundPage();

  const key = `u/${share.email}/${share.path}`;
  const name = share.path.split('/').pop();
  const url = new URL(request.url);

  /* POST = password check; success redirects to the preview page */
  if (request.method === 'POST') {
    if (!share.hash) {
      return Response.redirect(`${url.origin}/share/${token}`, 303);
    }
    let password = '';
    try {
      password = String((await request.formData()).get('password') || '');
    } catch { /* no form body */ }
    const ok = password
      && timingSafeEqualHex(await hashPassword(password, share.salt), share.hash);
    if (!ok) {
      const head = await env.KILIW_FILES.head(key);
      if (!head) return notFoundPage();
      return passwordPage(share, head.size, { wrongPassword: true });
    }
    const proof = await makeProof(share);
    return Response.redirect(`${url.origin}/share/${token}?k=${proof.k}&e=${proof.e}`, 303);
  }

  /* GET */
  const unlocked = !share.hash
    || await proofValid(share, url.searchParams.get('k'), url.searchParams.get('e'));
  const want = url.searchParams.get('dl') === '1' ? 'dl'
    : url.searchParams.get('raw') === '1' ? 'raw' : 'page';

  if (!unlocked) {
    /* file bytes stay locked; the page asks for the password */
    if (want !== 'page') return Response.redirect(`${url.origin}/share/${token}`, 302);
    const head = await env.KILIW_FILES.head(key);
    if (!head) return notFoundPage();
    return passwordPage(share, head.size);
  }

  if (want !== 'page') {
    const object = await env.KILIW_FILES.get(key);
    if (!object) return notFoundPage();
    return streamFile(object, name, want === 'raw');
  }

  const head = await env.KILIW_FILES.head(key);
  if (!head) return notFoundPage();
  const proofQuery = share.hash
    ? `&k=${encodeURIComponent(url.searchParams.get('k'))}&e=${encodeURIComponent(url.searchParams.get('e'))}`
    : '';
  return previewPage(share, head.size, proofQuery);
}
