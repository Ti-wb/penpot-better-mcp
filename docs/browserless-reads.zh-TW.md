# 無瀏覽器讀取

[English](browserless-reads.md) | **繁體中文** | [README](../README.zh-TW.md)

`read_document` 直接透過 HTTP 取得已儲存設計資料，不啟動 Chromium、Plugin 或官方 MCP sidecar。沿用本機登入 session，不需要新增設定或 token。編輯、渲染與任意 Plugin JavaScript 維持現有瀏覽器流程。MVP 降低執行時資源，現有映像仍包含 Chromium。

## 使用方式

直接傳入 workspace URL，不需先 `open_document`：

```js
read_document({url}) // 檔案資訊、revision、頁面與圖形數
read_document({url, view: "shapes", pageId, limit: 500,
  fields: ["name", "type", "x", "y", "width", "height", "fills", "content"]})
// 後續批次沿用第一筆的 snapshotId 與回傳的 nextOffset：
read_document({url, view: "shapes", pageId, limit: 500,
  fields: ["name", "type", "x", "y", "width", "height", "fills", "content"],
  offset: nextOffset, snapshotId})
```

`pageId` 預設使用 URL 的頁面，未指定則取第一頁。`shapeIds` 可選取最多 200 個已知 ID；未指定時以 ID 排序並分批回傳。一定包含 `id`，其他欄位為後端原始 camelCase key。例如後端 `type: "frame"` 對應 Plugin 的 board，富文字位於 `content`。這些是 JSON 資料，不是 Plugin 物件或即時計算的排版結果。根 frame 不列入圖形數與結果，摘要計數包含巢狀圖形。

`nextOffset` 為 `null` 表示讀取結束。後續批次須維持**相同欄位、頁面與篩選條件**，並傳入 `snapshotId`；遇到 `SNAPSHOT_CHANGED` 重新掃描，不保留歷史快照。未使用此檢查時，每次呼叫各自讀取當下已儲存版本。

## 一致性與限制

- 讀取不會自動關掉先前編輯留下的瀏覽器。編輯完成請以 `close_document` 釋放 handle；持續同檔讀取也會延後既有的閒置計時器。
- 同檔呼叫與寫入共用佇列。讀取會等待先前已接受的寫入及儲存確認；緊接 deferred 寫入時，包含存檔等待與重新下載完整檔案，但看不到其他 Gateway 或人類編輯器尚未儲存的修改，也不提供跨呼叫交易。
- 每次都向 Penpot 呼叫 `get-file`，有快取時帶上 `If-None-Match`。Penpot 的 ETag 納入身分、檔案版本與權限；304 可沿用序列化資料，變更時重新下載。權限或網路失敗時不回傳舊快取，憑證變更會清空快取。
- 只傳送符合設定站點、路徑、安全與有效期限的 cookies，拒絕 redirect。診斷紀錄不加入 cookies、內容、URL 或檔案 ID。仍不支援 viewer／分享連結。MVP 使用 session cookies，獨立 PAT 設定留待後續。
- 最多同時執行兩筆讀取，不受瀏覽器容量限制；仍受每檔與全域佇列上限約束。快取最多四個檔案、**序列化資料合計 32 MiB**；HTTP 回應**解壓後最多 32 MiB**；工具輸出 **4 MiB**；每批最多 **1,000 個圖形**。MVP 上限固定；解碼與處理中的資料另需暫時記憶體。即使 304 仍會重新解析快取 JSON；保留序列化資料而非完整物件樹，以部分 CPU 成本換取可控的常駐快取。
- 相較於直接查詢已載入的編輯器，每次都會增加後端與網路工作。304 減少傳輸與伺服器解碼，但仍需查詢版本／權限。後端延遲或負載高時，速度優勢可能縮小甚至反轉，尤其是小量讀取。
- 冷讀取與快取未命中會下載**完整檔案**。欄位選取與分批主要減少 MCP 輸出，不減少首次下載量。伺服器不提供 ETag 時，每次都重新下載。快取僅存於記憶體，成功關機時清除。既有 `PENPOT_TIMEOUT_MS` 適用於每次後端 HTTP 請求；Compose 目前使用內建預設值。

