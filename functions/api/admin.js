import {
  json, getSession, storageReady, isOwner, getUser, putUser, planLimits,
  listPromos, putPromo, deletePromo, normPromoCode, getPromo,
  PRO_TIERS, DEV_GB, wipeSessionsFor, mailReady, sendEmail, notifyAccountEvent,
  createResetLink,
} from '../../lib/api.js';

/* Owner-only site management: promo codes + basic stats. */

async function requireOwner(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  if (!isOwner(env, session.email)) {
    return { error: json({ success: false, error: 'forbidden' }, 403) };
  }
  return { session };
}

async function siteStats(env) {
  let users = 0;
  let files = 0;
  let bytes = 0;
  const count = async (prefix, fn) => {
    let cursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
      fn(page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  };
  await Promise.all([
    count('_auth/users/', (objs) => { users += objs.length; }),
    count('u/', (objs) => {
      for (const obj of objs) {
        if (!obj.key.endsWith('/.keep')) files += 1;
        bytes += obj.size;
      }
    }),
  ]);
  return { users, files, bytes };
}

/** Every account with its plan, usage and file count. */
async function listUsers(env) {
  const prefix = '_auth/users/';
  const emails = [];
  let cursor;
  do {
    const page = await env.KILIW_FILES.list({ prefix, cursor, limit: 1000 });
    emails.push(...page.objects.map((o) => o.key.slice(prefix.length).replace(/\.json$/, '')));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const users = [];
  await Promise.all(emails.map(async (email) => {
    const user = await getUser(env, email);
    if (!user) return;
    const limits = planLimits(user, env);
    let usage = 0;
    let files = 0;
    let fcursor;
    do {
      const page = await env.KILIW_FILES.list({ prefix: `u/${email}/`, cursor: fcursor, limit: 1000 });
      for (const obj of page.objects) {
        usage += obj.size;
        if (!obj.key.endsWith('/.keep')) files += 1;
      }
      fcursor = page.truncated ? page.cursor : undefined;
    } while (fcursor);
    users.push({
      email,
      plan: limits.type,
      gb: limits.gb || null,
      quota: limits.quota,
      until: limits.type === 'free' ? null : limits.until,
      api: Boolean(limits.api),
      /* raw record fields: spot expired/broken activations at a glance */
      planRaw: user.plan || null,
      planUntilRaw: user.planUntil || null,
      usage,
      files,
      totp: Boolean(user.totp),
      banned: Boolean(user.banned),
      avatar: user.avatar || null,
      created: user.created || null,
    });
  }));
  users.sort((a, b) => b.usage - a.usage);
  return users;
}

/* GET /api/admin                  — promo list + stats
   GET /api/admin?view=users       — every user with usage details
   GET /api/admin?avatar=<email>   — that user's avatar image */
export async function onRequestGet({ request, env }) {
  const { error } = await requireOwner(request, env);
  if (error) return error;

  const url = new URL(request.url);

  const avatarOf = url.searchParams.get('avatar');
  if (avatarOf) {
    const object = await env.KILIW_FILES.get(`_auth/avatars/${avatarOf}`);
    if (!object) return json({ success: false, error: 'not-found' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get('Content-Type')) headers.set('Content-Type', 'image/jpeg');
    headers.set('Cache-Control', 'private, max-age=3600');
    return new Response(object.body, { headers });
  }

  if (url.searchParams.get('view') === 'users') {
    return json({ success: true, users: await listUsers(env) });
  }

  const [promos, stats] = await Promise.all([listPromos(env), siteStats(env)]);
  return json({ success: true, promos, stats });
}

/* POST /api/admin
   { action: "promo-add", code, percent, maxUses? }
   { action: "promo-remove", code } */
export async function onRequestPost({ request, env }) {
  const { error } = await requireOwner(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');

  if (action === 'promo-add') {
    const code = normPromoCode(body?.code);
    const percent = Math.round(Number(body?.percent));
    const maxUses = Math.max(0, Math.round(Number(body?.maxUses) || 0)); // 0 = unlimited
    if (!code || code.length < 3) return json({ success: false, error: 'bad-code' }, 400);
    /* up to 100: a 100% code grants the plan for free */
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      return json({ success: false, error: 'bad-percent' }, 400);
    }
    const existing = await getPromo(env, code);
    await putPromo(env, {
      code,
      percent,
      maxUses,
      uses: existing?.uses || 0,
      created: existing?.created || Date.now(),
    });
    return json({ success: true, promos: await listPromos(env) });
  }

  if (action === 'promo-remove') {
    await deletePromo(env, body?.code);
    return json({ success: true, promos: await listPromos(env) });
  }

  /* support tool: set a user's plan by hand (fixes botched activations) */
  if (action === 'set-plan') {
    const email = String(body?.email || '').trim().toLowerCase();
    const plan = String(body?.plan || '');
    const user = await getUser(env, email);
    if (!user) return json({ success: false, error: 'not-found' }, 404);

    if (plan === 'free') {
      delete user.plan;
      delete user.planGb;
      delete user.planUntil;
    } else if (plan === 'pro' || plan === 'dev') {
      const days = Math.min(Math.max(Math.round(Number(body?.days)) || 30, 1), 3650);
      const gb = plan === 'dev' ? DEV_GB : Math.round(Number(body?.gb));
      if (plan === 'pro' && !PRO_TIERS[gb]) return json({ success: false, error: 'bad-request' }, 400);
      user.plan = plan;
      user.planGb = gb;
      user.planUntil = Date.now() + days * 24 * 60 * 60 * 1000;
      user.lastPaymentId = `admin-grant-${Date.now()}`;
    } else {
      return json({ success: false, error: 'bad-request' }, 400);
    }
    await putUser(env, user);
    return json({ success: true, plan: planLimits(user, env) });
  }

  /* moderation: suspend / restore an account */
  if (action === 'ban' || action === 'unban') {
    const email = String(body?.email || '').trim().toLowerCase();
    if (isOwner(env, email)) return json({ success: false, error: 'bad-request' }, 400);
    const user = await getUser(env, email);
    if (!user) return json({ success: false, error: 'not-found' }, 404);
    if (action === 'ban') {
      user.banned = Date.now();
      await putUser(env, user);
      /* kick every signed-in device right away */
      await wipeSessionsFor(env, email);
    } else {
      delete user.banned;
      await putUser(env, user);
    }
    return json({ success: true, banned: Boolean(user.banned) });
  }

  /* support: drop a user's 2FA (lost authenticator) */
  if (action === 'clear-2fa') {
    const email = String(body?.email || '').trim().toLowerCase();
    const user = await getUser(env, email);
    if (!user) return json({ success: false, error: 'not-found' }, 404);
    if (!user.totp) return json({ success: false, error: 'no-2fa' }, 400);
    delete user.totp;
    await putUser(env, user);
    await notifyAccountEvent(env, email, '2fa-disabled');
    return json({ success: true });
  }

  /* support: email the user a link to the password reset page */
  if (action === 'send-reset') {
    if (!mailReady(env)) return json({ success: false, error: 'mail-not-configured' }, 503);
    const email = String(body?.email || '').trim().toLowerCase();
    const user = await getUser(env, email);
    if (!user) return json({ success: false, error: 'not-found' }, 404);
    const origin = new URL(request.url).origin;
    const k = await createResetLink(env, email);
    const mail = resetLinkEmail(`${origin}/reset?k=${k}`);
    const sent = await sendEmail(env, email, mail.subject, mail.text, mail.html);
    if (!sent) return json({ success: false, error: 'mail-failed' }, 502);
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}

/** Support email: a button that opens the password reset page. */
function resetLinkEmail(url) {
  const font = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  const subject = 'Reset your Kiliw password';
  const text = `Set a new password for your Kiliw account (the link works once and expires in 15 minutes): ${url}\n\nIf you didn't expect this email, you can safely ignore it.`;
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#161616;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#161616;">
    <tr><td align="center" style="padding:36px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#1E1E1E;border:1px solid #2F2F2F;border-radius:24px;">
        <tr><td style="padding:30px 28px 0;font-family:${font};">
          <span style="font-size:20px;font-weight:800;color:#F2F2F2;letter-spacing:-0.3px;">Kiliw <span style="color:#D97757;">Cloud</span></span>
        </td></tr>
        <tr><td style="padding:16px 28px 0;font-family:${font};font-size:14.5px;line-height:1.55;color:#B9B9B9;">Our support team sent you this link to set a new password for your account. It works once and expires in 15 minutes.</td></tr>
        <tr><td align="center" style="padding:24px 28px 0;">
          <a href="${url}" style="display:inline-block;padding:14px 28px;background:#C8603E;border-radius:14px;font-family:${font};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">Reset password</a>
        </td></tr>
        <tr><td style="padding:22px 28px 30px;font-family:${font};font-size:12.5px;line-height:1.55;color:#7C7C7C;">If you didn't expect this email, you can safely ignore it — your password stays unchanged.</td></tr>
      </table>
      <div style="padding-top:16px;font-family:${font};font-size:12px;color:#5C5C5C;">Kiliw Cloud · kiliw.com</div>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}
