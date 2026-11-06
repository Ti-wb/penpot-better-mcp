# 大量讀寫與 Proxy 開銷

2026-11-06，在這台 6 vCPU、約 11.2 GiB RAM 的 Linux VM 實測。主要目標是內網 Penpot 2.18.5 的單一大型檔案頻繁讀寫；官方 MCP sidecar 為本次確認的最新 2.18.6，Chromium 全程 headless。

## 測試方式

兩個專用檔案各有 3,000 個原生矩形，尺寸、排列與查詢相同。直連組使用 Chromium 原生 WebSocket 連官方 sidecar；Proxy 組經真正的 Streamable HTTP MCP client、gateway、官方 sidecar 及受管瀏覽器。原生對照使用同一個 sidecar，Docker 部署對照使用同版本的兩個 sidecar 實例。直連組只在建立 socket 時改寫目的位址／路由 token，沒有逐訊息的 Node relay。

這些是合成圖形，並非含大量圖片、字型、元件與 Auto Layout 的真實複雜設計。冷啟動、執行回覆與儲存完成分開測量。分位數採樣量列在表中，不能當成正式服務的 SLA。

## 延遲

原版 `0ff0bca` 的簡單讀取中位數為 **788.02 ms**，直連同輪為 **3.53 ms**。主要原因是所有 `execute_code` 都等待 saved 穩定 750 ms，另有重複的文件確認呼叫。原版壓測在後續切檔階段遇到 MCP 選單等待逾時；前面已完成的延遲樣本有效，但該輪整體狀態記為失敗。

改善後保留預設 `save=wait` 的逐次儲存確認，新增 `save=deferred` 與批次結束時的 `flush_document`，並把暖連線的文件檢查併入同一次執行。以下 Docker 部署數字使用 **deferred 的執行回覆**：

| 操作 | 樣本數／路徑 | 官方直連 p50 | Docker Proxy p50 | 額外時間 |
|---|---:|---:|---:|---:|
| 同檔簡單讀取 | 60 | 3.03 ms | 7.45 ms | 4.42 ms |
| 讀取全部 3,000 圖形、約 1.6 MB 回覆 | 10 | 1,099.44 ms | 1,130.09 ms | 30.65 ms，約 2.8% |
| 一次更新 100 圖形座標 | 2 | 6,165.48 ms | 6,223.41 ms | 57.93 ms；樣本少，只作部署確認 |

簡單讀取 p95 為直連 3.71 ms、Docker Proxy 10.31 ms；全量讀取 p95 分別為 1,211.61 ms、1,309.66 ms。原生 gateway 的另一輪 60 次讀取中位數為 5.02 ms（直連 2.56 ms）。

較完整的原生批次寫入測試各跑 10 批、每批更新 100 個圖形：直連中位數 6,069.57 ms、Proxy 6,064.39 ms。批次末端另等待 1,309 ms 確認儲存；Docker 的末端確認為 1,421 ms。這些差異顯示本次大量物件修改主要耗時在 Penpot／Plugin，而非 Proxy 轉送。不要把執行回覆當成落盤成功。

**未選 deferred 時，750 ms 的儲存穩定檢查仍然保留。**高頻讀取及批次修改應使用 deferred，寫入批次最後再 flush。任意 JavaScript 的副作用無法靠猜測自動分類成唯讀，因此沒有默默移除預設的持久化保證。

## 負載與正確性

原生完整負載輪次包含每檔 3,000 圖形、每路 1,000 次座標更新、80 次以 8 路併發送出的全檔掃描，以及 200 次連續掃描（約 215 秒）。計數、名稱唯一性與座標加總，在完整關閉瀏覽器後重新讀取仍一致。

64 次突發請求中，33 筆獲接受並完成，31 筆明確回 `BUSY`。上限是同時執行／排隊 32 筆；送出期間已有操作完成時可再接受新請求。這是過載保護，不是 64 路平行執行。8 路全檔掃描依序完成，中位數約 8.7 秒；同一檔案的操作仍序列化。

