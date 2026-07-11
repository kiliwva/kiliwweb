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
import * as folderZip from '../functions/api/folder-zip.js';
import * as batch from '../functions/api/batch.js';
import * as trash from '../functions/api/trash.js';
import * as stars from '../functions/api/stars.js';
import * as search from '../functions/api/search.js';
import * as photos from '../functions/api/photos.js';
import * as mpu from '../functions/api/mpu.js';
import * as billing from '../functions/api/billing.js';
import * as yookassa from '../functions/api/yookassa.js';
import * as heleket from '../functions/api/heleket.js';
import * as avatar from '../functions/api/avatar.js';
import * as verifyEmail from '../functions/api/verify-email.js';
import * as deleteAccount from '../functions/api/delete-account.js';
import * as share from '../functions/api/share.js';
import * as collab from '../functions/api/collab.js';
import * as notifications from '../functions/api/notifications.js';
import * as admin from '../functions/api/admin.js';
import * as sessions from '../functions/api/sessions.js';
import * as apikeys from '../functions/api/apikeys.js';
import * as apiV1 from '../functions/api/v1.js';
import * as debug from '../functions/api/debug.js';
import { handleShare } from '../functions/share.js';
import { json, purgeExpiredAccounts } from '../lib/api.js';

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
  '/api/folder-zip': folderZip,
  '/api/batch': batch,
  '/api/trash': trash,
  '/api/stars': stars,
  '/api/search': search,
  '/api/photos': photos,
  '/api/mpu': mpu,
  '/api/billing': billing,
  '/api/yookassa': yookassa,
  '/api/heleket': heleket,
  '/api/avatar': avatar,
  '/api/share': share,
  '/api/collab': collab,
  '/api/notifications': notifications,
  '/api/admin': admin,
  '/api/sessions': sessions,
  '/api/apikeys': apikeys,
  '/api/verify-email': verifyEmail,
  '/api/delete-account': deleteAccount,
  '/api/debug': debug,
};

function dispatch(mod, context) {
  const method = context.request.method;
  const name = `onRequest${method[0]}${method.slice(1).toLowerCase()}`;
  const handler = mod[name];
  if (!handler) return json({ success: false, error: 'method-not-allowed' }, 405);
  return handler(context);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const waitUntil = (promise) => ctx.waitUntil(promise);

    /* public share links: no session required, any host */
    const shared = pathname.match(/^\/share\/([0-9a-f]{32})$/);
    if (shared) return handleShare(request, env, shared[1]);

    if (pathname.startsWith('/api/v1/')) {
      return apiV1.handle({ request, env, waitUntil });
    }

    if (pathname.startsWith('/api/')) {
      const mod = ROUTES[pathname];
      if (mod) return dispatch(mod, { request, env, params: {}, waitUntil });
      return json({ success: false, error: 'not-found' }, 404);
    }

    /* Pages-middleware-compatible context: next() serves static assets. */
    const response = await pageRouter({
      request,
      env,
      next: () => env.ASSETS.fetch(request),
    });

    /* HTML must never be cached: stale pages reference old scripts and
       break after deploys. Versioned assets (?v=) may cache freely. */
    const type = response.headers.get('Content-Type') || '';
    if (type.includes('text/html')) {
      const fresh = new Response(response.body, response);
      fresh.headers.set('Cache-Control', 'no-store');
      return fresh;
    }
    return response;
  },

  /* daily cron: wipe accounts whose 7-day deletion grace has passed */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredAccounts(env));
  },
};
