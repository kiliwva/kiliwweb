import { json, parsePath, scopedPath } from '../../lib/api.js';
import { requireSession, requireScope } from './files/index.js';
import { collectZipEntries, zipResponse } from '../../lib/zip.js';

/* GET /api/folder-zip?p=a/b[&scope=..] — download a folder as a .zip.
   p may be empty inside a shared-folder scope (= the whole grant). */
export async function onRequestGet({ request, env }) {
  const { session, error } = await requireSession(request, env);
  if (error) return error;
  const { scope, error: scopeError } = await requireScope(request, env, session);
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const p = parsePath(url.searchParams.get('p') || '');
  if (p === null || (!p && !scope.base)) {
    return json({ success: false, error: 'bad-path' }, 400);
  }

  const full = scopedPath(scope, p);
  const prefix = `u/${scope.email}/${full}/`;
  const rootName = full.split('/').pop();

  const { entries, error: zipError } = await collectZipEntries(env.KILIW_FILES, prefix, rootName);
  if (zipError) return json({ success: false, error: zipError }, 413);
  if (!entries.length) return json({ success: false, error: 'not-found' }, 404);

  return zipResponse(entries, `${rootName}.zip`);
}
