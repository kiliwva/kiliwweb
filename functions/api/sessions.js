import {
  json, getSession, storageReady, listUserSessions, sha256Hex,
} from '../../lib/api.js';

/* Devices: every live session of the account.
   Session tokens never leave the server — clients see a hash id. */

const sessionId = async (token) => (await sha256Hex(token)).slice(0, 16);

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/sessions — list devices, newest first, current marked */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const sessions = await listUserSessions(env, session.email);
  const out = await Promise.all(sessions.map(async (s) => ({
    id: await sessionId(s.token),
    device: s.device,
    created: s.created,
    current: s.token === session.token,
  })));
  out.sort((a, b) => (b.current - a.current) || (b.created - a.created));
  return json({ success: true, sessions: out });
}

/* POST /api/sessions
   { action: "revoke", id }      — sign out one device
   { action: "revoke-others" }   — sign out everywhere else */
export async function onRequestPost({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }
  const action = String(body?.action || '');
  const sessions = await listUserSessions(env, session.email);

  if (action === 'revoke') {
    const id = String(body?.id || '');
    for (const s of sessions) {
      if (await sessionId(s.token) === id) {
        await env.KILIW_FILES.delete(`_auth/sessions/${s.token}.json`);
        return json({ success: true, loggedOut: s.token === session.token });
      }
    }
    return json({ success: false, error: 'not-found' }, 404);
  }

  if (action === 'revoke-others') {
    let removed = 0;
    for (const s of sessions) {
      if (s.token === session.token) continue;
      await env.KILIW_FILES.delete(`_auth/sessions/${s.token}.json`);
      removed += 1;
    }
    return json({ success: true, removed });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
