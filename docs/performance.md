# 效能摘要

量測日期：2026-11-06；6 vCPU、約 11.2 GiB RAM 的 Linux VM，全程 headless。主要情境是內網 Penpot 2.18.5 的大型單檔高頻讀寫，官方 sidecar 為 2.18.6。不同測試的資料量與資源指標分別標示，不能互相套用。

## 讀寫開銷

兩個專用檔案各 3,000 個原生矩形。直連組以 Chromium 原生 WebSocket 連官方 sidecar；Proxy 組經真正 HTTP MCP client、原生 Node Gateway 及受管 browser，兩組共用同版本 sidecar。簡單讀取交錯量測，其餘依序量測。

| 操作 | 每條路徑樣本數 | 官方直連 p50 | Proxy p50 |
|---|---:|---:|---:|
| 簡單讀取 | 30 | 2.45 ms | 5.76 ms |
| 全量讀取 3,000 圖形 | 20 | 1,152.23 ms | 1,169.02 ms |
| 每批更新 100 圖形 | 10 | 4,945.86 ms | 5,068.80 ms |

數字是 `save=deferred` 的執行回覆，寫入批次最後另行 flush。預設 `save=wait` 保留 750 ms 的 saved 穩定檢查，不能直接拿來比較純轉送成本。簡單讀取差約 3.31 ms；大型查詢與修改主要耗時在 Plugin／editor，差值仍包含主機與後端變動，不能全歸因於 Proxy。

同輪通過 3 輪 8 路讀取、24 次併發遞增、64 次突發請求及 60 次連續全檔掃描。突發中 33 筆完成、31 筆回 `BUSY`；抵達期間已有工作完成，故接受總數可超過同時排隊上限 32。計數與座標加總在冷重開後一致，6,000 個自建圖形已清理並冷讀確認。證據：`test-results/load-workers-internal.json`。

## 多 client 與頁面

4 個獨立 SDK clients，排除 LLM 思考時間。每次寫入刻意等待後才更新計數，藉執行區間驗證平行與序列化；以下比較單一全域佇列 `0121378` 與每檔 worker（容量 2）。

| 內網，相同腳本 | 單一佇列 | 每檔 worker |
|---|---:|---:|
| 同檔 16 次遞增與 160 圖形 | 5.33 s | 5.40 s |
| 同檔兩頁，各 client 寫 10 圖形 | 28.76 s | 13.62 s |
| 兩檔 8 次遞增與 80 圖形 | 73.99 s | 4.23 s |

跨檔改善主要來自免除反覆載入 editor，不代表每次 Plugin 執行都有同等加速。這是各一輪量測，不是 SLA。最新版 2.18.6 同一套檢查亦通過；同檔仍依序執行，寫入後切頁仍需等待儲存。證據：`multi-baseline.json`、`multi-internal.json`、`multi-latest.json`。

空白 fixture 的 12 次明確切頁量測中，首筆包含前次儲存約 802 ms，其餘為 21–28 ms；不是任意大型檔案的保證。編輯器回歸只需少量來回切頁，反覆壓力留在 `test:reclamation`。

## 記憶體與資源回收

官方 Plugin 會將結果物件寫進 browser console，inspector 可能持續保留它們。控制實驗在相同讀取後強制 GC，直連組 renderer heap 為 173.8 → 1,301.9 MiB，Proxy 釋放 console 參照後為 174.3 → 175.0 MiB；直連組再清除參照也降至 174.5 MiB。這支持使用 `Runtime.discardConsoleEntries` 的原因；正常運行不強制 GC，MCP 日誌與 Plugin storage 保留。[官方執行器](https://github.com/penpot/penpot/blob/2.18.6/mcp/packages/plugin/src/task-handlers/ExecuteCodeTaskHandler.ts)

目前每檔 worker 的 3,000 圖形負載中，單檔 renderer heap 為 366.9 → 1,010 → 236.7 MiB（最後為量測用 GC 後）；browser 各程序 RSS 加總為 1,951.6 → 2,321.4 → 1,451.1 MiB。Node 測試程序同時包含直連與 Proxy clients，RSS 為 221.3 → 205.4 MiB，不能當成獨立 Gateway 成本。RSS 加總也可能重複計算共享頁。

單檔 3,000 圖形的回收測試另在最新版跑 5 輪、內網跑 3 輪，合計 160 次全量讀取、64 次併發遞增及 32 次切頁。每輪明確／閒置回收後，觀測的 Chromium 程序皆退出、relay sockets 為零，冷讀校驗與最後清理通過。Node 在各輪回收後約 221–246 MiB；不能據此推論多日運作無洩漏。證據：`reclamation.json`、`reclamation-internal.json`。

Docker 四 client／PNG 驗收的容器峰值約 2,302 MiB，所有 Chromium 退出後約 393 MiB；最後 Node RSS 約 186 MiB，cgroup 另含約 235 MiB active file cache。這組較小設計的部署取樣不等於上述 3,000 圖形負載，也不能把容器用量直接視為 Node heap。證據：`workers-docker-resources.json`、`multi-docker-memory.jsonl`。

診斷開關另以 ABBA 順序比較，各 200 次暖讀的 p50 為啟用 3.41／停用 3.38 ms；各 20 次 1 MiB 回傳為 56.29／54.87 ms。沒有新增逐次 RPC，但此單機樣本不證明零開銷。證據：`diagnostics.json`。

## 重現與適用範圍

先依 [測試指南](testing.md) 啟動 sidecar 並指定專用檔案：

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:load
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json RECLAIM_ROUNDS=3 npm run test:reclamation
npm run test:diagnostics
```

`LOAD_SHAPES`／`RECLAIM_SHAPES` 可調整圖形數，預設 3,000；修改數量後不能沿用上述量測結論。`LOAD_KEEP_FIXTURE=1` 保留負載圖形，`LOAD_MEMORY_ONLY=1` 僅量測記憶體；`LOAD_BASELINE_DIR`／`MULTI_BASELINE_DIR` 可指定舊版編譯目錄。單獨比較多 client 可執行 `E2E_TARGETS_FILE=... npx tsx test/multi-client.ts`。完整負載腳本為 [load.ts](../test/load.ts)、[reclamation.ts](../test/reclamation.ts)。

以上是合成矩形、短時連續負載，未涵蓋多日運行、大量圖片／字型、複雜元件與 Auto Layout、所有 Plugin API 或任意大小回傳。方案 A 仍負擔 Chromium 成本；browser 數量有上限不代表單一 editor 記憶體固定。方案 C 的後端讀取與 revision cache 尚未實作。
