import {
  json, storageReady, getSession, getUser, randomHex,
} from '../../lib/api.js';

/* Minecraft server auth (K-ID for offline-mode servers).

   The game server (Bearer MC_API_KEY):
     POST /api/mc { action: "create", nick, server } → { token, poll, url }
     GET  /api/mc?token=..&poll=..                   → pending|ok|denied|expired

   The player (browser, session cookie):
     GET  /api/mc?token=..&info=1                    → { nick, server, status }
     POST /api/mc { action: "approve" | "deny", token }

   The first approval binds the nick to the K-ID account
   (_auth/mcnick/<nick>); afterwards only that account may approve
   joins under the nick. */

const MC_TTL = 5 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{24}$/;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

const key = (token) => `_auth/mc/${token}.json`;
const nickKey = (nick) => `_auth/mcnick/${nick.toLowerCase()}.json`;

function serverAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return Boolean(env.MC_API_KEY) && auth === `Bearer ${env.MC_API_KEY}`;
}

async function load(env, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const obj = await env.KILIW_FILES.get(key(token));
  if (!obj) return null;
  const data = await obj.json().catch(() => null);
  if (!data || data.expires < Date.now()) {
    await env.KILIW_FILES.delete(key(token)).catch(() => {});
    return null;
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');

  /* --- game server: issue a login link --- */
  if (action === 'create') {
    if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
    const nick = String(body?.nick || '');
    const server = String(body?.server || '').slice(0, 48) || 'Minecraft server';
    if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
    const token = randomHex(12);
    const poll = randomHex(32);
    await env.KILIW_FILES.put(key(token), JSON.stringify({
      poll,
      nick,
      server,
      status: 'pending',
      expires: Date.now() + MC_TTL,
    }));
    const url = new URL(request.url);
    return json({ success: true, token, poll, url: `${url.origin}/mc#${token}`, ttl: MC_TTL });
  }

  /* --- player: approve or deny from the browser --- */
  if (action === 'approve' || action === 'deny') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const data = await load(env, body?.token);
    if (!data || data.status !== 'pending') {
      return json({ success: false, error: 'mc-expired' }, 410);
    }

    if (action === 'deny') {
      data.status = 'denied';
      await env.KILIW_FILES.put(key(body.token), JSON.stringify(data));
      return json({ success: true });
    }

    /* nick binding: first approval claims the nick for this account */
    const bindObj = await env.KILIW_FILES.get(nickKey(data.nick));
    const bind = bindObj ? await bindObj.json().catch(() => null) : null;
    if (bind && bind.email !== session.email) {
      data.status = 'denied';
      await env.KILIW_FILES.put(key(body.token), JSON.stringify(data));
      return json({ success: false, error: 'nick-taken' }, 409);
    }
    const user = await getUser(env, session.email);
    if (!user || user.banned) return json({ success: false, error: 'unauthorized' }, 401);
    if (!bind) {
      await env.KILIW_FILES.put(nickKey(data.nick), JSON.stringify({
        email: session.email,
        created: Date.now(),
      }));
    }
    data.status = 'approved';
    data.email = session.email;
    await env.KILIW_FILES.put(key(body.token), JSON.stringify(data));
    return json({ success: true, nick: data.nick });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  /* player page: what is being approved? */
  if (url.searchParams.get('info') === '1') {
    const data = await load(env, token);
    if (!data) return json({ success: true, status: 'expired' });
    return json({ success: true, status: data.status, nick: data.nick, server: data.server });
  }

  /* game server poll */
  if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
  const data = await load(env, token);
  if (!data) return json({ success: true, status: 'expired' });
  if (data.poll !== String(url.searchParams.get('poll') || '')) {
    return json({ success: false, error: 'bad-request' }, 403);
  }
  if (data.status === 'approved') {
    await env.KILIW_FILES.delete(key(token)).catch(() => {});
    return json({ success: true, status: 'ok', nick: data.nick });
  }
  if (data.status === 'denied') {
    await env.KILIW_FILES.delete(key(token)).catch(() => {});
    return json({ success: true, status: 'denied' });
  }
  return json({ success: true, status: 'pending' });
}
