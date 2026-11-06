# Browserless reads

**English** | [繁體中文](browserless-reads.zh-TW.md) | [README](../README.md)

`read_document` reads saved design data over HTTP without Chromium, the plugin, or the official MCP sidecar. It reuses the local login session; no new configuration or token is required. Editing, rendering, and arbitrary Plugin JavaScript still use the existing browser path. This MVP reduces runtime resources; the supplied image still includes Chromium.

## Use

Call the tool directly with a workspace URL, without `open_document`:

```js
read_document({url}) // file identity, revision, pages and shape counts
read_document({url, view: "shapes", pageId, limit: 500,
  fields: ["name", "type", "x", "y", "width", "height", "fills", "content"]})
// Continue using the first response's snapshotId and nextOffset:
read_document({url, view: "shapes", pageId, limit: 500,
  fields: ["name", "type", "x", "y", "width", "height", "fills", "content"],
  offset: nextOffset, snapshotId})
```

`pageId` defaults to the URL's page, then the first page. `shapeIds` selects up to 200 known IDs; otherwise shapes are sorted by ID and paginated. `id` is always returned; other fields are raw backend camelCase keys. For example, backend `type: "frame"` corresponds to a Plugin board, and rich text is in `content`. These are JSON records, not Plugin objects or computed layout. The root frame is excluded from counts/results. Summary counts include nested shapes.

A scan ends when `nextOffset` is `null`. Pass the **same fields, page and filters** with `snapshotId` on later batches. `SNAPSHOT_CHANGED` means restart the scan; no historical snapshots are retained. Without that guard, each call reads the current saved state independently.

## Consistency and limits

- Reads do not close browsers retained by earlier editing. Release finished edit handles with `close_document`; ongoing same-file reads also postpone the existing idle timer.
- Same-file calls share the gateway's write queue. A read waits for earlier accepted writes and their save confirmation. A read immediately after deferred writes includes the save wait and a fresh full-file fetch. It cannot see unsaved changes in other gateways or human editors, and does not make a multi-call workflow transactional.
- Each call sends `get-file` to Penpot, including `If-None-Match` when cached. Penpot's ETag includes identity, file versions and permissions. A 304 reuses serialized data; a change downloads a fresh file. Failed authorization/network requests never serve cached data. Credential changes clear the cache.
- Requests use cookies matching the configured origin, path, security and expiry; redirects are rejected. No cookies, content, URLs or file IDs are added to diagnostics. Viewer/share links remain unsupported. The MVP uses session cookies; standalone PAT configuration is future work.
- At most two reads execute concurrently, independently of browser capacity. Same-file and global queue limits still apply. Cache: four files and **32 MiB total serialized data**; HTTP response: **32 MiB decompressed**; tool output: **4 MiB**; batch: up to **1,000 shapes**. These MVP limits are fixed. Decoding and in-flight data use additional transient RAM. Even a 304 reparses the cached JSON; retaining serialized bytes instead of decoded trees trades some CPU for bounded persistent storage.
- Unlike reading an already loaded editor, every call adds backend/network work. A 304 reduces transfer and decoding on the server, but still requires metadata/permission checks. High backend latency or load can reduce or reverse the speed advantage, especially for tiny reads.
- Cold reads and cache misses fetch the **whole file**. Field selection/pagination reduce MCP output, not that initial download. No ETag means a full fetch each time. The cache is in memory and cleared on successful shutdown. The existing `PENPOT_TIMEOUT_MS` applies to each backend HTTP request; Compose currently uses its built-in default.

## Feasibility and next steps

| Direction | Benefit | Tradeoff / status |
|---|---|---|
| Full JSON snapshot + ETag | Removes browser startup/residency and repeated file transfer; simple schema-aware reads | Implemented MVP; initial full download and a server round trip per call remain |
| `get-page` / object subtree, then fragment caching | Less cold-read transfer and decoding for a small part of a huge file | Next step; `get-page` lacks the same file ETag contract, so snapshot consistency needs additional version checks |
| Webhook-fed read index | Repeated searches/aggregations avoid full design decoding | Larger service with synchronization, permission revalidation, storage and stale-index recovery; premature for this gateway |

The backend APIs are viable but version-sensitive internal RPCs, not the Plugin API contract. The MVP requests JSON without advertising pointer/objects-map features so the backend resolves those structures. Do not silently reinterpret arbitrary `execute_code` as read-only, or return stale cache entries just to avoid network latency. Images, font/layout calculations, selection and Plugin storage require the browser path.

Sources: [official access-token integration](https://help.penpot.app/technical-guide/integration/), [`get-file`, `get-page` and authorization in Penpot 2.18.6](https://github.com/penpot/penpot/blob/2.18.6/backend/src/app/rpc/commands/files.clj), [ETag middleware](https://github.com/penpot/penpot/blob/2.18.6/backend/src/app/rpc/cond.clj), [feature compatibility](https://github.com/penpot/penpot/blob/2.18.6/common/src/app/common/features.cljc).

## Validation

`npm run test:reads` uses dedicated acceptance files and removes only its own test shapes/pages. It compares saved fields with the Plugin API, exercises deferred-write visibility and page reads, checks snapshot invalidation, then compares cold/warm scans, a single-shape lookup and eight concurrent readers. Set `READ_SHAPES` (default 3000) and `READ_SAMPLES` (default 12) to change the workload. Existing installations use the same manifest/session overrides as [other integration tests](testing.md).

Results are written to ignored `test-results/browserless-isolated.json` or `local-report.json`. Browser RSS is a sum across browser processes, not unique physical memory; Node RSS includes test/client/serialization allocations. A cold scan clears the file cache/reopens the editor inside an already running gateway; it includes editor startup only for the browser path. Warm comparisons use equal field projections; save confirmation happens outside the timed read scans. These are workload-specific measurements, not a universal speed guarantee. The short soak does not prove leak freedom, and CPU usage was not measured independently.

Unit tests cover denied/expired sessions, credential rotation, cache failure, output limits and queue behavior with mocked backend responses. Real-instance tests use the authorized test account; live read-only-role and permission-revocation scenarios have not been exercised.

## Performance guidance

Measure your own workload with the documented test scripts. Keep deployment details and raw results in ignored local reports.
