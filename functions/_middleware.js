/* Routes requests by host and session:
   - kiliw.com / www:   signed out → auth.kiliw.com, signed in → cloud.kiliw.com
   - auth.kiliw.com:    signed out → auth page; signed in → cloud.kiliw.com
   - cloud.kiliw.com:   signed out → auth.kiliw.com; signed in → cloud app
   - *.workers.dev / *.pages.dev / localhost: auth and cloud on one host */

import { getSession, authRedirect, afterAuthRedirect, isPlainHost } from '../lib/api.js';

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

  const isRoot = url.pathname === '/' || url.pathname === '/index.html';
  const isCloudPage = url.pathname === '/cloud.html';

  /* single-host mode (workers.dev previews, local dev) */
  if (isPlainHost(host)) {
    if (session && isRoot) return env.ASSETS.fetch(new URL('/cloud.html', url));
    if (!session && isCloudPage) {
      return Response.redirect(new URL('/', url).toString(), 302);
    }
    return next();
  }

  const isAuthHost = host.startsWith('auth.');
  const isCloudHost = host.startsWith('cloud.');

  if (isAuthHost) {
    if (session && isRoot) return Response.redirect(afterAuthRedirect(request), 302);
    if (isCloudPage) return Response.redirect(afterAuthRedirect(request), 302);
    return next();
  }

  if (isCloudHost) {
    if (!session && (isRoot || isCloudPage)) {
      return Response.redirect(authRedirect(request), 302);
    }
    if (session && isRoot) return env.ASSETS.fetch(new URL('/cloud.html', url));
    return next();
  }

  /* apex / www: pure dispatcher */
  if (isRoot || isCloudPage) {
    return Response.redirect(
      session ? afterAuthRedirect(request) : authRedirect(request),
      302,
    );
  }
  return next();
}
