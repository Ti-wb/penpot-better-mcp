# Agent 操作指引

MCP 初始化與 `high_level_overview` 都提供相同核心指引。以下為完整工作流程。

1. `open_document({url})` 取得 handle，必要時 `inspect_document` 讀頁面清單。Proxy 自行啟動 headless 編輯器。
2. `open_page({documentHandle, pageId})` 切頁，改用回傳的新 handle；不再使用的舊 handle 要關閉。建立頁面時先以 `execute_code` 執行 `const p = penpot.createPage(); p.name = "Draft"; return p.id;`，再交給 `open_page`。不要在設計腳本中直接導航。
3. 讀取相關 API 文件，先讀現況，再以小批次修改。單檔高頻工作可從每批 100 個圖形開始，視耗時與資料大小調整。查詢只回傳所需欄位或摘要，避免每一步重新列出整份文件。
4. 連續操作可用 `save: "deferred"`；批次完成、交接或收尾前執行 `flush_document`。預設 `save: "wait"` 則逐次確認。不要把 deferred 成功當成已儲存。
5. 讀回重要計數／ID／修改結果，再關閉不需要的 handles。所有非同步修改都應在腳本內 `await`，避免回傳後仍有背景寫入。

文件與頁面 target 綁定在 handle 上。`open_page` 保留同一編輯器的 Plugin storage；切檔、閒置回收、故障重建會清空暫存，所以重要 ID 與批次進度應由呼叫端保存。每次 `open_page` 都產生新 handle，不要任由它們累積到 128 個上限。

關閉已被取代的 handle 會確認當前待儲存工作，但保留其他 handle 正在使用的編輯器；關閉最後一個 handle 才退出瀏覽器。可用回傳的 `browserReleased` 與 `remainingHandles` 確認收尾狀態。預設 10 分鐘閒置回收會退出瀏覽器，下一次呼叫可用原 handle 重新載入。

## 權限與錯誤

| 回應 | 處理方式 |
|---|---|
| `DOCUMENT_CONTEXT_CHANGED` | 該次使用者程式碼尚未執行；明確呼叫 `open_page` 或 `open_document`，使用新 handle |
| `PLUGIN_PERMISSION_DENIED` | 看 `permission` 欄位；停止重試受限 API，設計內容存取是否可用要分開判斷。腳本可能已完成前段修改，應先讀回 |
| `SCRIPT_SYNTAX_ERROR` | 依 `details.upstreamMessage` 保留的原始錯誤修正 JavaScript，縮小腳本並檢查括號／字串。此類別也可能是執行時拋出的 SyntaxError，不能假定全部修改都未發生 |
| `EXECUTION_UNKNOWN`／`SAVE_UNCONFIRMED` | 不重送寫入；重新 open 取得 fresh handle，讀回已保存的資料後再調整。新 handle 成功不會替舊寫入背書 |
| `BUSY` | 等待已有操作完成，再降低併發；超過 32 筆接受中的操作會拒絕 |

API 文件不代表已取得權限。缺少 `user:read` 的 Plugin 無法存取 `activeUsers`。一般設計請省略 `currentUser` / `activeUsers` 探測；Gateway 不替 Plugin 擴權，升級後請驗證自己的站點。

任意 JavaScript 不是交易，工具失敗也可能已有部分修改。執行較短、目的單一的片段，將建立結果 ID 留在呼叫端，先檢查再重試。此 worker 是一個帳號的可信任工作環境，尚未提供多租戶隔離或方案 C 的直接後端讀寫。
