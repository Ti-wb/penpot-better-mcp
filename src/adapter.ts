import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DocumentTarget } from './document.js';

/** Operation boundary for a future backend API adapter. No browser types cross it. */
export interface DesignAdapter {
  open(target: DocumentTarget): Promise<CallToolResult>;
  execute(target: DocumentTarget, code: string): Promise<CallToolResult>;
  exportShape(target: DocumentTarget, args: { shapeId: string; format: 'png' | 'svg' }): Promise<CallToolResult>;
  documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
