import { json, getSession, getUser } from '../../lib/api.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);
  const user = await getUser(env, session.email);
  return json({ success: true, email: session.email, totp: Boolean(user?.totp) });
}
