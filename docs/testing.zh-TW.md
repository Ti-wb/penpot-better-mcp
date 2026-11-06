# 測試指南

[English](testing.md) | **繁體中文** | [README](../README.zh-TW.md)

先跑快速檢查，再依改動選擇整合測試；負載測試另外選跑。測試只使用專用 `Headless acceptance …` 檔案，不操作正式設計；結果保存在未追蹤的 `test-results/`。

## 測試指令

| 指令 | 覆蓋與執行時機 |
|---|---|
| `npm run check && npm test` | 型別與單元／HTTP 回歸；日常修改，不需 Penpot |
| `npm run test:acceptance` | 建置、stdio／HTTP、PNG、持久化與四 client 同檔／跨檔；路由修改或發佈前 |
| `npm run test:editor` | 批次儲存、SVG／PNG fill、頁面與 Plugin 錯誤；adapter 修改或 Penpot 升級，限隔離 fixture |
| `npm run test:faults` | 啟動／導航／認證、SDK／sidecar timeout、browser／page 遺失、容量與關機；生命週期修改，限隔離 fixture |
| `npm run test:reads` | 無瀏覽器 HTTP、ETag 驗證、已儲存資料一致性、3,000 圖形對照與記憶體；後端讀取變更 |
| `npm run test:load` | 每檔 3,000 圖形、直連／Proxy 比較、併發讀取、過載與連續掃描；效能修改 |
| `npm run test:reclamation` | 單檔 3,000 圖形的連續讀寫、切頁、明確／閒置回收與程序資源；資源生命週期修改 |
| `npm run test:diagnostics` | ABBA 紀錄開關對照，暖讀與 1 MiB 回覆；紀錄功能修改 |

驗收由 `e2e.ts` 與 `multi-client.ts` 組成；故障測試另以獨立程序執行 `shutdown.ts`。Fixture 檢查、session 路徑與回報共用 [test/support.ts](../test/support.ts)。

## 隔離環境

```bash
npm ci
npm run browser:install
docker compose -f compose.dev.yaml up -d
docker compose -f test/compose.yaml --profile faults up -d
# 首次執行：建立測試帳號、兩個檔案與本機 session。
npm run fixture:setup
npm run check && npm test
npm run test:editor
npm run test:faults
npm run test:acceptance
```

預設使用 `.state/latest-targets.json` 與 `.state/latest-session.json`。Editor／fault 測試要求站點為 `http://127.0.0.1:19001`。開發 sidecar 使用 14401／14402 ports，`faults` sidecar 使用 14411／14412；兩者均與正式 Gateway 的私有 sidecar 分開。

[測試 Compose](../test/compose.yaml) 以 digest 固定 Penpot 2.18.6。升級時請一起核對 frontend、backend、exporter 與 MCP 版本。Loopback fixture 的簡化認證與固定測試憑證僅供隔離測試。

## 既有站點驗收

提供兩個專用檔案的 manifest，以及已授權的 storageState：

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:acceptance
# 改測已部署的 HTTP Gateway。
E2E_TARGETS_FILE=.state/acceptance-targets.json E2E_HTTP_URL=http://127.0.0.1:4545/mcp npm run test:acceptance
```

HTTP token 從 `.state/gateway-token` 讀取，不寫入紀錄。Manifest 格式：`{ "base": "site origin", "files": [{ "id": "file UUID A", "name": "Headless acceptance A", "url": "workspace URL A" }, { "id": "file UUID B", "name": "Headless acceptance B", "url": "workspace URL B" }] }`。專用測試檔必須事先存在，腳本不會搜尋使用者設計。

負載測試需明確設定 `E2E_TARGETS_FILE`；使用既有站點站點時另設 `PENPOT_STORAGE_STATE`。預設清理 fixture，`LOAD_KEEP_FIXTURE=1` 才保留負載圖形。參數與重現方式見[效能摘要](performance.zh-TW.md)。

## 覆蓋範圍

測試以四個獨立 clients 檢查同檔序列化與跨檔重疊，並涵蓋頁面／handle 目標、儲存確認與冷讀、未知寫入、容量限制、回收、關機恢復、錯誤分類與紀錄遮罩。關機情境包含 12 秒寫入、重複 SIGTERM、注入一次 close 失敗、恢復讀取與自動重試。

已覆蓋部署中官方上游的四個公開 MCP 工具，不代表每個 Plugin API、唯讀角色或動態撤權組合均已驗證。Viewer／分享連結、多租戶／跨站與 SSO/MFA 自動更新仍不在實作範圍。

既有報告位於 `test-results/`：`acceptance.json`、`multi-client.json`、`editor.json`、`faults.json`、`shutdown.json`、`local-report.json` 與 `local-report.json`。效能測試條件與結果另見[效能摘要](performance.zh-TW.md)。

## 收尾

測試會清理自己建立的圖形與頁面；同一組固定前綴 fixture 不可同時執行多輪負載測試。確認程序結束後，只停止測試服務：

```bash
docker compose -f compose.dev.yaml down
docker compose -f test/compose.yaml --profile faults down
```

`down` 保留 volumes，只有明確要重置 fixture 時才使用 `down -v`。上述指令不會停止正式 Gateway，其關機與儲存行為見 [README](../README.zh-TW.md)。
