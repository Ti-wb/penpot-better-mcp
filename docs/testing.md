# 測試指南

一般修改先跑快速回歸，依改動選擇真實環境驗收；負載量測不放進日常回歸。測試只使用專用 `Headless acceptance …` 檔案，結果保存在未追蹤的 `test-results/`，不讀寫正式設計。

## 測試入口

| 指令 | 覆蓋與執行時機 |
|---|---|
| `npm run check && npm test` | 型別與 28 項單元／HTTP 回歸；每次修改必跑，不需 Penpot |
| `npm run test:acceptance` | 建置後跑 stdio／HTTP、PNG、持久化與四 client 同檔／跨檔；修改路由或發佈前執行 |
| `npm run test:editor` | 批次儲存、SVG／PNG fill、頁面與錯誤分類；修改 adapter 或升級 Penpot 時執行，限隔離 fixture |
| `npm run test:faults` | 初始化／導航／認證、SDK／sidecar timeout、browser／page loss、容量與 SIGTERM 關機；修改生命週期時執行，限隔離 fixture |
| `npm run test:load` | 每檔 3,000 圖形、直連／Proxy 比較、8 路讀取、過載與連續掃描；效能調整時選跑 |
| `npm run test:reclamation` | 單檔 3,000 圖形多輪讀寫、切頁、明確／閒置回收與程序資源；回收或記憶體調整時選跑 |
| `npm run test:diagnostics` | ABBA 開關紀錄對照，暖讀與 1 MiB 回覆；紀錄功能調整時選跑 |

`test:acceptance` 由 `e2e.ts` 與 `multi-client.ts` 組成；`test:editor` 涵蓋頁面、批次與 Plugin 錯誤；`test:faults` 共用 SDK／sidecar timeout 情境，並以獨立子程序測關機。Fixture 檢查、登入路徑及回報共用 [test/support.ts](../test/support.ts)。

## 隔離環境

```bash
npm ci
npm run browser:install
docker compose -f compose.dev.yaml up -d
docker compose -f test/compose.yaml --profile faults up -d
# 首次建立測試帳號、兩個專用檔案及本機 session：
npm run fixture:setup
npm run check && npm test
npm run test:editor
npm run test:faults
npm run test:acceptance
```

一般驗收預設讀 `.state/latest-targets.json` 與 `.state/latest-session.json`。Fault/editor 測試另外檢查站點必須是 `http://127.0.0.1:19001`；短逾時 sidecar 使用 `faults` profile 的 14411／14412 ports。主開發 sidecar 為 14401／14402，與正式 Gateway 的私有 sidecar 分開。

測試 Compose 固定 Penpot 2.18.6 的 digest；這是 2026-11-06 查詢官方 `latest` 的版本，不是永遠浮動的 latest。驗證新版本時請同步核對 frontend、backend、exporter、MCP 並更新 [Compose](../test/compose.yaml)。Loopback fixture 的簡化登入與固定測試憑證不可用於正式站。

## 內網與實際 endpoint

明確提供兩個專用檔案的 manifest 及有權限的 storageState：

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:acceptance
# 改走已部署 Gateway；兩個驗收腳本共用同一 endpoint 設定：
E2E_TARGETS_FILE=.state/acceptance-targets.json E2E_HTTP_URL=http://127.0.0.1:4545/mcp npm run test:acceptance
```

HTTP token 從 `.state/gateway-token` 讀取，不輸出至紀錄。Manifest 格式為 `{ "base": "站點 origin", "files": [{ "id": "file UUID", "name": "Headless acceptance A", "url": "workspace URL" }, { "id": "另一個 file UUID", "name": "Headless acceptance B", "url": "workspace URL" }] }`；檔案必須事先存在且確實是專用測試檔，腳本不會搜尋使用者設計。

壓測需自行設定 `E2E_TARGETS_FILE`；指定內網時，亦明確設定 `PENPOT_STORAGE_STATE`。`LOAD_KEEP_FIXTURE=1` 才保留圖形供同輪對照；預設清理。完整方法與選跑參數見 [效能摘要](performance.md)。

## 必要回歸與驗證邊界

| 風險／能力 | 保留的驗證 |
|---|---|
| 同檔互相覆寫、跨檔被全域佇列阻塞 | 4 個獨立 MCP clients，以 read-await-modify 檢查同檔區間不重疊、跨檔確實重疊及遞增不遺失 |
| 錯頁／錯檔寫入 | URL 正規化、不可變 handles、誤導航前置拒絕；同檔新舊頁 handles 沿用 editor／storage |
| 執行成功但尚未保存 | 攔截 backend save，確認 flush 不提早成功；冷重開讀回、PNG／SVG 與原尺寸填色匯出 |
| 未知寫入被重送或當成成功 | browser／page loss、SDK／sidecar timeout；舊 handle 保留未知狀態，晚到與排隊腳本不執行 |
| 容量或資源洩漏 | 初始化失敗、容量 1 回收、慢 close 不阻塞其他 slot、不多回收、閒置重試與 handle 額度 |
| 關機中斷工作 | 真實 HTTP 子程序的 12 秒寫入、重複 SIGTERM、一次 close 失敗注入、恢復讀取、自動重試與冷讀 |
| 錯誤與紀錄失真 | Plugin 權限／語法錯誤、一般回傳不誤判、HTTP 授權、紀錄遮罩與階段計時 |

驗證環境是無 DISPLAY 的 Linux VM，內網 Penpot 2.18.5 及隔離 2.18.6。官方部署的 4 個公開 MCP 工具已覆蓋；不代表每個 Plugin API、唯讀角色或動態撤權組合皆經實測。分享／viewer 連結、多租戶、跨站授權及 SSO/MFA 自動更新不在目前實作範圍。

最近驗證（2026-11-06）：28 項快速回歸；隔離 fixture 的編輯器 16 組、故障 8 組、關機 5 項，以及最新版 stdio／內網 Docker 各 13 項一般與多 client 驗收，全部通過。測試圖形與臨時頁面已清理。

原始結果為 `acceptance.json`、`multi-client.json`、`editor.json`、`faults.json`、`shutdown.json`，內網為 `tidy-internal-acceptance.json`、`tidy-internal-multi.json`。效能量測的版本、日期與樣本數另列於 [效能摘要](performance.md)。

## 收尾

測試會清理自己建立的圖形與臨時頁面；`test:load` 的固定前綴 fixture 不應同時啟動多輪。確認測試程序已結束後，只停止測試服務：

```bash
docker compose -f compose.dev.yaml down
docker compose -f test/compose.yaml --profile faults down
```

`down` 保留 volumes。只有明確要重置隔離 fixture 時才使用 `down -v`；正式 Gateway 不屬於上述測試服務。正常關機的儲存保障及外部強制終止限制見 [README](../README.md)。
