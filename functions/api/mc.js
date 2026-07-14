import {
  json, storageReady, getSession, getUser, putUser, randomHex,
} from '../../lib/api.js';
import qrcode from '../../lib/qrcode.js';

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
/* reverse index so a Telegram user can see / unlink their nickname */
const tgNickKey = (tgId) => `_auth/mctg/${tgId}.json`;
/* live player statistics pushed by the plugin */
const statsKey = (nick) => `_auth/mcstats/${nick.toLowerCase()}.json`;

/* the latest stats snapshot for a nickname (or null) */
export async function getMcStats(env, nick) {
  if (!nick) return null;
  const obj = await env.KILIW_FILES.get(statsKey(nick));
  if (!obj) return null;
  return obj.json().catch(() => null);
}

/* the nickname currently linked to this Telegram, or null */
export async function getTgNick(env, tgId) {
  if (!tgId) return null;
  const obj = await env.KILIW_FILES.get(tgNickKey(tgId));
  if (!obj) return null;
  const data = await obj.json().catch(() => null);
  return (data && data.nick) || null;
}

/* unlink the nickname from this Telegram (frees it for anyone) */
export async function unlinkTgNick(env, tgId) {
  const nick = await getTgNick(env, tgId);
  if (!nick) return null;
  const bindObj = await env.KILIW_FILES.get(nickKey(nick));
  const bind = bindObj ? await bindObj.json().catch(() => null) : null;
  if (bind && bind.tgId === tgId) {
    await env.KILIW_FILES.delete(nickKey(nick)).catch(() => {});
  }
  await env.KILIW_FILES.delete(tgNickKey(tgId)).catch(() => {});
  return nick;
}

function serverAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return Boolean(env.MC_API_KEY) && auth === `Bearer ${env.MC_API_KEY}`;
}

/* 2-letter country code -> flag emoji */
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  const base = 0x1F1E6;
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((c) => base + c.charCodeAt(0) - 65),
  );
}

/* where is the player connecting from? (free geo lookup, best effort) */
async function lookupGeo(env, ip) {
  if (!ip) return null;
  if (env.MAIL_DEBUG) return { city: 'Berlin', cc: 'DE', flag: flagEmoji('DE') };
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    const j = await res.json();
    if (j && j.success !== false) {
      const cc = j.country_code || '';
      return { city: j.city || '', cc, flag: (j.flag && j.flag.emoji) || flagEmoji(cc) };
    }
  } catch { /* geo is optional */ }
  return null;
}

/* the location / ip / session block shown in every confirmation, as
   structured items so the mini app can draw its own icons */
export function joinMeta(data, token) {
  const items = [];
  const geo = data.geo;
  if (geo && (geo.city || geo.cc)) {
    const place = [geo.city, geo.cc].filter(Boolean).join(', ');
    items.push({ icon: 'geo', flag: geo.flag || '', text: place });
  }
  if (data.ip) items.push({ icon: 'ip', text: data.ip });
  if (token) items.push({ icon: 'session', text: `Session #${token.slice(0, 6).toUpperCase()}` });
  return items;
}

/* same block as plain lines for Telegram chat messages */
export function joinMetaLines(data, token) {
  const emoji = { geo: '📍', ip: '📡', session: '🎫' };
  return joinMeta(data, token).map((m) => {
    const lead = m.icon === 'geo' && m.flag ? m.flag : emoji[m.icon];
    return `${lead} ${m.text}`;
  });
}

/* keep the bot from spamming: remember the last message we sent to a
   chat and delete it before posting a new one */
const tgMsgKey = (chatId) => `_auth/tgmsg/${chatId}.json`;

export async function tgDeletePrev(env, chatId) {
  if (!env.TG_BOT_TOKEN) return;
  try {
    const prev = await env.KILIW_FILES.get(tgMsgKey(chatId));
    if (!prev) return;
    await env.KILIW_FILES.delete(tgMsgKey(chatId)).catch(() => {});
    const { messageId } = await prev.json();
    if (messageId && !env.MAIL_DEBUG) {
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      }).catch(() => {});
    }
  } catch { /* nothing to delete */ }
}

