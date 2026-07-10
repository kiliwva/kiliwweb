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

export async function createSession(env, email, request) {
  const token = randomHex(32);
  await env.KILIW_FILES.put(
    `_auth/sessions/${token}.json`,
    JSON.stringify({ email, created: Date.now(), expires: Date.now() + SESSION_TTL * 1000 }),
  );
  return { token, cookie: buildSessionCookie(request, token) };
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
