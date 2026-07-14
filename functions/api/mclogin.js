import {
  json, storageReady, randomHex,
  createMcidSession, getMcidSession, destroyMcidSession, isMcidAdmin,
} from '../../lib/api.js';
import { getTgNick, unlinkTgNick } from './mc.js';

/* Telegram web-login for the panel at mcid.<domain>.

   Handshake (the browser drives it):
     POST /api/mclogin { action: "start" }      → { token, poll, botUrl }
     GET  /api/mclogin?token=..&poll=..          → pending|ok|expired (+cookie on ok)
   Session:
     GET  /api/mclogin?me=1                       → who am I / admin?
     POST /api/mclogin { action: "logout" }
     POST /api/mclogin { action: "my-unlink" }    → drop my Minecraft nick

   The confirmation itself happens inside the bot mini app, which calls
   approveLogin() (exported below) via /api/tg { action: "weblogin" }. */

const LOGIN_TTL = 5 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{24}$/;
const loginKey = (t) => `_auth/mclogin/${t}.json`;

/* accept TG_BOT_USERNAME however it was pasted: bare name, @name, or a
   full t.me URL — a malformed handle produces a dead t.me link */
function botUsername(env) {
  return String(env.TG_BOT_USERNAME || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .trim();
}

/* mark a pending login as approved by this Telegram user */
export async function approveLogin(env, token, tgUser) {
  if (!TOKEN_RE.test(String(token || ''))) return { error: 'bad-token' };
  const obj = await env.KILIW_FILES.get(loginKey(token));
  const data = obj ? await obj.json().catch(() => null) : null;
  if (!data || data.expires < Date.now() || data.status !== 'pending') return { error: 'expired' };
  data.status = 'approved';
  data.tgId = tgUser.id;
  data.tgUsername = tgUser.username || '';
  await env.KILIW_FILES.put(loginKey(token), JSON.stringify(data));
  return { ok: true };
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

  if (action === 'start') {
    const uname = botUsername(env);
    if (!uname) return json({ success: false, error: 'not-configured' }, 503);
    const token = randomHex(12);
    const poll = randomHex(32);
    await env.KILIW_FILES.put(loginKey(token), JSON.stringify({
      poll, status: 'pending', created: Date.now(), expires: Date.now() + LOGIN_TTL,
    }));
    return json({
      success: true,
      token,
      poll,
      bot: uname,
      botUrl: `https://t.me/${uname}?start=login_${token}`,
      tgUrl: `tg://resolve?domain=${uname}&start=login_${token}`,
      ttl: LOGIN_TTL,
    });
  }

  if (action === 'logout') {
    const cookie = await destroyMcidSession(request, env);
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
  }

  if (action === 'my-unlink') {
    const s = await getMcidSession(request, env);
    if (!s) return json({ success: false, error: 'unauthorized' }, 401);
    const nick = await unlinkTgNick(env, s.tgId);
    return json({ success: true, unlinked: nick });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);

  /* panel bootstrap: who is signed in here? */
  if (url.searchParams.get('me') === '1') {
    const s = await getMcidSession(request, env);
    if (!s) return json({ success: true, authed: false });
    return json({
      success: true,
      authed: true,
      tgId: s.tgId,
      tgUsername: s.tgUsername || '',
      admin: isMcidAdmin(env, s.tgId),
      nick: await getTgNick(env, s.tgId),
    });
  }

  /* the browser polls until the bot confirms, then gets its cookie */
  const token = url.searchParams.get('token') || '';
  const poll = url.searchParams.get('poll') || '';
  if (TOKEN_RE.test(token)) {
    const obj = await env.KILIW_FILES.get(loginKey(token));
    const data = obj ? await obj.json().catch(() => null) : null;
    if (!data || data.expires < Date.now()) return json({ success: true, status: 'expired' });
    if (data.poll !== poll) return json({ success: false, error: 'forbidden' }, 403);
    if (data.status === 'approved') {
      await env.KILIW_FILES.delete(loginKey(token)).catch(() => {});
      const { cookie } = await createMcidSession(
        env, { tgId: data.tgId, tgUsername: data.tgUsername }, request,
      );
      return json({ success: true, status: 'ok' }, 200, { 'Set-Cookie': cookie });
    }
    return json({ success: true, status: data.status });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
