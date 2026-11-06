# 驗收結果

> 本頁站點網址已匿名化為範例網址；原始測試使用私人部署。

驗收日期：2026-11-06。環境為這台 Linux VM，測試程序沒有 `DISPLAY`；Docker gateway 以 UID 1000 執行，使用 headless Chromium，沒有 X server 或使用者維持的瀏覽器分頁。

## 真實 Penpot 驗收

| Penpot | Gateway 執行方式 | 結果 |
|---|---|---|
| 內網 `https://penpot.example.com`，2.18.5 | 原生 Node、stdio MCP | 7/7 通過 |
| 同一內網站點，2.18.5 | Docker、Streamable HTTP MCP | 壓測及修正後重跑 7/7 通過 |
| 官方最新映像，2.18.6 | 隔離 Compose fixture、原生 stdio MCP | 7/7 通過 |

每組驗收使用專用的兩個 `Headless acceptance …` 檔案，依序檢查：

1. 真正的 MCP client 初始化與工具清單。
2. 冷啟動瀏覽器、自動連接 MCP，讀回正確的檔案 ID 與 Penpot 版本。
3. 建立原生可編輯矩形，等待儲存完成。
4. 併發送出 A、B、A 三次查詢，確認序列化、檔案對應與寫入持久化。
5. 透過官方 MCP 匯出 PNG，驗證檔案格式。
6. 關閉瀏覽器後重新開檔，按 ID 讀回剛建立的圖形。
7. 刪除本次測試圖形。

Docker gateway 的官方 `high_level_overview` 與 `penpot_api_info` 轉送也已實測。內網測試使用使用者自行在終端登入後的 session；帳密沒有經過對話傳遞。正式設計未納入測試。

## 故障與邊界

- 最新版隔離 fixture 實測 3/3 通過：上游執行逾時回傳 `EXECUTION_UNKNOWN`、重建瀏覽器後讀回相同文件、沒有登入 cookie 時回傳 `AUTH_REQUIRED`。
- 自動化回歸測試 8/8 通過：連結解析、站點／分享連結邊界、序列化與失敗後恢復、不重送不確定的寫入及錯誤遮罩、HTTP 授權與真實 MCP 協定、deferred／flush 順序、官方工具錯誤正規化，以及失敗／關閉時回收 handle 資料。
- 最新版隔離 fixture 的補充驗收 8/8 通過：alternate query URL 正規化、保留使用者日誌與 Plugin storage、工具錯誤、延後的後端儲存請求與 flush、冷重開持久化、SVG XML、原尺寸 PNG fill 匯出，以及意外切檔時拒絕寫入。
- 官方 4 個公開工具與其參數已逐項比對；完整覆蓋範圍及未完成事項見 [功能矩陣](functionality.md)。
- TypeScript 檢查、建置與 Docker 映像建置通過。
- Git 與 Docker context 排除 `.state`；session 與 gateway token 檔權限為 `0600`。

驗收發現並修正一個持久化競態：Penpot 的 pending 指示器有 debounce，立即查詢可能仍看到前一次的 saved。Gateway 現在等待 saved 狀態穩定及儲存請求結束，再允許切檔／正常關閉。跨檔案及冷重開驗收用來確認實際後端持久化，單看工具成功回覆不算通過。

## 獨立審查修正

對 `d68a177` 的審查重現了四項問題，修正後以 `test:lifecycle` 在隔離 2.18.6 fixture 完成 5/5 故障回歸：

| 審查問題 | 修正與驗證 |
|---|---|
| 瀏覽器遺失後 flush 誤報成功 | 分別測試關閉整個瀏覽器與單一頁面；同檔案所有舊 handle 均回 `SAVE_UNCONFIRMED`，檢查或新 handle 儲存不會清除舊 handle 的不確定狀態。關閉已遺失的 editor 會釋放資源並仍回報不確定結果。新 handle 可讀回並繼續操作，其他檔案不受影響。 |
| 官方 sidecar 先逾時，舊腳本繼續執行 | 使用 2 秒 sidecar／30 秒 Gateway timeout，確認回 `EXECUTION_UNKNOWN` 前瀏覽器已退出，延遲寫入與佇列中的後續寫入均未發生。SDK 先逾時的既有測試也已加入舊 handle／新 handle 的驗證。 |
| 載入失敗後無法重試 | 攔截首次導航讓它失敗；無需手動清理，下一次開檔即可成功。 |
| 初始化失敗洩漏 Chromium | 連續三次無效 storageState 與一次 relay 安裝失敗後，所有啟動的 Chromium 均已退出，handle 資料無殘留。 |

