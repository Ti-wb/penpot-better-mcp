import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GatewayApi } from './gateway.js';
import { GatewayError, publicError } from './errors.js';
import { gatewayInstructions } from './instructions.js';

function json(value: unknown): CallToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
export function createMcpServer(gateway: GatewayApi) {
  const server = new McpServer({ name: 'penpot-better-mcp', version: '0.1.0' }, {
    instructions: gatewayInstructions,
  });
  const safe = <T>(fn: (args: T) => Promise<CallToolResult>) => async (args: T) => {
    try { return await fn(args); } catch (error) { return { ...json(publicError(error)), isError: true }; }
  };
  const handle = { documentHandle: z.string().uuid() };
  server.registerTool('open_document', { description: 'Open an editor file URL in a managed headless browser. Returns a handle bound to the file and to page-id when the URL specifies it. Use open_page to select another page with a new handle.', inputSchema: { url: z.string().max(4096) }, annotations: { readOnlyHint: true, openWorldHint: true } }, safe(async args => {
    const opened = await gateway.open(args.url);
    return { ...json(opened), ...(opened.result.isError ? { isError: true } : {}) };
  }));
  server.registerTool('inspect_document', { description: 'Read current file identity and page list.', inputSchema: handle, annotations: { readOnlyHint: true } }, safe(args => gateway.inspect(args.documentHandle)));
  server.registerTool('open_page', { description: 'Select a page in the same file and return a NEW page-bound documentHandle. Flushes prior edits and reuses the editor. Old handles keep their original target. Use this after createPage; avoid navigating with penpot.openPage inside execute_code.', inputSchema: { ...handle, pageId: z.string().uuid() }, annotations: { readOnlyHint: true } }, safe(async args => {
    const opened = await gateway.openPage(args.documentHandle, args.pageId);
    return { ...json(opened), ...(opened.result.isError ? { isError: true } : {}) };
  }));
  server.registerTool('execute_code', { description: 'Execute official Penpot Plugin API JavaScript in the specified file. May edit designs. Default save=wait confirms persistence. For frequent reads or batched writes, use save=deferred to return immediately after execution, then flush_document after the write batch. Deferred success does not confirm persistence. Never retry uncertain edits blindly.', inputSchema: { ...handle, code: z.string().min(1).max(100_000), save: z.enum(['wait','deferred']).default('wait') }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, safe(args => gateway.execute(args.documentHandle, args.code, args.save)));
  server.registerTool('flush_document', { description: 'Wait for prior deferred edits to finish saving before reporting a batch complete. Page switching, worker eviction and normal close also flush automatically.', inputSchema: handle }, safe(args => gateway.flush(args.documentHandle)));
  server.registerTool('export_shape', { description: 'Export a shape, selection or page through the official MCP tool. mode=fill returns the original image fill (PNG only); shape is the default. SVG is returned as text.', inputSchema: { ...handle, shapeId: z.union([z.string().uuid(),z.enum(['page','selection'])]), format: z.enum(['png', 'svg']).default('png'), mode: z.enum(['shape','fill']).default('shape') }, annotations: { readOnlyHint: true } }, safe(args => {
    if(args.mode==='fill' && args.format!=='png')throw new GatewayError('INVALID_EXPORT','Image fill export supports PNG only.');
    return gateway.export(args.documentHandle, { shapeId: args.shapeId, format: args.format, mode: args.mode });
  }));
  server.registerTool('close_document', { description: 'Confirm active pending saves and release this handle. Keeps this file\'s editor while its other handles remain; closes only this file\'s browser when its last handle is released. Returns browserReleased, remainingFileHandles and global remainingHandles. Idle reclamation also closes the browser after saving.', inputSchema: handle }, safe(async args => json(await gateway.closeDocument(args.documentHandle))));
  server.registerTool('high_level_overview', { description: 'Read the upstream Penpot Plugin API overview with managed-browser instructions.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(async () => {
    const result = await gateway.documentation('high_level_overview', {});
    return { ...result, content: [
      { type: 'text', text: gatewayInstructions },
      ...result.content,
    ] };
  }));
  server.registerTool('penpot_api_info', { description: 'Read the upstream API documentation for a type or member.', inputSchema: { type: z.string(), member: z.string().optional() }, annotations: { readOnlyHint: true } }, safe(args => gateway.documentation('penpot_api_info', args)));
  return server;
}
