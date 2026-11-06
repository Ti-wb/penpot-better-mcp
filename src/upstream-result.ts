import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Official sidecar timeouts arrive as successful JSON-RPC responses containing
// this exact plain-text envelope, not as SDK timeout exceptions. The plugin
// task is still running, so the caller must retire its browser before yielding.
export function isUpstreamTaskTimeout(result: CallToolResult): boolean {
  return result.content.some(item => item.type === 'text' &&
    /^Tool execution failed: Error: Task [0-9a-f-]+ timed out after \d+(?:\.\d+)? seconds$/i.test(item.text));
}

// Released official MCP catches tool exceptions into TextResponse without
// setting isError. Preserve the useful message, but restore MCP error semantics.
// A user returning the same string is JSON-wrapped under `result`, so it does
// not match this transport-level prefix.
export function normalizeUpstreamResult(result: CallToolResult): CallToolResult {
  return result.content.some(item => item.type === 'text' && item.text.startsWith('Tool execution failed:'))
    ? { ...result, isError: true }
    : result;
}
