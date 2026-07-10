import {
  json, getSession, storageReady,
  listNotifications, getNotification, saveNotification, deleteNotification,
  addNotification, getShare, saveShare,
} from '../../lib/api.js';

async function requireSession(request, env) {
  if (!storageReady(env)) {
    return { error: json({ success: false, error: 'not-configured' }, 503) };
  }
  const session = await getSession(request, env);
  if (!session) return { error: json({ success: false, error: 'unauthorized' }, 401) };
  return { session };
}

/* GET /api/notifications — the user's notifications + unread count */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;

  const notifications = await listNotifications(env, session.email);
  return json({
    success: true,
    notifications,
    unread: notifications.filter((n) => !n.read).length,
  });
}

/* POST /api/notifications
   { action: "read" }           — mark everything read
   { action: "dismiss", id }    — delete one
   { action: "grant", id }      — access-request: add the person to the link */
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

  if (action === 'read') {
    const notifications = await listNotifications(env, session.email);
    for (const notif of notifications) {
      if (!notif.read) {
        notif.read = true;
        await saveNotification(env, session.email, notif);
      }
    }
    return json({ success: true });
  }

  const id = String(body?.id || '');

  if (action === 'dismiss') {
    await deleteNotification(env, session.email, id);
    return json({ success: true });
  }

  if (action === 'grant') {
    const notif = await getNotification(env, session.email, id);
    if (!notif || notif.type !== 'access-request') {
      return json({ success: false, error: 'not-found' }, 404);
    }
    const share = await getShare(env, notif.token);
    if (!share || share.email !== session.email || share.access !== 'restricted') {
      /* link was deleted or changed: just drop the request */
      await deleteNotification(env, session.email, id);
      return json({ success: false, error: 'link-gone' }, 410);
    }
    const allowed = share.allowed || [];
    if (!allowed.includes(notif.from)) allowed.push(notif.from);
    share.allowed = allowed.sort();
    await saveShare(env, share);
    await deleteNotification(env, session.email, id);
    /* tell the requester */
    await addNotification(env, notif.from, {
      type: 'access-granted',
      from: session.email,
      path: share.path,
      token: share.token,
    });
    return json({ success: true });
  }

  return json({ success: false, error: 'bad-request' }, 400);
}
