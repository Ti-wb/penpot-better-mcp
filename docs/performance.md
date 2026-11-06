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

## 實際設計觀察後的改善

同檔切頁改用 `open_page`，保持同一編輯器並回傳新 handle。最新版 fixture 的連續 12 次切頁，首筆等待前次儲存約 802 ms，其餘為 21–28 ms；關閉被取代的 handle 會確認儲存，並保留其他 handle 正在使用的編輯器。最後一個 handle 關閉才回收整個瀏覽器。

新增耗時紀錄沒有增加暖路徑的 MCP 往返。以 ABBA 順序比較啟用／停用，各 200 次暖機讀取：p50 為 3.41／3.38 ms，p95 為 4.81／4.61 ms；各 20 次合成 1 MiB 回傳的 p50 為 56.29／54.87 ms。這是紀錄功能開關的比較，不能代替上面的直連／Proxy 對照，也不能推論零開銷。欄位及方法見 [diagnostics.md](diagnostics.md)。

最新版 2.18.6 的資源回收實測在單一檔案建立 3,000 個圖形，完成五輪讀寫／切頁／關閉／重開，共 100 次全量讀取、40 次併發遞增及 20 次切頁。每輪都確認計數及座標加總，交替使用明確關閉和 1.5 秒的測試用閒置期限；正式設定仍為 10 分鐘。

| 資源檢查 | 五輪結果 |
|---|---|
| 每輪讀寫後的 Chromium 程序 RSS 加總 | 2,342–2,787 MiB；後四輪落在 2,342–2,464 MiB |
| 明確關閉最後一個 handle | 約 161–217 ms；儲存已於關閉前確認 |
| 閒置回收 | 約 1.64–1.67 秒，包含 1.5 秒等待 |
| 回收後 | 觀測到的 Chromium 程序均退出，relay sockets 為零 |
| Gateway 與測試 client 共用的 Node 程序 | 回收後 RSS 221–244 MiB，有小幅上升，未據此宣稱不存在長期洩漏 |
| 生命週期與資料 | 含清理冷讀共 7 次啟動／7 次關閉；持久化檢查及清理均通過 |

此輪未強制 GC；RSS 包含配置器保留的頁面，程序 RSS 加總也可能重複計算共享頁。證據支持瀏覽器與連線能在工作後回收，並不代表使用中的大型 Penpot 編輯器沒有記憶體成本，也不等於多日運行已驗證。結果在 `test-results/reclamation.json`；重現使用 `npm run test:reclamation`，需先建立最新版 fixture。腳本只修改專用檔案中的本次 UUID 前綴圖形及臨時頁面，最後刪除並冷重開確認。

內網 2.18.5 也以單檔 3,000 圖形完成三輪，共 60 次全量讀取、24 次併發遞增與 12 次切頁。每輪的資料校驗、Chromium 程序退出及清理冷讀均通過，含清理共 5 次啟動／5 次關閉。大量讀取後的 Chromium RSS 加總為 1,694–2,740 MiB；回收後測試 Node 為 231–246 MiB。明確關閉約 109–165 ms，1.5 秒測試閒置期限約 1.60 秒完成回收。紀錄為 `test-results/reclamation-internal.json`；使用 `E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json RECLAIM_ROUNDS=3 RECLAIM_REPORT=reclamation-internal.json npm run test:reclamation` 重現。

## 重現與限制

審查修正後另以實際 Docker gateway、每檔 **1,000 個圖形**做復驗（`load-review-fixed.json`），同樣使用 deferred 加批次末端 flush：

| 操作 | 樣本數／路徑 | 官方直連 p50 | Docker Proxy p50 |
|---|---:|---:|---:|
| 簡單讀取 | 60 | 2.96 ms | 6.98 ms |
| 全量讀取，約 0.53 MB | 5 | 386.66 ms | 389.90 ms |
| 一次更新 100 圖形 | 2 | 2,534.93 ms | 2,589.72 ms |

簡單讀取的額外時間約 4.02 ms，Proxy p95 為 8.47 ms；新增 handle 狀態檢查沒有增加上游呼叫。8 路讀取、24 次併發遞增、64 次突發請求、冷重開讀回與全部 2,000 個圖形的清理均通過。這是較小資料量的修正復驗；上面的 3,000 圖形數字保留其原始測試範圍，寫入的 2 個樣本也不足以推論尾端延遲。

```bash
docker compose -f compose.dev.yaml up -d
E2E_TARGETS_FILE=.state/acceptance-targets.json LOAD_PHASE=optimized npm run test:load
# 只比較 console 參照與保留 heap，保留測試圖形供下一輪：
E2E_TARGETS_FILE=.state/acceptance-targets.json LOAD_PHASE=memory-fixed LOAD_MEMORY_ONLY=1 LOAD_KEEP_FIXTURE=1 npm run test:load
```

需自行指定有權限的專用測試 manifest；腳本要求兩個檔案名稱皆為 `Headless acceptance …`。每輪只處理自己的 `__better_mcp_load_v1__:` 圖形。預設會清理，`LOAD_KEEP_FIXTURE=1` 才保留。原始結果在未追蹤的 `test-results/load-*.json`；程式碼在 [test/load.ts](../test/load.ts)。

