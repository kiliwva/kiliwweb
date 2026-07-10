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
import * as file from '../functions/api/file.js';
import * as folders from '../functions/api/folders.js';
import * as mpu from '../functions/api/mpu.js';
import * as billing from '../functions/api/billing.js';
import * as yookassa from '../functions/api/yookassa.js';
import { json } from '../lib/api.js';

const ROUTES = {
  '/api/login': login,
  '/api/register': register,
  '/api/logout': logout,
  '/api/me': me,
  '/api/password': password,
  '/api/2fa': twofa,
  '/api/files': filesIndex,
  '/api/file': file,
  '/api/folders': folders,
  '/api/mpu': mpu,
  '/api/billing': billing,
  '/api/yookassa': yookassa,
};

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
      const mod = ROUTES[pathname];
      if (mod) return dispatch(mod, { request, env, params: {} });
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
