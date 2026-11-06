import { randomUUID } from 'node:crypto';
import type { DesignAdapter, ExportOptions, SaveMode } from './adapter.js';
import { parseDocument, targetPage, type DocumentTarget } from './document.js';
import { GatewayError } from './errors.js';
import { Diagnostics, type Operation } from './diagnostics.js';
import type { WorkerScheduler } from './worker-pool.js';

/** A single file's serial execution and persistence boundary. */
export class DocumentWorker {
  private readonly documents = new Map<string, DocumentTarget>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idle?: NodeJS.Timeout;
  private stopping = false;
  constructor(private readonly adapter: DesignAdapter, private readonly baseUrl: string, private readonly idleMs = 600_000, private readonly diagnostics = new Diagnostics(), private readonly scheduler?: WorkerScheduler) {}
  get documentCount() { return this.documents.size; }

  private async closeAdapter() { await this.adapter.close(); this.scheduler?.closed(); }

  private serial<T>(operation: Operation, task: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new GatewayError('SHUTTING_DOWN', 'The worker is shutting down.'));
    if (this.pending >= 32) { this.diagnostics.busy(operation, this.pending); return Promise.reject(new GatewayError('BUSY', 'The worker queue is full; retry later.')); }
    const queuedAt = performance.now(), queuedAhead = this.pending;
    clearTimeout(this.idle); this.pending++;
    const result = this.queue.then(async () => {
      try { return await this.diagnostics.run(operation, queuedAt, queuedAhead, () => this.scheduler ? this.scheduler.run(operation, task) : task(), this.scheduler?.id); }
      finally {
        this.pending--;
        this.scheduleIdle();
      }
    });
    // Do not retain the last potentially large response in every idle worker.
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private scheduleIdle() {
    if (this.pending || this.stopping) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = undefined;
      this.queue = this.queue.then(() => this.diagnostics.run('idle_reclaim', performance.now(), 0,
        () => this.scheduler ? this.scheduler.close(() => this.closeAdapter()) : this.closeAdapter(), this.scheduler?.id))
        .catch(() => {
          // A live editor with unconfirmed saves stays open. Recheck next idle
          // interval instead of leaving it resident forever after one failure.
          this.scheduleIdle();
        });
    }, this.idleMs).unref();
  }
  private target(handle: string) { const doc = this.documents.get(handle); if (!doc) throw new GatewayError('UNKNOWN_DOCUMENT', 'Open the document again to obtain a valid handle.'); return doc; }
  open(url: string) {
    return this.serial('open_document', async () => {
      if (this.documents.size >= 128) throw new GatewayError('DOCUMENT_LIMIT', 'Close unused document handles first.');
      const target = parseDocument(url, this.baseUrl);
      try {
        const result = await this.adapter.open(target);
        if (result.isError) { this.adapter.release(target); return { result }; }
        const documentHandle = randomUUID(); this.documents.set(documentHandle, target);
        return { documentHandle, fileId: target.fileId, pageId: target.pageId, result };
      } catch (error) { this.adapter.release(target); throw error; }
    });
  }
  inspect(handle: string) { return this.serial('inspect_document', () => this.adapter.open(this.target(handle))); }
  openPage(handle: string, pageId: string) {
    return this.serial('open_page', async () => {
      if (this.documents.size >= 128) throw new GatewayError('DOCUMENT_LIMIT', 'Close unused document handles first.');
      const source = this.target(handle); const target = targetPage(source, pageId);
      try {
        const result = await this.adapter.openPage(source, target);
        if (result.isError) { this.adapter.release(target); return { result }; }
        const documentHandle = randomUUID(); this.documents.set(documentHandle, target);
        return { documentHandle, fileId: target.fileId, pageId: target.pageId, result };
      } catch (error) { this.adapter.release(target); throw error; }
    });
  }
  execute(handle: string, code: string, save: SaveMode = 'wait') { return this.serial('execute_code', () => this.adapter.execute(this.target(handle), code, save)); }
  flush(handle: string) { return this.serial('flush_document', () => this.adapter.flush(this.target(handle))); }
  export(handle: string, args: ExportOptions) { return this.serial('export_shape', () => this.adapter.exportShape(this.target(handle), args)); }
  documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>) { return this.serial(name, () => this.adapter.documentation(name, args)); }
  closeDocument(handle: string) {
    return this.serial('close_document', async () => {
      const target = this.target(handle), browserReleased = this.documents.size === 1;
      if (browserReleased) await this.closeAdapter();
      else await this.adapter.flushPending();
      this.adapter.release(target); this.documents.delete(handle);
      return { closed: true, browserReleased, remainingHandles: this.documents.size };
    });
  }
  async shutdown() {
    this.stopping = true;
    clearTimeout(this.idle); await this.queue; clearTimeout(this.idle);
    try {
      await this.diagnostics.run('shutdown', performance.now(), 0,
        () => this.scheduler ? this.scheduler.close(() => this.closeAdapter()) : this.closeAdapter(), this.scheduler?.id);
    } catch (error) { this.stopping = false; this.scheduleIdle(); throw error; }
    for (const target of this.documents.values()) this.adapter.release(target);
    this.documents.clear();
  }
}
