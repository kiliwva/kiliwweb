/* Minimal WebAuthn (passkeys) server side: registration and assertion
   verification with no dependencies. Supports ES256 (-7) and RS256
   (-257) credentials, attestation "none" (attestation statements are
   not verified — standard for consumer passkeys). */

import { bytesToHex, randomHex } from './api.js';

/* ---------- base64url ---------- */

export function b64uEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/* ---------- tiny CBOR decoder (enough for WebAuthn structures) ---------- */

function cborDecode(bytes) {
  let pos = 0;
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) return bytes[pos++];
    if (info === 25) { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; }
    if (info === 26) {
      const v = (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
      pos += 4;
      return v;
    }
    throw new Error('cbor: unsupported length');
  }
  function item() {
    const initial = bytes[pos++];
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0: return readLen(info); // unsigned int
      case 1: return -1 - readLen(info); // negative int
      case 2: { const n = readLen(info); const v = bytes.slice(pos, pos + n); pos += n; return v; } // bytes
      case 3: { const n = readLen(info); const v = new TextDecoder().decode(bytes.slice(pos, pos + n)); pos += n; return v; } // text
      case 4: { const n = readLen(info); const arr = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 5: { const n = readLen(info); const map = new Map(); for (let i = 0; i < n; i++) { const k = item(); map.set(k, item()); } return map; }
      default: throw new Error(`cbor: unsupported major type ${major}`);
    }
  }
  const value = item();
  return { value, rest: bytes.slice(pos) };
}

/* ---------- authenticator data ---------- */

export function parseAuthData(authData) {
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const counter = (authData[33] * 0x1000000) + (authData[34] << 16) + (authData[35] << 8) + authData[36];
  const out = {
    rpIdHash,
    flags,
    counter,
    userPresent: Boolean(flags & 0x01),
    userVerified: Boolean(flags & 0x04),
    hasCredential: Boolean(flags & 0x40),
  };
  if (out.hasCredential) {
    const credIdLen = (authData[53] << 8) | authData[54];
    out.credentialId = authData.slice(55, 55 + credIdLen);
    const { value: coseKey } = cborDecode(authData.slice(55 + credIdLen));
    out.coseKey = coseKey;
  }
  return out;
}

/** COSE key (Map) → storable JWK-ish object. ES256 or RS256 only. */
export function coseToStoredKey(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return { alg: 'ES256', x: b64uEncode(cose.get(-2)), y: b64uEncode(cose.get(-3)) };
  }
  if (kty === 3 && alg === -257) {
    return { alg: 'RS256', n: b64uEncode(cose.get(-1)), e: b64uEncode(cose.get(-2)) };
  }
  return null;
}

async function importStoredKey(pk) {
  if (pk.alg === 'ES256') {
    return crypto.subtle.importKey(
      'jwk', { kty: 'EC', crv: 'P-256', x: pk.x, y: pk.y },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
  }
  return crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: pk.n, e: pk.e, alg: 'RS256' },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
}

/** WebAuthn ES256 signatures are DER; WebCrypto wants raw r||s. */
function derToRaw(der) {
  let pos = 2; // 0x30 len
  if (der[1] & 0x80) pos += der[1] & 0x7f;
  const readInt = () => {
    pos++; // 0x02
    let len = der[pos++];
    let start = pos;
    pos += len;
    /* strip leading zeros, left-pad to 32 */
    while (len > 32) { start++; len--; }
    const out = new Uint8Array(32);
    out.set(der.slice(start, start + len), 32 - len);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/* ---------- challenges (single-use, 5 minutes) ---------- */

const CH_TTL = 5 * 60 * 1000;
const chKey = (id) => `_webauthn/${id}.json`;

export async function createChallenge(env, type, email = null) {
  const id = randomHex(16);
  const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
  await env.KILIW_FILES.put(chKey(id), JSON.stringify({
    challenge, type, email, expires: Date.now() + CH_TTL,
  }), { httpMetadata: { contentType: 'application/json' } });
  return { ctx: id, challenge };
}

export async function takeChallenge(env, id, type) {
  if (!/^[0-9a-f]{32}$/.test(String(id))) return null;
  const rec = await env.KILIW_FILES.get(chKey(id));
  if (!rec) return null;
  await env.KILIW_FILES.delete(chKey(id)); // single use
  try {
    const data = JSON.parse(await rec.text());
    if (data.type !== type || data.expires < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/* ---------- verification ---------- */

/** The RP id is the registrable base domain (kiliw.com covers auth./cloud.). */
export function rpIdFor(hostname) {
  if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return hostname;
  if (hostname.endsWith('.workers.dev') || hostname.endsWith('.pages.dev')) return hostname;
  return hostname.split('.').slice(-2).join('.');
}

function originAllowed(origin, rpId) {
  try {
    const host = new URL(origin).hostname;
    return host === rpId || host.endsWith(`.${rpId}`);
  } catch {
    return false;
  }
}

/** Verify a registration (attestation) response. → stored credential or {error}. */
export async function verifyRegistration(env, rpId, expectedChallenge, credential) {
  try {
    const clientData = JSON.parse(new TextDecoder().decode(b64uDecode(credential.response.clientDataJSON)));
    if (clientData.type !== 'webauthn.create') return { error: 'bad-type' };
    if (clientData.challenge !== expectedChallenge) return { error: 'bad-challenge' };
    if (!originAllowed(clientData.origin, rpId)) return { error: 'bad-origin' };

    const { value: att } = cborDecode(b64uDecode(credential.response.attestationObject));
    const authData = parseAuthData(att.get('authData'));
    if (bytesToHex(authData.rpIdHash) !== bytesToHex(await sha256(new TextEncoder().encode(rpId)))) {
      return { error: 'bad-rpid' };
    }
    if (!authData.userPresent || !authData.hasCredential) return { error: 'bad-authdata' };
    const pk = coseToStoredKey(authData.coseKey);
    if (!pk) return { error: 'unsupported-key' };

    return {
      id: b64uEncode(authData.credentialId),
      pk,
      counter: authData.counter,
    };
  } catch {
    return { error: 'bad-request' };
  }
}

/** Verify an assertion (login) response against a stored credential. */
export async function verifyAssertion(rpId, expectedChallenge, stored, credential) {
  try {
    const clientDataRaw = b64uDecode(credential.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataRaw));
    if (clientData.type !== 'webauthn.get') return { error: 'bad-type' };
    if (clientData.challenge !== expectedChallenge) return { error: 'bad-challenge' };
    if (!originAllowed(clientData.origin, rpId)) return { error: 'bad-origin' };

    const authData = b64uDecode(credential.response.authenticatorData);
    const parsed = parseAuthData(authData);
    if (bytesToHex(parsed.rpIdHash) !== bytesToHex(await sha256(new TextEncoder().encode(rpId)))) {
      return { error: 'bad-rpid' };
    }
    if (!parsed.userPresent) return { error: 'not-present' };

    const signedData = new Uint8Array(authData.length + 32);
    signedData.set(authData, 0);
    signedData.set(await sha256(clientDataRaw), authData.length);

    const key = await importStoredKey(stored.pk);
    let sig = b64uDecode(credential.response.signature);
    let ok;
    if (stored.pk.alg === 'ES256') {
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signedData,
      );
    } else {
      ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signedData);
    }
    if (!ok) return { error: 'bad-signature' };

    /* clone detection: a counter that goes backwards is suspicious */
    if (parsed.counter && stored.counter && parsed.counter <= stored.counter) {
      return { error: 'counter-replay' };
    }
    return { counter: parsed.counter };
  } catch {
    return { error: 'bad-request' };
  }
}
