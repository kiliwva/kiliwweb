/* Routes requests by host and session:
   - kiliw.com / www:   signed out → auth.kiliw.com, signed in → cloud.kiliw.com
   - auth.kiliw.com:    signed out → auth page; signed in → cloud.kiliw.com
   - cloud.kiliw.com:   signed out → auth.kiliw.com; signed in → cloud app
   - id.kiliw.com:      the shared K-ID account hub (root = profile)
   - *.workers.dev / *.pages.dev / localhost: auth and cloud on one host */

import {
  getSession, authRedirect, afterAuthRedirect, isPlainHost, isMcidAdminEmail,
} from '../lib/api.js';

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
  const isMcidPage = url.pathname === '/mcid.html' || url.pathname === '/mcid';
  const isAdminPage = url.pathname === '/admin.html' || url.pathname === '/admin' || isMcidPage;
  const isCloudPage = isAdminPage
    || ['/dash.html', '/dash', '/checkout.html', '/checkout'].includes(url.pathname);
  /* the K-ID account hub page (session required) */
  const isIdPage = ['/id.html', '/id'].includes(url.pathname);

  /* the admin page is for the site owner only */
  if (isAdminPage && session && env.OWNER_EMAIL && session.email !== env.OWNER_EMAIL) {
    return Response.redirect(new URL('/dash', url).toString(), 302);
  }
  if (isLegacyApp) {
    return Response.redirect(new URL('/dash', url).toString(), 301);
  }

  /* the marketing landing lives at the root (except on the auth host);
     fetching the extensionless twin avoids the assets-layer redirect.
     Signed-in visitors get their buttons rewritten on the server, so
     nothing flashes from "Sign in" to "Open my cloud" after load. */
  const landing = async () => {
    const res = await env.ASSETS.fetch(new URL('/home', url));
    if (!session) return res;
    const appLink = {
      element(el) {
        el.setAttribute('href', '/dash');
        el.setInnerContent('Open my cloud');
      },
    };
    return new HTMLRewriter()
      .on('a#lp-auth', appLink)
      .on('a#lp-start', appLink)
      .on('a[data-plan]', {
        element(el) {
          const q = el.getAttribute('data-plan');
          el.setAttribute('href', q === 'free' ? '/dash' : `/checkout.html?${q}`);
        },
      })
      .transform(res);
  };
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
    if (!session && (isCloudPage || isIdPage)) {
      return Response.redirect(new URL('/login', url).toString(), 302);
    }
    return next();
  }

  const isAuthHost = host.startsWith('auth.');
  const isCloudHost = host.startsWith('cloud.');
  const isIdHost = host.startsWith('id.');
  const isMcidHost = host.startsWith('mcid.');

  /* mcid.<domain>: the Minecraft host. Everything runs on the Kiliw ID
     account — no Telegram. /login shows the same sign-in window as the id
     host so the /mc join page can sign the player in without leaving mcid.
     The root serves the moderation panel to Minecraft admins; a signed-in
     non-admin is sent to their account, a signed-out visitor to sign-in. */
  if (isMcidHost) {
    if (isLogin) {
      return session
        ? Response.redirect(new URL('/', url).toString(), 302)
        : authPage();
    }
    if (isRoot) {
      if (!session) return authPage();
      if (isMcidAdminEmail(env, session.email)) {
        return env.ASSETS.fetch(new URL('/mcid', url));
      }
      return Response.redirect(`${url.protocol}//id.${host.split('.').slice(-2).join('.')}/`, 302);
    }
    return next();
  }

  /* id.<domain>: the shared account hub for the whole ecosystem */
  if (isIdHost) {
    const idPage = () => env.ASSETS.fetch(new URL('/id', url));
    if (isRoot || isIdPage) {
      return session
        ? idPage()
        : Response.redirect(new URL('/login', url).toString(), 302);
    }
    if (isLogin) {
      return session
        ? Response.redirect(new URL('/', url).toString(), 302)
        : authPage();
    }
    if (isCloudPage) {
      return Response.redirect(`${url.protocol}//cloud.${host.split('.').slice(-2).join('.')}${url.pathname}`, 302);
    }
    return next();
  }

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
    if (isIdPage) {
      return Response.redirect(`${url.protocol}//id.${host.split('.').slice(-2).join('.')}/`, 302);
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
