import {
  getShare, hashPassword, timingSafeEqualHex, moderateShare, moderateStoredImage,
  modVerdictsAt, parsePath, parseRange, getSession, getUser, requestShareAccess,
} from '../lib/api.js';
import { collectZipEntries, zipResponse } from '../lib/zip.js';

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

/* Adult content detection: images are analyzed by a vision model when the
   link is created (share.sensitive on the record); the name check below is
   the fallback and the only signal for videos. */
const SENSITIVE_RE = /porn|nsfw|xxx/i;

function isSensitive(share, name, kind) {
  if (share.sensitive === true) return true;
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
    /* paint the overscroll / safe areas dark too (iOS shows white otherwise) */
    html { background: #090909; }
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
    .brand { color: inherit; text-decoration: none; }
    .brand-lock {
      display: inline-flex;
      align-items: baseline;
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1;
      white-space: nowrap;
    }
    .brand-lock .bl-mark { height: 0.8em; width: auto; flex: none; }
    .brand-lock .bl-word {
      margin-left: 0.14em;
      background: linear-gradient(120deg, #F2A47B 0%, #D97757 55%, #C05C3E 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .brand-lock .bl-dash {
      flex: none;
      width: 0.17em;
      height: 0.17em;
      border-radius: 26%;
      background: #F2F2F2;
      margin-left: 0.17em;
      transform: translateY(-0.25em);
    }
    .brand-lock .bl-dash + .bl-word { margin-left: 0.17em; }
    .bar-actions { display: flex; align-items: center; gap: 8px; }
    .bar-avatar {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      overflow: hidden;
      background: linear-gradient(135deg, #E08A63 0%, #C96A47 100%);
      color: #FFF;
      font-size: 16px;
      font-weight: 800;
      text-decoration: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      transition: transform 0.15s, filter 0.15s;
    }
    .bar-avatar:hover { transform: scale(1.06); filter: brightness(1.05); }
    .bar-avatar img { width: 100%; height: 100%; object-fit: cover; }

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
    .hint em { font-style: normal; color: #D9A38C; }
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

    /* shared folder listing */
    .folder-panel {
      width: min(720px, 100%);
      max-height: calc(100dvh - 250px);
      overflow-y: auto;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 20px;
      padding: 10px;
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
    }
    .f-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      text-decoration: none;
      color: inherit;
      transition: background 0.15s;
    }
    .f-row:hover { background: rgba(255, 255, 255, 0.05); }
    .f-row > svg { width: 20px; height: 20px; flex: none; color: #D97757; }
    .f-row.f-file > svg { width: 24px; height: 24px; color: #B05C40; }
    .f-name {
      flex: 1;
      min-width: 0;
      font-size: 14px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: inherit;
      text-decoration: none;
    }
    a.f-name:hover { color: #E08A63; }
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      font-size: 13px;
      font-weight: 700;
      color: #A3A3A3;
      text-decoration: none;
      transition: color 0.15s;
    }
    .back-link:hover { color: #E08A63; }
    .f-size { flex: none; font-size: 12px; font-weight: 600; color: #9C9C9C; }
    .f-dl {
      flex: none;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      color: #F2F2F2;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.10);
    }
    .f-dl:hover { background: rgba(255, 255, 255, 0.13); }
    .f-dl svg { width: 16px; height: 16px; }
    .f-empty { padding: 34px 20px; text-align: center; font-size: 13.5px; font-weight: 600; color: #9C9C9C; }
    .thumb {
      position: relative;
      width: 40px;
      height: 40px;
      flex: none;
      display: block;
      border-radius: 11px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.09);
    }
    .thumb img, .thumb video { display: block; width: 100%; height: 100%; object-fit: cover; }
    .thumb.censored img, .thumb.censored video { filter: blur(7px) saturate(0.7); transform: scale(1.25); }
    .thumb-play {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #FFF;
      background: rgba(0, 0, 0, 0.18);
      pointer-events: none;
    }
    .thumb-play svg { width: 15px; height: 15px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); }
    .thumb.censored .thumb-play { display: none; }
    .thumb-lock {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.3);
      color: #FFF;
    }
    .thumb-lock svg { width: 14px; height: 14px; }

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

const WORDMARK = '<span class="brand-lock" style="font-size:19px" role="img" aria-label="k cloud"><svg class="bl-mark" viewBox="5.7 3.45 12.6 17.1" aria-hidden="true"><defs><linearGradient id="kwg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F2A47B"/><stop offset=".55" stop-color="#D97757"/><stop offset="1" stop-color="#B4552F"/></linearGradient></defs><rect x="5.7" y="3.45" width="3.6" height="3.6" rx="1.1" fill="#F2F2F2"/><rect x="5.7" y="7.95" width="3.6" height="3.6" rx="1.1" fill="#F2F2F2"/><rect x="5.7" y="12.45" width="3.6" height="3.6" rx="1.1" fill="#F2F2F2"/><rect x="5.7" y="16.95" width="3.6" height="3.6" rx="1.1" fill="#F2F2F2"/><rect x="10.2" y="7.95" width="3.6" height="3.6" rx="1.1" fill="url(#kwg)"/><rect x="14.7" y="3.45" width="3.6" height="3.6" rx="1.1" fill="url(#kwg)"/><rect x="10.2" y="12.45" width="3.6" height="3.6" rx="1.1" fill="url(#kwg)"/><rect x="14.7" y="16.95" width="3.6" height="3.6" rx="1.1" fill="url(#kwg)"/></svg><span class="bl-word">cloud</span></span>';

/** Floating top bar: brand, Sign in (or the signed-in viewer's avatar),
    and optionally the Download button. */
function topBar(dlUrl, viewer) {
  const who = viewer
    ? `<a class="bar-avatar" href="/dash" title="${esc(viewer.email)}">${
      viewer.avatar
        ? `<img src="/api/avatar?v=${viewer.avatar}" alt="">`
        : `<span>${esc(viewer.email[0].toUpperCase())}</span>`
    }</a>`
    : '<a class="btn ghost" href="/login"><span class="btn-label">Sign in</span></a>';
  return `
  <header class="bar">
    <a class="brand" href="/">${WORDMARK}</a>
    <div class="bar-actions">
      ${dlUrl ? `<a class="btn" href="${dlUrl}" download>${DL_ICON}<span class="btn-label">Download</span></a>` : ''}
      ${who}
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
  <meta name="theme-color" content="#090909">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${esc(title)} — Kiliw Cloud</title>
  <style>${CSS}</style>
</head>
<body>
${backdrop}${inner}
  <p class="foot">© ${new Date().getFullYear()} KiliwCloud · a product of Synestix, LLC · 2200 Porter Rd, Bear, DE 19701-2022, USA</p>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function notFoundPage(viewer = null) {
  return page('Link not found', `${topBar(null, viewer)}
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

/* ---------- shared folder listing ---------- */

const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/></svg>';

/* per-family colors for the extension badge on file icons (mirrors cloud.js) */
const EXT_COLORS = (() => {
  const families = [
    ['#E5484D', 'pdf'],
    ['#4E86E8', 'doc docx rtf odt pages'],
    ['#E06B2B', 'ppt pptx key odp'],
    ['#38A169', 'xls xlsx csv ods numbers'],
    ['#7C7C85', 'txt md log'],
    ['#2E9FE6', 'psd'],
    ['#E8930C', 'ai eps'],
    ['#E5397D', 'indd'],
    ['#C13BD6', 'xd'],
    ['#7D7DE8', 'aep prproj'],
    ['#9B59F5', 'fig sketch'],
    ['#C0932B', 'zip rar 7z tar gz bz2 xz'],
    ['#8B5CF6', 'mp3 wav flac ogg m4a aac'],
    ['#D6409F', 'mp4 mov mkv webm avi m4v'],
    ['#2AA189', 'js ts jsx tsx json py rb go rs java c cpp cs php sh yml yaml sql html css scss xml'],
    ['#6C7BE0', 'ttf otf woff woff2'],
    ['#64748B', 'exe msi apk dmg pkg deb rpm iso'],
    ['#B0813C', 'epub mobi'],
    ['#D97757', 'png jpg jpeg gif webp avif bmp heic svg'],
  ];
  const map = {};
  for (const [color, exts] of families) for (const e of exts.split(' ')) map[e] = color;
  return map;
})();

/** File icon with a colored extension badge; plain outline for unknown types. */
function typedFileIcon(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  const color = EXT_COLORS[ext];
  if (!color) return FILE_ICON;
  const badge = `<rect x="1" y="12" width="16" height="8.5" rx="2.2" fill="${color}" stroke="none"/>`
    + `<text x="9" y="18.4" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="5.2" font-weight="800" letter-spacing="0.02em" fill="#fff" stroke="none">${ext.toUpperCase().slice(0, 4)}</text>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:#8E8E96" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/>${badge}</svg>`;
}

function encPath(path) {
  return encodeURIComponent(path).replace(/%2F/gi, '/');
}

function folderPage(share, rp, folders, files, proofQuery, viewer) {
  const rootName = share.path.split('/').pop();
  const title = rp ? `${rootName}/${rp}` : rootName;
  const base = `/share/${share.token}`;
  const rows = [];

  if (rp) {
    const parent = rp.includes('/') ? rp.slice(0, rp.lastIndexOf('/')) : '';
    rows.push(`<a class="f-row" href="${base}?${parent ? `p=${encPath(parent)}` : 'p='}${proofQuery}">
      ${FOLDER_ICON}<span class="f-name">..</span></a>`);
  }
  for (const folder of folders) {
    const rel = rp ? `${rp}/${folder}` : folder;
    rows.push(`<div class="f-row">
      ${FOLDER_ICON}<a class="f-name" href="${base}?p=${encPath(rel)}${proofQuery}">${esc(folder)}</a>
      <a class="f-dl" href="${base}?zipdir=${encPath(rel)}${proofQuery}" aria-label="Download ${esc(folder)} as ZIP">${DL_ICON}</a>
    </div>`);
  }
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
  const THUMB_MAX = 8 * 1024 * 1024;
  const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  for (const file of files) {
    const rel = rp ? `${rp}/${file.name}` : file.name;
    const sensitive = file.sensitive || SENSITIVE_RE.test(file.name);
    let visual = typedFileIcon(file.name);
    if (IMG_EXT.test(file.name) && file.size <= THUMB_MAX) {
      visual = `<span class="thumb${sensitive ? ' censored' : ''}">
        <img loading="lazy" alt="" src="${base}?raw=${encPath(rel)}${proofQuery}">
        ${sensitive ? `<span class="thumb-lock">${LOCK_SVG}</span>` : ''}
      </span>`;
    } else if (/\.(mp4|webm|m4v|mov)$/i.test(file.name)) {
      visual = `<span class="thumb${sensitive ? ' censored' : ''}">
        <video muted playsinline preload="metadata" src="${base}?raw=${encPath(rel)}${proofQuery}#t=0.1"></video>
        <span class="thumb-play"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z"/></svg></span>
        ${sensitive ? `<span class="thumb-lock">${LOCK_SVG}</span>` : ''}
      </span>`;
    }
    rows.push(`<div class="f-row f-file">
      ${visual}<a class="f-name" href="${base}?view=${encPath(rel)}${proofQuery}">${esc(file.name)}</a>
      <span class="f-size">${formatSize(file.size)}</span>
      <a class="f-dl" href="${base}?dl=${encPath(rel)}${proofQuery}" download aria-label="Download ${esc(file.name)}">${DL_ICON}</a>
    </div>`);
  }
  const list = rows.length
    ? rows.join('\n')
    : '<p class="f-empty">This folder is empty.</p>';

  const count = folders.length + files.length;
  const zipUrl = count ? `${base}?zipdir=${encPath(rp)}${proofQuery}` : null;
  return page(title, `${topBar(zipUrl, viewer)}
  <section class="file-head">
    <h1 class="share-name">${esc(title)}</h1>
    <p class="share-meta">${count} item${count === 1 ? '' : 's'} · folder shared by <em>${esc(share.email)}</em></p>
  </section>
  <main class="share-stage"><div class="folder-panel">${list}</div></main>`);
}

function passwordPage(share, size, viewer, { wrongPassword = false } = {}) {
  const name = share.path.split('/').pop();
  return page(name, `${topBar(null, viewer)}
  <main class="center-stage">
    <div class="card">
      <div class="card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      </div>
      <h1 class="card-title">${esc(name)}</h1>
      <p class="card-meta">${share.folder ? 'Folder' : formatSize(size)} · shared by <em>${esc(share.email)}</em></p>
      <p class="hint">This ${share.folder ? 'folder' : 'file'} is protected. Enter the password to open it.</p>
      <form method="POST" action="/share/${share.token}">
        <input type="password" name="password" placeholder="Password" autocomplete="off" required autofocus>
        ${wrongPassword ? '<p class="error">Wrong password. Try again.</p>' : ''}
        <button class="btn" type="submit">Unlock</button>
      </form>
    </div>
  </main>`);
}

/** Preview area markup for one file: media/frame/na block (+ censor cover). */
function buildStage({ name, size, kind, sensitive, rawUrl, dlUrl }) {
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
      ${typedFileIcon(name)}
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
  return { stage, note, backdropUrl };
}

function previewPage(share, size, proofQuery, viewer) {
  const name = share.path.split('/').pop();
  const base = `/share/${share.token}`;
  const rawUrl = `${base}?raw=1${proofQuery}`;
  const dlUrl = `${base}?dl=1${proofQuery}`;
  const kind = previewKind(name, size);
  const sensitive = isSensitive(share, name, kind);
  const { stage, note, backdropUrl } = buildStage({ name, size, kind, sensitive, rawUrl, dlUrl });

  /* no preview → the stage already shows one big download button */
  return page(name, `${topBar(kind ? dlUrl : null, viewer)}
  <section class="file-head">
    <h1 class="share-name">${esc(name)}</h1>
    <p class="share-meta">${formatSize(size)} · shared by <em>${esc(share.email)}</em></p>
  </section>
  <main class="share-stage">${stage}</main>
  ${note}`, { backdropUrl });
}

/** Preview of a single file inside a shared folder. */
function folderPreviewPage(share, rel, size, proofQuery, viewer, aiSensitive = false) {
  const name = rel.split('/').pop();
  const base = `/share/${share.token}`;
  const rawUrl = `${base}?raw=${encPath(rel)}${proofQuery}`;
  const dlUrl = `${base}?dl=${encPath(rel)}${proofQuery}`;
  const kind = previewKind(name, size);
  const sensitive = aiSensitive
    || ((kind === 'image' || kind === 'video') && SENSITIVE_RE.test(name));
  const { stage, note, backdropUrl } = buildStage({ name, size, kind, sensitive, rawUrl, dlUrl });

  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const backUrl = `${base}?${parent ? `p=${encPath(parent)}` : 'p='}${proofQuery}`;

  return page(name, `${topBar(kind ? dlUrl : null, viewer)}
  <section class="file-head">
    <h1 class="share-name">${esc(name)}</h1>
    <p class="share-meta">${formatSize(size)} · shared by <em>${esc(share.email)}</em></p>
    <a class="back-link" href="${backUrl}">← Back to folder</a>
  </section>
  <main class="share-stage">${stage}</main>
  ${note}`, { backdropUrl });
}

/** Restricted links: sign in, or signed in without access. */
function restrictedPage(share, viewer, requested = false) {
  const name = share.path.split('/').pop();
  const ask = requested
    ? '<p class="hint" style="color:#7FBF8E;">✓ Request sent — the owner will see it in their notifications.</p>'
    : `<form method="POST" action="/share/${share.token}">
        <input type="hidden" name="action" value="request-access">
        <button class="btn" type="submit">Request access</button>
      </form>`;
  const inner = viewer
    ? `<h1 class="card-title">No access to “${esc(name)}”.</h1>
      <p class="hint">You are signed in as <em>${esc(viewer.email)}</em>, but this link is limited to specific people.</p>
      ${ask}`
    : `<h1 class="card-title">${esc(name)}</h1>
      <p class="hint">This link is private. Sign in with an account that has been given access.</p>
      <a class="btn" href="/login">Sign in</a>`;
  return page(name, `${topBar(null, viewer)}
  <main class="center-stage">
    <div class="card">
      <div class="card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      </div>
      ${inner}
    </div>
  </main>`, { status: 403 });
}

/* ---------- streaming ---------- */

/** Stream an R2 object, honouring Range requests (video thumbnails and
    player seeking fetch only the bytes they need). Returns null when
    the key does not exist. */
async function streamFile(env, key, name, inline, request) {
  const head = await env.KILIW_FILES.head(key);
  if (!head) return null;

  const range = parseRange(request, head.size);
  if (range?.invalid) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}` },
    });
  }
  const object = await env.KILIW_FILES.get(
    key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const type = headers.get('Content-Type') || 'application/octet-stream';
  if (!headers.get('Content-Type')) headers.set('Content-Type', type);
  headers.set('Accept-Ranges', 'bytes');
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${head.size}`);
    headers.set('Content-Length', String(range.length));
  } else {
    headers.set('Content-Length', String(head.size));
  }
  headers.set('Cache-Control', 'no-store');
  if (inline) {
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    /* user-supplied markup (html/svg/…) must not run scripts on our origin */
    if (!SAFE_INLINE.test(type)) headers.set('Content-Security-Policy', 'sandbox');
  } else {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

/* ---------- shared folder handler ---------- */

async function handleFolderShare(request, env, share, url, viewer) {
  const rootPrefix = `u/${share.email}/${share.path}/`;

  /* the folder must still exist */
  const probe = await env.KILIW_FILES.list({ prefix: rootPrefix, limit: 1 });
  if (!probe.objects.length) return notFoundPage(viewer);

  if (request.method === 'POST') {
    if (!share.hash) return Response.redirect(`${url.origin}/share/${share.token}`, 303);
    let password = '';
    try {
      password = String((await request.formData()).get('password') || '');
    } catch { /* no form body */ }
    const ok = password
      && timingSafeEqualHex(await hashPassword(password, share.salt), share.hash);
    if (!ok) return passwordPage(share, 0, viewer, { wrongPassword: true });
    const proof = await makeProof(share);
    return Response.redirect(`${url.origin}/share/${share.token}?k=${proof.k}&e=${proof.e}`, 303);
  }

  const unlocked = !share.hash
    || await proofValid(share, url.searchParams.get('k'), url.searchParams.get('e'));
  if (!unlocked) {
    if (url.searchParams.get('dl')) {
      return Response.redirect(`${url.origin}/share/${share.token}`, 302);
    }
    return passwordPage(share, 0, viewer);
  }
  const proofQuery = share.hash
    ? `&k=${encodeURIComponent(url.searchParams.get('k'))}&e=${encodeURIComponent(url.searchParams.get('e'))}`
    : '';

  /* ?zipdir — download the whole folder (or a subfolder) as a .zip */
  if (url.searchParams.has('zipdir')) {
    const relParsed = parsePath(url.searchParams.get('zipdir') || '');
    if (relParsed === null) return notFoundPage(viewer);
    const prefix = `${rootPrefix}${relParsed ? `${relParsed}/` : ''}`;
    const rootName = relParsed ? relParsed.split('/').pop() : share.path.split('/').pop();
    const { entries, error } = await collectZipEntries(env.KILIW_FILES, prefix, rootName);
    if (error) {
      return page('Too large', `${topBar(null, viewer)}
      <main class="center-stage"><div class="card">
        <h1 class="card-title">Folder is too big for a ZIP</h1>
        <p class="hint">This folder exceeds the 4 GB archive limit. Download the files individually instead.</p>
      </div></main>`, { status: 413 });
    }
    if (!entries.length) return notFoundPage(viewer);
    return zipResponse(entries, `${rootName}.zip`);
  }

  /* ?dl=<rel> download · ?raw=<rel> inline stream · ?view=<rel> preview page */
  const dl = url.searchParams.get('dl');
  const raw = url.searchParams.get('raw');
  if (dl || raw) {
    const rel = parsePath(dl || raw);
    if (!rel) return notFoundPage(viewer);
    const res = await streamFile(env, `${rootPrefix}${rel}`, rel.split('/').pop(), Boolean(raw), request);
    return res || notFoundPage(viewer);
  }
  const view = url.searchParams.get('view');
  if (view) {
    const rel = parsePath(view);
    if (!rel) return notFoundPage(viewer);
    const head = await env.KILIW_FILES.head(`${rootPrefix}${rel}`);
    if (!head) return notFoundPage(viewer);
    /* content-based 18+ check (cached per file) on top of the name check */
    const aiSensitive = await moderateStoredImage(env, share.email, `${share.path}/${rel}`);
    return folderPreviewPage(share, rel, head.size, proofQuery, viewer, aiSensitive === true);
  }

  /* ?p=<relative path> — browse a subfolder */
  const rpParsed = parsePath(url.searchParams.get('p') || '');
  const rp = rpParsed === null ? '' : rpParsed;

  const prefix = `${rootPrefix}${rp ? `${rp}/` : ''}`;
  const folders = new Set();
  const files = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const dp of page.delimitedPrefixes) {
      folders.add(dp.slice(prefix.length).replace(/\/$/, ''));
    }
    for (const obj of page.objects) {
      const fname = obj.key.slice(prefix.length);
      if (fname === '.keep' || !fname) continue;
      files.push({ name: fname, size: obj.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => a.name.localeCompare(b.name));

  /* cached 18+ verdicts → blurred thumbnails */
  const level = `${share.path}${rp ? `/${rp}` : ''}`;
  const verdicts = await modVerdictsAt(env, share.email, level);
  for (const file of files) {
    if (verdicts.flagged.has(file.name)) file.sensitive = true;
  }

  return folderPage(share, rp, [...folders].sort(), files, proofQuery, viewer);
}

/* ---------- handler ---------- */

export async function handleShare(request, env, token) {
  if (!env.KILIW_FILES) return notFoundPage();
  const share = await getShare(env, token);
  if (!share) return notFoundPage();

  const key = `u/${share.email}/${share.path}`;
  const name = share.path.split('/').pop();
  const url = new URL(request.url);

  /* who is looking at the page (avatar in the top bar instead of Sign in) */
  let viewer = null;
  try {
    const session = await getSession(request, env);
    if (session) {
      const user = await getUser(env, session.email);
      viewer = { email: session.email, avatar: user?.avatar || null };
    }
  } catch { viewer = null; }

  /* restricted links: only the owner and listed people, signed in */
  if (share.access === 'restricted') {
    const ok = viewer
      && (viewer.email === share.email || (share.allowed || []).includes(viewer.email));
    if (!ok) {
      /* a signed-in visitor may ask the owner for access */
      let requested = false;
      if (request.method === 'POST' && viewer) {
        let action = '';
        try {
          action = String((await request.formData()).get('action') || '');
        } catch { /* no form body */ }
        if (action === 'request-access') {
          requested = await requestShareAccess(env, share, viewer.email);
        }
      }
      return restrictedPage(share, viewer, requested);
    }
  }

  if (share.folder) return handleFolderShare(request, env, share, url, viewer);

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
      if (!head) return notFoundPage(viewer);
      return passwordPage(share, head.size, viewer, { wrongPassword: true });
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
    if (!head) return notFoundPage(viewer);
    return passwordPage(share, head.size, viewer);
  }

  if (want !== 'page') {
    const res = await streamFile(env, key, name, want === 'raw', request);
    return res || notFoundPage(viewer);
  }

  const head = await env.KILIW_FILES.head(key);
  if (!head) return notFoundPage(viewer);
  /* links created before content moderation existed: check on first view */
  await moderateShare(env, share);
  const proofQuery = share.hash
    ? `&k=${encodeURIComponent(url.searchParams.get('k'))}&e=${encodeURIComponent(url.searchParams.get('e'))}`
    : '';
  return previewPage(share, head.size, proofQuery, viewer);
}
