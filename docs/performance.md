# Performance

**English** | [繁體中文](performance.zh-TW.md) | [README](../README.md)

Performance depends on file contents, host capacity, backend latency, and concurrent work. Measure on your own dedicated fixtures before sizing a deployment. For the saved-data read path and its limits, see [browserless reads](browserless-reads.md).

## What to compare

- Compare the direct Plugin path and gateway with the same files, pages, fields, and batch sizes. Separate editor startup, warm reads, and write/save latency.
- Compare one file, multiple pages in one file, and multiple files. Same-file calls serialize; cross-file work is bounded by browser capacity.
- Confirm saved data after closing and reopening the editor. A deferred execution reply is not proof of persistence; finish writes with `flush_document`.
- Record Node memory separately from Chromium and container memory. Summed process RSS can double-count shared pages; container memory also includes file cache.
- Check that closing the last handle and idle reclamation release browsers and relay sockets. Short runs do not establish long-term memory stability.
- Compare diagnostics enabled and disabled with the same workload. Include the sample count, medians, tail latency, and outliers when interpreting a local result.

The adapter clears browser console references without forcing garbage collection or removing MCP logs and Plugin storage. This can reduce retained result objects; it does not cap an editor's memory use.

## Run locally

Follow [testing](testing.md) to prepare a disposable fixture or dedicated acceptance files. For an existing site, put `E2E_TARGETS_FILE`, `PENPOT_STORAGE_STATE`, and upstream addresses in your private `.env`, using [.env.example](../.env.example) as a reference:

```bash
node --env-file=.env --import tsx test/load.ts
node --env-file=.env --import tsx test/reclamation.ts
node --env-file=.env --import tsx test/diagnostics.ts
```

Use the existing npm test scripts for the isolated fixture without loading site-specific settings. Load tests require an explicit `E2E_TARGETS_FILE`.

- `LOAD_SHAPES` / `RECLAIM_SHAPES`: fixture shape count; changing it requires a new comparison.
- `LOAD_KEEP_FIXTURE=1`: retain load-test shapes; leave unset for normal cleanup.
- `LOAD_MEMORY_ONLY=1`: measure memory only.
- `LOAD_BASELINE_DIR` / `MULTI_BASELINE_DIR`: compiled baseline directories for local comparisons. Run multi-client tests separately with `node --env-file=.env --import tsx test/multi-client.ts`.

Reports stay in ignored `test-results/`. Keep site URLs, document IDs, deployment versions, host specifications, and raw deployment measurements in local evidence rather than tracked documentation.

## Limits

Synthetic rectangle tests do not cover every Plugin API, complex components or Auto Layout, image/font-heavy files, unbounded responses, or multi-day sessions. Browser count limits do not bound per-editor memory. Field selection and pagination reduce backend-read output, but a cold cache still fetches the whole file. Results from one environment are not a universal capacity or latency guarantee.
