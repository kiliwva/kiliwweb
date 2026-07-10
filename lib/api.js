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

/** YooKassa charges in RUB: fixed conversion rate. */
export const RUB_PER_USD = 90;

/** Pro price in USD for a 30-day period; null for a non-existent tier. */
export function proPrice(gb) {
  return PRO_TIERS[gb] ?? null;
}

export function proActive(user) {
  return Boolean(user && user.plan === 'pro' && user.planUntil && user.planUntil > Date.now());
}

export function planLimits(user, env) {
  /* the site owner always has the top Pro plan */
  if (env?.OWNER_EMAIL && user?.email === env.OWNER_EMAIL) {
    return {
      type: 'pro',
      maxFile: PRO_MAX_FILE,
      quota: PRO_GB_MAX * GIB,
      gb: PRO_GB_MAX,
      until: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    };
  }
  if (proActive(user)) {
    return {
      type: 'pro',
      maxFile: PRO_MAX_FILE,
      quota: (user.planGb || PRO_GB_MIN) * GIB,
      gb: user.planGb || PRO_GB_MIN,
      until: user.planUntil,
    };
  }
  return { type: 'free', maxFile: FREE_MAX_FILE, quota: FREE_QUOTA };
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

export async function createShare(env, email, path, password) {
  /* one share per file: replace an existing link */
  const old = await shareTokenForFile(env, email, path);
  if (old) await env.KILIW_FILES.delete(shareTokenKey(old));

  const share = { token: randomHex(16), email, path, created: Date.now() };
  if (password) {
    share.salt = randomHex(16);
    share.hash = await hashPassword(password, share.salt);
  }
  await env.KILIW_FILES.put(shareTokenKey(share.token), JSON.stringify(share));
  await env.KILIW_FILES.put(shareFileKey(email, path), share.token);
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

/** Public link for a share: always on the apex host. */
export function shareUrl(request, token) {
  const url = new URL(request.url);
  const host = isPlainHost(url.hostname) ? url.host : baseHost(url.hostname);
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

/** Activate/extend Pro for a user after a confirmed payment (idempotent). */
export async function applyProPurchase(env, email, gb, paymentId) {
  if (!email || !Number.isFinite(gb)) return false;
  const user = await getUser(env, email);
  if (!user) return false;
  if (user.lastPaymentId === paymentId) return true; // already applied

  user.plan = 'pro';
  user.planGb = Math.min(Math.max(Math.round(gb), PRO_GB_MIN), PRO_GB_MAX);
  const base = proActive(user) && user.planUntil ? user.planUntil : Date.now();
  user.planUntil = base + PRO_DAYS * 24 * 60 * 60 * 1000;
  user.lastPaymentId = paymentId;
  if (user.pendingPayment?.id === paymentId || user.pendingPayment === paymentId) {
    delete user.pendingPayment;
  }
  await putUser(env, user);
  return true;
}

/** Apply a succeeded YooKassa payment (metadata carries email + gb). */
export async function applyPayment(env, payment) {
  if (!payment || payment.status !== 'succeeded') return false;
  return applyProPurchase(env, payment.metadata?.email, Number(payment.metadata?.gb), payment.id);
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
