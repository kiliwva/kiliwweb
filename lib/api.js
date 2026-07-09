/* Shared helpers for Pages Functions: sessions, password hashing,
   Turnstile verification, cookies. */

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

function isPlainHost(host) {
  return host === 'localhost' || /^[\d.]+$/.test(host) || host.endsWith('.pages.dev');
}

/** kiliw.com for auth.kiliw.com / www.kiliw.com / kiliw.com */
export function mainHost(host) {
  if (host.startsWith('auth.')) return host.slice(5);
  return host.replace(/^www\./, '');
}

/** Where to send the user after successful sign-in. */
export function afterAuthRedirect(request) {
  const host = hostname(request);
  const proto = new URL(request.url).protocol;
  if (host.startsWith('auth.')) return `${proto}//${mainHost(host)}/`;
  return '/';
}

/** Where to send the user to sign in. */
export function authRedirect(request) {
  const host = hostname(request);
  const proto = new URL(request.url).protocol;
  if (!host.startsWith('auth.') && !isPlainHost(host)) {
    return `${proto}//auth.${mainHost(host)}/`;
  }
  return '/';
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

export async function createSession(env, email, request) {
  const token = randomHex(32);
  await env.KILIW_KV.put(
    `sess:${token}`,
    JSON.stringify({ email, created: Date.now() }),
    { expirationTtl: SESSION_TTL },
  );
  return { token, cookie: buildSessionCookie(request, token) };
}

export async function getSession(request, env) {
  if (!env.KILIW_KV) return null;
  const token = getCookie(request, 'kiliw_session');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const raw = await env.KILIW_KV.get(`sess:${token}`);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return session && session.email ? { ...session, token } : null;
  } catch {
    return null;
  }
}

export async function destroySession(request, env) {
  const session = await getSession(request, env);
  if (session) await env.KILIW_KV.delete(`sess:${session.token}`);
  return buildSessionCookie(request, 'deleted', 0);
}

/* ---------- Turnstile ---------- */

export async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET_KEY || TEST_SECRET_KEY;
  if (!token || typeof token !== 'string') return false;

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
    return outcome.success === true;
  } catch {
    /* siteverify unreachable: allow only in dev (test secret), fail closed in prod */
    return secret === TEST_SECRET_KEY;
  }
}
