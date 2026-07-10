/* Worker entry point (Cloudflare Workers with static assets).
   Reuses the same handlers as the Pages Functions in functions/. */

import { onRequest as pageRouter } from '../functions/_middleware.js';
import * as login from '../functions/api/login.js';
import * as register from '../functions/api/register.js';
import * as logout from '../functions/api/logout.js';
import * as me from '../functions/api/me.js';
import * as password from '../functions/api/password.js';
import * as twofa from '../functions/api/2fa.js';
import * as filesIndex from '../functions/api/files/index.js';
import * as fileItem from '../functions/api/files/[name].js';
import { json } from '../lib/api.js';

function dispatch(mod, context) {
  const method = context.request.method;
  const name = `onRequest${method[0]}${method.slice(1).toLowerCase()}`;
  const handler = mod[name];
  if (!handler) return json({ success: false, error: 'method-not-allowed' }, 405);
  return handler(context);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      const context = { request, env, params: {} };
      if (pathname === '/api/login') return dispatch(login, context);
      if (pathname === '/api/register') return dispatch(register, context);
      if (pathname === '/api/logout') return dispatch(logout, context);
      if (pathname === '/api/me') return dispatch(me, context);
      if (pathname === '/api/password') return dispatch(password, context);
      if (pathname === '/api/2fa') return dispatch(twofa, context);
      if (pathname === '/api/files') return dispatch(filesIndex, context);
      const match = pathname.match(/^\/api\/files\/([^/]+)$/);
      if (match) {
        context.params = { name: match[1] };
        return dispatch(fileItem, context);
      }
      return json({ success: false, error: 'not-found' }, 404);
    }

    /* Pages-middleware-compatible context: next() serves static assets. */
    return pageRouter({
      request,
      env,
      next: () => env.ASSETS.fetch(request),
    });
  },
};
