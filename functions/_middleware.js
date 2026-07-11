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
  const isLogin = url.pathname === '/login';
  /* legacy app URLs from before the landing page existed */
  const isLegacyApp = ['/cloud.html', '/cloud'].includes(url.pathname);
  /* pages that require a session (the app + checkout + admin);
     the assets layer also serves them at extensionless clean URLs */
  const isAdminPage = url.pathname === '/admin.html' || url.pathname === '/admin';
  const isCloudPage = isAdminPage
    || ['/dash.html', '/dash', '/checkout.html', '/checkout'].includes(url.pathname);

  /* the admin page is for the site owner only */
  if (isAdminPage && session && env.OWNER_EMAIL && session.email !== env.OWNER_EMAIL) {
    return Response.redirect(new URL('/dash', url).toString(), 302);
  }
  if (isLegacyApp) {
    return Response.redirect(new URL('/dash', url).toString(), 301);
  }

  /* the marketing landing lives at the root (except on the auth host);
     fetching the extensionless twin avoids the assets-layer redirect */
  const landing = () => env.ASSETS.fetch(new URL('/home', url));
  /* the auth page content (index.html) for /login on non-auth hosts */
  const authPage = () => env.ASSETS.fetch(new URL('/', url));

  /* single-host mode (workers.dev previews, local dev) */
  if (isPlainHost(host)) {
    if (isRoot) return landing();
    if (isLogin) {
      return session
        ? Response.redirect(new URL('/dash', url).toString(), 302)
        : authPage();
    }
    if (!session && isCloudPage) {
      return Response.redirect(new URL('/login', url).toString(), 302);
    }
    return next();
  }

  const isAuthHost = host.startsWith('auth.');
  const isCloudHost = host.startsWith('cloud.');

  if (isAuthHost) {
    if (session && (isRoot || isLogin)) return Response.redirect(afterAuthRedirect(request), 302);
    if (isLogin) return authPage();
    if (isCloudPage) return Response.redirect(afterAuthRedirect(request), 302);
    return next();
  }

  if (isCloudHost) {
    if (isRoot) return landing();
    if (isLogin) {
      return session
        ? Response.redirect(new URL('/dash', url).toString(), 302)
        : authPage();
    }
    if (!session && isCloudPage) {
      return Response.redirect(authRedirect(request), 302);
    }
    return next();
  }

  /* apex / www: pure dispatcher */
  if (isRoot || isLogin || isCloudPage) {
    return Response.redirect(
      session ? afterAuthRedirect(request) : authRedirect(request),
      302,
    );
  }
  return next();
}
