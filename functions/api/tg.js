import {
  json, storageReady, getSession, getUser, putUser, randomHex, isOwner,
} from '../../lib/api.js';
import { loadJoin, decideJoin } from './mc.js';

/* Telegram bot: K-ID account linking + Minecraft join approvals.

   Telegram (webhook, verified by a secret header):
     POST /api/tg                       ← bot updates (/start, buttons)

   The mini app inside the bot (Telegram initData instead of cookies):
     POST /api/tg { action: "auth",    initData }
     POST /api/tg { action: "approve" | "deny", initData, token }

   The site (session cookie, /tglink confirm page):
     POST /api/tg { action: "bind", code }
     GET  /api/tg?link=<code>           → who is asking to be linked
     GET  /api/tg?setup=1               → owner: register webhook + menu

   Storage: _auth/tg/<telegram id> → { email } is the binding;
   _auth/tglink/<code> holds a 10-minute link request. */

const LINK_TTL = 10 * 60 * 1000;
const tgKey = (id) => `_auth/tg/${id}.json`;
const linkKey = (code) => `_auth/tglink/${code}.json`;

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

async function getBinding(env, tgId) {
  const obj = await env.KILIW_FILES.get(tgKey(tgId));
  if (!obj) return null;
  return obj.json().catch(() => null);
}

async function makeLinkCode(env, tgUser) {
  const code = randomHex(16);
  await env.KILIW_FILES.put(linkKey(code), JSON.stringify({
    tgId: tgUser.id,
    username: tgUser.username || '',
    first: tgUser.first_name || '',
    expires: Date.now() + LINK_TTL,
  }));
  return code;
}

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

async function handleStart(env, bot, origin, msg, param) {
  const chatId = msg.chat.id;
  const from = msg.from;
  const binding = from ? await getBinding(env, from.id) : null;

  /* deep link from the Minecraft chat / map QR: /start mc_<token> */
  if (param.startsWith('mc_')) {
    const token = param.slice(3);
    const data = await loadJoin(env, token);
    if (!data || data.status !== 'pending') {
      await bot.call('sendMessage', {
        chat_id: chatId,
        text: 'This sign-in link has expired. Rejoin the server to get a fresh one.',
      });
      return;
    }
    if (!binding) {
      const code = await makeLinkCode(env, from);
      await bot.call('sendMessage', {
        chat_id: chatId,
        text: `To approve joins you first need to connect your K-ID account.\n\nAfter connecting, tap the link from the game chat (or scan the map) again.`,
        reply_markup: { inline_keyboard: [[
          { text: 'Connect my K-ID', url: `${origin}/tglink#${code}` },
        ]] },
      });
      return;
    }
    await bot.call('sendMessage', {
      chat_id: chatId,
      text: `Minecraft sign-in\n\nLet ${data.server} log you in as ${data.nick}?\nAccount: ${binding.email}`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Yes, that’s me', callback_data: `mc:ok:${token}` },
        { text: '❌ Deny', callback_data: `mc:no:${token}` },
      ]] },
    });
    return;
  }

  /* plain /start */
  if (binding) {
    const user = await getUser(env, binding.email);
    const nick = user && user.mcNick ? `\nMinecraft nickname: ${user.mcNick}` : '';
    await bot.call('sendMessage', {
      chat_id: chatId,
      text: `You are connected as ${binding.email}.${nick}\n\nWhen you join a Minecraft server, the confirmation will show up here. You can also scan a sign-in QR from the app below.`,
      reply_markup: { inline_keyboard: [[
        { text: 'Open K-ID', web_app: { url: `${origin}/tg` } },
      ]] },
    });
    return;
  }
  const code = await makeLinkCode(env, from);
  await bot.call('sendMessage', {
    chat_id: chatId,
    text: 'Hi! I connect your Telegram to your K-ID account, so you can approve Minecraft sign-ins right here.\n\nConnect your account to get started:',
    reply_markup: { inline_keyboard: [[
      { text: 'Connect my K-ID', url: `${origin}/tglink#${code}` },
    ]] },
  });
}

