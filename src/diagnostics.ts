import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { GatewayError } from './errors.js';

export type Operation = 'open_document' | 'open_page' | 'inspect_document' | 'execute_code' | 'flush_document' | 'export_shape' | 'close_document' | 'high_level_overview' | 'penpot_api_info' | 'idle_reclaim' | 'shutdown';
type Phase = 'activationMs' | 'upstreamMs' | 'saveMs' | 'cleanupMs';
type Lifecycle = 'browser_started' | 'browser_closed' | 'editor_ready' | 'editor_lost' | 'page_selected';
type RecordSink = (record: Record<string, unknown>) => void;
interface Timing { activationMs: number; upstreamMs: number; saveMs: number; cleanupMs: number; upstreamCalls: number; connectionProbeRetries: number; }
interface Scope { requestId: string; operation: Operation; timing: Timing; phase?: Phase; live: { value: boolean }; }

function toolResult(value: unknown): { isError?: unknown; content?: unknown } | undefined {
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  return (object.result && typeof object.result === 'object' ? object.result : object) as ReturnType<typeof toolResult>;
}
function contentBytes(result: ReturnType<typeof toolResult>): number {
  if (!Array.isArray(result?.content)) return 0;
  return result.content.reduce((total, item) => total + (typeof item?.text === 'string' ? Buffer.byteLength(item.text) : typeof item?.data === 'string' ? Buffer.byteLength(item.data) : 0), 0);
}
function resultError(result: ReturnType<typeof toolResult>): string | undefined {
  if (!result?.isError) return;
  const first = Array.isArray(result.content) ? result.content.find(item => item?.type === 'text')?.text : undefined;
  // Never log an upstream error message; it can contain user code or data.
  if (typeof first === 'string' && first.length < 4096) {
    try {
      const { code } = JSON.parse(first);
      if (['DOCUMENT_CONTEXT_CHANGED', 'PLUGIN_PERMISSION_DENIED', 'SCRIPT_SYNTAX_ERROR'].includes(code)) return code;
    } catch { /* Plain upstream errors have no structured code. */ }
  }
  return 'UPSTREAM_TOOL_ERROR';
}

/** Fixed, non-sensitive fields only. Disabled instances bypass ALS and clocks. */
export class Diagnostics {
  private readonly context = new AsyncLocalStorage<Scope>();
  constructor(private readonly sink?: RecordSink) {}
  private emit(record: Record<string, unknown>) {
    try { this.sink?.({ eventVersion: 1, at: new Date().toISOString(), ...record }); } catch { /* Logging must not change tool outcomes. */ }
  }
  async run<T>(operation: Operation, queuedAt: number, queuedAhead: number, task: () => Promise<T>): Promise<T> {
    if (!this.sink) return task();
    const started = performance.now();
    const scope: Scope = { requestId: randomUUID(), operation, live: { value: true }, timing: { activationMs: 0, upstreamMs: 0, saveMs: 0, cleanupMs: 0, upstreamCalls: 0, connectionProbeRetries: 0 } };
    return this.context.run(scope, async () => {
      let value: T | undefined, errorCode: string | undefined;
      try { value = await task(); errorCode = resultError(toolResult(value)); return value; }
      catch (error) { errorCode = error instanceof GatewayError ? error.code : 'OPERATION_FAILED'; throw error; }
      finally {
        scope.live.value = false;
        const timing = Object.fromEntries(Object.entries(scope.timing).map(([key, value]) => [key, Math.round(Math.max(0, value) * 100) / 100]));
        this.emit({ event: 'request', requestId: scope.requestId, operation, outcome: errorCode ? 'error' : 'ok', ...(errorCode ? { errorCode } : {}),
          queuedAhead, queueMs: Math.round((started - queuedAt) * 100) / 100, totalMs: Math.round((performance.now() - queuedAt) * 100) / 100,
          ...timing, responseContentBytes: contentBytes(toolResult(value)) });
      }
    });
  }
  busy(operation: Operation, queuedAhead: number) {
    this.emit({ event: 'request', requestId: randomUUID(), operation, outcome: 'rejected', errorCode: 'BUSY', queuedAhead, queueMs: 0, totalMs: 0 });
  }
  async span<T>(phase: Phase, task: () => Promise<T>): Promise<T> {
    const scope = this.sink ? this.context.getStore() : undefined;
    if (!scope?.live.value) return task();
    const start = performance.now();
    try { return await this.context.run({ ...scope, phase }, task); }
    finally {
      const duration = performance.now() - start;
      scope.timing[phase] += duration;
      // Phases are exclusive, so setup/teardown do not double-count nested RPCs or saving.
      if (scope.phase) scope.timing[scope.phase] -= duration;
    }
  }
  count(name: 'upstreamCalls' | 'connectionProbeRetries') {
    const scope = this.sink ? this.context.getStore() : undefined;
    if (scope?.live.value) scope.timing[name]++;
  }
  lifecycle(event: Lifecycle, forced = false) {
    if (!this.sink) return;
    const scope = this.context.getStore();
    this.emit({ event, ...(scope?.live.value ? { requestId: scope.requestId, operation: scope.operation } : {}), forced, nodeRssBytes: process.memoryUsage().rss });
  }
}
