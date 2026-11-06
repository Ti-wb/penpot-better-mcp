# 耗時與資源紀錄

預設在 stderr 輸出一行 JSON 對應一次 Gateway 操作。`docker compose logs gateway` 可查看；`PENPOT_DIAGNOSTICS=false` 可停用。stdio 的 stdout 保留給 MCP。紀錄不包含 URL、文件／頁面 ID、handle、程式碼、回傳內容、帳號或憑證。

`event=request` 的欄位：

| 欄位 | 定義 |
|---|---|
| `requestId`、`operation`、`outcome` | Gateway 產生的隨機識別碼、工具名稱、成功／錯誤／拒絕 |
| `queueMs`、`queuedAhead` | 從進入 Gateway 至取得 worker 的等待時間、抵達時已接受但未完成的操作數 |
| `activationMs` | 瀏覽器／編輯器初始化與切檔，扣除其中的上游呼叫、儲存與回收時間 |
| `upstreamMs`、`upstreamCalls` | 官方 MCP 往返時間與次數，含序列化、網路及 Plugin 執行；不能解讀成純 Plugin CPU 時間 |
| `saveMs` | 等待 Penpot 確認儲存的時間 |
| `cleanupMs` | 回收瀏覽器與連線的時間，扣除儲存等待 |
| `totalMs` | 含排隊的 Gateway 總時間；不含前端 HTTP 傳輸或 Codex 思考時間 |
| `responseContentBytes` | 回傳 content 的文字／base64 UTF-8 位元組數；不含 JSON 外層，並非實際網路流量 |
| `connectionProbeRetries` | 開檔連線時未確認身分的唯讀探測次數，與使用者程式碼重試不同 |
| `errorCode` | 安全的錯誤類別；不記錄原始例外訊息 |

四項階段耗時互不重複；未分類的少量 Gateway 處理成本包含在總時間內。`BUSY` 在接受排隊前拒絕，只記錄拒絕資訊。HTTP 授權／schema 失敗發生於 Gateway 之前，不在這份操作紀錄內。

`browser_started`、`editor_ready`、`page_selected`、`editor_lost`、`browser_closed` 提供生命週期事件與當時的 Node RSS；它不包含 Chromium 記憶體。正常閒置回收以 `operation=idle_reclaim` 關聯耗時，非預期遺失才回報 `editor_lost`。首次連線探測可能遇到尚未連上的上游錯誤，應與最終開檔結果及 probe 次數一起判讀。

沒有新增每次讀寫的額外 MCP 往返，也不為紀錄重新序列化大型回應。使用 `npm run test:diagnostics` 在專用 fixture 對照開啟／停用紀錄的暖機讀取與 1 MiB 回應；數據是當次主機環境的比較，並非普遍延遲保證。
