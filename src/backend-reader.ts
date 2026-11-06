import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { DocumentTarget } from './document.js';
import { Diagnostics } from './diagnostics.js';
import { GatewayError } from './errors.js';

export const readOptionsSchema = z.object({
  view: z.enum(['summary', 'shapes']).default('summary'),
  pageId: z.string().uuid().transform(v => v.toLowerCase()).optional(),
  shapeIds: z.array(z.string().uuid().transform(v => v.toLowerCase())).min(1).max(200).optional(),
  fields: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(64)).min(1).max(32).optional(),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ReadOptions = z.input<typeof readOptionsSchema>;
export interface SavedDocumentReader { read(target: DocumentTarget, options?: ReadOptions): Promise<CallToolResult>; clear(): void; }
interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean; expires: number; partitionKey?: string; }
type ObjectData = Record<string, unknown>;
interface PageData { id: string; name: string; objects: Record<string, ObjectData>; }
interface FileData { id: string; name: string; revn: number; vern: number; data: { pages: string[]; pagesIndex: Record<string, PageData> }; }
interface CachedFile { raw: Buffer; etag: string; snapshotId: string; }
const rootId = '00000000-0000-0000-0000-000000000000';
const defaultFields = ['id', 'name', 'type', 'parentId', 'frameId', 'x', 'y', 'width', 'height', 'rotation', 'hidden', 'shapes'];
const maxResponseBytes = 32 * 1024 * 1024;
const maxOutputBytes = 4 * 1024 * 1024;

function object(value: unknown): value is ObjectData { return !!value && typeof value === 'object' && !Array.isArray(value); }
function incompatible(): never { throw new GatewayError('BACKEND_INCOMPATIBLE', 'Expected a resolved Penpot JSON file. Check the deployed Penpot version; use browser tools for unsupported files.'); }
function parseFile(raw: Buffer, fileId: string): FileData {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { incompatible(); }
  if (!object(value) || value.id !== fileId || typeof value.name !== 'string' || !Number.isSafeInteger(value.revn)
    || !Number.isSafeInteger(value.vern) || !object(value.data) || !Array.isArray(value.data.pages) || !object(value.data.pagesIndex)) incompatible();
  for (const id of value.data.pages) {
    const page = typeof id === 'string' && value.data.pagesIndex[id];
    if (!object(page) || page.id !== id || typeof page.name !== 'string' || !object(page.objects)) incompatible();
  }
  return value as unknown as FileData;
}

