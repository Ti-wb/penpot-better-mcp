import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Released official MCP catches tool exceptions into TextResponse without
// setting isError. Preserve the useful message, but restore MCP error semantics.
// A user returning the same string is JSON-wrapped under `result`, so it does
// not match this transport-level prefix.
export function normalizeUpstreamResult(result: CallToolResult): CallToolResult {
  return result.content.some(item => item.type === 'text' && item.text.startsWith('Tool execution failed:'))
    ? { ...result, isError: true }
    : result;
}
