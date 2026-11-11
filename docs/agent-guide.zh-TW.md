# Agent 操作指引

[English](agent-guide.md) | **繁體中文** | [README](../README.zh-TW.md)

MCP 初始化與 `high_level_overview` 都提供相同核心指引。

只需已儲存摘要或圖形資料時，先用 `read_document({url})`，不需瀏覽器或 handle。以 `view: "shapes"`、`pageId`、`fields`、`limit`／`offset` 選取資料；後續批次帶上回傳的 `snapshotId`，遇到 `SNAPSHOT_CHANGED` 重新開始。詳見[無瀏覽器讀取](browserless-reads.zh-TW.md)。需要編輯或渲染時再使用下列流程。

## 操作流程

1. 以 `open_document({url})` 取得 handle；用 `inspect_document` 查看頁面清單。Gateway 會自行啟動 headless 編輯器。
2. 以 `open_page({documentHandle, pageId})` 切頁，改用回傳的新 handle。建立頁面時先執行 `const p = penpot.createPage(); p.name = "Draft"; return p.id;`，再將 ID 交給 `open_page`。不要在設計腳本內導航。
3. 先讀 API 文件與現有設計，再進行修改。高頻寫入可從每批約 100 個圖形開始，視負載調整；查詢只回傳需要的欄位或摘要。
4. 連續操作可用 `save: "deferred"`；寫入批次完成或交接前執行 `flush_document`。預設 `save: "wait"` 逐次確認儲存，deferred 成功只表示執行完成。
5. 讀回重要 ID、計數與修改結果，關閉不用的 handles。腳本內的非同步修改都應 `await`。

Handle 綁定檔案與頁面。每次 `open_page` 都產生新 handle，請關閉已被取代者，避免累積到 128 個上限。切頁會保留 Plugin storage；容量回收、閒置回收與故障重建會清空暫存，重要 ID 與進度應由 client 保存。

關閉 handle 會確認待儲存工作；同檔仍有其他 handles 時保留編輯器，最後一個關閉才釋放瀏覽器。可查看 `browserReleased`、`remainingFileHandles` 與全域 `remainingHandles`。預設閒置十分鐘也會回收瀏覽器，保留的 handle 可在下次呼叫時重新開啟。

## 多 Agent 協作

所有 Agent 請連到**同一個 HTTP endpoint**。不同檔案在瀏覽器容量內平行執行，同檔所有頁面共用佇列。預設保留兩個瀏覽器，確認儲存後才回收閒置檔案。個別 client 斷線不會關閉其他 client 的 handles；獨立 Gateway 或 stdio processes 不共用鎖。

佇列只保護單次呼叫。兩個 Agent 可能同時讀到 `x=0`，之後各寫 `x=1`，因而遺失一次遞增。將相依的「讀取、計算、寫入」放在同一段 `execute_code`，或寫入前核對現值，發現變動就停止。腳本失敗前可能已完成部分修改，不具交易保證。

同檔 Agents 共用 Plugin storage，請使用各自的 key 前綴，並分配圖形／頁面編輯範圍。人類或其他 Gateway 的編輯不受這條佇列保護。

## 權限與錯誤

| 回應 | 處理方式 |
|---|---|
| `DOCUMENT_CONTEXT_CHANGED` | 本次使用者程式碼尚未執行；呼叫 `open_page` 或 `open_document`，使用新 handle。 |
| `PLUGIN_PERMISSION_DENIED` | 查看 `permission`，停止重試受限 API。腳本前段可能已修改設計，應先讀回。 |
| `SCRIPT_SYNTAX_ERROR` | 依 `details.upstreamMessage` 修正腳本。執行時拋出的 SyntaxError 可能發生在修改之後，不能假定完全沒有變動。 |
| `EXECUTION_UNKNOWN` / `SAVE_UNCONFIRMED` | 不重送寫入；用新 handle 讀回已儲存資料。新 handle 成功不代表舊寫入已確認。 |
| `WORKER_CAPACITY` | 其他檔案無法確認儲存，不能安全回收；先處理其儲存狀態。本次設計程式尚未執行。 |
| `BUSY` | 等待既有工作完成並降低併發；接受中的操作上限為每檔 32、全域 128。 |

API 文件不代表已取得權限。缺少 `user:read` 的 Plugin 無法存取 `activeUsers`。一般設計請省略 `currentUser` / `activeUsers` 探測；Gateway 不替 Plugin 擴權，升級後應重跑 `npm run test:editor` 檢查自己的站點。