這次確認的是上述資料量、工具呼叫與短時連續負載。沒有涵蓋長達數天的運行、多租戶、大型圖片／字型集合、所有 Plugin API 或任意大小檔案。較大的結構化查詢仍受 Plugin API 掃描成本影響；方案 C 的後端讀取、revision cache 與增量查詢，是後續可降低這項成本的方向。

## 多 Agent 與每檔 worker（2026-11-06）

四個獨立 SDK client／HTTP transport 模擬 Agent 送出 MCP 呼叫，沒有讓 LLM 思考時間影響量測。基準為 `0121378` 的單一全域佇列；新架構預設保留 2 個 browser。每次寫入有刻意等待再更新計數的區段，以確認同檔操作不交錯、跨檔執行時間確實重疊。

| 內網 2.18.5，相同腳本 | 舊版 | 每檔 worker |
|---|---:|---:|
| 同檔，4 clients 共 16 次讀取後遞增與 160 圖形寫入 | 5.33 s | 5.40 s |
| 同檔兩頁，4 clients 各寫 10 圖形 | 28.76 s | 13.62 s |
| 兩檔，4 clients 共 8 次讀取後遞增與 80 圖形寫入 | 73.99 s | 4.23 s |

跨檔加速主要來自不再反覆載入 editor；不能解讀為每次 Plugin 執行速度提升同樣倍數。這是各一輪量測，會受主機與後端負載影響。同檔仍依序執行；跨頁會先等儲存，因此寫入後切頁仍有儲存成本。

最新官方映像 2.18.6 同一套測試亦通過：同檔 2.32 s、跨頁 11.74 s、兩檔 2.28 s。兩個環境皆確認計數、頁面歸屬、冷重開後的所有圖形數量，以及關閉檔案 A／斷開一個 client 不影響檔案 B。測試結束已清除所有自建圖形與頁面，並再次冷讀確認。

原始紀錄為 `test-results/multi-baseline.json`、`multi-internal.json`、`multi-latest.json`。重跑使用 `E2E_TARGETS_FILE=... PENPOT_STORAGE_STATE=... npm run test:multi`；以 `MULTI_BASELINE_DIR` 指向舊版編譯目錄可比較舊架構。

同輪內網 3,000 圖形／檔案的大量讀寫，Proxy 使用原生 Node HTTP，與官方 MCP 直連共用 sidecar；簡單讀取交錯量測，其餘操作依序量測。

| 操作 | 每條路徑樣本數 | 官方直連 p50 | Proxy p50 |
|---|---:|---:|---:|
| 簡單讀取 | 30 | 2.45 ms | 5.76 ms |
| 全量讀取 3,000 圖形 | 20 | 1,152.23 ms | 1,169.02 ms |
| 每批更新 100 圖形 | 10 | 4,945.86 ms | 5,068.80 ms |

這輪簡單讀取差約 3.31 ms；大量讀寫仍主要受 Plugin／編輯器處理時間影響。差值含主機與後端變動，不能全歸因於 worker pool。另測 3 輪 8 路讀取、24 次併發遞增、64 次突發請求與 60 次連續全檔掃描；報告為 `test-results/load-workers-internal.json`。

這輪 64 個突發請求中，33 個完成、31 個明確回 `BUSY`；因請求陸續抵達時已有操作完成，接受總數可超過同時排隊上限 32。所有計數與座標加總在冷重開後一致，兩個檔案共 6,000 個自建圖形已清理並冷讀確認。

記憶體不是固定不變：單檔 renderer heap 從建立 fixture 後的 366.9 MiB，於大量操作後暫增至 1,010 MiB，量測用 GC 後降至 236.7 MiB；該 browser 各程序 RSS 加總為 1,951.6 → 2,321.4 → 1,451.1 MiB，共享頁可能重複計入。Node 測試程序同時含直連與 Proxy client，RSS 由 221.3 降至 205.4 MiB，不能當成獨立 Gateway 的記憶體成本。正式執行不會強制 GC。這支持本輪暫存可被回收，沒有證明數天運行完全無洩漏；常駐 browser 數量則由 pool 上限約束。

實際 Docker endpoint 的四 client 測試，跨檔 8 次操作為 4.03 s；另通過 PNG 匯出與冷重開。兩套驗收共記錄 120 個 Gateway 操作、0 個錯誤，14 次 browser 啟動皆對應關閉，同時最多 2 個。Docker 記憶體取樣峰值約 2,302 MiB，全部 Chromium 退出後約 393 MiB；最後 Node RSS 約 186 MiB，cgroup 另有約 235 MiB active file cache，Docker 用量不能直接當作 Node heap 或洩漏量。初始值是在 Playwright 尚未啟動前量測，也不適合作為暖機後的固定基線。紀錄為 `multi-docker.json`、`workers-docker-resources.json` 與 `multi-docker-memory.jsonl`。
