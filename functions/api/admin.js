import {
  json, getSession, storageReady, isOwner,
  listPromos, putPromo, deletePromo, normPromoCode, getPromo,
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

/* GET /api/admin — promo list + stats */
export async function onRequestGet({ request, env }) {
  const { error } = await requireOwner(request, env);
  if (error) return error;

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
    if (!Number.isFinite(percent) || percent < 1 || percent > 90) {
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

  return json({ success: false, error: 'bad-request' }, 400);
}
