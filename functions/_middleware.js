/* Routes requests by host and session:
   - auth.<domain>: signed out → auth page; signed in → redirect to <domain>
   - <domain>:      signed out → redirect to auth.<domain>; signed in → cloud app
   - *.pages.dev / localhost (no subdomains): auth and cloud served from one host */

import { getSession, authRedirect, mainHost } from '../lib/api.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const host = url.hostname;

  if (url.pathname.startsWith('/api/')) return next();

  let session = null;
  try {
    session = await getSession(request, env);
  } catch {
    session = null;
  }

  const isAuthHost = host.startsWith('auth.');
  const isRoot = url.pathname === '/' || url.pathname === '/index.html';

  if (isAuthHost) {
    if (session && isRoot) {
      return Response.redirect(`${url.protocol}//${mainHost(host)}/`, 302);
    }
    return next();
  }

  if (session) {
    if (isRoot) {
      return env.ASSETS.fetch(new URL('/cloud.html', url));
    }
    return next();
  }

  /* signed out */
  if (url.pathname === '/cloud.html') {
    return Response.redirect(new URL('/', url).toString(), 302);
  }
  if (isRoot) {
    const target = authRedirect(request);
    if (target !== '/') return Response.redirect(target, 302);
  }
  return next();
}
