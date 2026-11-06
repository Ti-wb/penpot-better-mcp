# Agent guide

**English** | [繁體中文](agent-guide.zh-TW.md) | [README](../README.md)

MCP initialization and `high_level_overview` provide the same core instructions.

## Workflow

1. Call `open_document({url})` to obtain a handle; use `inspect_document` for the page list. The gateway starts the headless editor.
2. Call `open_page({documentHandle, pageId})` and use its new handle. To create a page, first execute `const p = penpot.createPage(); p.name = "Draft"; return p.id;`, then pass its ID to `open_page`. Do not navigate inside design scripts.
3. Read the relevant API documentation and existing design before editing. Start with batches of about 100 shapes for frequent writes, then adjust to the workload. Return only needed fields or summaries.
4. Use `save: "deferred"` for consecutive operations, then `flush_document` before completing or handing off a write batch. Default `save: "wait"` confirms each call; deferred success only confirms execution.
5. Read back important IDs, counts, and changes; close unused handles. Always `await` asynchronous modifications inside the script.

Handles retain their file and page targets. Each `open_page` creates a new handle; close superseded ones to stay below the 128-handle limit. Page switching preserves Plugin storage, but eviction, idle reclamation, and recovery clear it. Keep important IDs and progress in the client.

Closing a handle confirms pending saves and keeps the editor while other handles use that file. The last close releases its browser; check `browserReleased`, `remainingFileHandles`, and global `remainingHandles`. Default ten-minute idle reclamation also closes the browser; a retained handle reopens it on the next call.

## Multiple agents

Connect all agents to the **same HTTP endpoint**. Different files run in parallel within browser capacity, while all pages of one file share a queue. The default pool holds two browsers and reclaims idle files after confirming saves. A client disconnect does not close other clients' handles. Separate gateway or stdio processes do not share locks.

The queue protects individual calls, not a whole workflow. Two agents can both read `x=0` and later write `x=1`, losing an increment. Put dependent read/compute/write steps in one `execute_code`, or verify the current value before writing and stop if it changed. Scripts can partially modify a design before failing; they are not transactions.

Agents editing one file share Plugin storage. Use separate key prefixes and agree on shape/page ownership. Human editors and other gateways are outside this queue.

## Permissions and errors

| Response | Action |
|---|---|
| `DOCUMENT_CONTEXT_CHANGED` | This call's user code has not run. Use `open_page` or `open_document` and the new handle. |
| `PLUGIN_PERMISSION_DENIED` | Check `permission` and stop retrying the restricted API. Earlier script steps may have changed the design; read back first. |
| `SCRIPT_SYNTAX_ERROR` | Use `details.upstreamMessage` to correct the script. A runtime-thrown SyntaxError can occur after edits, so do not assume nothing changed. |
| `EXECUTION_UNKNOWN` / `SAVE_UNCONFIRMED` | Do not replay writes. Open a fresh handle and inspect saved data; a successful new handle does not confirm the old write. |
| `WORKER_CAPACITY` | Other files cannot confirm saves and cannot be reclaimed safely. Resolve their save state first; this call's design code has not run. |
| `BUSY` | Wait for pending work and reduce concurrency. Limits are 32 accepted operations per file and 128 globally. |

API documentation does not grant permissions. A plugin without `user:read` cannot access `activeUsers`. Avoid probing `currentUser` / `activeUsers` for ordinary design work. The gateway does not expand plugin permissions; validate your own installation after upgrades.
