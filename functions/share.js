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

/** Photos/videos with adult markers in the name start censored. */
const SENSITIVE_RE = /porn|nsfw|xxx/i;

function isSensitive(name, kind) {
  return (kind === 'image' || kind === 'video') && SENSITIVE_RE.test(name);
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
      display: flex;
      flex-direction: column;
      font-family: 'Manrope', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      background:
        radial-gradient(90% 60% at 85% -10%, rgba(217, 119, 87, 0.10) 0%, transparent 60%),
        radial-gradient(120% 120% at 15% 0%, #1C1C1C 0%, #121212 46%, #090909 100%);
      background-attachment: fixed;
      color: #F2F2F2;
      -webkit-font-smoothing: antialiased;
    }

    /* ambient backdrop from the file itself */
    .backdrop {
      position: fixed;
      inset: -12%;
      z-index: -1;
      background-size: cover;
      background-position: center;
      filter: blur(90px) saturate(1.25) brightness(0.7);
      opacity: 0;
      animation: backdrop-in 1s ease 0.1s forwards;
    }
    @keyframes backdrop-in { to { opacity: 0.32; } }

    /* floating glass top bar */
    .bar {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 14px clamp(12px, 3vw, 26px) 0;
      padding: 10px 12px 10px 20px;
      background: rgba(18, 18, 18, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      backdrop-filter: blur(26px) saturate(1.5);
      -webkit-backdrop-filter: blur(26px) saturate(1.5);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .brand {
      font-size: 16.5px;
      font-weight: 800;
      letter-spacing: -0.3px;
      white-space: nowrap;
      color: inherit;
      text-decoration: none;
    }
    .brand em { font-style: normal; color: #D97757; }
    .bar-actions { display: flex; align-items: center; gap: 8px; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 11px 20px;
      font: inherit;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.01em;
      text-align: center;
      text-decoration: none;
      white-space: nowrap;
      color: #FFF;
      background: linear-gradient(135deg, #E08A63 0%, #D46F4C 100%);
      /* transparent border keeps the same height as the bordered ghost variant */
      border: 1px solid transparent;
      border-radius: 999px;
      cursor: pointer;
      box-shadow: 0 10px 26px rgba(217, 119, 87, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.18);
      transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
    }
    .btn:hover { filter: brightness(1.06); }
    .btn:active { transform: scale(0.97); }
    .btn svg { width: 16px; height: 16px; }
    .btn.ghost {
      color: #F2F2F2;
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.10);
      box-shadow: none;
    }
    .btn.ghost:hover { background: rgba(255, 255, 255, 0.12); filter: none; }

    /* centered file title under the bar */
    .file-head {
      flex: none;
      padding: clamp(18px, 4vh, 34px) 20px 0;
      text-align: center;
      animation: rise 0.55s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .share-name {
      max-width: min(720px, 92vw);
      margin: 0 auto;
      font-size: clamp(19px, 3vw, 26px);
      font-weight: 800;
      letter-spacing: -0.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .share-meta {
      max-width: min(720px, 92vw);
      margin: 5px auto 0;
      font-size: 13px;
      font-weight: 600;
      color: #A3A3A3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .share-meta em { font-style: normal; color: #D9A38C; }

    .share-stage {
      flex: 1;
      display: grid;
      place-items: center;
      padding: clamp(14px, 3vh, 26px) 22px 26px;
      min-height: 0;
      animation: rise 0.65s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .preview-media {
      max-width: 100%;
      max-height: calc(100dvh - 250px);
      border-radius: 20px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);
    }
    audio.preview-media { width: min(560px, 100%); box-shadow: none; }
    .preview-frame {
      width: min(1100px, 100%);
      height: calc(100dvh - 250px);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 20px;
      background: #191919;
    }
    .na { text-align: center; max-width: 400px; padding: 40px 24px; }
    .na svg { width: 56px; height: 56px; color: #C96A47; }
    .na p { margin: 14px 0 22px; font-size: 14px; font-weight: 600; line-height: 1.5; color: #9C9C9C; }

    /* centered glass card (password / not found) */
    .center-stage {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 24px 14px;
    }
    .card {
      width: 100%;
      max-width: 410px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 28px;
      padding: 32px 28px 28px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(30px) saturate(1.4);
      -webkit-backdrop-filter: blur(30px) saturate(1.4);
      animation: rise 0.5s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .card-icon {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      margin-bottom: 18px;
      border-radius: 16px;
      background: rgba(217, 119, 87, 0.14);
      border: 1px solid rgba(217, 119, 87, 0.25);
    }
    .card-icon svg { width: 24px; height: 24px; color: #E08A63; }
    .card-title {
      font-size: 21px;
      font-weight: 800;
      letter-spacing: -0.4px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .card-meta { margin-top: 6px; font-size: 13px; font-weight: 600; color: #9C9C9C; }
    .card-meta em { font-style: normal; color: #D9A38C; }
    .hint { margin-top: 16px; font-size: 13.5px; font-weight: 600; line-height: 1.55; color: #B9B9B9; }
    .error { margin-top: 14px; font-size: 13.5px; font-weight: 700; color: #F28B70; }
    input[type="password"] {
      width: 100%;
      margin-top: 18px;
      padding: 15px 18px;
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      color: #F2F2F2;
      background: rgba(255, 255, 255, 0.06);
      border: 1.5px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input[type="password"]:focus {
      border-color: #D97757;
      box-shadow: 0 0 0 4px rgba(217, 119, 87, 0.18);
    }
    .card .btn { display: flex; width: 100%; margin-top: 16px; padding: 15px 16px; border-radius: 16px; }

    /* censored sensitive previews */
    .sensitive {
      position: relative;
      display: grid;
      place-items: center;
      max-width: 100%;
    }
    .sensitive:not(.revealed) {
      width: min(760px, 92vw);
      height: min(480px, 62dvh);
      border-radius: 20px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    /* while censored the media fills the whole card as one big blur */
    .sensitive:not(.revealed) .preview-media {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      max-height: none;
      object-fit: cover;
      border-radius: 0;
      filter: blur(56px) saturate(0.85);
      transform: scale(1.2);
      pointer-events: none;
      box-shadow: none;
    }
    .sensitive-cover {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgba(10, 10, 10, 0.45);
      text-align: center;
      padding: 20px;
    }
    .sensitive.revealed .sensitive-cover { display: none; }
    .sensitive-cover svg { width: 44px; height: 44px; color: #F2F2F2; }
    .sensitive-cover h2 { margin: 12px 0 4px; font-size: 17px; font-weight: 800; letter-spacing: -0.2px; }
    .sensitive-cover p { margin-bottom: 18px; font-size: 13px; font-weight: 600; color: #C9C9C9; max-width: 300px; line-height: 1.5; }
    .sensitive-note {
      flex: none;
      margin: 0 14px;
      padding: 10px 16px;
      text-align: center;
      font-size: 12.5px;
      font-weight: 700;
      color: #E8A38B;
      background: rgba(217, 119, 87, 0.10);
      border: 1px solid rgba(217, 119, 87, 0.25);
      border-radius: 12px;
      align-self: center;
    }

    .foot {
      flex: none;
      padding: 16px;
      font-size: 12px;
      font-weight: 600;
      color: #6C6C6C;
      text-align: center;
    }
    .foot a { color: #9C9C9C; text-decoration: none; }
    .foot a:hover { color: #D97757; }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: none; }
    }

    @media (max-width: 560px) {
      .bar { margin: 10px 10px 0; padding: 8px 10px 8px 16px; }
      .btn { padding: 10px 16px; font-size: 13.5px; }
      .btn .btn-label { display: none; }
      .btn.ghost .btn-label { display: inline; }
      .share-stage { padding: 12px 14px 20px; }
      .preview-media { max-height: calc(100dvh - 270px); }
      .preview-frame { height: calc(100dvh - 270px); }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }`;

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/></svg>';

/** Floating top bar: brand, Sign in, and optionally the Download button. */
function topBar(dlUrl) {
  return `
  <header class="bar">
    <a class="brand" href="/">Kiliw <em>Cloud</em></a>
    <div class="bar-actions">
      <a class="btn ghost" href="/"><span class="btn-label">Sign in</span></a>
      ${dlUrl ? `<a class="btn" href="${dlUrl}" download>${DL_ICON}<span class="btn-label">Download</span></a>` : ''}
    </div>
  </header>`;
}

function page(title, inner, { status = 200, backdropUrl = null } = {}) {
  const backdrop = backdropUrl
    ? `<div class="backdrop" style="background-image:url('${backdropUrl}')" aria-hidden="true"></div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <title>${esc(title)} — Kiliw Cloud</title>
  <style>${CSS}</style>
</head>
<body>
${backdrop}${inner}
  <p class="foot">© ${new Date().getFullYear()} KiliwCloud · a product of Synestix, LLC, registered in the United States</p>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function notFoundPage() {
  return page('Link not found', `${topBar(null)}
  <main class="center-stage">
    <div class="card">
      <div class="card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><path d="M4 4l16 16"/></svg>
      </div>
      <h1 class="card-title">This link doesn't work anymore.</h1>
      <p class="hint">The file was removed or the share link was deleted by its owner.</p>
    </div>
  </main>`, { status: 404 });
}

function passwordPage(share, size, { wrongPassword = false } = {}) {
  const name = share.path.split('/').pop();
  return page(name, `${topBar(null)}
  <main class="center-stage">
    <div class="card">
      <div class="card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      </div>
      <h1 class="card-title">${esc(name)}</h1>
      <p class="card-meta">${formatSize(size)} · shared by <em>${esc(share.email)}</em></p>
      <p class="hint">This file is protected. Enter the password to open it.</p>
      <form method="POST" action="/share/${share.token}">
        <input type="password" name="password" placeholder="Password" autocomplete="off" required autofocus>
        ${wrongPassword ? '<p class="error">Wrong password. Try again.</p>' : ''}
        <button class="btn" type="submit">Unlock</button>
      </form>
    </div>
  </main>`);
}

function previewPage(share, size, proofQuery) {
  const name = share.path.split('/').pop();
  const base = `/share/${share.token}`;
  const rawUrl = `${base}?raw=1${proofQuery}`;
  const dlUrl = `${base}?dl=1${proofQuery}`;
  const kind = previewKind(name, size);
  const sensitive = isSensitive(name, kind);

  let stage;
  if (kind === 'image') {
    stage = `<img class="preview-media" src="${rawUrl}" alt="${esc(name)}">`;
  } else if (kind === 'video') {
    stage = `<video class="preview-media" src="${rawUrl}" controls playsinline${sensitive ? ' preload="metadata"' : ''}></video>`;
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

  /* sensitive photos/videos start blurred behind a warning cover */
  if (sensitive) {
    stage = `<div class="sensitive" id="sensitive">
      ${stage}
      <div class="sensitive-cover">
        <div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/></svg>
          <h2>Sensitive content</h2>
          <p>This file may contain adult or sensitive material. View it only if you are sure.</p>
          <button class="btn" type="button" onclick="document.getElementById('sensitive').classList.add('revealed')">Show anyway</button>
        </div>
      </div>
    </div>`;
  }

  const note = sensitive
    ? '<p class="sensitive-note">⚠ Sensitive content — this file may contain adult material.</p>'
    : '';

  /* ambient backdrop from the image itself (never for censored files) */
  const backdropUrl = kind === 'image' && !sensitive ? rawUrl : null;

  return page(name, `${topBar(dlUrl)}
  <section class="file-head">
    <h1 class="share-name">${esc(name)}</h1>
    <p class="share-meta">${formatSize(size)} · shared by <em>${esc(share.email)}</em></p>
  </section>
  <main class="share-stage">${stage}</main>
  ${note}`, { backdropUrl });
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
