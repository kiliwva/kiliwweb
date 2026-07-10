import {
  json, getSession, getUser, planLimits, storageUsage, storageReady, yookassaReady,
  PRO_TIERS,
} from '../../lib/api.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);

  const user = await getUser(env, session.email);
  const limits = planLimits(user);
  const usage = storageReady(env) ? await storageUsage(env, session.email) : 0;

  return json({
    success: true,
    email: session.email,
    totp: Boolean(user?.totp),
    plan: {
      type: limits.type,
      maxFile: limits.maxFile,
      quota: limits.quota,
      gb: limits.gb,
      until: limits.until,
    },
    usage,
    billing: {
      available: yookassaReady(env),
      tiers: Object.entries(PRO_TIERS).map(([gb, price]) => ({ gb: Number(gb), price })),
    },
  });
}
