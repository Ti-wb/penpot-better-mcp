import type { DesignAdapter, ExportOptions, SaveMode } from './adapter.js';
import { DocumentWorker } from './document-worker.js';
import { parseDocument } from './document.js';
import { Diagnostics, type Operation } from './diagnostics.js';
import { GatewayError } from './errors.js';
import { WorkerPool } from './worker-pool.js';
import type { ReadOptions, SavedDocumentReader } from './backend-reader.js';

export type GatewayApi = Pick<DocumentWorker, 'open' | 'openPage' | 'inspect' | 'execute' | 'flush' | 'export' | 'documentation' | 'closeDocument' | 'shutdown'> & {
  read?: (url: string, options?: ReadOptions) => ReturnType<SavedDocumentReader['read']>;
};
interface Entry { fileId: string; worker: DocumentWorker; pending: number; disposing?: Promise<void>; }

/** One queue/adapter per file, sharing a bounded warm-browser pool. */
export class Gateway implements GatewayApi {
  private readonly workers = new Map<string, Entry>();
  private readonly handles = new Map<string, Entry>();
  private readonly adapters = new WeakSet<DesignAdapter>();
  private readonly pool: WorkerPool;
  private docs?: DocumentWorker;
  private pending = 0;
  private opening = 0;
  private stopping = false;
  private drained?: () => void;
  private closing?: Promise<void>;
  constructor(private readonly createAdapter: (fileId?: string) => DesignAdapter, private readonly baseUrl: string,
    private readonly idleMs = 600_000, private readonly diagnostics = new Diagnostics(), maxWorkers = 2,
    private readonly reader?: SavedDocumentReader) {
    this.pool = new WorkerPool(maxWorkers, diagnostics);
  }
  private adapter(fileId?: string) {
    const adapter = this.createAdapter(fileId);
    if (this.adapters.has(adapter)) throw new Error('The adapter factory must return a distinct adapter for every worker');
    this.adapters.add(adapter); return adapter;
  }
  private create(fileId: string): Entry {
    const adapter = this.adapter(fileId);
    const entry = { fileId, pending: 0, worker: new DocumentWorker(adapter, this.baseUrl, this.idleMs, this.diagnostics,
      this.pool.register(() => adapter.close(), () => adapter.hasResources)) };
    this.workers.set(fileId, entry); return entry;
  }
  private reject<T>(operation: Operation, error: unknown): Promise<T> {
    return this.diagnostics.run(operation, performance.now(), this.pending, () => Promise.reject(error));
  }
  private async admit<T>(operation: Operation, task: () => Promise<T>): Promise<T> {
    if (this.stopping) return this.reject(operation, new GatewayError('SHUTTING_DOWN', 'The gateway is shutting down.'));
    if (this.pending >= 128) { this.diagnostics.busy(operation, this.pending); throw new GatewayError('BUSY', 'The gateway queue is full; retry later.'); }
    this.pending++;
    try { return await task(); }
    finally { this.pending--; if (!this.pending) { this.drained?.(); this.drained = undefined; } }
  }
  private dispatch<T>(operation: Operation, getEntry: () => Entry, task: (entry: Entry) => Promise<T>): Promise<T> {
    return this.admit(operation, async () => {
      let entry: Entry;
      // An open waits for empty-worker disposal before reusing the file key.
      try { entry = getEntry(); while (entry.disposing) { await entry.disposing; entry = getEntry(); } }
      catch (error) { return await this.reject(operation, error); }
      entry.pending++;
      try { return await task(entry); }
      finally { entry.pending--; this.disposeEmpty(entry); }
    });
  }
  private disposeEmpty(entry: Entry) {
    if (entry.pending || entry.worker.documentCount || entry.disposing || this.stopping) return;
    entry.disposing = entry.worker.shutdown().then(() => {
      if (this.workers.get(entry.fileId) === entry) this.workers.delete(entry.fileId);
    }).catch(() => {
      // Keep the adapter if it refuses to confirm saving. No forced eviction.
    }).finally(() => { entry.disposing = undefined; });
  }
  private target(handle: string) {
    const entry = this.handles.get(handle);
    if (!entry) throw new GatewayError('UNKNOWN_DOCUMENT', 'Open the document again to obtain a valid handle.');
    return entry;
  }
  private async newHandle<T extends {documentHandle?: string}>(operation: Operation, task: () => Promise<T>) {
    if (this.handles.size + this.opening >= 128) return this.reject<T>(operation, new GatewayError('DOCUMENT_LIMIT', 'Close unused document handles first.'));
    this.opening++;
    try { return await task(); } finally { this.opening--; }
  }
  open(url: string) {
    let target;
    try { target = parseDocument(url, this.baseUrl); }
    catch (error) { return this.reject<Awaited<ReturnType<DocumentWorker['open']>>>('open_document', error); }
    return this.newHandle('open_document', () => this.dispatch('open_document', () => this.workers.get(target.fileId) ?? this.create(target.fileId), async entry => {
      const result = await entry.worker.open(target.url);
      if (result.documentHandle) this.handles.set(result.documentHandle, entry);
      return result;
    }));
  }
  read(url: string, options: ReadOptions = {}) {
    let target;
    try {
      target = parseDocument(url, this.baseUrl);
      if (!this.reader) throw new GatewayError('READ_UNAVAILABLE', 'The backend reader is not configured.');
    } catch (error) { return this.reject<Awaited<ReturnType<SavedDocumentReader['read']>>>('read_document', error); }
    return this.dispatch('read_document', () => this.workers.get(target.fileId) ?? this.create(target.fileId),
      entry => entry.worker.readSaved(() => this.reader!.read(target, options)));
  }
  openPage(handle: string, pageId: string) {
    return this.newHandle('open_page', () => this.dispatch('open_page', () => this.target(handle), async entry => {
      const result = await entry.worker.openPage(handle, pageId);
      if (result.documentHandle) this.handles.set(result.documentHandle, entry);
      return result;
    }));
  }
  inspect(handle: string) { return this.dispatch('inspect_document', () => this.target(handle), e => e.worker.inspect(handle)); }
  execute(handle: string, code: string, save: SaveMode = 'wait') { return this.dispatch('execute_code', () => this.target(handle), e => e.worker.execute(handle, code, save)); }
  flush(handle: string) { return this.dispatch('flush_document', () => this.target(handle), e => e.worker.flush(handle)); }
  export(handle: string, args: ExportOptions) { return this.dispatch('export_shape', () => this.target(handle), e => e.worker.export(handle, args)); }
  closeDocument(handle: string) {
    return this.dispatch('close_document', () => this.target(handle), async entry => {
      const result = await entry.worker.closeDocument(handle); this.handles.delete(handle);
      return { ...result, remainingFileHandles: result.remainingHandles, remainingHandles: this.handles.size };
    });
  }
  documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>) {
    return this.admit(name, () => {
      this.docs ??= new DocumentWorker(this.adapter(), this.baseUrl, this.idleMs, this.diagnostics);
      return this.docs.documentation(name, args);
    });
  }
  shutdown(): Promise<void> {
    this.closing ??= this.shutdownWorkers().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private async shutdownWorkers() {
    this.stopping = true;
    if (this.pending) await new Promise<void>(resolve => { this.drained = resolve; });
    const entries = [...this.workers.values()];
    const results = await Promise.allSettled([
      ...entries.map(async entry => { await entry.disposing; await entry.worker.shutdown(); }),
      ...(this.docs ? [this.docs.shutdown()] : []),
    ]);
    entries.forEach((entry, index) => {
      if (results[index].status !== 'fulfilled') return;
      for (const [handle, owner] of this.handles) if (owner === entry) this.handles.delete(handle);
      this.workers.delete(entry.fileId);
    });
    if (this.docs && results[entries.length].status === 'fulfilled') this.docs = undefined;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') { this.stopping = false; throw failure.reason; }
    this.handles.clear(); this.workers.clear();
    this.reader?.clear();
  }
}