export async function tgStoreMsg(env, chatId, messageId) {
  if (!messageId) return;
  await env.KILIW_FILES.put(tgMsgKey(chatId), JSON.stringify({ messageId, ts: Date.now() })).catch(() => {});
}

/* When the nick is already tied to a Telegram, ping that Telegram with
   approve/deny buttons the moment the player joins — no tapping links. */
async function tgNotify(env, chatId, data, token, origin) {
  const meta = joinMetaLines(data, token);
  const payload = {
    chat_id: chatId,
    text: `Sign-in request\n\n${data.server} wants to log you in as ${data.nick}.`
      + (meta.length ? `\n\n${meta.join('\n')}` : '')
      + '\n\nOpen to review and confirm.',
    reply_markup: { inline_keyboard: [
      [{ text: 'Review & confirm', web_app: { url: `${origin}/tg#mc_${token}` } }],
    ] },
  };
  await tgDeletePrev(env, chatId);
  if (env.MAIL_DEBUG) return { ok: true, debugTg: payload };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const jsonRes = await res.json();
    await tgStoreMsg(env, chatId, jsonRes && jsonRes.result && jsonRes.result.message_id);
    return jsonRes;
  } catch {
    return { ok: false };
  }
}

export async function loadJoin(env, token) {
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

/* Approve or deny a pending join. Shared by the web approval page and
   the Telegram bot. `who` identifies the approver: { email } for a site
   session, { tgId, tgUsername, email? } for Telegram — a K-ID account
   is NOT required, the nick can bind straight to the Telegram user. */
export async function decideJoin(env, token, who, approve) {
  const data = await loadJoin(env, token);
  if (!data || data.status !== 'pending') return { error: 'mc-expired', http: 410 };

  if (!approve) {
    data.status = 'denied';
    await env.KILIW_FILES.put(key(token), JSON.stringify(data));
    return { denied: true, nick: data.nick };
  }

  if (!who || (!who.email && !who.tgId)) return { error: 'unauthorized', http: 401 };

  /* nick binding: the first approval claims the nick — for the K-ID
     account when there is one, otherwise for the Telegram user */
  const bindObj = await env.KILIW_FILES.get(nickKey(data.nick));
  const bind = bindObj ? await bindObj.json().catch(() => null) : null;
  if (bind) {
    const owns = (bind.email && who.email && bind.email === who.email)
      || (bind.tgId && who.tgId && bind.tgId === who.tgId);
    if (!owns) {
      data.status = 'denied';
      await env.KILIW_FILES.put(key(token), JSON.stringify(data));
      return { error: 'nick-taken', http: 409 };
    }
  }

  if (who.email) {
    const user = await getUser(env, who.email);
    if (!user || user.banned) return { error: 'unauthorized', http: 401 };
    if (user.mcNick !== data.nick) {
      user.mcNick = data.nick;
      await putUser(env, user);
    }
    /* claim the nick, or upgrade a Telegram-only claim to the account */
    if (!bind || !bind.email) {
      await env.KILIW_FILES.put(nickKey(data.nick), JSON.stringify({
        ...(bind || {}),
        email: who.email,
        tgId: who.tgId || (bind && bind.tgId) || null,
        created: (bind && bind.created) || Date.now(),
      }));
    }
  } else if (!bind) {
    await env.KILIW_FILES.put(nickKey(data.nick), JSON.stringify({
      tgId: who.tgId,
      tgUsername: who.tgUsername || '',
      created: Date.now(),
    }));
  }

  /* keep the reverse index fresh so the mini app can show the nick */
  if (who.tgId) {
    await env.KILIW_FILES.put(tgNickKey(who.tgId), JSON.stringify({
      nick: data.nick,
      created: Date.now(),
    }));
  }

  data.status = 'approved';
  data.email = who.email || null;
  data.tgId = who.tgId || null;
  await env.KILIW_FILES.put(key(token), JSON.stringify(data));
  return { nick: data.nick };
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

  /* --- game server: push player statistics --- */
  if (action === 'stats') {
    if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
    const players = Array.isArray(body?.players) ? body.players : [];
    let saved = 0;
    for (const pl of players.slice(0, 200)) {
      const nick = String(pl?.nick || '');
      if (!NICK_RE.test(nick)) continue;
      await env.KILIW_FILES.put(statsKey(nick), JSON.stringify({ ...pl, updated: Date.now() }));
      saved += 1;
    }
    return json({ success: true, saved });
  }

  /* --- game server: issue a login link --- */
  if (action === 'create') {
    if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
    const nick = String(body?.nick || '');
    const server = String(body?.server || '').slice(0, 48) || 'Minecraft server';
    if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
    const ip = String(body?.ip || '').slice(0, 45);
    const geo = await lookupGeo(env, ip);
    const token = randomHex(12);
    const poll = randomHex(32);
    await env.KILIW_FILES.put(key(token), JSON.stringify({
      poll,
      nick,
      server,
      ip,
      geo,
      status: 'pending',
      expires: Date.now() + MC_TTL,
    }));
    /* players approve through the Telegram bot; the site page /mc stays
       as a fallback when the bot is not configured */
    const reqUrl = new URL(request.url);
    const url = env.TG_BOT_USERNAME
      ? `https://t.me/${env.TG_BOT_USERNAME}?start=mc_${token}`
      : `${reqUrl.origin}/mc#${token}`;
    /* QR module matrix ("1" dark / "0" light rows) — the plugin draws
       it on an in-game map so the player can scan it with a phone */
    let qr = null;
    try {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      const n = q.getModuleCount();
      qr = [];
      for (let r = 0; r < n; r += 1) {
        let row = '';
        for (let c = 0; c < n; c += 1) row += q.isDark(r, c) ? '1' : '0';
        qr.push(row);
      }
    } catch { qr = null; }
    /* known nick → push the confirmation straight to their Telegram */
    let notified = false;
    let debugTg = null;
    if (env.TG_BOT_TOKEN) {
      const bindObj = await env.KILIW_FILES.get(nickKey(nick));
      const bind = bindObj ? await bindObj.json().catch(() => null) : null;
      if (bind && bind.tgId) {
        const sent = await tgNotify(env, bind.tgId, { nick, server, ip, geo }, token, reqUrl.origin);
        notified = Boolean(sent && sent.ok);
        if (sent && sent.debugTg) debugTg = sent.debugTg;
      }
    }
    return json({
      success: true, token, poll, url, qr, notified, ttl: MC_TTL,
      ...(debugTg ? { debugTg } : {}),
    });
  }

  /* --- player: approve or deny from the browser --- */
  if (action === 'approve' || action === 'deny') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const res = await decideJoin(env, body?.token, { email: session.email }, action === 'approve');
    if (res.error) return json({ success: false, error: res.error }, res.http);
    return json({ success: true, nick: res.nick });
  }

  /* --- player: untie the nickname from the account --- */
  if (action === 'unlink') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const user = await getUser(env, session.email);
    if (!user) return json({ success: false, error: 'unauthorized' }, 401);
    if (user.mcNick) {
      const bindObj = await env.KILIW_FILES.get(nickKey(user.mcNick));
      const bind = bindObj ? await bindObj.json().catch(() => null) : null;
      if (bind && bind.email === session.email) {
        await env.KILIW_FILES.delete(nickKey(user.mcNick)).catch(() => {});
      }
      delete user.mcNick;
      await putUser(env, user);
    }
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  /* player page: what is being approved? */
  if (url.searchParams.get('info') === '1') {
    const data = await loadJoin(env, token);
    if (!data) return json({ success: true, status: 'expired' });
    return json({ success: true, status: data.status, nick: data.nick, server: data.server });
  }

  /* game server poll */
  if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
  const data = await loadJoin(env, token);
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
