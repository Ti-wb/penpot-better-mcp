import { GatewayError } from './errors.js';

export interface DocumentTarget { url: string; fileId: string; pageId?: string; }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function parseDocument(input: string, baseUrl: string): DocumentTarget {
  let url: URL;
  try { url = new URL(input); } catch { throw new GatewayError('INVALID_URL', 'Expected an absolute Penpot file URL.'); }
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password) throw new GatewayError('SITE_NOT_ALLOWED', 'The URL must belong to the configured Penpot site.');
  const [hashPath, hashQuery = ''] = url.hash.slice(1).split('?');
  const params = new URLSearchParams(url.search);
  new URLSearchParams(hashQuery).forEach((v, k) => {
    if (params.has(k) && params.get(k) !== v) throw new GatewayError('AMBIGUOUS_URL', 'URL query and fragment disagree.');
    params.set(k, v);
  });
  if (params.has('share-id') || params.get('screen') === 'view' || params.get('screen') === 'viewer' || hashPath.startsWith('/view')) throw new GatewayError('UNSUPPORTED_LINK', 'Share/viewer links require a read-only adapter; use an editor file URL in this release.');
  const legacy = hashPath.match(/^\/workspace\/([^/]+)\/([^/]+)\/?$/);
  const fileId = params.get('file-id') || legacy?.[2];
  const teamId = params.get('team-id') || legacy?.[1];
  const pageId = params.get('page-id') || undefined;
  if (!fileId || !uuid.test(fileId) || !teamId || !uuid.test(teamId) || (pageId && !uuid.test(pageId))) throw new GatewayError('INVALID_DOCUMENT', 'Expected a workspace URL with valid team-id, file-id and optional page-id.');
  const canonical = new URL(baseUrl);
  const query = new URLSearchParams();
  if (pageId) query.set('page-id', pageId);
  query.set('team-id', teamId); query.set('file-id', fileId);
  // Both tested releases use the hash router. Accept alternate link syntax,
  // but navigate using the deployed editor route rather than passing it on.
  canonical.hash = '/workspace?' + query;
  return { url: canonical.href, fileId, pageId };
}
