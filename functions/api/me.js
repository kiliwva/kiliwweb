import { json, getSession } from '../../lib/api.js';

export async function onRequestGet({ request, env }) {
  const session = await getSession(request, env);
  if (!session) return json({ success: false, error: 'unauthorized' }, 401);
  return json({ success: true, email: session.email });
}
