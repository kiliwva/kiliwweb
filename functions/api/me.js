import {
  json, getSession, getUser, planLimits, storageUsage, storageReady,
  yookassaReady, heleketReady, PRO_TIERS, isOwner,
} from '../../lib/api.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  const user = await getUser(env, session.email);
  const limits = planLimits(user, env);
  const usage = storageReady(env) ? await storageUsage(env, session.email) : 0;

  return json({
    success: true,
    email: session.email,
    totp: Boolean(user?.totp),
    avatar: user?.avatar || null,
    owner: isOwner(env, session.email),
    plan: {
      type: limits.type,
      maxFile: limits.maxFile,
      quota: limits.quota,
      gb: limits.gb,
      until: limits.until,
    },
    usage,
    billing: {
      yookassa: yookassaReady(env),
      heleket: heleketReady(env),
      tiers: Object.entries(PRO_TIERS).map(([gb, price]) => ({ gb: Number(gb), price })),
    },
  });
}
