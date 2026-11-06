import { randomUUID } from 'node:crypto';
import { Diagnostics, type Operation } from './diagnostics.js';
import { GatewayError } from './errors.js';

export interface WorkerScheduler {
  readonly id: string;
  run<T>(operation: Operation, task: () => Promise<T>): Promise<T>;
  close(task: () => Promise<void>): Promise<void>;
  closed(): void;
}
interface Slot { id: string; busy: boolean; used: number; close: () => Promise<void>; hasResources: () => boolean; closing?: Promise<void>; }
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
  register(close: () => Promise<void>, hasResources: () => boolean): WorkerScheduler {
    const slot: Slot = { id: randomUUID(), busy: false, used: 0, close, hasResources };
    return {
      id: slot.id,
      run: async <T>(operation: Operation, task: () => Promise<T>) => {
        // Saved reads and closing evicted handles need no new browser slot.
        // Resident workers still acquire their slot to exclude concurrent eviction.
        if (operation === 'close_document' || operation === 'read_document') {
          await slot.closing;
          if (!this.resident.has(slot)) return task();
        }
        await this.diagnostics.span('workerWaitMs', () => this.acquire(slot));
        try { return await task(); }
        finally {
          slot.busy = false; slot.used = performance.now();
          if (!slot.hasResources()) this.resident.delete(slot);
          this.pump();
        }
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
    slot.closing = Promise.resolve().then(close).then(() => { this.resident.delete(slot); }).catch(error => {
      // Every waiting caller observed this attempt. Mark failure before pumping
      // again, avoiding repeated save waits for the same unavailable resource.
      for (const waiter of this.waiters) waiter.failed.add(slot);
      throw error;
    }).finally(() => {
      // A lost browser can be fully retired while close still reports unknown
      // saving. Keep that uncertainty in the adapter, not as occupied capacity.
      if (!slot.hasResources()) this.resident.delete(slot);
      slot.closing = undefined; this.pump();
    });
    return slot.closing;
  }
  private pump() {
    if (this.pumping) { this.repump = true; return; }
    this.pumping = true;
    try { this.drain(); } finally {
      this.pumping = false;
      if (this.repump) { this.repump = false; this.pump(); }
    }
  }
  private drain() {
    // Reclamation runs outside this pump: one slow save must not hold every
    // other file behind it when another slot becomes available.
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i], slot = waiter.slot;
      if (slot.closing || slot.busy) { i++; continue; }
      if (this.resident.has(slot) || this.resident.size < this.limit) {
        this.waiters.splice(i, 1); this.resident.add(slot); slot.busy = true; waiter.resolve();
      } else { i++; }
    }
    const waiting = this.waiters.filter(w => !w.slot.busy && (!this.resident.has(w.slot) || w.slot.closing));
    let needed = waiting.length - [...this.resident].filter(s => s.closing).length;
    const candidates = [...this.resident].filter(s => !s.busy && !s.closing).sort((a,b) => a.used-b.used);
    for (const victim of candidates) {
      if (needed <= 0) break;
      if (!waiting.some(w => !w.failed.has(victim))) continue;
      needed--;
      void this.retire(victim, () => this.diagnostics.run('worker_eviction', performance.now(), 0, victim.close, victim.id)).catch(() => {});
    }
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i];
      if (waiter.slot.busy || waiter.slot.closing || this.resident.has(waiter.slot) || this.resident.size < this.limit
        || [...this.resident].some(s => s.busy || s.closing || !waiter.failed.has(s))) {
        i++; continue;
      }
      this.waiters.splice(i, 1);
      waiter.reject(new GatewayError('WORKER_CAPACITY', 'Other files have unconfirmed saves and cannot be reclaimed. Flush or resolve those files before opening another one.'));
    }
  }
}
