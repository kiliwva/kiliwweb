import { getShare, hashPassword, timingSafeEqualHex } from '../lib/api.js';

/* Public share pages: GET/POST /share/<token>
   - open link  → branded download page (no account needed)
   - ?dl=1      → direct download (links without a password only)
   - POST       → password check for protected links, then the download */

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

function page(title, inner, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <title>${esc(title)} — Kiliw Cloud</title>
  <style>
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
      display: grid;
      place-items: center;
      padding: 20px 14px;
      font-family: 'Manrope', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      background: radial-gradient(120% 120% at 20% 0%, #262626 0%, #161616 48%, #0C0C0C 100%);
      color: #F2F2F2;
    }
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
    .brand { font-size: 17px; font-weight: 800; letter-spacing: -0.3px; margin-bottom: 22px; }
    .brand em { font-style: normal; color: #D97757; }
    .file-name {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.4px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .file-meta { margin-top: 6px; font-size: 13px; font-weight: 600; color: #9C9C9C; }
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
    .btn {
      display: block;
      width: 100%;
      margin-top: 16px;
      padding: 15px 16px;
      font: inherit;
      font-size: 15px;
      font-weight: 800;
      text-align: center;
      text-decoration: none;
      color: #FFF;
      background: #D97757;
      border: 0;
      border-radius: 14px;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:hover { background: rgba(185, 84, 50, 0.9); }
    .btn:active { transform: scale(0.98); }
    .foot { margin-top: 18px; font-size: 12px; font-weight: 600; color: #6C6C6C; text-align: center; }
    .foot a { color: #9C9C9C; text-decoration: none; }
    .foot a:hover { color: #D97757; }
  </style>
</head>
<body>
  <main class="card">
    <p class="brand">Kiliw <em>Cloud</em></p>
    ${inner}
    <p class="foot"><a href="/">kiliw.com</a> — private cloud storage</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function notFoundPage() {
  return page('Link not found', `
    <h1 class="file-name">This link doesn't work anymore.</h1>
    <p class="hint">The file was removed or the share link was deleted by its owner.</p>`, 404);
}

function downloadPage(share, size, { wrongPassword = false } = {}) {
  const name = share.path.split('/').pop();
  const head = `
    <h1 class="file-name">${esc(name)}</h1>
    <p class="file-meta">${formatSize(size)} · shared via Kiliw Cloud</p>`;

  if (!share.hash) {
    return page(name, `${head}
    <a class="btn" href="/share/${share.token}?dl=1" download>Download</a>`);
  }
  return page(name, `${head}
    <p class="hint">This file is protected. Enter the password to download it.</p>
    <form method="POST" action="/share/${share.token}">
      <input type="password" name="password" placeholder="Password" autocomplete="off" required autofocus>
      ${wrongPassword ? '<p class="error">Wrong password. Try again.</p>' : ''}
      <button class="btn" type="submit">Download</button>
    </form>`);
}

function streamDownload(object, name) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('Cache-Control', 'no-store');
  return new Response(object.body, { headers });
}

export async function handleShare(request, env, token) {
  if (!env.KILIW_FILES) return notFoundPage();
  const share = await getShare(env, token);
  if (!share) return notFoundPage();

  const key = `u/${share.email}/${share.path}`;
  const name = share.path.split('/').pop();

  if (request.method === 'POST') {
    if (!share.hash) {
      const object = await env.KILIW_FILES.get(key);
      return object ? streamDownload(object, name) : notFoundPage();
    }
    let password = '';
    try {
      password = String((await request.formData()).get('password') || '');
    } catch { /* no form body */ }
    const hash = await hashPassword(password, share.salt);
    if (!password || !timingSafeEqualHex(hash, share.hash)) {
      const head = await env.KILIW_FILES.head(key);
      if (!head) return notFoundPage();
      return downloadPage(share, head.size, { wrongPassword: true });
    }
    const object = await env.KILIW_FILES.get(key);
    return object ? streamDownload(object, name) : notFoundPage();
  }

  /* GET */
  if (new URL(request.url).searchParams.get('dl') === '1' && !share.hash) {
    const object = await env.KILIW_FILES.get(key);
    return object ? streamDownload(object, name) : notFoundPage();
  }
  const head = await env.KILIW_FILES.head(key);
  if (!head) return notFoundPage();
  return downloadPage(share, head.size);
}