未確認不代表一定沒有寫入：只關閉頁面時，Penpot 仍可能完成最後一次儲存。錯誤後必須透過新 handle 讀回實際結果，不能以重新連線成功推論舊寫入已保存。

## 實際設計觀察後的改善

切頁改善以 `npm run test:pages` 在最新 2.18.6 fixture 通過四組驗證：12 次同檔切頁沿用瀏覽器、編輯器與 Plugin storage；不存在頁面保持原頁；直接呼叫 Plugin 切頁後，錯誤 handle 的下一次程式碼在執行前被拒絕，並可透過 `open_page` 恢復；延後寫入經切頁及冷重開仍存在。首輪有待儲存工作時為 802 ms，其餘切頁為 21–28 ms。初次量測紀錄為 `test-results/pages-stage1.json`；最後回歸使用 `pages.json`。

同輪單元與 HTTP 協定回歸共 9 項通過。重新查詢官方 `latest`，四個映像 digest 仍與下表一致。

耗時紀錄改善後，單元／HTTP 回歸共 12 項通過，包括排隊時間、巢狀階段不重複計算、超載／錯誤紀錄、內容隱私與紀錄失敗不影響操作。最新版 fixture 以 ABBA 順序比較開啟／停用紀錄，各 200 次暖機讀取與 20 次 1 MiB 回傳：暖機 p50 為 3.41／3.38 ms、p95 為 4.81／4.61 ms；大型回傳 p50 為 56.29／54.87 ms。沒有新增逐次 RPC；這組單機樣本的差異很小，並非統計上已證明零開銷。實測也確認瀏覽器啟動／回收事件及 response 大小。紀錄為 `test-results/diagnostics.json` 與不含 payload 的 `diagnostics.ndjson`。

Agent 指引與錯誤分類已於最新版 2.18.6 及內網 2.18.5 各通過 3 項實測：`user:read` 拒絕被分類為 `PLUGIN_PERMISSION_DENIED`、無效腳本回傳 `SCRIPT_SYNTAX_ERROR`、兩種錯誤後正常讀取與 flush 仍可用。一般使用者回傳的相同錯誤文字不會被誤判。MCP HTTP 回歸確認初始化與概覽提供一致指引。證據為 `test-results/guidance.json`、`guidance-internal.json`。

資源回收改善後，單元／HTTP 回歸共 14 項通過，包括多 handle 共用編輯器、最後 handle 才退出瀏覽器、未儲存時不丟棄 handle、閒置儲存未確認後重新檢查，以及工作／關機期間不觸發閒置回收。兩個環境各用單檔 3,000 圖形驗證，最新版五輪、內網三輪，共 160 次全量讀取、64 次併發遞增與 32 次切頁；每輪都確認數量與座標加總、冷重開持久化、Chromium 程序退出及 relay sockets 清空。所有本次測試圖形與臨時頁面均已清理，最後冷讀確認無殘留。資源數字及限制見 [效能報告](performance.md)，原始紀錄為 `reclamation.json`、`reclamation-internal.json`。

本輪另通過切頁 4 項、生命週期故障 5 項、批次／匯出／持久化 8 項與 SDK 逾時／認證恢復 3 項回歸。最後建置在最新版 stdio 與實際內網 Docker HTTP 完整驗收各 7 項通過，紀錄為 `latest-four-improvements.json`、`internal-docker-four-improvements.json`。Docker 部署已更新。

本機 Codex 已重新載入 MCP 設定，新連線探索為 9 個工具；實際透過 Codex 呼叫 `open_page`、釋放舊 handle、讀取新 handle 及最後回收皆通過，見 `codex-proxy-refresh.json`、`codex-four-improvements.json`。本次正在執行中的 Codex 回合仍保留更新前 8 個工具的探索快照；驗證新功能時應開新對話取得完整清單。

部署核對確認 7 個主要 JS 檔案雜湊與本機最後建置一致、容器 healthy、零重啟。部署後驗收的 18 個操作沒有錯誤，瀏覽器啟動／關閉各 3 次；收尾只剩 Node 與 init，容器約 393 MiB、CPU 0%。沒有把正常關閉誤記為 editor 遺失。紀錄為 `deployment-four-improvements.json`；測試用 Compose 服務已停止，volumes 保留，正式 Proxy 持續運作。

## 映像版本

本次先從官方拉取 `latest`，再固定為實際取得的 2.18.6 digest；沒有沿用本機舊 Penpot 映像。完整 digest 見 [test/compose.yaml](../test/compose.yaml) 與 [compose.yaml](../compose.yaml)。

