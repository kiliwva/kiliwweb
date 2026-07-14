import {
  json, storageReady, getSession, getUser, putUser, randomHex, isOwner,
  getMcidSession, isMcidAdmin, isMcidAdminNick,
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
const DEVICE_RE = /^[0-9a-f]{16,64}$/;

const key = (token) => `_auth/mc/${token}.json`;
const nickKey = (nick) => `_auth/mcnick/${nick.toLowerCase()}.json`;
/* reverse index so a Telegram user can see / unlink their nickname */
const tgNickKey = (tgId) => `_auth/mctg/${tgId}.json`;
/* machine signature -> the nick registered on that computer */
const deviceKey = (sig) => `_auth/mcdev/${sig}.json`;
/* owner-banned nicknames (blocked from signing in at all) */
const banKey = (nick) => `_auth/mcban/${nick.toLowerCase()}.json`;

const isBanned = async (env, nick) => Boolean(await env.KILIW_FILES.get(banKey(nick)));

/* Anti-multiaccounting at the computer level: has this machine
   signature already been claimed by a *different, still-active* nick?
   Returns that nick, or null. If the owning nick was unlinked since,
   the stale record is freed so the computer can be used again. */
async function deviceOwner(env, sig, nick) {
  if (!sig) return null;
  const obj = await env.KILIW_FILES.get(deviceKey(sig));
  const rec = obj ? await obj.json().catch(() => null) : null;
  if (!rec || !rec.nick) return null;
  if (rec.nick.toLowerCase() === String(nick).toLowerCase()) return null;
  const stillBound = await env.KILIW_FILES.get(nickKey(rec.nick));
  if (!stillBound) {
    await env.KILIW_FILES.delete(deviceKey(sig)).catch(() => {});
    return null;
  }
  return rec.nick;
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

/* normalize TG_BOT_USERNAME (bare / @name / full URL) so the web page can
   build a working Telegram deep link */
function mcBotUsername(env) {
  return String(env.TG_BOT_USERNAME || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .trim();
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
      /* ?v defeats Telegram's mini-app webview cache; keep in sync with tg.js */
      [{ text: 'Review & confirm', web_app: { url: `${origin}/tg?v=160#mc_${token}` } }],
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

  /* owner-banned nickname: refuse outright */
  if (await isBanned(env, data.nick)) {
    data.status = 'denied';
    await env.KILIW_FILES.put(key(token), JSON.stringify(data));
    return { error: 'nick-banned', http: 403, held: data.nick };
  }

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
  } else {
    /* Anti-multiaccounting: one Telegram (or one K-ID account) may hold
       only a single nickname. Claiming a fresh nick while already tied
       to another one is refused — the player must unlink the old nick
       first. Re-approving an already-owned nick skips this (bind above). */
    let held = null;
    if (who.tgId) held = await getTgNick(env, who.tgId);
    if (!held && who.email) {
      const u = await getUser(env, who.email);
      held = (u && u.mcNick) || null;
    }
    if (held && held.toLowerCase() !== data.nick.toLowerCase()) {
      data.status = 'denied';
      await env.KILIW_FILES.put(key(token), JSON.stringify(data));
      return { error: 'multi-account', http: 409, held };
    }
    /* computer-level: refuse a fresh nick from a machine already
       registered to a different, still-active nickname */
    const machineOwner = await deviceOwner(env, data.device, data.nick);
    if (machineOwner) {
      data.status = 'denied';
      await env.KILIW_FILES.put(key(token), JSON.stringify(data));
      return { error: 'device-taken', http: 409, held: machineOwner };
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
        nick: data.nick,
        email: who.email,
        tgId: who.tgId || (bind && bind.tgId) || null,
        created: (bind && bind.created) || Date.now(),
      }));
    }
  } else if (!bind) {
    await env.KILIW_FILES.put(nickKey(data.nick), JSON.stringify({
      nick: data.nick,
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

  /* register this computer to the nick so no second account can be made
     from it (freed automatically when the nick is later unlinked) */
  if (data.device) {
    await env.KILIW_FILES.put(deviceKey(data.device), JSON.stringify({
      nick: data.nick,
      ip: data.ip || '',
      tgId: who.tgId || null,
      created: Date.now(),
    })).catch(() => {});
  }

  data.status = 'approved';
  data.email = who.email || null;
  data.tgId = who.tgId || null;
  await env.KILIW_FILES.put(key(token), JSON.stringify(data));
  return { nick: data.nick };
}

/* the moderation panel is reachable two ways: the site owner (email
   session on cloud.<domain>/mcid) or an admin Telegram (panel session
   on mcid.<domain>) */
async function isMcAdmin(request, env) {
  const session = await getSession(request, env);
  if (session && isOwner(env, session.email)) return true;
  const mcid = await getMcidSession(request, env);
  if (!mcid) return false;
  if (isMcidAdmin(env, mcid.tgId)) return true;
  return isMcidAdminNick(env, await getTgNick(env, mcid.tgId));
}

/* everything the owner panel shows: nick bindings, registered
   computers and the manual ban list */
async function listMcAdmin(env) {
  const readAll = async (prefix) => {
    const out = [];
    let cursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        const rec = await env.KILIW_FILES.get(obj.key);
        const d = rec ? await rec.json().catch(() => null) : null;
        out.push({ id: obj.key.slice(prefix.length).replace(/\.json$/, ''), d });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  };
  const [nicksRaw, devsRaw, bansRaw] = await Promise.all([
    readAll('_auth/mcnick/'), readAll('_auth/mcdev/'), readAll('_auth/mcban/'),
  ]);
  const nicks = nicksRaw.map(({ id, d }) => ({
    nick: (d && d.nick) || id,
    tgId: (d && d.tgId) || null,
    tgUsername: (d && d.tgUsername) || null,
    email: (d && d.email) || null,
    created: (d && d.created) || null,
  })).sort((a, b) => (b.created || 0) - (a.created || 0));
  const devices = devsRaw.map(({ id, d }) => ({
    sig: id,
    nick: (d && d.nick) || null,
    ip: (d && d.ip) || null,
    tgId: (d && d.tgId) || null,
    created: (d && d.created) || null,
  })).sort((a, b) => (b.created || 0) - (a.created || 0));
  const bans = bansRaw.map(({ id, d }) => ({
    nick: (d && d.nick) || id,
    reason: (d && d.reason) || null,
    created: (d && d.created) || null,
  })).sort((a, b) => (b.created || 0) - (a.created || 0));
  return { nicks, devices, bans };
}

/* release a nick's binding + its reverse Telegram index (its device
   records free themselves on next use once the binding is gone) */
async function releaseNick(env, nick) {
  const bindObj = await env.KILIW_FILES.get(nickKey(nick));
  const bind = bindObj ? await bindObj.json().catch(() => null) : null;
  if (bind && bind.tgId) await env.KILIW_FILES.delete(tgNickKey(bind.tgId)).catch(() => {});
  await env.KILIW_FILES.delete(nickKey(nick)).catch(() => {});
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

  /* --- moderation panel (owner email or admin Telegram) --- */
  if (action.startsWith('admin-')) {
    if (!await isMcAdmin(request, env)) {
      return json({ success: false, error: 'forbidden' }, 403);
    }
    const nick = String(body?.nick || '');

    if (action === 'admin-unlink') {
      if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
      await releaseNick(env, nick);
      return json({ success: true, ...(await listMcAdmin(env)) });
    }

    if (action === 'admin-free-device') {
      const sig = String(body?.sig || '').toLowerCase();
      if (!DEVICE_RE.test(sig)) return json({ success: false, error: 'bad-request' }, 400);
      await env.KILIW_FILES.delete(deviceKey(sig)).catch(() => {});
      return json({ success: true, ...(await listMcAdmin(env)) });
    }

    if (action === 'admin-ban') {
      if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
      await env.KILIW_FILES.put(banKey(nick), JSON.stringify({
        nick,
        reason: String(body?.reason || '').slice(0, 120),
        created: Date.now(),
      }));
      /* kick them out of any existing binding so the ban bites now */
      await releaseNick(env, nick);
      return json({ success: true, ...(await listMcAdmin(env)) });
    }

    if (action === 'admin-unban') {
      if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
      await env.KILIW_FILES.delete(banKey(nick)).catch(() => {});
      return json({ success: true, ...(await listMcAdmin(env)) });
    }

    return json({ success: false, error: 'bad-request' }, 400);
  }

  /* --- game server: issue a login link --- */
  if (action === 'create') {
    if (!serverAuthed(request, env)) return json({ success: false, error: 'unauthorized' }, 401);
    const nick = String(body?.nick || '');
    const server = String(body?.server || '').slice(0, 48) || 'Minecraft server';
    if (!NICK_RE.test(nick)) return json({ success: false, error: 'bad-nick' }, 400);
    /* owner-banned nickname: refuse before issuing a code */
    if (await isBanned(env, nick)) {
      const b = await (await env.KILIW_FILES.get(banKey(nick))).json().catch(() => null);
      const reason = b && b.reason ? `\nReason: ${b.reason}` : '';
      return json({ success: false, error: 'nick-banned', message: `This nickname is banned.${reason}` }, 403);
    }
    const ip = String(body?.ip || '').slice(0, 45);
    const device = String(body?.device || '').toLowerCase();
    const dev = DEVICE_RE.test(device) ? device : '';
    /* computer-level hard block: reject before issuing a code if this
       machine already belongs to a different, still-active nick */
    const machineOwner = await deviceOwner(env, dev, nick);
    if (machineOwner) {
      return json({
        success: false,
        error: 'device-taken',
        held: machineOwner,
        message: `This computer is already registered to "${machineOwner}".\nOnly one account per computer.`,
      }, 409);
    }
    const geo = await lookupGeo(env, ip);
    const token = randomHex(12);
    const poll = randomHex(32);
    await env.KILIW_FILES.put(key(token), JSON.stringify({
      poll,
      nick,
      server,
      ip,
      geo,
      device: dev,
      status: 'pending',
      expires: Date.now() + MC_TTL,
    }));
    /* players approve through the Telegram bot; the site page /mc stays
       as a fallback when the bot is not configured */
    const reqUrl = new URL(request.url);
    /* the chat link goes to the web approval page (sign in with K-ID),
       so no Telegram is needed for the site route */
    const url = `${reqUrl.origin}/mc#${token}`;
    /* the map QR encodes the same /mc page URL: the bot's in-app scanner
       recognizes the /mc#<token> pattern, and a plain phone camera opens
       the page which then launches the bot via tg:// (no t.me anywhere) */
    const qrData = url;
    /* QR module matrix ("1" dark / "0" light rows) — the plugin draws
       it on an in-game map so the player can scan it with a phone */
    let qr = null;
    try {
      const q = qrcode(0, 'M');
      q.addData(qrData);
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
    if (res.error) return json({ success: false, error: res.error, held: res.held || null }, res.http);
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

  /* moderation panel data (owner email or admin Telegram) */
  if (url.searchParams.get('admin') === '1') {
    if (!await isMcAdmin(request, env)) {
      return json({ success: false, error: 'forbidden' }, 403);
    }
    return json({ success: true, ...(await listMcAdmin(env)) });
  }

  /* player page: what is being approved? */
  if (url.searchParams.get('info') === '1') {
    const data = await loadJoin(env, token);
    if (!data) return json({ success: true, status: 'expired' });
    return json({
      success: true,
      status: data.status,
      nick: data.nick,
      server: data.server,
      bot: mcBotUsername(env),
    });
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
