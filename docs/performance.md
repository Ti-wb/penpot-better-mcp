# Performance

**English** | [繁體中文](performance.zh-TW.md) | [README](../README.md)

For the browserless read MVP and its separate cold/warm/memory comparison, see [browserless reads](browserless-reads.md). The measurements below cover the original Plugin path.

Measurements recorded on **2026-11-06**: a headless Linux VM with 6 vCPU and about 11.2 GiB RAM, primarily internal Penpot 2.18.5 with the official 2.18.6 MCP sidecar. Workloads and memory metrics below are separate measurements, not interchangeable capacity estimates.

## Read/write overhead

Two dedicated files held 3,000 native rectangles each. The direct path used Chromium's native WebSocket to the official sidecar; the Proxy path used a real HTTP MCP client, native Node gateway, and managed browser. Both used the same sidecar version. Simple reads were interleaved; other measurements ran sequentially.

| Operation | Samples per path | Direct p50 | Proxy p50 |
|---|---:|---:|---:|
| Simple read | 30 | 2.45 ms | 5.76 ms |
| Read all 3,000 shapes | 20 | 1,152.23 ms | 1,169.02 ms |
| Update 100 shapes per batch | 10 | 4,945.86 ms | 5,068.80 ms |

These are `save=deferred` execution replies; write batches were flushed separately. Default `save=wait` includes a 750 ms saved-state stability check. The simple-read difference is about 3.31 ms; larger operations mostly spend time in the Plugin/editor. Host and backend variation also contribute to the differences.

Concurrent reads/increments, overload, and 60 repeated full-file scans passed. Cold reopening confirmed counts and coordinate totals; all 6,000 fixture shapes were removed and cold-read verified. Source: `test-results/load-workers-internal.json`.

## Multiple clients and pages

Four independent SDK clients, excluding LLM thinking time, deliberately delayed writes to verify execution overlap and serialization. The baseline was a single global queue (`92b780f`); the per-file pool capacity was two.

| Same internal-instance script | Global queue | Per-file workers |
|---|---:|---:|
| One file: 16 increments and 160 shapes | 5.33 s | 5.40 s |
| Two pages in one file: 10 shapes per client | 28.76 s | 13.62 s |
| Two files: 8 increments and 80 shapes | 73.99 s | 4.23 s |

Each result is one trial, not an SLA. Most cross-file improvement comes from avoiding editor reloads. Same-file calls still serialize and page changes wait for saves. Correctness checks also passed on 2.18.6. Sources: `multi-baseline.json`, `multi-internal.json`, `multi-latest.json` in `test-results/`.

In 12 explicit page switches on an empty fixture, the first took about 802 ms including a prior save; the others took 21–28 ms. This does not predict large-file switching time.

## Memory and reclamation

The [upstream executor](https://github.com/penpot/penpot/blob/2.18.6/mcp/packages/plugin/src/task-handlers/ExecuteCodeTaskHandler.ts) logs result objects to the browser console, where inspector references can retain them. After forced GC in a controlled comparison, direct renderer heap grew from 173.8 to 1,301.9 MiB; the Proxy's console-reference cleanup kept it at 174.3 to 175.0 MiB. Clearing the direct path's references reduced it to 174.5 MiB too. Normal operation clears references without forcing GC or removing MCP logs/Plugin storage.

| Workload / metric | Observation | Interpretation |
|---|---|---|
| One 3,000-shape file: renderer heap | 366.9 → 1,010 → 236.7 MiB | Final sample follows measurement-only GC |
| Same workload: summed browser-process RSS | 1,951.6 → 2,321.4 → 1,451.1 MiB | Shared pages may be counted more than once; the harness does not isolate gateway Node cost |
| Reclamation: 5 isolated + 3 internal rounds | Chromium processes exited and relay sockets reached zero after every reclamation; Node RSS about 221–246 MiB | Covered 160 full reads, 64 concurrent increments, and 32 page changes; cold readback and cleanup passed |
| Docker, four clients / PNG | Container peak about 2,302 MiB; about 393 MiB after Chromium exited | Smaller designs than the 3,000-shape load; container memory includes file cache and is not Node heap |

Reclamation and Docker sources in `test-results/`: `reclamation.json`, `reclamation-internal.json`, `workers-docker-resources.json`, `multi-docker-memory.jsonl`. These short runs do not prove leak-free operation over multiple days.

Logging was compared in ABBA order: 200 warm reads per setting had p50 of 3.41 ms enabled / 3.38 ms disabled; 20 responses of 1 MiB each had 56.29 / 54.87 ms. This sample does not establish zero overhead. Source: `diagnostics.json`.

## Reproduction and limits

Follow [testing](testing.md) to start the sidecar and provide dedicated files:

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:load
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json RECLAIM_ROUNDS=3 npm run test:reclamation
npm run test:diagnostics
```

- `LOAD_SHAPES` / `RECLAIM_SHAPES`: shape count, default 3,000. Different counts require new measurements.
- `LOAD_KEEP_FIXTURE=1`: retain load-test shapes; `LOAD_MEMORY_ONLY=1`: measure memory only.
- `LOAD_BASELINE_DIR` / `MULTI_BASELINE_DIR`: older compiled build for comparison. Run multi-client tests alone with `E2E_TARGETS_FILE=... npx tsx test/multi-client.ts`.

Workload scripts: [load.ts](../test/load.ts), [reclamation.ts](../test/reclamation.ts). These short synthetic-rectangle tests do not cover long-running sessions, image/font-heavy files, complex components/Auto Layout, every Plugin API, or unbounded responses. The gateway still runs Chromium: limiting browser count does not cap an editor's memory. Direct backend reads and revision caching remain future work.
