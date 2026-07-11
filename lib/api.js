/* Shared helpers for the Worker / Pages Functions: sessions, users,
   password hashing, Turnstile verification, cookies.

   All data lives in one R2 bucket (binding KILIW_FILES):
     _auth/users/<email>.json      — account records
     _auth/sessions/<token>.json   — sessions (30-day expiry)
     u/<email>/<filename>          — the user's files */

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export function storageReady(env) {
  return Boolean(env.KILIW_FILES);
}

export async function getUser(env, email) {
  const obj = await env.KILIW_FILES.get(`_auth/users/${email}.json`);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

export async function putUser(env, user) {
  await env.KILIW_FILES.put(`_auth/users/${user.email}.json`, JSON.stringify(user));
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      /* Safari heuristically caches responses without Cache-Control,
         serving stale profile/file data — never cache API JSON */
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/* ---------- hex / crypto ---------- */

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: 100000 },
    key, 256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- hosts / redirects ---------- */

function hostname(request) {
  return new URL(request.url).hostname;
}

export function isPlainHost(host) {
  return host === 'localhost' || /^[\d.]+$/.test(host)
    || host.endsWith('.pages.dev') || host.endsWith('.workers.dev');
}

/** kiliw.com for auth.kiliw.com / cloud.kiliw.com / www.kiliw.com */
export function baseHost(host) {
  return host.replace(/^(auth|cloud|www)\./, '');
}

/** Where to send the user after successful sign-in: the cloud app. */
export function afterAuthRedirect(request) {
  const host = hostname(request);
  const proto = new URL(request.url).protocol;
  if (isPlainHost(host)) return '/';
  return `${proto}//cloud.${baseHost(host)}/`;
}

/** Where to send the user to sign in. */
export function authRedirect(request) {
  const host = hostname(request);
  const proto = new URL(request.url).protocol;
  if (isPlainHost(host)) return '/';
  return `${proto}//auth.${baseHost(host)}/`;
}

/* ---------- cookies / sessions ---------- */

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function cookieDomain(host) {
  if (isPlainHost(host)) return null;
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

export function buildSessionCookie(request, token, maxAge = SESSION_TTL) {
  const url = new URL(request.url);
  const domain = cookieDomain(url.hostname);
  let cookie = `kiliw_session=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
  if (domain) cookie += `; Domain=${domain}`;
  if (url.protocol === 'https:') cookie += '; Secure';
  return cookie;
}

/** Human label for the signing-in device, parsed from the User-Agent. */
export function deviceLabel(request) {
  const ua = request?.headers?.get('User-Agent') || '';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} · ${os}`;
}

export async function createSession(env, email, request) {
  const token = randomHex(32);
  await env.KILIW_FILES.put(
    `_auth/sessions/${token}.json`,
    JSON.stringify({
      email,
      device: deviceLabel(request),
      created: Date.now(),
      expires: Date.now() + SESSION_TTL * 1000,
    }),
  );
  return { token, cookie: buildSessionCookie(request, token) };
}

/** Every live session of an account: [{token, device, created}]. */
export async function listUserSessions(env, email) {
  const prefix = '_auth/sessions/';
  const keys = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const sessions = [];
  await Promise.all(keys.map(async (key) => {
    const rec = await env.KILIW_FILES.get(key);
    if (!rec) return;
    try {
      const data = JSON.parse(await rec.text());
      if (data.email !== email) return;
      if (data.expires && data.expires < Date.now()) return;
      sessions.push({
        token: key.slice(prefix.length).replace(/\.json$/, ''),
        device: data.device || null,
        created: data.created || 0,
      });
    } catch { /* skip unreadable */ }
  }));
  sessions.sort((a, b) => b.created - a.created);
  return sessions;
}

export async function getSession(request, env) {
  if (!storageReady(env)) return null;
  const token = getCookie(request, 'kiliw_session');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const obj = await env.KILIW_FILES.get(`_auth/sessions/${token}.json`);
  if (!obj) return null;
  try {
    const session = JSON.parse(await obj.text());
    if (!session || !session.email) return null;
    if (session.expires && session.expires < Date.now()) {
      await env.KILIW_FILES.delete(`_auth/sessions/${token}.json`);
      return null;
    }
    return { ...session, token };
  } catch {
    return null;
  }
}

export async function destroySession(request, env) {
  const session = await getSession(request, env);
  if (session) await env.KILIW_FILES.delete(`_auth/sessions/${session.token}.json`);
  return buildSessionCookie(request, 'deleted', 0);
}

/* ---------- plans / quotas ---------- */

export const GIB = 1024 * 1024 * 1024;
export const FREE_MAX_FILE = 1 * GIB;
export const FREE_QUOTA = 10 * GIB;
export const PRO_MAX_FILE = 50 * GIB;
export const PRO_GB_MIN = 250;
export const PRO_GB_MAX = 1024;
export const PRO_DAYS = 30;

/** Fixed Pro tiers: storage GB → price in USD per 30 days. */
export const PRO_TIERS = { 250: 4.99, 500: 8.99, 1024: 17.99 };

/** DEV plan: Pro-level storage plus developer API access. */
export const DEV_GB = 500;
export const DEV_PRICE = 12.99;

/** YooKassa charges in RUB: last-resort rate if no source is reachable. */
export const RUB_PER_USD = 90;

const RATE_TTL = 60 * 60 * 1000; // refresh the exchange rate hourly
const RATE_KEY = '_rates/usd-rub.json';

/** Live USD→RUB rate: Central Bank of Russia, fallback to open.er-api.com,
    cached in R2 for an hour; a stale cache beats the fixed constant. */
export async function usdRubRate(env) {
  let cached = null;
  const rec = await env.KILIW_FILES.get(RATE_KEY);
  if (rec) {
    try {
      cached = JSON.parse(await rec.text());
    } catch { cached = null; }
  }
  if (cached?.rate > 0 && cached.fetched + RATE_TTL > Date.now()) return cached.rate;

  let rate = null;
  try {
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js');
    const data = await res.json();
    const value = Number(data?.Valute?.USD?.Value);
    if (Number.isFinite(value) && value > 0) rate = value;
  } catch { /* try the next source */ }
  if (!rate) {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      const data = await res.json();
      const value = Number(data?.rates?.RUB);
      if (Number.isFinite(value) && value > 0) rate = value;
    } catch { /* fall through */ }
  }

  if (rate) {
    await env.KILIW_FILES.put(RATE_KEY, JSON.stringify({ rate, fetched: Date.now() }));
    return rate;
  }
  if (cached?.rate > 0) return cached.rate; // stale but real
  return RUB_PER_USD;
}

/* ---------- promo codes ----------
   _promo/<CODE>.json — {code, percent, maxUses, uses, created} */

const promoKey = (code) => `_promo/${code}.json`;

export function normPromoCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

export async function getPromo(env, code) {
  if (!code) return null;
  const rec = await env.KILIW_FILES.get(promoKey(code));
  if (!rec) return null;
  try {
    return JSON.parse(await rec.text());
  } catch {
    return null;
  }
}

/** A promo that can still be used, or null. */
export async function validatePromo(env, rawCode) {
  const promo = await getPromo(env, normPromoCode(rawCode));
  if (!promo) return null;
  if (promo.maxUses && promo.uses >= promo.maxUses) return null;
  return promo;
}

export async function putPromo(env, promo) {
  await env.KILIW_FILES.put(promoKey(promo.code), JSON.stringify(promo));
}

export async function deletePromo(env, code) {
  await env.KILIW_FILES.delete(promoKey(normPromoCode(code)));
}

export async function listPromos(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: '_promo/', cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const promos = [];
  await Promise.all(keys.map(async (key) => {
    const rec = await env.KILIW_FILES.get(key);
    if (!rec) return;
    try {
      promos.push(JSON.parse(await rec.text()));
    } catch { /* skip */ }
  }));
  return promos.sort((a, b) => b.created - a.created);
}

export async function bumpPromoUse(env, code) {
  const promo = await getPromo(env, code);
  if (!promo) return;
  promo.uses = (promo.uses || 0) + 1;
  await putPromo(env, promo);
}

/** Price after a percent discount, floored at $0.50.
    A 100% promo makes the plan free (activated without a payment). */
export function discountedPrice(base, promo) {
  if (!promo) return base;
  if (promo.percent >= 100) return 0;
  return Math.max(0.5, Math.round(base * (100 - promo.percent)) / 100);
}

export function isOwner(env, email) {
  return Boolean(env?.OWNER_EMAIL && email === env.OWNER_EMAIL);
}

/** Pro price in USD for a 30-day period; null for a non-existent tier. */
export function proPrice(gb) {
  return PRO_TIERS[gb] ?? null;
}

export function proActive(user) {
  return Boolean(user && user.plan === 'pro' && user.planUntil && user.planUntil > Date.now());
}

export function devActive(user) {
  return Boolean(user && user.plan === 'dev' && user.planUntil && user.planUntil > Date.now());
}

export function planLimits(user, env) {
  /* the site owner always has the top plan, API included */
  if (env?.OWNER_EMAIL && user?.email === env.OWNER_EMAIL) {
    return {
      type: 'pro',
      maxFile: PRO_MAX_FILE,
      quota: PRO_GB_MAX * GIB,
      gb: PRO_GB_MAX,
      until: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
      api: true,
    };
  }
  if (devActive(user)) {
    return {
      type: 'dev',
      maxFile: PRO_MAX_FILE,
      quota: (user.planGb || DEV_GB) * GIB,
      gb: user.planGb || DEV_GB,
      until: user.planUntil,
      api: true,
    };
  }
  if (proActive(user)) {
    return {
      type: 'pro',
      maxFile: PRO_MAX_FILE,
      quota: (user.planGb || PRO_GB_MIN) * GIB,
      gb: user.planGb || PRO_GB_MIN,
      until: user.planUntil,
      api: false,
    };
  }
  return { type: 'free', maxFile: FREE_MAX_FILE, quota: FREE_QUOTA, api: false };
}

/** Total bytes stored under the user's prefix. */
export async function storageUsage(env, email) {
  const prefix = `u/${email}/`;
  let total = 0;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) total += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

/* ---------- developer API keys ----------
   _auth/apikeys/<sha256(secret)>.json   — {email, name, prefix, created}
   _auth/apikeysbyuser/<email>/<hash>    — per-user index */

const apiKeyRecKey = (hash) => `_auth/apikeys/${hash}.json`;
const apiKeyUserPrefix = (email) => `_auth/apikeysbyuser/${email}/`;

export async function createApiKey(env, email, name) {
  const secret = `kw_${randomHex(20)}`;
  const hash = await sha256Hex(secret);
  const record = {
    email,
    name: String(name || 'API key').slice(0, 40),
    prefix: secret.slice(0, 8),
    created: Date.now(),
    hash,
  };
  await env.KILIW_FILES.put(apiKeyRecKey(hash), JSON.stringify(record));
  await env.KILIW_FILES.put(`${apiKeyUserPrefix(email)}${hash}`, '1');
  return { secret, ...record };
}

export async function listApiKeys(env, email) {
  const prefix = apiKeyUserPrefix(email);
  const hashes = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    hashes.push(...page.objects.map((o) => o.key.slice(prefix.length)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const keys = [];
  await Promise.all(hashes.map(async (hash) => {
    const rec = await env.KILIW_FILES.get(apiKeyRecKey(hash));
    if (!rec) return;
    try {
      keys.push(JSON.parse(await rec.text()));
    } catch { /* skip */ }
  }));
  return keys.sort((a, b) => b.created - a.created);
}

export async function revokeApiKey(env, email, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return false;
  const rec = await env.KILIW_FILES.get(apiKeyRecKey(hash));
  if (!rec) return false;
  try {
    if (JSON.parse(await rec.text()).email !== email) return false;
  } catch {
    return false;
  }
  await env.KILIW_FILES.delete(apiKeyRecKey(hash));
  await env.KILIW_FILES.delete(`${apiKeyUserPrefix(email)}${hash}`);
  return true;
}

export async function wipeApiKeys(env, email) {
  const prefix = apiKeyUserPrefix(email);
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      await env.KILIW_FILES.delete(apiKeyRecKey(obj.key.slice(prefix.length)));
      await env.KILIW_FILES.delete(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Resolve `Authorization: Bearer kw_…` to the key owner's email. */
export async function apiKeyUser(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(kw_[0-9a-f]{40})$/i);
  if (!match) return null;
  const rec = await env.KILIW_FILES.get(apiKeyRecKey(await sha256Hex(match[1])));
  if (!rec) return null;
  try {
    return JSON.parse(await rec.text()).email;
  } catch {
    return null;
  }
}

/* ---------- names / paths ---------- */

const MAX_SEGMENT = 180;
const MAX_DEPTH = 12;

/** A single file or folder name: no slashes, no control chars. */
export function cleanSegment(raw) {
  const name = String(raw || '')
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  if (!name || name === '.' || name === '..' || name === '.keep' || name.length > MAX_SEGMENT) {
    return null;
  }
  return name;
}

/** Folder path like "a/b/c" (or ""). Returns null when invalid. */
export function parsePath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const segments = value.split('/').filter((s) => s !== '');
  if (segments.length > MAX_DEPTH) return null;
  const clean = [];
  for (const segment of segments) {
    const name = cleanSegment(segment);
    if (!name) return null;
    clean.push(name);
  }
  return clean.join('/');
}

/* ---------- public file shares ----------
   _share/t/<token>.json          — share record {token, email, path, created, salt?, hash?}
   _share/f/<email>/<path>        — file → token index (body = token) */

const shareTokenKey = (token) => `_share/t/${token}.json`;
const shareFileKey = (email, path) => `_share/f/${email}/${path}`;

export async function getShare(env, token) {
  if (!/^[0-9a-f]{32}$/.test(token || '')) return null;
  const obj = await env.KILIW_FILES.get(shareTokenKey(token));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

export async function shareTokenForFile(env, email, path) {
  const obj = await env.KILIW_FILES.get(shareFileKey(email, path));
  return obj ? (await obj.text()).trim() : null;
}

export async function createShare(env, email, path, password, folder = false, access = 'public') {
  /* one share per file/folder: replace an existing link */
  const old = await shareTokenForFile(env, email, path);
  if (old) await env.KILIW_FILES.delete(shareTokenKey(old));

  const share = { token: randomHex(16), email, path, created: Date.now() };
  if (folder) share.folder = true;
  if (access === 'restricted') {
    /* only listed people (signed in) can open; passwords don't apply */
    share.access = 'restricted';
    share.allowed = [];
  } else if (password) {
    share.salt = randomHex(16);
    share.hash = await hashPassword(password, share.salt);
  }
  await env.KILIW_FILES.put(shareTokenKey(share.token), JSON.stringify(share));
  await env.KILIW_FILES.put(shareFileKey(email, path), share.token);
  return share;
}

/** Persist changes to an existing share record (e.g. the sensitive flag). */
export async function saveShare(env, share) {
  await env.KILIW_FILES.put(shareTokenKey(share.token), JSON.stringify(share));
}

/* --- content-based 18+ detection (Workers AI) --- */

const AI_IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;
const AI_MAX_BYTES = 6 * 1024 * 1024; // don't feed huge originals to the model

export function canModerateImage(env, path, size) {
  return Boolean(env.AI) && AI_IMAGE_RE.test(path) && size > 0 && size <= AI_MAX_BYTES;
}

/** Ask a vision model whether the image is adult content.
    Returns true / false, or null when it can't be analyzed. */
export async function detectSensitiveImage(env, bytes) {
  if (!env.AI) return null;
  try {
    const res = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: [...new Uint8Array(bytes)],
      prompt: 'Does this image contain nudity, sexual or explicit adult (18+) content? Answer with only YES or NO.',
      max_tokens: 8,
    });
    const answer = String(res?.description || '').trim().toLowerCase();
    if (answer.startsWith('yes')) return true;
    if (answer.startsWith('no')) return false;
    if (/\byes\b/.test(answer)) return true;
    if (/\bno\b/.test(answer)) return false;
    return null;
  } catch {
    return null; /* model unavailable: fall back to name-based detection */
  }
}

/** Content check for any stored image, cached in _mod/<email>/<path>.json.
    Used for files viewed inside shared folders. Returns true/false/null. */
export async function moderateStoredImage(env, email, path) {
  const modKey = `_mod/${email}/${path}.json`;
  const cached = await env.KILIW_FILES.get(modKey);
  if (cached) {
    try {
      return JSON.parse(await cached.text()).sensitive;
    } catch {
      return null;
    }
  }
  const key = `u/${email}/${path}`;
  const head = await env.KILIW_FILES.head(key);
  if (!head || !canModerateImage(env, path, head.size)) return null;
  const object = await env.KILIW_FILES.get(key);
  if (!object) return null;
  const sensitive = await detectSensitiveImage(env, await object.arrayBuffer());
  /* null is cached too: "analyzed, unknown" — avoids re-running every view */
  await env.KILIW_FILES.put(modKey, JSON.stringify({ sensitive, checked: Date.now() }));
  return sensitive;
}

/** Keep the cached verdict when a file is renamed. */
export async function moveModVerdict(env, email, oldPath, newPath) {
  const old = await env.KILIW_FILES.get(`_mod/${email}/${oldPath}.json`);
  if (!old) return;
  await env.KILIW_FILES.put(`_mod/${email}/${newPath}.json`, await old.text());
  await env.KILIW_FILES.delete(`_mod/${email}/${oldPath}.json`);
}

export async function deleteModVerdict(env, email, path) {
  await env.KILIW_FILES.delete(`_mod/${email}/${path}.json`);
}

/** Cached verdicts for one folder level: {checked: Set, flagged: Set}. */
export async function modVerdictsAt(env, email, folderPath) {
  const prefix = `_mod/${email}/${folderPath ? `${folderPath}/` : ''}`;
  const keys = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const checked = new Set();
  const flagged = new Set();
  await Promise.all(keys.map(async (key) => {
    const rec = await env.KILIW_FILES.get(key);
    if (!rec) return;
    const name = key.slice(prefix.length).replace(/\.json$/, '');
    checked.add(name);
    try {
      if (JSON.parse(await rec.text()).sensitive === true) flagged.add(name);
    } catch { /* skip unreadable */ }
  }));
  return { checked, flagged };
}

/** Classify a shared image once and remember the verdict on the record. */
export async function moderateShare(env, share) {
  if (share.sensitive !== undefined) return share; // already checked
  const key = `u/${share.email}/${share.path}`;
  const head = await env.KILIW_FILES.head(key);
  if (!head || !canModerateImage(env, share.path, head.size)) return share;
  const object = await env.KILIW_FILES.get(key);
  if (!object) return share;
  /* null is stored too: "analyzed, unknown" — avoids re-running on every view */
  share.sensitive = await detectSensitiveImage(env, await object.arrayBuffer());
  await saveShare(env, share);
  return share;
}

export async function deleteShareForFile(env, email, path) {
  const token = await shareTokenForFile(env, email, path);
  if (!token) return;
  await env.KILIW_FILES.delete(shareTokenKey(token));
  await env.KILIW_FILES.delete(shareFileKey(email, path));
}

/** Move a share record when its file is renamed. */
export async function moveShare(env, email, oldPath, newPath) {
  const token = await shareTokenForFile(env, email, oldPath);
  if (!token) return;
  const share = await getShare(env, token);
  if (share) {
    share.path = newPath;
    await env.KILIW_FILES.put(shareTokenKey(token), JSON.stringify(share));
    await env.KILIW_FILES.put(shareFileKey(email, newPath), token);
  }
  await env.KILIW_FILES.delete(shareFileKey(email, oldPath));
}

/** Drop every share pointing inside a deleted folder. */
export async function deleteSharesUnder(env, email, folderPath) {
  const prefix = `_share/f/${email}/${folderPath}/`;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      const token = rec ? (await rec.text()).trim() : '';
      if (token) await env.KILIW_FILES.delete(shareTokenKey(token));
      await env.KILIW_FILES.delete(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/* ---------- folder collaborators (edit access by email) ----------
   _collab/m/<member>/<gid>.json          — grant record {owner, path, granted}
   _collab/o/<owner>/<enc(path)>/<member> — owner-side index (body = gid) */

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(digest));
}

export async function collabId(owner, path) {
  return (await sha256Hex(`collab:${owner}:${path}`)).slice(0, 16);
}

const collabMemberKey = (member, gid) => `_collab/m/${member}/${gid}.json`;
const collabOwnerPrefix = (owner) => `_collab/o/${owner}/`;
const collabOwnerKey = (owner, path, member) => `${collabOwnerPrefix(owner)}${encodeURIComponent(path)}/${member}`;

export async function addCollab(env, owner, path, member) {
  const gid = await collabId(owner, path);
  await env.KILIW_FILES.put(
    collabMemberKey(member, gid),
    JSON.stringify({ owner, path, granted: Date.now() }),
  );
  await env.KILIW_FILES.put(collabOwnerKey(owner, path, member), gid);
}

export async function removeCollab(env, owner, path, member) {
  await env.KILIW_FILES.delete(collabMemberKey(member, await collabId(owner, path)));
  await env.KILIW_FILES.delete(collabOwnerKey(owner, path, member));
}

export async function listCollabMembers(env, owner, path) {
  const prefix = `${collabOwnerPrefix(owner)}${encodeURIComponent(path)}/`;
  const members = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) members.push(obj.key.slice(prefix.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return members.sort();
}

export async function listSharedWithMe(env, member) {
  const prefix = `_collab/m/${member}/`;
  const keys = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const grants = [];
  await Promise.all(keys.map(async (key) => {
    const rec = await env.KILIW_FILES.get(key);
    if (!rec) return;
    try {
      const grant = JSON.parse(await rec.text());
      grants.push({
        id: key.slice(prefix.length).replace(/\.json$/, ''),
        owner: grant.owner,
        path: grant.path,
      });
    } catch { /* skip unreadable */ }
  }));
  return grants.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getGrant(env, member, gid) {
  if (!/^[0-9a-f]{16}$/.test(gid || '')) return null;
  const rec = await env.KILIW_FILES.get(collabMemberKey(member, gid));
  if (!rec) return null;
  try {
    return JSON.parse(await rec.text());
  } catch {
    return null;
  }
}

/** Access scope for the file APIs: the user's own root, or (with ?scope=)
    a folder someone shared with them for editing. Returns null when the
    grant doesn't exist (revoked). */
export async function resolveScope(env, session, request) {
  const gid = new URL(request.url).searchParams.get('scope');
  if (!gid) return { email: session.email, base: '' };
  const grant = await getGrant(env, session.email, gid);
  if (!grant) return null;
  return { email: grant.owner, base: grant.path };
}

/** Join scope base with path parts, skipping empties. */
export function scopedPath(scope, ...parts) {
  return [scope.base, ...parts].filter(Boolean).join('/');
}

/** Drop every grant on folderPath or inside it ('' = everything owned). */
export async function removeCollabsUnder(env, owner, folderPath) {
  const prefix = collabOwnerPrefix(owner);
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const tail = obj.key.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash < 0) continue;
      const path = decodeURIComponent(tail.slice(0, slash));
      const member = tail.slice(slash + 1);
      if (!folderPath || path === folderPath || path.startsWith(`${folderPath}/`)) {
        await env.KILIW_FILES.delete(collabMemberKey(member, await collabId(owner, path)));
        await env.KILIW_FILES.delete(obj.key);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Account deletion: drop grants in both directions. */
export async function wipeCollabForAccount(env, email) {
  await removeCollabsUnder(env, email, ''); // folders this account shared
  const prefix = `_collab/m/${email}/`; // folders shared with this account
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      try {
        const grant = rec ? JSON.parse(await rec.text()) : null;
        if (grant) await env.KILIW_FILES.delete(collabOwnerKey(grant.owner, grant.path, email));
      } catch { /* skip */ }
      await env.KILIW_FILES.delete(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/* ---------- notifications ----------
   _notif/<email>/<id>.json — {id, type, from, path, token, created, read} */

const notifKey = (email, id) => `_notif/${email}/${id}.json`;

export async function addNotification(env, email, notif) {
  const id = `${Date.now()}-${randomHex(4)}`;
  await env.KILIW_FILES.put(
    notifKey(email, id),
    JSON.stringify({ ...notif, id, created: Date.now(), read: false }),
  );
  return id;
}

export async function listNotifications(env, email) {
  const prefix = `_notif/${email}/`;
  const keys = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const out = [];
  await Promise.all(keys.map(async (key) => {
    const rec = await env.KILIW_FILES.get(key);
    if (!rec) return;
    try {
      out.push(JSON.parse(await rec.text()));
    } catch { /* skip unreadable */ }
  }));
  out.sort((a, b) => b.created - a.created);
  return out.slice(0, 50);
}

export async function getNotification(env, email, id) {
  if (!/^[0-9]+-[0-9a-f]+$/.test(id || '')) return null;
  const rec = await env.KILIW_FILES.get(notifKey(email, id));
  if (!rec) return null;
  try {
    return JSON.parse(await rec.text());
  } catch {
    return null;
  }
}

export async function saveNotification(env, email, notif) {
  await env.KILIW_FILES.put(notifKey(email, notif.id), JSON.stringify(notif));
}

export async function deleteNotification(env, email, id) {
  await env.KILIW_FILES.delete(notifKey(email, id));
}

/** "X asks for access" for the share owner; deduped while one is pending. */
export async function requestShareAccess(env, share, fromEmail) {
  const existing = await listNotifications(env, share.email);
  if (existing.some((n) => n.type === 'access-request' && n.token === share.token && n.from === fromEmail)) {
    return true; // already requested
  }
  await addNotification(env, share.email, {
    type: 'access-request',
    from: fromEmail,
    path: share.path,
    token: share.token,
  });
  return true;
}

/** Public link for a share: always on the cloud subdomain. */
export function shareUrl(request, token) {
  const url = new URL(request.url);
  const host = isPlainHost(url.hostname) ? url.host : `cloud.${baseHost(url.hostname)}`;
  return `${url.protocol}//${host}/share/${token}`;
}

/* ---------- YooKassa ---------- */

export function yookassaReady(env) {
  return Boolean(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY);
}

export async function yookassaRequest(env, method, path, body, idempotenceKey) {
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  const headers = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
  };
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
  const res = await fetch(`https://api.yookassa.ru/v3${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/** Activate/extend Pro or DEV for a user after a confirmed payment (idempotent). */
export async function applyProPurchase(env, email, gb, paymentId, plan = 'pro') {
  if (!email || !Number.isFinite(gb)) return false;
  const user = await getUser(env, email);
  if (!user) return false;
  if (user.lastPaymentId === paymentId) return true; // already applied

  const isDev = plan === 'dev';
  user.plan = isDev ? 'dev' : 'pro';
  user.planGb = isDev
    ? DEV_GB
    : Math.min(Math.max(Math.round(gb), PRO_GB_MIN), PRO_GB_MAX);
  const base = (proActive(user) || devActive(user)) && user.planUntil ? user.planUntil : Date.now();
  user.planUntil = base + PRO_DAYS * 24 * 60 * 60 * 1000;
  user.lastPaymentId = paymentId;
  if (user.pendingPayment?.id === paymentId || user.pendingPayment === paymentId) {
    delete user.pendingPayment;
  }
  await putUser(env, user);
  return true;
}

/** Apply a succeeded YooKassa payment (metadata carries email + gb + plan). */
export async function applyPayment(env, payment) {
  if (!payment || payment.status !== 'succeeded') return false;
  return applyProPurchase(
    env,
    payment.metadata?.email,
    Number(payment.metadata?.gb),
    payment.id,
    payment.metadata?.plan === 'dev' ? 'dev' : 'pro',
  );
}

/* ---------- Heleket (crypto payments) ---------- */

export function heleketReady(env) {
  return Boolean(env.HELEKET_MERCHANT_ID && env.HELEKET_API_KEY);
}

async function md5Hex(str) {
  /* MD5 is a documented non-standard digest in Cloudflare Workers */
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(str));
  return bytesToHex(new Uint8Array(digest));
}

function base64Utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export async function heleketRequest(env, path, body) {
  const payload = JSON.stringify(body);
  const sign = await md5Hex(base64Utf8(payload) + env.HELEKET_API_KEY);
  const res = await fetch(`https://api.heleket.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      merchant: env.HELEKET_MERCHANT_ID,
      sign,
    },
    body: payload,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

const HELEKET_PAID = ['paid', 'paid_over'];
const HELEKET_FAILED = ['fail', 'cancel', 'system_fail', 'refund_process', 'refund_paid', 'wrong_amount'];

export function heleketOutcome(paymentStatus) {
  if (HELEKET_PAID.includes(paymentStatus)) return 'succeeded';
  if (HELEKET_FAILED.includes(paymentStatus)) return 'canceled';
  return 'pending';
}

/* ---------- email (Resend) ---------- */

export function mailReady(env) {
  return Boolean(env.RESEND_API_KEY);
}

export async function sendEmail(env, to, subject, text, html) {
  if (env.MAIL_DEBUG === '1') return true; // local testing: pretend sent
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Kiliw <noreply@kiliw.com>',
        to: [to],
        subject,
        text,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function sixDigitCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

const PENDING_TTL = 15 * 60 * 1000; // 15 minutes

export async function getPending(env, email) {
  const obj = await env.KILIW_FILES.get(`_auth/pending/${email}.json`);
  if (!obj) return null;
  try {
    const pending = JSON.parse(await obj.text());
    if (pending.expires < Date.now()) {
      await env.KILIW_FILES.delete(`_auth/pending/${email}.json`);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export async function putPending(env, pending) {
  await env.KILIW_FILES.put(`_auth/pending/${pending.email}.json`, JSON.stringify(pending));
}

export async function deletePending(env, email) {
  await env.KILIW_FILES.delete(`_auth/pending/${email}.json`);
}

export function newPending(email, salt, hash) {
  return {
    email,
    salt,
    hash,
    code: sixDigitCode(),
    expires: Date.now() + PENDING_TTL,
    attempts: 0,
    lastSent: Date.now(),
  };
}

/** Branded dark email with the code rendered as six OTP boxes. */
export function buildCodeEmail({ subject, intro, note, code }) {
  const font = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  const cells = [...String(code)].map((digit) => `
        <td style="width:46px;height:56px;background:#262626;border:1.5px solid #3E3E3E;border-radius:12px;text-align:center;vertical-align:middle;font-family:${font};font-size:22px;font-weight:800;color:#F2F2F2;">${digit}</td>
        <td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#161616;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#161616;">
    <tr><td align="center" style="padding:36px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#1E1E1E;border:1px solid #2F2F2F;border-radius:24px;">
        <tr><td style="padding:30px 28px 0;font-family:${font};">
          <span style="font-size:20px;font-weight:800;color:#F2F2F2;letter-spacing:-0.3px;">Kiliw <span style="color:#D97757;">Cloud</span></span>
        </td></tr>
        <tr><td style="padding:16px 28px 0;font-family:${font};font-size:14.5px;line-height:1.55;color:#B9B9B9;">${intro}</td></tr>
        <tr><td align="center" style="padding:22px 20px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
        </td></tr>
        <tr><td style="padding:22px 28px 30px;font-family:${font};font-size:12.5px;line-height:1.55;color:#7C7C7C;">${note}</td></tr>
      </table>
      <div style="padding-top:16px;font-family:${font};font-size:12px;color:#5C5C5C;">Kiliw Cloud · kiliw.com</div>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

export function verificationEmail(code) {
  const { subject, html } = buildCodeEmail({
    subject: `${code} — your Kiliw verification code`,
    intro: 'Here is your verification code. Enter it on the sign-up page to finish creating your account.',
    note: "The code expires in 15 minutes. If you didn't request it, just ignore this email.",
    code,
  });
  const text = `Your Kiliw verification code: ${code}. It expires in 15 minutes. If you didn't request it, just ignore this email.`;
  return { subject, text, html };
}

/* ---------- TOTP (2FA) ---------- */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

async function totpCode(secretB32, counter) {
  const key = await crypto.subtle.importKey(
    'raw', base32Decode(secretB32),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (
    ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3]
  ) % 1000000;
  return String(code).padStart(6, '0');
}

/** Verify a 6-digit TOTP code with a ±1 step window (30 s steps). */
export async function verifyTotp(secretB32, code) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const drift of [0, -1, 1]) {
    if (timingSafeEqualHex(await totpCode(secretB32, counter + drift), normalized)) {
      return true;
    }
  }
  return false;
}

export function otpauthUri(email, secretB32) {
  const label = encodeURIComponent(`Kiliw:${email}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=Kiliw&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- Turnstile ---------- */

export async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET_KEY || TEST_SECRET_KEY;
  if (!token || typeof token !== 'string') {
    return { ok: false, codes: ['missing-input-response'] };
  }

  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    const outcome = await res.json();
    if (outcome.success === true) return { ok: true };
    return { ok: false, codes: outcome['error-codes'] || ['unknown'] };
  } catch {
    /* siteverify unreachable: allow only in dev (test secret), fail closed in prod */
    return { ok: secret === TEST_SECRET_KEY, codes: ['siteverify-unreachable'] };
  }
}

/* ---------- trash (30-day recycle bin) ---------- */

export const TRASH_TTL = 30 * 24 * 60 * 60 * 1000;

const trashPrefix = (email) => `_trash/${email}/`;

/** Move a stored file into the owner's trash instead of deleting it. */
export async function trashFile(env, email, fullPath) {
  const key = `u/${email}/${fullPath}`;
  const object = await env.KILIW_FILES.get(key);
  if (!object) return false;
  const id = `${Date.now()}-${randomHex(4)}`;
  await env.KILIW_FILES.put(`${trashPrefix(email)}${id}`, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: { path: fullPath, deleted: String(Date.now()) },
  });
  await env.KILIW_FILES.delete(key);
  return true;
}

/** List trash items newest-first; expired ones are purged on the way. */
export async function listTrash(env, email) {
  const items = [];
  const expired = [];
  const cutoff = Date.now() - TRASH_TTL;
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({
      prefix: trashPrefix(email), cursor, limit: 1000, include: ['customMetadata'],
    });
    for (const obj of page.objects) {
      const id = obj.key.slice(trashPrefix(email).length);
      const deleted = Number(obj.customMetadata?.path ? obj.customMetadata?.deleted : id.split('-')[0]) || 0;
      if (deleted < cutoff) {
        expired.push(obj.key);
        continue;
      }
      items.push({
        id,
        path: obj.customMetadata?.path || id,
        size: obj.size,
        deleted,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (expired.length) await env.KILIW_FILES.delete(expired);
  items.sort((a, b) => b.deleted - a.deleted);
  return items;
}

/** Put a trash item back; picks "name (n).ext" when the spot is taken. */
export async function restoreTrash(env, email, id) {
  const object = await env.KILIW_FILES.get(`${trashPrefix(email)}${id}`);
  if (!object) return null;
  const original = object.customMetadata?.path || id;

  let target = original;
  for (let n = 1; await env.KILIW_FILES.head(`u/${email}/${target}`); n++) {
    if (n > 50) return null;
    const dir = original.includes('/') ? original.slice(0, original.lastIndexOf('/') + 1) : '';
    const name = original.split('/').pop();
    const dot = name.lastIndexOf('.');
    target = dot > 0
      ? `${dir}${name.slice(0, dot)} (${n})${name.slice(dot)}`
      : `${dir}${name} (${n})`;
  }
  await env.KILIW_FILES.put(`u/${email}/${target}`, object.body, {
    httpMetadata: object.httpMetadata,
  });
  await env.KILIW_FILES.delete(`${trashPrefix(email)}${id}`);
  return target;
}

export async function purgeTrashItem(env, email, id) {
  await env.KILIW_FILES.delete(`${trashPrefix(email)}${id}`);
}

export async function emptyTrash(env, email) {
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: trashPrefix(email), cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.KILIW_FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/* ---------- starred files ---------- */

const starsKey = (email) => `_auth/starred/${email}`;

export async function getStars(env, email) {
  const rec = await env.KILIW_FILES.get(starsKey(email));
  if (!rec) return [];
  try {
    const arr = JSON.parse(await rec.text());
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveStars(env, email, paths) {
  if (!paths.length) {
    await env.KILIW_FILES.delete(starsKey(email));
    return;
  }
  await env.KILIW_FILES.put(starsKey(email), JSON.stringify(paths), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function setStar(env, email, path, on) {
  const stars = await getStars(env, email);
  const has = stars.includes(path);
  if (on && !has) stars.push(path);
  else if (!on && has) stars.splice(stars.indexOf(path), 1);
  else return;
  await saveStars(env, email, stars);
}

export async function moveStar(env, email, oldPath, newPath) {
  const stars = await getStars(env, email);
  const i = stars.indexOf(oldPath);
  if (i < 0) return;
  stars[i] = newPath;
  await saveStars(env, email, stars);
}

export async function removeStar(env, email, path) {
  await setStar(env, email, path, false);
}

export async function removeStarsUnder(env, email, folderPath) {
  const stars = await getStars(env, email);
  const kept = stars.filter((p) => p !== folderPath && !p.startsWith(`${folderPath}/`));
  if (kept.length !== stars.length) await saveStars(env, email, kept);
}

/* ---------- account wipe (shared by delete-account and the purge cron) ---------- */

export async function wipeStoragePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.KILIW_FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function wipeSessionsFor(env, email) {
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: '_auth/sessions/', cursor, limit: 1000 });
    for (const obj of page.objects) {
      const record = await env.KILIW_FILES.get(obj.key);
      if (!record) continue;
      try {
        if (JSON.parse(await record.text()).email === email) {
          await env.KILIW_FILES.delete(obj.key);
        }
      } catch { /* skip unreadable */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function wipeAccount(env, email) {
  await wipeStoragePrefix(env, `u/${email}/`);

  /* public share links (records first, then the file index) */
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: `_share/f/${email}/`, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      const token = rec ? (await rec.text()).trim() : '';
      if (token) await env.KILIW_FILES.delete(`_share/t/${token}.json`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await wipeStoragePrefix(env, `_share/f/${email}/`);
  await wipeStoragePrefix(env, `_mod/${email}/`); // cached image-moderation verdicts
  await wipeStoragePrefix(env, `_notif/${email}/`); // notifications
  await wipeStoragePrefix(env, `_trash/${email}/`); // recycle bin
  await env.KILIW_FILES.delete(starsKey(email));

  /* folder edit grants, in both directions */
  await wipeCollabForAccount(env, email);
  await wipeApiKeys(env, email);
  await wipeSessionsFor(env, email);

  await env.KILIW_FILES.delete(`_auth/avatars/${email}`);
  await env.KILIW_FILES.delete(`_auth/pending/${email}.json`);
  await env.KILIW_FILES.delete(`_auth/users/${email}.json`);
}

/** Wipe every account whose 7-day deletion grace period has passed. */
export async function purgeExpiredAccounts(env) {
  const now = Date.now();
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix: '_auth/users/', cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rec = await env.KILIW_FILES.get(obj.key);
      if (!rec) continue;
      try {
        const user = JSON.parse(await rec.text());
        if (user.deleteAt && user.deleteAt <= now) await wipeAccount(env, user.email);
      } catch { /* skip unreadable */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
