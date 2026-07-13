import {
  json, storageReady, getUser, putUser, createSession, randomHex,
  hashPassword, afterAuthRedirect, wipeAccount,
} from '../../lib/api.js';

/* Social sign-in (Google / GitHub) for the K-ID account system.
   GET /api/oauth?start=1&provider=google|github  → redirect to the provider
   GET /api/oauth/callback?code&state             → session + redirect

   Configure in the dashboard (secrets):
   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
   Register the callback URL with each provider:
   https://id.<domain>/api/oauth/callback */

const STATE_TTL = 10 * 60 * 1000;

function conf(env, provider) {
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
  }
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
  }
  return null;
}

const backToLogin = (url, reason) => Response.redirect(
  new URL(`/login?oauth=${reason}`, url).toString(), 302,
);

export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ success: false, error: 'not-configured' }, 503);
  const url = new URL(request.url);

  /* ---------- provider callback ---------- */
  if (url.pathname.endsWith('/callback')) {
    const stateKey = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    if (!/^[0-9a-f]{64}$/.test(stateKey) || !code) return backToLogin(url, 'failed');

    const obj = await env.KILIW_FILES.get(`_auth/oauth/${stateKey}.json`);
    await env.KILIW_FILES.delete(`_auth/oauth/${stateKey}.json`).catch(() => {});
    const state = obj ? await obj.json().catch(() => null) : null;
    if (!state || state.expires < Date.now()) return backToLogin(url, 'failed');

    const c = conf(env, state.provider);
    if (!c) return backToLogin(url, 'unavailable');

    let email = '';
    try {
      email = state.provider === 'google'
        ? await googleEmail(c, code, `${url.origin}/api/oauth/callback`)
        : await githubEmail(c, code);
    } catch {
      email = '';
    }
    email = String(email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return backToLogin(url, 'failed');

    let user = await getUser(env, email);
    if (user?.banned) return backToLogin(url, 'banned');
    let restored = false;
    if (user?.deleteAt) {
      if (user.deleteAt <= Date.now()) {
        await wipeAccount(env, email);
        user = null;
      } else {
        delete user.deleteAt;
        restored = true;
        await putUser(env, user);
      }
    }
    if (!user) {
      /* first social sign-in: the account starts passwordless (a random
         password nobody knows; a real one can be set via reset) */
      const salt = randomHex(16);
      user = {
        email,
        salt,
        hash: await hashPassword(randomHex(32), salt),
        created: Date.now(),
        oauth: state.provider,
      };
      await putUser(env, user);
    }

    const { cookie } = await createSession(env, email, request);
    const headers = new Headers();
    headers.set('Set-Cookie', cookie);
    headers.set('Location', state.after || afterAuthRedirect(request));
    return new Response(null, { status: 302, headers });
  }

  /* ---------- start ---------- */
  if (url.searchParams.get('start') === '1') {
    const provider = String(url.searchParams.get('provider') || '');
    const c = conf(env, provider);
    if (!c) return backToLogin(url, 'unavailable');

    const stateKey = randomHex(32);
    await env.KILIW_FILES.put(`_auth/oauth/${stateKey}.json`, JSON.stringify({
      provider,
      after: afterAuthRedirect(request),
      expires: Date.now() + STATE_TTL,
    }));

    const redirectUri = `${url.origin}/api/oauth/callback`;
    const target = provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: c.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state: stateKey,
        prompt: 'select_account',
      })
      : 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
        client_id: c.id,
        redirect_uri: redirectUri,
        scope: 'user:email',
        state: stateKey,
      });
    return Response.redirect(target, 302);
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

/* ---------- provider plumbing ---------- */

async function googleEmail(c, code, redirectUri) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.id,
      client_secret: c.secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) return '';
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const info = await infoRes.json();
  return info.email_verified ? info.email : '';
}

async function githubEmail(c, code) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, client_id: c.id, client_secret: c.secret }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) return '';
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'KiliwCloud',
    },
  });
  const emails = await emailsRes.json();
  if (!Array.isArray(emails)) return '';
  const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
  return primary ? primary.email : '';
}
