import {
  json, storageReady, getSession, isOwner,
} from '../../lib/api.js';
import {
  loadJoin, decideJoin, joinMeta, joinMetaLines, tgDeletePrev, tgStoreMsg,
  getTgNick, unlinkTgNick,
} from './mc.js';

/* Telegram bot: Minecraft join approvals, tied to Telegram only —
   no site account is involved anywhere in the bot.

   Telegram (webhook, verified by a secret header):
     POST /api/tg                       ← bot updates (/start, buttons)

   The mini app inside the bot (Telegram initData instead of cookies):
     POST /api/tg { action: "auth",    initData }
     POST /api/tg { action: "info",    initData, token }
     POST /api/tg { action: "approve" | "deny", initData, token }

   Owner utilities (session cookie):
     GET  /api/tg?setup=1               → register webhook + menu button
     GET  /api/tg?reset=1               → wipe all bindings and nicks */

const botReady = (env) => Boolean(env.TG_BOT_TOKEN && env.TG_BOT_USERNAME);

/* id.<domain> origin (or the same origin in single-host dev) */
function idOrigin(request) {
  const url = new URL(request.url);
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1'
    || host.endsWith('.workers.dev') || host.endsWith('.pages.dev')) {
    return url.origin;
  }
  const base = host.split('.').slice(-2).join('.');
  return `https://id.${base}`;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/* updates must carry X-Telegram-Bot-Api-Secret-Token = this value */
async function webhookSecret(env) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`${env.TG_BOT_TOKEN}:kiliw-tg-webhook`),
  );
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

/* validate the signed payload Telegram gives to mini apps; returns the
   Telegram user object or null */