/** HTTP only. Cache serialized bytes, never browsers or unbounded decoded design trees. */
export class BackendReader implements SavedDocumentReader {
  private readonly cache = new Map<string, CachedFile>();
  private cacheBytes = 0;
  private authFingerprint?: string;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly config: Pick<Config, 'baseUrl' | 'storageState' | 'timeoutMs'>,
    private readonly diagnostics = new Diagnostics(), private readonly fetcher: typeof fetch = fetch) {}

  clear() { this.cache.clear(); this.cacheBytes = 0; this.authFingerprint = undefined; }
  private async bounded<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  private remove(id: string) { const entry = this.cache.get(id); if (entry) this.cacheBytes -= entry.raw.length; this.cache.delete(id); }
  private remember(id: string, value: CachedFile) {
    this.remove(id);
    // Serialized cache budget: 32 MiB total, at most four files. Decoding is transient.
    while (this.cache.size && (this.cache.size >= 4 || this.cacheBytes + value.raw.length > maxResponseBytes)) this.remove(this.cache.keys().next().value!);
    this.cache.set(id, value); this.cacheBytes += value.raw.length;
  }
  private async cookieHeader(url: URL): Promise<string> {
    let cookies: Cookie[];
    try {
      const info = await stat(this.config.storageState);
      if (!info.isFile()) throw new Error();
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new GatewayError('INSECURE_SESSION', 'Set the session file permissions to 0600.');
      const state = JSON.parse(await readFile(this.config.storageState, 'utf8'));
      if (!Array.isArray(state.cookies)) throw new Error();
      cookies = state.cookies;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('AUTH_REQUIRED', 'Create or renew the local Penpot login session first.');
    }
    const now = Date.now() / 1000;
    const matches = cookies.filter(c => c && typeof c.domain === 'string' && typeof c.path === 'string'
      && typeof c.name === 'string' && typeof c.value === 'string' && !c.partitionKey
      && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) && /^[\x21-\x3A\x3C-\x7E]*$/.test(c.value)
      && (c.domain.startsWith('.') ? url.hostname === c.domain.slice(1) || url.hostname.endsWith(c.domain) : url.hostname === c.domain)
      && (!c.secure || url.protocol === 'https:') && (c.expires === -1 || c.expires > now)
      && c.path.startsWith('/') && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')));
    if (!matches.length) throw new GatewayError('AUTH_REQUIRED', 'No valid login cookies for the configured Penpot site. Renew the local session.');
    return matches.sort((a,b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
  private async download(response: Response): Promise<Buffer> {
    if (Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body?.cancel();
      throw new GatewayError('READ_TOO_LARGE', 'The saved file exceeds the 32 MiB backend read limit. Use browser tools or split the file.');
    }
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxResponseBytes) throw new GatewayError('READ_TOO_LARGE', 'The saved file exceeds the 32 MiB backend read limit. Use browser tools or split the file.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks, bytes);
  }
  private async savedFile(fileId: string): Promise<{file: FileData; snapshotId: string}> {
    const url = new URL('/api/rpc/command/get-file', this.config.baseUrl);
    let fingerprint: string | undefined;
    try {
      const cookie = await this.cookieHeader(url);
      fingerprint = createHash('sha256').update(cookie).digest('hex');
      if (fingerprint !== this.authFingerprint) { this.clear(); this.authFingerprint = fingerprint; }
      const cached = this.cache.get(fileId);
      this.diagnostics.count('backendCalls');
      const response = await this.fetcher(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie,
          ...(cached ? {'If-None-Match': cached.etag} : {}) },
        // Omitting features asks Penpot to resolve pointer/objects maps on the server.
        body: JSON.stringify({id: fileId}),
      });
      let entry: CachedFile;
      if (response.status === 304 && cached) {
        await response.body?.cancel();
        this.diagnostics.count('cacheRevalidations'); entry = cached;
      } else {
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 401) throw new GatewayError('AUTH_REQUIRED', 'The Penpot session has expired. Renew the local login.');
          if (response.status === 403 || response.status === 404) throw new GatewayError('DOCUMENT_UNAVAILABLE', 'The file is unavailable or this account lacks read permission.');
          if (response.status === 429) throw new GatewayError('BACKEND_BUSY', 'Penpot is rate limiting reads. Reduce concurrency and retry later.');
          throw new GatewayError('BACKEND_READ_FAILED', 'Penpot rejected the saved-file read. Check server compatibility and availability.');
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
          await response.body?.cancel(); incompatible();
        }
        const raw = await this.download(response);
        entry = {raw, etag: response.headers.get('etag') || '', snapshotId: createHash('sha256').update(raw).digest('hex')};
      }
      const file = parseFile(entry.raw, fileId);
      // Every hit is authorized/revalidated by Penpot. Never serve stale data on error.
      if (fingerprint === this.authFingerprint && entry.etag && entry.etag.length <= 256 && !/[\r\n]/.test(entry.etag)) this.remember(fileId, entry);
      else this.remove(fileId);
      return {file, snapshotId: entry.snapshotId};
    } catch (error) {
      this.remove(fileId);
      if (error instanceof GatewayError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new GatewayError('READ_TIMEOUT', 'The backend read timed out; retrying this read is safe.');
      throw new GatewayError('BACKEND_UNAVAILABLE', 'Cannot read from the configured Penpot backend. Check connectivity and the local session.');
    }
  }
  async read(target: DocumentTarget, input: ReadOptions = {}): Promise<CallToolResult> {
    const parsed = readOptionsSchema.safeParse(input);
    if (!parsed.success) throw new GatewayError('INVALID_READ', 'Invalid read options. Check page/shape IDs, fields, pagination and snapshotId.');
    const options = parsed.data;
    return this.bounded(() => this.readSelected(target, options));
  }
  private async readSelected(target: DocumentTarget, options: z.output<typeof readOptionsSchema>): Promise<CallToolResult> {
    const {file, snapshotId} = await this.diagnostics.span('backendMs', () => this.savedFile(target.fileId));
    if (options.snapshotId && options.snapshotId !== snapshotId) throw new GatewayError('SNAPSHOT_CHANGED', 'The saved file changed between reads. Restart pagination with the new snapshot.');
    const pageId = options.pageId ?? target.pageId ?? file.data.pages[0];
    const selected = file.data.pagesIndex[pageId];
    if ((options.pageId || target.pageId || options.view === 'shapes') && (!selected || !file.data.pages.includes(pageId))) throw new GatewayError('INVALID_PAGE', 'The requested page is not in this file.');
    const pages = file.data.pages.map(id => {
      const page = file.data.pagesIndex[id];
      return {id, name: page.name, shapeCount: Object.keys(page.objects).length - (Object.hasOwn(page.objects, rootId) ? 1 : 0)};
    });
    const output: ObjectData = {source: 'backend', consistency: 'saved', snapshotId,
      file: {id: file.id, name: file.name, revision: file.revn, version: file.vern}, pages};
    if (options.view === 'shapes') {
      // Stable ID order plus snapshotId lets callers detect edits between batches.
      const ids = (options.shapeIds ? [...new Set(options.shapeIds)] : Object.keys(selected.objects)).filter(id => id !== rootId && Object.hasOwn(selected.objects, id)).sort();
      const fields = [...new Set(['id', ...(options.fields ?? defaultFields)])];
      let bytes = 0;
      const shapes = ids.slice(options.offset, options.offset + options.limit).map(id => {
        const shape = selected.objects[id];
        if (!object(shape) || shape.id !== id) incompatible();
        const value = Object.fromEntries(fields.filter(key => Object.hasOwn(shape, key)).map(key => [key, shape[key]]));
        bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > maxOutputBytes) throw new GatewayError('READ_OUTPUT_TOO_LARGE', 'Read fewer shapes or select fewer fields (4 MiB output limit).');
        return value;
      });
      Object.assign(output, {pageId, total: ids.length, offset: options.offset,
        nextOffset: options.offset + shapes.length < ids.length ? options.offset + shapes.length : null, shapes,
        ...(options.shapeIds ? {missingShapeIds: options.shapeIds.filter(id => !Object.hasOwn(selected.objects, id))} : {})});
    }
    const text = JSON.stringify(output);
    if (Buffer.byteLength(text) > maxOutputBytes) throw new GatewayError('READ_OUTPUT_TOO_LARGE', 'Read fewer shapes or select fewer fields (4 MiB output limit).');
    return {content: [{type: 'text', text}]};
  }
}