| 映像 | Digest 開頭 |
|---|---|
| `penpotapp/frontend` | `80f0baff19a2` |
| `penpotapp/backend` | `121472d0ab4a` |
| `penpotapp/exporter` | `85f1d6eff14b` |
| `penpotapp/mcp` | `08292a1e3b6e` |

Gateway 使用 Playwright 1.63.0 的官方容器映像，亦固定 digest。內網站點維持原有 2.18.5。

## 重現與證據

請依 [README](../README.md) 啟動 sidecar、建立隔離 fixture，執行 `npm test`、`npm run test:e2e`、`npm run test:recovery`、`npm run test:batch`、`npm run test:lifecycle` 與 `npm run test:load`。最新故障回歸結果在未追蹤的 `test-results/lifecycle.json`、`recovery.json`；正常功能重跑結果為 `batch.json`、`latest-after-review-fixes.json`、`internal-docker-after-review-fixes.json`。修正後的 1,000 圖形復驗見 `load-review-fixed.json`。先前報告與 PNG 證據亦保留在同目錄。這些檔案不含 session 或 bearer token。

## 大量讀寫

內網兩個專用檔案各建立 3,000 個原生圖形，完成直連／Proxy 對照、批次更新、8 路併發、過載拒絕、連續掃描與切檔。Docker 服務另通過 24 次併發遞增，沒有遺失或重複修改；大量修改經完整關閉瀏覽器再開檔，計數、唯一性與座標加總保持一致。測試圖形均已清理並冷重開確認。

量測期間修正了逐次儲存等待造成的固定延遲、切檔時的 MCP 連接競態，以及官方 Plugin console 留住結果物件造成的記憶體累積。完整方法、延遲、資源用量與限制見 [效能報告](performance.md)。

## 驗收範圍

目前交付為單一使用者、單一站點的方案 A。已驗證 workspace 編輯器連結，沒有聲稱支援所有形式的 Penpot URL。分享／viewer 連結、跨站點自動登入、SSO/MFA 登入流程與多租戶隔離尚未完成。大量讀寫已測合成矩形；含大型圖片、元件與 Auto Layout 的複雜設計，以及多日持續運行仍未涵蓋。權限由實際登入帳號與 Penpot 判定，未另行實測團隊角色撤銷的每種情境。

方案 C 目前提供 adapter 邊界與演進設計，尚未實作直接後端讀取。瀏覽器工具列、儲存指示器與 WebSocket 路徑是版本相依處；升級 Penpot 時應重跑以上真實驗收。

## 多 Agent worker pool（2026-11-06）

`npm run check`、`npm run build` 與 24 項單元／HTTP 回歸通過。新增測試包含同檔 URL 別名與 UUID 大小寫共用佇列、跨檔平行、LRU 與容量上限、儲存未確認拒絕回收、慢回收不阻擋其他常駐檔案、關閉已回收檔案不搶佔 slot、128 個 handle 的預留額度、每檔 32／全域 128 請求上限，以及 close/reopen/shutdown 競態。

內網 2.18.5 與官方最新映像 2.18.6 的四 client 實測各 6 組通過；對照基準確認舊架構跨檔也依序執行，新架構不同檔案的執行區間確實重疊。每檔內的區間均不重疊、計數沒有遺失，冷重開確認資料持久化。量測與邊界見 [performance.md](performance.md)。本輪重新查詢 Docker Registry，四個官方 `latest` digest 與測試 Compose 固定值一致。

最新版額外通過 5 組頁面測試與 5 組故障測試：交替舊頁 handle 保留 editor／storage，原有頁面防誤寫仍有效；檔案 A 的 browser／page 遺失或 sidecar timeout，不會關閉檔案 B 的 browser。A 的舊 handles 保留未知儲存狀態，逾時腳本與其後排隊寫入不會偷偷繼續執行。

此處的序列化以一次工具呼叫為單位；跨呼叫的 Agent 計畫仍需前置條件與分工，不提供交易、跨 gateway 鎖或多租戶權限隔離。

容量設為 1 的最新版四 client 實測也通過 6 組檢查，兩檔交替時實際觸發回收／重開，仍保留遞增結果、頁面歸屬與冷讀資料。正常容量下的 stdio E2E 另通過 7 組檢查，涵蓋原生寫入與 PNG 匯出；權限／語法錯誤恢復 3 組通過。紀錄分別為 `multi-latest-capacity1.json`、`workers-latest-e2e.json`、`guidance.json`。