實際 Docker 服務另通過 24 次併發遞增（每輪 8 次）：每個回傳值連續且唯一，沒有遺失或重複修改。這輪還包含 16 次併發全檔掃描、20 次連續掃描、64 次突發請求（32 完成／32 回 `BUSY`），以及冷重開後的完整讀回。最後已刪除兩個檔案共 6,000 個測試圖形，重新開檔確認殘留為零。

切檔已補強舊 WebSocket 回收與實際 Plugin 就緒判定。修正後的 4 次大型檔案切換通過，中位數約 6 秒、最慢約 17.4 秒。跨檔仍需重新載入編輯器；這項架構成本尚未由多檔快取消除。

## 記憶體

測試發現，官方 Plugin 把執行結果寫進瀏覽器 console，Chrome 會保留結果物件。直連與原版 Proxy 都會發生；不是 Node relay 的資料佇列累積。[官方執行器](https://github.com/penpot/penpot/blob/2.18.6/mcp/packages/plugin/src/task-handlers/ExecuteCodeTaskHandler.ts)

用相同的 60 次簡單讀取、20 次全量回傳及 20 次掃描比較，並以強制 GC 排除暫時垃圾：

| 路徑 | 開始的 renderer JS heap | 工作完成、GC 後 |
|---|---:|---:|
| 官方直連，保留 console 記錄 | 173.8 MiB | 1,301.9 MiB |
| Proxy，自動釋放 console 參照 | 174.3 MiB | 175.0 MiB |

直連組另外清除 console 參照後也降至 174.5 MiB，支持這個原因。Proxy 現在在接收工具結果後呼叫 `Runtime.discardConsoleEntries`；正式運行沒有每次強制 GC。MCP 回傳的使用者日誌與 Plugin `storage` 已另行實測保留。

上述是 **renderer JS heap**，不是整個瀏覽器或容器用量。該記憶體對照中，Proxy Chromium 各程序 RSS 加總約 1.37 GiB（可能重複計算共享頁）；同程序的測試 client 加 gateway Node RSS 峰值約 227 MiB。方案 A 仍需負擔 Chromium 的資源成本，不能把低轉送延遲解讀為零資源開銷。

Docker 全負載期間，gateway 容器（包含 Chromium）的記憶體峰值為 **2.63 GiB**，CPU 峰值為 **599%**（約 6 個核心）。所有 handle 關閉、Chromium 退出後，容器閒置用量約 **354 MiB**、CPU 0%。這是此合成工作負載的整體成本，不能歸因為 Proxy 轉送本身；但實際部署必須預留這些資源。

## 重現與限制

```bash
docker compose -f compose.dev.yaml up -d
E2E_TARGETS_FILE=.state/acceptance-targets.json LOAD_PHASE=optimized npm run test:load
# 只比較 console 參照與保留 heap，保留測試圖形供下一輪：
E2E_TARGETS_FILE=.state/acceptance-targets.json LOAD_PHASE=memory-fixed LOAD_MEMORY_ONLY=1 LOAD_KEEP_FIXTURE=1 npm run test:load
```

需自行指定有權限的專用測試 manifest；腳本要求兩個檔案名稱皆為 `Headless acceptance …`。每輪只處理自己的 `__better_mcp_load_v1__:` 圖形。預設會清理，`LOAD_KEEP_FIXTURE=1` 才保留。原始結果在未追蹤的 `test-results/load-*.json`；程式碼在 [test/load.ts](../test/load.ts)。

這次確認的是上述資料量、工具呼叫與短時連續負載。沒有涵蓋長達數天的運行、多租戶、大型圖片／字型集合、所有 Plugin API 或任意大小檔案。較大的結構化查詢仍受 Plugin API 掃描成本影響；方案 C 的後端讀取、revision cache 與增量查詢，是後續可降低這項成本的方向。
