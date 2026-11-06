# 效能摘要

[English](performance.md) | **繁體中文** | [README](../README.zh-TW.md)

**2026-11-06 的量測紀錄**：6 vCPU、約 11.2 GiB RAM 的 headless Linux VM，主要使用內網 Penpot 2.18.5 與官方 2.18.6 MCP sidecar。下列負載與記憶體指標來自不同量測，不能互相套用為容量估計。

## 讀寫開銷

兩個專用檔案各含 3,000 個原生矩形。直連組以 Chromium 原生 WebSocket 連官方 sidecar；Proxy 組使用真正的 HTTP MCP client、原生 Node Gateway 與受管瀏覽器，兩組 sidecar 版本相同。簡單讀取交錯量測，其餘依序執行。

| 操作 | 每條路徑樣本數 | 直連 p50 | Proxy p50 |
|---|---:|---:|---:|
| 簡單讀取 | 30 | 2.45 ms | 5.76 ms |
| 全量讀取 3,000 圖形 | 20 | 1,152.23 ms | 1,169.02 ms |
| 每批更新 100 圖形 | 10 | 4,945.86 ms | 5,068.80 ms |

數字是 `save=deferred` 的執行回覆，寫入批次另行 flush。預設 `save=wait` 包含 750 ms 的 saved 穩定檢查。簡單讀取差約 3.31 ms；大型操作主要耗時在 Plugin／editor，主機與後端變動也會影響差值。

併發讀取／遞增、過載與 60 次連續全檔掃描均通過。冷重開確認計數與座標加總一致，6,000 個 fixture 圖形已清理並冷讀驗證。來源：`test-results/load-workers-internal.json`。

## 多 client 與頁面

四個獨立 SDK clients，排除 LLM 思考時間，寫入刻意延遲以驗證執行重疊與序列化。基準為單一全域佇列（`92b780f`），每檔 worker 的瀏覽器池容量為兩個。

| 相同內網測試腳本 | 全域佇列 | 每檔 workers |
|---|---:|---:|
| 同檔 16 次遞增與 160 圖形 | 5.33 s | 5.40 s |
| 同檔兩頁，各 client 寫 10 圖形 | 28.76 s | 13.62 s |
| 兩檔 8 次遞增與 80 圖形 | 73.99 s | 4.23 s |

各結果只有一輪量測，不是 SLA。跨檔改善主要來自減少編輯器重載；同檔仍依序執行，切頁仍需等待儲存。2.18.6 也通過正確性檢查。來源為 `test-results/` 中的 `multi-baseline.json`、`multi-internal.json`、`multi-latest.json`。

空白 fixture 的 12 次明確切頁中，首筆含前次儲存約 802 ms，其餘為 21–28 ms；不能據此推估大型檔案的切頁時間。

## 記憶體與資源回收

[官方執行器](https://github.com/penpot/penpot/blob/2.18.6/mcp/packages/plugin/src/task-handlers/ExecuteCodeTaskHandler.ts) 將結果物件寫入 browser console，inspector 可能持續保留參照。控制實驗強制 GC 後，直連 renderer heap 從 173.8 升至 1,301.9 MiB；Proxy 清除 console 參照後維持在 174.3 至 175.0 MiB，直連組清除後也降至 174.5 MiB。正常運行只清除參照，不強制 GC，也不刪除 MCP 日誌或 Plugin storage。

| 負載／指標 | 觀測結果 | 解讀 |
|---|---|---|
| 單檔 3,000 圖形：renderer heap | 366.9 → 1,010 → 236.7 MiB | 最後一筆經量測用 GC |
| 同一負載：browser 各程序 RSS 加總 | 1,951.6 → 2,321.4 → 1,451.1 MiB | 共享頁可能重複計算；測試程序未隔離 Gateway Node 成本 |
| 回收：隔離 5 輪＋內網 3 輪 | 每輪回收後 Chromium 程序退出、relay sockets 為零；Node RSS 約 221–246 MiB | 涵蓋 160 次全量讀取、64 次併發遞增與 32 次切頁，冷讀與清理通過 |
| Docker，四 client／PNG | 容器峰值約 2,302 MiB；Chromium 退出後約 393 MiB | 設計規模小於 3,000 圖形負載；容器用量包含 file cache，不是 Node heap |

回收與 Docker 來源位於 `test-results/`：`reclamation.json`、`reclamation-internal.json`、`workers-docker-resources.json`、`multi-docker-memory.jsonl`。短時測試不能證明多日運作沒有洩漏。

紀錄開關以 ABBA 順序比較：各 200 次暖讀 p50 為啟用 3.41 ms／停用 3.38 ms；各 20 次 1 MiB 回覆為 56.29／54.87 ms。此樣本不能證明零開銷。來源：`diagnostics.json`。

## 重現與適用範圍

依[測試指南](testing.zh-TW.md) 啟動 sidecar，並提供專用檔案：

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:load
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json RECLAIM_ROUNDS=3 npm run test:reclamation
npm run test:diagnostics
```

- `LOAD_SHAPES` / `RECLAIM_SHAPES`：圖形數，預設 3,000；調整後需要重新量測。
- `LOAD_KEEP_FIXTURE=1`：保留負載圖形；`LOAD_MEMORY_ONLY=1`：僅量測記憶體。
- `LOAD_BASELINE_DIR` / `MULTI_BASELINE_DIR`：供比較的舊版編譯目錄。多 client 可單獨執行 `E2E_TARGETS_FILE=... npx tsx test/multi-client.ts`。

負載腳本：[load.ts](../test/load.ts)、[reclamation.ts](../test/reclamation.ts)。這些短時合成矩形測試未涵蓋長時間工作階段、大量圖片／字型、複雜元件／Auto Layout、所有 Plugin API 或無上限的回傳。Gateway 仍需執行 Chromium，限制瀏覽器數量不代表限制單一編輯器記憶體；直接後端讀取與 revision cache 尚待實作。
