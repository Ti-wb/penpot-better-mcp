# 驗收結果

> 本頁站點網址已匿名化為範例網址；原始測試使用私人部署。

驗收日期：2026-11-06。環境為這台 Linux VM，測試程序沒有 `DISPLAY`；Docker gateway 以 UID 1000 執行，使用 headless Chromium，沒有 X server 或使用者維持的瀏覽器分頁。

## 真實 Penpot 驗收

| Penpot | Gateway 執行方式 | 結果 |
|---|---|---|
| 內網 `https://penpot.example.com`，2.18.5 | 原生 Node、stdio MCP | 7/7 通過 |
| 同一內網站點，2.18.5 | Docker、Streamable HTTP MCP | 7/7 通過 |
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
- 自動化回歸測試 5/5 通過：連結解析、站點／分享連結邊界、序列化與失敗後恢復、不重送不確定的寫入及錯誤遮罩、HTTP 授權與真實 MCP 協定。
- TypeScript 檢查、建置與 Docker 映像建置通過。
- Git 與 Docker context 排除 `.state`；session 與 gateway token 檔權限為 `0600`。

驗收發現並修正一個持久化競態：Penpot 的 pending 指示器有 debounce，立即查詢可能仍看到前一次的 saved。Gateway 現在等待 saved 狀態穩定及儲存請求結束，再允許切檔／正常關閉。跨檔案及冷重開驗收用來確認實際後端持久化，單看工具成功回覆不算通過。

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

請依 [README](../README.md) 啟動 sidecar、建立隔離 fixture，執行 `npm test`、`npm run test:e2e` 與 `npm run test:recovery`。本次報告保存在未追蹤的 `test-results/internal.json`、`internal-docker.json`、`latest.json`、`recovery.json`，PNG 證據在同目錄。這些檔案不含 session 或 bearer token。

## 驗收範圍

目前交付為單一使用者、單一站點的方案 A。已驗證 workspace 編輯器連結，沒有聲稱支援所有形式的 Penpot URL。分享／viewer 連結、跨站點自動登入、SSO/MFA 登入流程、多租戶隔離及大型設計檔壓力測試尚未完成。權限由實際登入帳號與 Penpot 判定，未另行實測團隊角色撤銷的每種情境。

方案 C 目前提供 adapter 邊界與演進設計，尚未實作直接後端讀取。瀏覽器工具列、儲存指示器與 WebSocket 路徑是版本相依處；升級 Penpot 時應重跑以上真實驗收。
