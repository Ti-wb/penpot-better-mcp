import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Gateway } from './gateway.js';
import { publicError } from './errors.js';

function json(value: unknown): CallToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
export function createMcpServer(gateway: Gateway) {
  const server = new McpServer({ name: 'penpot-better-mcp', version: '0.1.0' }, {
    instructions: 'Open a Penpot editor URL with open_document first. The gateway opens the browser and connects MCP automatically; do not ask the user to open a Penpot tab. Use the returned documentHandle on every design call. Read high_level_overview and API docs before executing code. Calls are serialized. Plugin storage resets on file switches or browser recovery; keep durable identifiers in your client. Never blindly retry an edit after EXECUTION_UNKNOWN or SAVE_UNCONFIRMED; inspect first. This worker represents one authenticated Penpot user. Viewer/share links are not supported yet.',
  });
  const safe = <T>(fn: (args: T) => Promise<CallToolResult>) => async (args: T) => {
    try { return await fn(args); } catch (error) { return { ...json(publicError(error)), isError: true }; }
  };
  const handle = { documentHandle: z.string().uuid() };
  server.registerTool('open_document', { description: 'Open an editor file URL in a managed headless browser. Returns a handle bound to this file.', inputSchema: { url: z.string().max(4096) }, annotations: { readOnlyHint: true, openWorldHint: true } }, safe(async args => {
    const opened = await gateway.open(args.url);
    return { ...json(opened), ...(opened.result.isError ? { isError: true } : {}) };
  }));
  server.registerTool('inspect_document', { description: 'Read current file identity and page list.', inputSchema: handle, annotations: { readOnlyHint: true } }, safe(args => gateway.inspect(args.documentHandle)));
  server.registerTool('execute_code', { description: 'Execute official Penpot Plugin API JavaScript in the specified file. May edit designs. Waits for the editor saved indicator; do not retry uncertain outcomes.', inputSchema: { ...handle, code: z.string().min(1).max(100_000) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, safe(args => gateway.execute(args.documentHandle, args.code)));
  server.registerTool('export_shape', { description: 'Export a shape through the official MCP tool.', inputSchema: { ...handle, shapeId: z.string().min(1).max(128), format: z.enum(['png', 'svg']).default('png') }, annotations: { readOnlyHint: true } }, safe(args => gateway.export(args.documentHandle, { shapeId: args.shapeId, format: args.format })));
  server.registerTool('close_document', { description: 'Release a document handle and the active browser. Other handles can reopen their files.', inputSchema: handle }, safe(async args => json(await gateway.closeDocument(args.documentHandle))));
  server.registerTool('high_level_overview', { description: 'Read the upstream Penpot Plugin API overview with managed-browser instructions.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(async () => {
    const result = await gateway.documentation('high_level_overview', {});
    return { ...result, content: [
      { type: 'text', text: 'Gateway instructions override manual-connection steps below: call open_document(url); this gateway opens and connects Penpot automatically. Include documentHandle on design calls. Plugin storage is temporary and resets on file switches, idle reclamation and recovery. This gateway exposes the tools in tools/list; the upstream local-filesystem import_image helper is not exposed. Use execute_code and documented Plugin media APIs for imports.' },
      ...result.content,
    ] };
  }));
  server.registerTool('penpot_api_info', { description: 'Read the upstream API documentation for a type or member.', inputSchema: { type: z.string(), member: z.string().optional() }, annotations: { readOnlyHint: true } }, safe(args => gateway.documentation('penpot_api_info', args)));
  return server;
}
