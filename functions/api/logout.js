import { json, destroySession, authRedirect } from '../../lib/api.js';

export async function onRequestPost({ request, env }) {
  const cookie = await destroySession(request, env);
  return json(
    { success: true, redirect: authRedirect(request) },
    200,
    { 'Set-Cookie': cookie },
  );
}
