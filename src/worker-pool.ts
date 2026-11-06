import { randomUUID } from 'node:crypto';
import { Diagnostics, type Operation } from './diagnostics.js';
import { GatewayError } from './errors.js';

export interface WorkerScheduler {
  readonly id: string;
  run<T>(operation: Operation, task: () => Promise<T>): Promise<T>;
  close(task: () => Promise<void>): Promise<void>;
  closed(): void;
}
interface Slot { id: string; busy: boolean; used: number; close: () => Promise<void>; closing?: Promise<void>; }
interface Waiter { slot: Slot; resolve: () => void; reject: (error: unknown) => void; failed: Set<Slot>; }

/** Bounds resident browsers, not logical handles. Busy workers are never evicted. */
export class WorkerPool {
  private readonly resident = new Set<Slot>();
  private readonly waiters: Waiter[] = [];
  private pumping = false;
  private repump = false;
  constructor(private readonly limit: number, private readonly diagnostics: Diagnostics) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error('Worker limit must be an integer from 1 to 16');
  }
  get residentCount() { return this.resident.size; }
  register(close: () => Promise<void>): WorkerScheduler {
    const slot: Slot = { id: randomUUID(), busy: false, used: 0, close };
    return {
      id: slot.id,
      run: async <T>(operation: Operation, task: () => Promise<T>) => {
        // Closing an evicted handle must not evict another file just to reserve
        // a browser slot; close/flushPending never launch a browser.
        if (operation === 'close_document') {
          await slot.closing;
          if (!this.resident.has(slot)) return task();
        }
        await this.diagnostics.span('workerWaitMs', () => this.acquire(slot));
        try { return await task(); }
        finally { slot.busy = false; slot.used = performance.now(); this.pump(); }
      },
      close: task => this.retire(slot, task),
      closed: () => { this.resident.delete(slot); this.pump(); },
    };
  }
  private acquire(slot: Slot): Promise<void> {
    if (this.resident.has(slot) && !slot.closing && !slot.busy) {
      slot.busy = true; return Promise.resolve();
    }
    return new Promise((resolve, reject) => { this.waiters.push({slot, resolve, reject, failed: new Set()}); this.pump(); });
  }
  private retire(slot: Slot, close: () => Promise<void>): Promise<void> {
    if (slot.closing) return slot.closing;
    if (slot.busy) return Promise.reject(new Error('Cannot reclaim a busy worker'));
    slot.closing = Promise.resolve().then(close).then(() => { this.resident.delete(slot); }).finally(() => {
      slot.closing = undefined; this.pump();
    });
    return slot.closing;
  }
  private pump() {
    if (this.pumping) { this.repump = true; return; }
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      if (this.repump) { this.repump = false; this.pump(); }
    });
  }
  private async drain() {
    while (this.waiters.length) {
      const waiter = this.waiters[0], slot = waiter.slot;
      if (slot.closing) { await slot.closing.catch(() => {}); continue; }
      if (slot.busy) return;
      if (this.resident.has(slot) || this.resident.size < this.limit) {
        this.waiters.shift(); this.resident.add(slot); slot.busy = true; waiter.resolve(); continue;
      }
      const victim = [...this.resident].filter(s => !s.busy && !s.closing && !waiter.failed.has(s)).sort((a,b) => a.used-b.used)[0];
      if (victim) {
        try {
          await this.retire(victim, () => this.diagnostics.run('worker_eviction', performance.now(), 0, victim.close, victim.id));
        } catch { waiter.failed.add(victim); }
        continue;
      }
      if ([...this.resident].some(s => s.busy || s.closing)) return;
      this.waiters.shift();
      waiter.reject(new GatewayError('WORKER_CAPACITY', 'Other files have unconfirmed saves and cannot be reclaimed. Flush or resolve those files before opening another one.'));
    }
  }
}