async function handleCallback(env, bot, cq) {
  const answer = (text) => bot.call('answerCallbackQuery', {
    callback_query_id: cq.id,
    ...(text ? { text } : {}),
  });
  const m = String(cq.data || '').match(/^mc:(ok|no):([0-9a-f]{24})$/);
  if (!m) { await answer(); return; }

  const binding = cq.from ? await getBinding(env, cq.from.id) : null;
  if (!binding) { await answer('Connect your K-ID first: send /start'); return; }

  const res = await decideJoin(env, m[2], binding.email, m[1] === 'ok');
  const edit = (text) => (cq.message ? bot.call('editMessageText', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    text,
  }) : Promise.resolve());

  if (res.error === 'mc-expired') {
    await edit('This sign-in link has expired. Rejoin the server to get a fresh one.');
  } else if (res.error === 'nick-taken') {
    await edit('❌ This nickname is tied to a different K-ID account.');
  } else if (res.error) {
    await edit('Something went wrong. Rejoin the server and try again.');
  } else if (res.denied) {
    await edit(`❌ Denied. ${res.nick} will be kicked from the server.`);
  } else {
    await edit(`✅ Done! Switch back to Minecraft — the server is unfreezing ${res.nick}.`);
  }
  await answer();
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
      if (update.callback_query) await handleCallback(env, bot, update.callback_query);
    } catch { /* never make Telegram retry-storm us */ }
    return json(env.MAIL_DEBUG ? { success: true, debugCalls: bot.calls } : { success: true });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');

  /* --- site (session cookie): confirm the Telegram link --- */
  if (action === 'bind') {
    const session = await getSession(request, env);
    if (!session) return json({ success: false, error: 'unauthorized' }, 401);
    const code = String(body?.code || '');
    if (!/^[0-9a-f]{32}$/.test(code)) return json({ success: false, error: 'bad-request' }, 400);
    const obj = await env.KILIW_FILES.get(linkKey(code));
    const link = obj ? await obj.json().catch(() => null) : null;
    await env.KILIW_FILES.delete(linkKey(code)).catch(() => {});
    if (!link || link.expires < Date.now()) {
      return json({ success: false, error: 'link-expired' }, 410);
    }
    const user = await getUser(env, session.email);
    if (!user) return json({ success: false, error: 'unauthorized' }, 401);
    /* one Telegram per account: drop the previous binding if any */
    if (user.tgId && user.tgId !== link.tgId) {
      await env.KILIW_FILES.delete(tgKey(user.tgId)).catch(() => {});
    }
    await env.KILIW_FILES.put(tgKey(link.tgId), JSON.stringify({
      email: session.email,
      username: link.username,
      created: Date.now(),
    }));
    user.tgId = link.tgId;
    user.tgUsername = link.username;
    await putUser(env, user);
    return json({ success: true, username: link.username });
  }

  /* --- mini app (Telegram initData) --- */
  if (!botReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const tgUser = await checkInitData(env, body?.initData);
  if (!tgUser) return json({ success: false, error: 'unauthorized' }, 401);
  const binding = await getBinding(env, tgUser.id);

  if (action === 'auth') {
    if (!binding) {
      const code = await makeLinkCode(env, tgUser);
      return json({
        success: true,
        linked: false,
        linkUrl: `${idOrigin(request)}/tglink#${code}`,
      });
    }
    const user = await getUser(env, binding.email);
    return json({
      success: true,
      linked: true,
      email: binding.email,
      mcNick: (user && user.mcNick) || null,
    });
  }

  if (action === 'approve' || action === 'deny') {
    if (!binding) return json({ success: false, error: 'not-linked' }, 403);
    const res = await decideJoin(env, String(body?.token || ''), binding.email, action === 'approve');
    if (res.error) return json({ success: false, error: res.error }, res.http);
    return json({ success: true, denied: Boolean(res.denied), nick: res.nick });
  }

  if (action === 'info') {
    const data = await loadJoin(env, String(body?.token || ''));
    if (!data) return json({ success: true, status: 'expired' });
    return json({ success: true, status: data.status, nick: data.nick, server: data.server });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);

  /* /tglink page: whose Telegram is asking to be connected? */
  const code = url.searchParams.get('link');
  if (code) {
    if (!/^[0-9a-f]{32}$/.test(code)) return json({ success: false, error: 'bad-request' }, 400);
    const obj = await env.KILIW_FILES.get(linkKey(code));
    const link = obj ? await obj.json().catch(() => null) : null;
    if (!link || link.expires < Date.now()) {
      return json({ success: false, error: 'link-expired' }, 410);
    }
    return json({ success: true, username: link.username, first: link.first });
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
      allowed_updates: ['message', 'callback_query'],
    });
    const menu = await bot.call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'K-ID', web_app: { url: `${origin}/tg` } },
    });
    const commands = await bot.call('setMyCommands', {
      commands: [{ command: 'start', description: 'Connect your K-ID account' }],
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
