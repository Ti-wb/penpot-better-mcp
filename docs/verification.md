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

切頁改善以 `npm run test:pages` 在最新 2.18.6 fixture 通過四組驗證：12 次同檔切頁沿用瀏覽器、編輯器與 Plugin storage；不存在頁面保持原頁；直接呼叫 Plugin 切頁後，錯誤 handle 的下一次程式碼在執行前被拒絕，並可透過 `open_page` 恢復；延後寫入經切頁及冷重開仍存在。首輪有待儲存工作時為 802 ms，其餘切頁為 21–28 ms。紀錄為 `test-results/pages.json`。

同輪單元與 HTTP 協定回歸共 9 項通過。重新查詢官方 `latest`，四個映像 digest 仍與下表一致。

耗時紀錄改善後，單元／HTTP 回歸共 12 項通過，包括排隊時間、巢狀階段不重複計算、超載／錯誤紀錄、內容隱私與紀錄失敗不影響操作。最新版 fixture 以 ABBA 順序比較開啟／停用紀錄，各 200 次暖機讀取與 20 次 1 MiB 回傳：暖機 p50 為 3.41／3.38 ms、p95 為 4.81／4.61 ms；大型回傳 p50 為 56.29／54.87 ms。沒有新增逐次 RPC；這組單機樣本的差異很小，並非統計上已證明零開銷。實測也確認瀏覽器啟動／回收事件及 response 大小。紀錄為 `test-results/diagnostics.json` 與不含 payload 的 `diagnostics.ndjson`。

Agent 指引與錯誤分類已於最新版 2.18.6 及內網 2.18.5 各通過 3 項實測：`user:read` 拒絕被分類為 `PLUGIN_PERMISSION_DENIED`、無效腳本回傳 `SCRIPT_SYNTAX_ERROR`、兩種錯誤後正常讀取與 flush 仍可用。一般使用者回傳的相同錯誤文字不會被誤判。MCP HTTP 回歸確認初始化與概覽提供一致指引。證據為 `test-results/guidance.json`、`guidance-internal.json`。

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