## 可行性與後續方向

| 方向 | 收益 | 代價／狀態 |
|---|---|---|
| 完整 JSON 快照＋ETag | 省去瀏覽器啟動、常駐與重複檔案傳輸，容易提供結構化讀取 | 已實作 MVP；仍需首次完整下載，每次仍有一次伺服器往返 |
| `get-page`／物件子樹，再加入 fragment 快取 | 查詢大型檔案局部內容時，減少冷讀取傳輸與解碼 | 建議下一步；`get-page` 沒有相同檔案 ETag 契約，須額外確認版本一致性 |
| 透過 Webhook 維護查詢索引 | 重複搜尋／統計不必每次解碼設計檔 | 需新增同步、權限重驗、儲存與過期索引復原機制，目前過重 |

後端 API 可行，但屬於會隨版本改變的內部 RPC，不等同 Plugin API 契約。MVP 請求 JSON，且不宣告 pointer／objects-map 功能，讓後端解析這些結構。不應把任意 `execute_code` 自動視為唯讀，也不應為了降低延遲而回傳未重驗的舊快取。圖片、字型／排版計算、選取狀態與 Plugin storage 仍需瀏覽器。

來源：[官方 access token 整合文件](https://help.penpot.app/technical-guide/integration/)、[Penpot 2.18.6 的 `get-file`、`get-page` 與權限檢查](https://github.com/penpot/penpot/blob/2.18.6/backend/src/app/rpc/commands/files.clj)、[ETag middleware](https://github.com/penpot/penpot/blob/2.18.6/backend/src/app/rpc/cond.clj)、[功能相容性](https://github.com/penpot/penpot/blob/2.18.6/common/src/app/common/features.cljc)。

## 驗證

`npm run test:reads` 使用專用驗收檔案，只清除該次建立的圖形與頁面。比對後端與 Plugin API 欄位、deferred 寫入可見性、跨頁讀取、快照失效，再量測冷／暖掃描、單一圖形查詢與八路併發。可用 `READ_SHAPES`（預設 3000）、`READ_SAMPLES`（預設 12）調整負載；既有站點請在私人 `.env` 設定 manifest、session 路徑與上游位址，再執行 `node --env-file=.env --import tsx test/browserless.ts`；詳見[測試指南](testing.zh-TW.md)。

結果寫入已忽略的 `test-results/`，部署專用報告請留在本機。瀏覽器 RSS 為各程序加總，並非去重後的實體記憶體；Node RSS 包含測試、client 與序列化配置。冷掃描是在已啟動的 Gateway 中清空檔案快取／重新開啟編輯器，只有瀏覽器路徑包含編輯器啟動；暖比較使用相同欄位，儲存確認不計入讀取計時。結果只代表這組負載，不保證每種讀取都更快。短期連讀不能證明完全沒有記憶體洩漏，本次也未獨立量測 CPU 用量。

單元測試以模擬後端回應覆蓋權限拒絕／session 過期、憑證更換、快取失敗、輸出上限與佇列行為。真實環境使用已授權測試帳號，尚未實測唯讀角色及即時撤銷權限情境。

## 效能量測

兩路徑應使用同一頁、相同欄位、批次大小與 fixture 圖形，分開比較冷掃描、暖掃描、單一圖形查詢與併發讀取。寫入緊接讀取的情境須將儲存確認一併計時。

後端讀取可省去瀏覽器啟動與編輯器常駐成本，但每次呼叫仍需處理後端與網路工作，較高的後端延遲會降低效益。關閉編輯 handles 後，純讀取不需瀏覽器程序。請依[效能指南](performance.zh-TW.md)量測自己的負載，環境細節與原始結果僅保存在已忽略的本機報告。
