# 效能指南

[English](performance.md) | **繁體中文** | [README](../README.zh-TW.md)

效能取決於檔案內容、主機容量、後端延遲與同時執行的工作。規劃部署容量前，請以自己的專用 fixture 量測。已儲存資料的讀取路徑及限制見[無瀏覽器讀取](browserless-reads.zh-TW.md)。

## 比較項目

- 直連 Plugin 與 Gateway 使用相同檔案、頁面、欄位及批次大小，分開量測編輯器啟動、暖讀與寫入／儲存延遲。
- 分別比較單檔、同檔多頁與多檔；同檔呼叫依序執行，跨檔工作則受瀏覽器容量限制。
- 關閉並重新開啟編輯器，確認已儲存資料。Deferred 執行回覆不代表已落盤，寫入完成後須呼叫 `flush_document`。
- 分別記錄 Node、Chromium 與容器記憶體；各程序 RSS 加總可能重複計算共享頁，容器數值另含 file cache。
- 確認最後一個 handle 關閉及閒置回收後，瀏覽器與 relay sockets 均已釋放。短時測試不能證明長期記憶體穩定。
- 以相同負載比較診斷紀錄開關，解讀本機結果時附上樣本數、中位數、尾端延遲與離群值。

Adapter 會清除 browser console 參照，不強制 GC，也不移除 MCP 日誌或 Plugin storage。這可減少結果物件被持續保留，但不會限制單一編輯器的記憶體用量。

## 本機執行

依[測試指南](testing.zh-TW.md)準備可拋棄的 fixture 或專用驗收檔案。既有站點的 `E2E_TARGETS_FILE`、`PENPOT_STORAGE_STATE` 與上游位址請放在私人 `.env`，設定範例見 [.env.example](../.env.example)：

```bash
node --env-file=.env --import tsx test/load.ts
node --env-file=.env --import tsx test/reclamation.ts
node --env-file=.env --import tsx test/diagnostics.ts
```

隔離 fixture 可沿用既有 npm 測試指令，不載入站點專用設定。負載測試需明確設定 `E2E_TARGETS_FILE`。

- `LOAD_SHAPES` / `RECLAIM_SHAPES`：fixture 圖形數，調整後須重新比較。
- `LOAD_KEEP_FIXTURE=1`：保留負載圖形；一般清理流程不要設定。
- `LOAD_MEMORY_ONLY=1`：僅量測記憶體。
- `LOAD_BASELINE_DIR` / `MULTI_BASELINE_DIR`：本機比較用的已編譯基準目錄。多 client 測試另以 `node --env-file=.env --import tsx test/multi-client.ts` 執行。

報告保存在已忽略的 `test-results/`。站點網址、文件 ID、部署版本、主機規格與原始部署量測請留在本機證據，不寫入追蹤文件。

## 適用範圍

合成矩形測試未涵蓋每個 Plugin API、複雜元件與 Auto Layout、大量圖片／字型、無上限回傳或多日工作階段。瀏覽器數量上限不代表單一編輯器的記憶體上限。欄位篩選與分頁可縮小後端讀取的輸出，但冷快取仍需取得整份檔案。單一環境的結果不能作為通用容量或延遲保證。
