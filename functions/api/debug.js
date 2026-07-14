import { json, getSession, storageReady, getUser, planLimits } from '../../lib/api.js';

/* GET /api/debug — session-protected server-state snapshot for support. */
export async function onRequestGet({ request, env }) {
  if (!storageReady(env)) return json({ error: 'not-configured' }, 503);
  const session = await getSession(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);

  const user = await getUser(env, session.email);
  const head = await env.KILIW_FILES.head(`_auth/avatars/${session.email}`);
  const limits = planLimits(user, env);

  return json({
    build: 135,
    email: session.email,
    userRecordFound: Boolean(user),
    avatarField: user?.avatar ?? null,
    totpEnabled: Boolean(user?.totp),
    /* raw plan fields + what they resolve to (support: plan disputes) */
    planRaw: user?.plan ?? null,
    planGb: user?.planGb ?? null,
    planUntil: user?.planUntil ?? null,
    planUntilIso: user?.planUntil ? new Date(user.planUntil).toISOString() : null,
    planExpired: Boolean(user?.planUntil && user.planUntil <= Date.now()),
    planResolved: limits.type,
    lastPaymentId: user?.lastPaymentId ?? null,
    pendingPayment: user?.pendingPayment ?? null,
    avatarObjectExists: Boolean(head),
    avatarObjectSize: head?.size ?? null,
    avatarObjectType: head?.httpMetadata?.contentType ?? null,
    avatarObjectUploaded: head?.uploaded ?? null,
  });
}
