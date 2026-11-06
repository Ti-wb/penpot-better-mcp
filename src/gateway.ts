import { randomUUID } from 'node:crypto';
import type { DesignAdapter } from './adapter.js';
import { parseDocument, type DocumentTarget } from './document.js';
import { GatewayError } from './errors.js';

export class Gateway {
  private readonly documents = new Map<string, DocumentTarget>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idle?: NodeJS.Timeout;
  constructor(private readonly adapter: DesignAdapter, private readonly baseUrl: string, private readonly idleMs = 600_000) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= 32) return Promise.reject(new GatewayError('BUSY', 'The worker queue is full; retry later.'));
    clearTimeout(this.idle); this.pending++;
    const result = this.queue.then(task);
    this.queue = result.catch(() => {}).finally(() => {
      this.pending--;
      if (!this.pending) this.idle = setTimeout(() => {
        this.idle = undefined;
        this.queue = this.queue.then(() => this.adapter.close()).catch(() => {});
      }, this.idleMs).unref();
    });
    return result;
  }
  private target(handle: string) { const doc = this.documents.get(handle); if (!doc) throw new GatewayError('UNKNOWN_DOCUMENT', 'Open the document again to obtain a valid handle.'); return doc; }
  open(url: string) {
    return this.serial(async () => {
      if (this.documents.size >= 128) throw new GatewayError('DOCUMENT_LIMIT', 'Close unused document handles first.');
      const target = parseDocument(url, this.baseUrl);
      const result = await this.adapter.open(target);
      if (result.isError) return { result };
      const documentHandle = randomUUID(); this.documents.set(documentHandle, target);
      return { documentHandle, fileId: target.fileId, pageId: target.pageId, result };
    });
  }
  inspect(handle: string) { return this.serial(() => this.adapter.open(this.target(handle))); }
  execute(handle: string, code: string) { return this.serial(() => this.adapter.execute(this.target(handle), code)); }
  export(handle: string, args: {shapeId: string; format: 'png' | 'svg'}) { return this.serial(() => this.adapter.exportShape(this.target(handle), args)); }
  documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>) { return this.serial(() => this.adapter.documentation(name, args)); }
  closeDocument(handle: string) { return this.serial(async () => { this.target(handle); await this.adapter.close(); this.documents.delete(handle); return { closed: true }; }); }
  async shutdown() { clearTimeout(this.idle); await this.queue; clearTimeout(this.idle); await this.adapter.close(); this.documents.clear(); }
}