async function checkInitData(env, initData) {
  try {
    const params = new URLSearchParams(String(initData || ''));
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = await hmacSha256(new TextEncoder().encode('WebAppData'), env.TG_BOT_TOKEN);
    const expected = toHex(await hmacSha256(secret, check));
    if (expected !== String(hash).toLowerCase()) return null;
    const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
    if (!(age >= -60 && age < 24 * 3600)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

const whoFrom = (tgUser) => ({
  email: null,
  tgId: tgUser.id,
  tgUsername: tgUser.username || '',
});

const tgName = (u) => (u && u.username ? `@${u.username}` : (u && u.first_name) || 'Telegram');

/* Bot API caller. With MAIL_DEBUG the calls are collected instead of
   sent, so the whole bot is testable offline. */
function makeBot(env) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      if (env.MAIL_DEBUG) return { ok: true, result: {} };
      try {
        const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch {
        return { ok: false };
      }
    },
  };
}

/* ---------- bot conversation ---------- */

/* send a message, first deleting the previous one we sent to this chat
   so the bot never piles up spam */
async function sendTracked(env, bot, chatId, payload) {
  await tgDeletePrev(env, chatId);
  const sent = await bot.call('sendMessage', { chat_id: chatId, ...payload });
  await tgStoreMsg(env, chatId, sent && sent.result && sent.result.message_id);
  return sent;
}

async function handleStart(env, bot, origin, msg, param) {
  const chatId = msg.chat.id;
  const from = msg.from;

  /* deep link from the Minecraft chat / map QR: /start mc_<token> */
  if (param.startsWith('mc_')) {
    const token = param.slice(3);
    const data = await loadJoin(env, token);
    if (!data || data.status !== 'pending') {
      await sendTracked(env, bot, chatId, {
        text: 'This code has expired. Rejoin the server to get a fresh one.',
      });
      return;
    }
    const meta = joinMetaLines(data, token);
    await sendTracked(env, bot, chatId, {
      text: `Sign-in request\n\n${data.server} wants to log you in as ${data.nick}.\nTelegram: ${tgName(from)}`
        + (meta.length ? `\n\n${meta.join('\n')}` : '')
        + '\n\nOpen to review and confirm.',
      reply_markup: { inline_keyboard: [
        [{ text: 'Review & confirm', web_app: { url: `${origin}/tg#mc_${token}` } }],
      ] },
    });
    return;
  }

  /* plain /start */
  await sendTracked(env, bot, chatId, {
    text: 'Welcome to K-MCID.\n\nWhen you join a Minecraft server, the sign-in request appears here — nothing to set up. The first approval ties your nickname to this Telegram, so no one else can join under it.\n\nYou can also scan a sign-in code shown on a computer screen:',
    reply_markup: { inline_keyboard: [[
      { text: 'Scan a code', web_app: { url: `${origin}/tg` } },
    ]] },
  });
}

/* ---------- HTTP entry points ---------- */

export async function onRequestPost({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);

  /* Telegram webhook (authenticated by the secret header) */
  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secretHeader) {
    if (!botReady(env) || secretHeader !== await webhookSecret(env)) {
      return json({ success: false, error: 'unauthorized' }, 401);
    }
    const update = await request.json().catch(() => null);
    if (!update) return json({ success: true });
    const bot = makeBot(env);
    const origin = idOrigin(request);
    try {
      const msg = update.message;
      if (msg && typeof msg.text === 'string' && msg.chat) {
        const parts = msg.text.trim().split(/\s+/);
        if (parts[0] === '/start' || parts[0] === `/start@${env.TG_BOT_USERNAME}`) {
          await handleStart(env, bot, origin, msg, parts[1] || '');
        }
      }
    } catch { /* never make Telegram retry-storm us */ }
    return json(env.MAIL_DEBUG ? { success: true, debugCalls: bot.calls } : { success: true });
  }

  /* --- mini app (Telegram initData) --- */
  if (!botReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');
  const tgUser = await checkInitData(env, body?.initData);
  if (!tgUser) return json({ success: false, error: 'unauthorized' }, 401);

  if (action === 'auth') {
    return json({ success: true, tgName: tgName(tgUser), mcNick: await getTgNick(env, tgUser.id) });
  }

  if (action === 'unlink') {
    const nick = await unlinkTgNick(env, tgUser.id);
    return json({ success: true, unlinked: nick });
  }

  if (action === 'approve' || action === 'deny') {
    const res = await decideJoin(env, String(body?.token || ''), whoFrom(tgUser), action === 'approve');
    if (res.error) return json({ success: false, error: res.error, held: res.held || null }, res.http);
    return json({ success: true, denied: Boolean(res.denied), nick: res.nick });
  }

  if (action === 'info') {
    const token = String(body?.token || '');
    const data = await loadJoin(env, token);
    if (!data) return json({ success: true, status: 'expired' });
    return json({
      success: true,
      status: data.status,
      nick: data.nick,
      server: data.server,
      meta: joinMeta(data, token),
    });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);

  /* owner: wipe every Telegram binding and Minecraft nick claim,
     so everyone starts fresh (GET /api/tg?reset=1) */
  if (url.searchParams.get('reset') === '1') {
    const session = await getSession(request, env);
    if (!session || !isOwner(env, session.email)) {
      return json({ success: false, error: 'unauthorized' }, 401);
    }
    const wipe = async (prefix) => {
      let n = 0;
      let cursor;
      do {
        const page = await env.KILIW_FILES.list({ prefix, cursor });
        for (const obj of page.objects) {
          await env.KILIW_FILES.delete(obj.key).catch(() => {});
          n += 1;
        }
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      return n;
    };
    const tgWiped = await wipe('_auth/tg/');
    const linksWiped = await wipe('_auth/tglink/');
    const nicksWiped = await wipe('_auth/mcnick/');
    await wipe('_auth/mctg/');
    const devicesWiped = await wipe('_auth/mcdev/');
    /* clear the mirror fields left on user records by older builds */
    let usersCleared = 0;
    let cursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix: '_auth/users/', cursor });
      for (const obj of page.objects) {
        const rec = await env.KILIW_FILES.get(obj.key);
        const user = rec ? await rec.json().catch(() => null) : null;
        if (user && (user.tgId || user.tgUsername || user.mcNick)) {
          delete user.tgId;
          delete user.tgUsername;
          delete user.mcNick;
          await env.KILIW_FILES.put(obj.key, JSON.stringify(user));
          usersCleared += 1;
        }
      }
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    return json({
      success: true,
      telegramBindings: tgWiped,
      pendingLinkCodes: linksWiped,
      minecraftNicks: nicksWiped,
      devices: devicesWiped,
      usersCleared,
    });
  }

  /* owner: wire the bot up (webhook + menu button) in one click */
  if (url.searchParams.get('setup') === '1') {
    const session = await getSession(request, env);
    if (!session || !isOwner(env, session.email)) {
      return json({ success: false, error: 'unauthorized' }, 401);
    }
    if (!botReady(env)) {
      return json({
        success: false,
        error: 'not-configured',
        hint: 'Add TG_BOT_TOKEN and TG_BOT_USERNAME in the Cloudflare dashboard first.',
      }, 503);
    }
    const bot = makeBot(env);
    const origin = idOrigin(request);
    const me = await bot.call('getMe', {});
    const webhook = await bot.call('setWebhook', {
      url: `${origin}/api/tg`,
      secret_token: await webhookSecret(env),
      allowed_updates: ['message'],
    });
    const menu = await bot.call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Scan', web_app: { url: `${origin}/tg` } },
    });
    const commands = await bot.call('setMyCommands', {
      commands: [{ command: 'start', description: 'Minecraft sign-in' }],
    });
    return json({
      success: Boolean(webhook?.ok),
      bot: me?.result?.username || env.TG_BOT_USERNAME,
      webhook: webhook?.ok ? `${origin}/api/tg` : webhook,
      menuButton: Boolean(menu?.ok),
      commands: Boolean(commands?.ok),
      ...(env.MAIL_DEBUG ? { debugCalls: bot.calls } : {}),
    });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