內網每檔 3,000 圖形的大量讀寫驗收通過 6 組檢查，包含 8 路讀取、24 次併發遞增、64 次突發請求、60 次連續全檔掃描、完整持久化與 6,000 個自建圖形清理。原始紀錄為 `load-workers-internal.json`；記憶體與延遲數字的解讀限制見效能報告。

實際 Codex 使用的 Docker endpoint 已更新為每檔 worker（預設 2），並比對 5 個核心編譯檔案雜湊與工作區一致。關閉開發 sidecar 後，四 client 驗收 6 組及 HTTP／PNG E2E 7 組全數通過；包含大寫 file UUID 仍進入同檔佇列。120 個操作紀錄無錯誤，14 次 browser 啟動全部關閉、同時最多 2 個，最後沒有 Chromium 程序。所有本輪圖形與臨時頁面已冷讀確認清理；開發及最新版測試服務已停止，資料卷保留。現行 gateway 與 private upstream 維持運作。

## 多 Agent 版本的獨立 Code Review（2026-11-06）

以 `3c3c04a` 為基準重新檢查原始碼、資源所有權、排程與程序關機流程，確認以下四項可重現問題，已在 `ed7991c` 修復：

| 優先度與位置 | 觸發條件及修復 |
|---|---|
| P1：`src/main.ts` 關機失敗中止恢復 | 舊版先關 HTTP listener，儲存失敗又造成未處理的 Promise rejection，程序以非零狀態退出。現在先完成工作與儲存，再關閉傳輸；失敗時保留未關閉的 editor 與恢復入口，每 5 秒重試。 |
| P1：`src/headless-adapter.ts` 訊號處理提前終止瀏覽器 | 實測在 12 秒寫入途中送出 SIGTERM，Playwright 預設處理先關閉 Chromium，導致 `EXECUTION_UNKNOWN`。現在停用 Playwright 的自動訊號處理，由 Gateway 統一完成排隊工作與儲存後退出；Compose 關機等待預設為 5 分鐘。 |
| P2：`src/worker-pool.ts` 已回收資源仍占容量 | 容量為 1 時，檔案 A 的 browser 已遺失且儲存未知；close 釋放資源後仍拋錯，造成 B 誤報 `WORKER_CAPACITY`。現在透過 adapter 的 `hasResources` 釋放容量，同時保留 A 舊 handles 的未知儲存狀態。 |
| P2：`src/worker-pool.ts` 慢回收阻塞其他待開檔案 | 全域分配流程等待一次慢 close，其他可用 slot 也無法交給等待中的檔案。現在讓回收獨立進行，僅按等待需求回收；同檔仍序列化，也不會多關閉沒有必要回收的暖機 browser。 |

兩項排程回歸在修正前均失敗，修正後通過；目前共 28 項單元／HTTP 測試通過，型別檢查、建置及 Docker 映像建置亦通過。沒有增加正常讀寫的 MCP 往返。

最新版 2.18.6 fixture 的 `test:lifecycle` 通過 6 組故障測試，包含容量 1 的真實 browser loss。新增 `test:shutdown` 啟動真正的 HTTP 子程序，執行 12 秒寫入並連續送出兩次 SIGTERM；測試只注入一次關閉時的 `SAVE_UNCONFIRMED`，確認寫入回應送達、原 editor／handle 可讀、5 秒後自動重試並正常退出、冷重開仍有寫入，以及清理自身圖形，共 5 項通過。原始程式在這個訊號情境會提前失去 browser，修正後通過。

內網 2.18.5 與最新版 2.18.6 的原生四 client 測試各 6 項通過；最新版 stdio／PNG E2E 另通過 7 項。紀錄為 `review-multi-internal.json`、`review-multi-latest.json`、`review-stdio-latest.json`、`lifecycle.json` 與 `shutdown-review.json`。本輪聚焦故障、競態及多 client 回歸，沒有重跑前一節的 6,000 圖形效能對照；長時間負載與外部強制終止的限制仍適用。

實際 Codex Docker endpoint 已部署 `ed7991c`，7 個核心編譯檔雜湊一致，關機等待為 300 秒。部署後內網四 client 的 6 組驗收全數通過，跨檔操作為 4.04 秒；104 個操作沒有錯誤，11 次 browser 啟動均正常關閉、同時最多 2 個，沒有非預期 editor 遺失。測試圖形及頁面已清理並冷重開確認，最後沒有 Chromium 殘留。容器 healthy、零重啟；開發／最新版測試服務已停止，資料卷保留。證據為 `review-multi-docker.json` 與 `deployment-review.json`。
