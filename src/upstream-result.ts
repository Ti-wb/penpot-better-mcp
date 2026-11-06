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
  const failed = result.content.find(item => item.type === 'text' && item.text.startsWith('Tool execution failed:'));
  if (failed?.type !== 'text') return result;
  const message = failed.text.slice('Tool execution failed:'.length).trim();
  const permission = /^(?:Error: )?(?:Error handling task: )?Permission ([a-z]+:[a-z]+) is not granted$/.exec(message)?.[1];
  const syntax = /^(?:Error: )?(?:Error handling task: )?(?:SyntaxError: |Unexpected token\b|Unexpected end of input\b)/.test(message);
  const guidance = permission ? {
    code: 'PLUGIN_PERMISSION_DENIED', permission, partialEditsPossible: true,
    message: 'This Penpot MCP plugin has not granted this permission. Avoid the denied API; file edit access is a separate check. Inspect any earlier edits in this script before retrying.',
  } : syntax ? {
    code: 'SCRIPT_SYNTAX_ERROR', partialEditsPossible: true,
    message: 'JavaScript reported a syntax error. Check the script syntax and use smaller chunks. Inspect earlier edits before retrying: code can also throw SyntaxError at runtime.',
  } : undefined;
  return { ...result, isError: true, ...(guidance ? {content: result.content.map(item => item === failed ? {type: 'text' as const, text: JSON.stringify(guidance)} : item)} : {}) };
}
