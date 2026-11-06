import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DocumentTarget } from './document.js';

export type SaveMode = 'wait' | 'deferred';
export interface ExportOptions { shapeId: string; format: 'png' | 'svg'; mode?: 'shape' | 'fill'; }

/** Operation boundary for a future backend API adapter. No browser types cross it. */
export interface DesignAdapter {
  open(target: DocumentTarget): Promise<CallToolResult>;
  openPage(source: DocumentTarget, target: DocumentTarget): Promise<CallToolResult>;
  execute(target: DocumentTarget, code: string, save?: SaveMode): Promise<CallToolResult>;
  flush(target: DocumentTarget): Promise<CallToolResult>;
  /** Confirm active work without activating another target; retire a lost worker. */
  flushPending(): Promise<void>;
  exportShape(target: DocumentTarget, args: ExportOptions): Promise<CallToolResult>;
  documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>): Promise<CallToolResult>;
  /** Release bookkeeping after a handle is discarded; does not flush or close. */
  release(target: DocumentTarget): void;
  close(): Promise<void>;
}
