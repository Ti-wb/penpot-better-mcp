# Penpot Better MCP

讓 MCP client 只提供 Penpot 檔案連結，就能在 Linux VM 的 headless Chromium 中開檔、讀寫與匯出。使用者不需要維持瀏覽器分頁。

第一版使用官方 MCP 與 Penpot 內建 Plugin。`DesignAdapter` 將編輯操作與 browser lifecycle 分開，之後可加入後端 API adapter，讓結構化查詢直接走 API。

## 執行範圍

- 每組 gateway 對應一位已登入使用者與一個明確設定的 Penpot 站點。
- 支援 workspace 檔案／頁面連結。自動開啟、連接 Plugin；不同檔案可平行執行，同檔案的所有頁面與 handles 共用依序執行的佇列。
- 使用獨立官方 MCP sidecar；只轉送受管瀏覽器的 MCP WebSocket，不影響設計協作 WebSocket，也不依賴使用者原本的 MCP client token。
- Session 過期會回傳 `AUTH_REQUIRED`，重新執行登入指令即可。SSO/MFA 的互動式登入尚未實作，可提供已授權的 Playwright storageState。
- 分享／viewer 連結目前明確拒絕，避免誤升級成完整檔案權限。多使用者服務、跨站自動授權與純後端 API adapter 是下一階段。

驗收版本與實際結果見 [verification.md](docs/verification.md)，功能範圍見 [functionality.md](docs/functionality.md)。

## 快速開始：Docker

需要 Docker Compose 與 Node.js 22+（用於初始化本機 token）；不需要桌面、X server 或 `DISPLAY`。第一次登入需在自己的互動式 terminal 完成，密碼不會回顯，也不會寫到 shell history 或檔案。

```bash
# 建立 session 目錄及獨立的 gateway bearer token（不輸出 token）
node scripts/init-state.mjs
docker compose build gateway

# 可在 headless VM 的 SSH terminal 操作；同時允許首次啟用此帳號的 MCP。
docker compose run --rm auth --base-url https://penpot.example.com --enable-mcp

docker compose up -d upstream gateway
curl http://127.0.0.1:4545/healthz
```

若 VM 的使用者不是 UID/GID `1000:1000`，在 `.env` 設定 `LOCAL_UID`、`LOCAL_GID`。先登入產生 `.state/session.json` 才啟動 gateway。session 及 bearer token 權限為 `0600`；gateway 僅唯讀掛載 `.state`，Docker build context 與 Git 都排除該目錄。`--enable-mcp` 會在必要時啟用 MCP 及建立金鑰，不會輪替既有有效金鑰；若只要登入可省略此選項。

MCP endpoint 為 `http://127.0.0.1:4545/mcp`，使用 Streamable HTTP，必須帶 `Authorization: Bearer <.state/gateway-token 的內容>`。此 token 代表該 gateway 的完整操作權限。保留 loopback binding；跨主機使用可透過 SSH tunnel。`/healthz` 只表示服務存活，不代表 Penpot session 仍有效。

也可以用 stdio，不需將 bearer token 放進 MCP client 設定：

```bash
docker compose up -d upstream
docker compose run --rm --no-deps -T gateway --stdio
```

MCP client 啟動命令可設定為 `docker`，arguments 為：

```json
["compose", "--project-directory", "/absolute/path/to/penpot-better-mcp", "run", "--rm", "--no-deps", "-T", "gateway", "--stdio"]
```

同一位使用者的多個獨立 gateway 有各自的檔案 handle，不會共用 browser。若共用一個 HTTP endpoint，請視為同一個可信任操作身分，不是多租戶服務。

## MCP 操作

| Tool | 用途 |
|---|---|
| `open_document(url)` | 開啟檔案，回傳 `documentHandle`、檔案資訊及頁面清單 |
| `inspect_document(documentHandle)` | 讀取目前文件資訊 |
| `open_page(documentHandle, pageId)` | 同檔切頁並取得新的頁面 handle，保留舊 handle 的目標；重用目前 editor |
| `execute_code(documentHandle, code, save?)` | 使用官方 Plugin API 執行 JavaScript；`save` 可選 `wait` 或 `deferred` |
| `flush_document(documentHandle)` | 等待先前批次寫入完成儲存 |
| `export_shape(documentHandle, shapeId, format, mode?)` | 回傳 PNG 圖片或 SVG 文字；`mode=fill` 匯出原始圖片填色（PNG） |
| `close_document(documentHandle)` | 確認儲存並釋放 handle；同檔最後一個 handle 關閉時釋放該檔 browser |
| `high_level_overview()` | 官方操作概覽 |
| `penpot_api_info(type, member?)` | 官方 API 文件 |

先讀取概覽及所需 API 文件，再執行操作。每次工具呼叫都指定 handle，避免使用隱含的「目前分頁」。程式碼必須 `await` 自己啟動的工作，不要留下未等待的背景修改。Plugin 的 `storage` 由同檔各 Agent 共用，會在 worker 回收及恢復 browser 時重置，需延續使用的物件 ID 請由 client 保存。本次官方 sidecar 的工具清單不含本機路徑 `import_image`；圖片可透過 `execute_code` 與 Plugin media API 匯入。

切頁請呼叫 `open_page(handle, pageId)`，並使用回傳的 **新 handle**。它會先確認儲存，再透過目前 editor 切頁，不會重新載入瀏覽器分頁。建立頁面時先用 `execute_code` 回傳 `penpot.createPage()` 的 ID，再交給 `open_page`。若程式自行呼叫 `penpot.openPage`，下一次沿用原頁 handle 會回 `DOCUMENT_CONTEXT_CHANGED`，附上 `details.expected`／`details.actual`；該次使用者程式尚未執行。此時明確選擇頁面取得新 handle 即可，舊 handle 不會被靜默改綁。

預設 `save: "wait"` 會等待編輯器穩定顯示 saved，並確認沒有未完成或失敗的儲存請求，避免讀到前一次儲存的狀態。高頻讀取或連續批次修改請用 `save: "deferred"`，避免每一筆都等待儲存；完成一批寫入後呼叫 `flush_document`。切頁、worker 回收與正常關閉也會等待儲存。

`close_document` 回傳 `browserReleased`、`remainingFileHandles` 與全域的 `remainingHandles`。關閉舊頁面的 handle 不會打斷其他 handle 使用的編輯器或清除 Plugin storage；同檔最後一個 handle 關閉才回收該檔瀏覽器，其他檔案仍可繼續執行。不再使用的 handles 應主動關閉。預設閒置 10 分鐘也會確認儲存並回收瀏覽器，保留 handles 供下次重新開檔；儲存未確認時保留編輯器，下一個閒置週期再檢查。

```text
open_document(url) → documentHandle
execute_code(documentHandle, code, save="deferred")
execute_code(documentHandle, code, save="deferred")
flush_document(documentHandle) → saved: true
```

`deferred` 的成功只表示程式執行完成，**不代表資料已落盤**；回覆的 `_meta.saveState` 為 `not_confirmed`。`wait` 及 `flush_document` 也不是跨系統交易保證。`EXECUTION_UNKNOWN` 或 `SAVE_UNCONFIRMED` 表示結果不確定，應先檢查文件，**不要直接重送寫入**。任意 JavaScript 可能在失敗前完成部分修改。

未確認寫入後若瀏覽器中斷或執行逾時，同檔案的既有 handle 會拒絕後續 `execute_code`／`flush_document`。`inspect_document` 仍可讀取文件資訊，並標記 `_meta.saveState: "unknown"`。請用 `open_document` 取得新 handle，讀回物件確認實際狀態，再決定是否補寫；其他檔案的 handle 可繼續使用。新 handle 不代表舊寫入已保存，確認後可關閉舊 handle。

每個檔案的 worker 依序處理操作，最多接受 32 個執行中／排隊請求；全域最多 128 個請求與 128 個 handles，超量請求回傳 `BUSY`。預設 `PENPOT_MAX_WORKERS=2`，最多保留兩個瀏覽器，可設為 1–16。超過容量時，先確認儲存再回收最久未使用的閒置 worker；工作中的檔案不會被回收，所有候選檔案均無法確認儲存時回 `WORKER_CAPACITY`。

多 Agent 請共用同一 HTTP endpoint。序列化以單次工具呼叫為單位，不會鎖住 Agent 的整段工作流程；依賴現值的讀取與修改應放進同一個 `execute_code`，或在寫入前檢查前置條件。各 Agent 應分配圖形範圍、使用不同的 storage key。一次程式碼可修改多個物件，通常比逐一呼叫工具有效率；大量讀取應只回傳需要的欄位及範圍。

## 本機開發

```bash
npm ci
npm run browser:install
npm run init
npm run auth -- --base-url https://penpot.example.com
npm run build
npm test
```

本機 Node 執行需要可連線的私有 MCP sidecar。使用 `compose.dev.yaml` 提供僅 loopback 可達的 HTTP / WebSocket：

```bash
docker compose -f compose.dev.yaml up -d
npm run dev -- --stdio
# HTTP 開發：npm run dev -- --http（預設 127.0.0.1:3000）
```

可用環境設定見 [.env.example](.env.example)。Node 不會隱式載入 `.env`；使用 shell 環境或 `node --env-file=.env dist/main.js`。Compose 會讀取 `.env`。

## 測試與停止

```bash
npm run check
npm test
docker compose -f test/compose.yaml up -d
# 最新映像的本機 fixture 建立與完整驗收：
npm run fixture:setup
E2E_TARGETS_FILE=.state/latest-targets.json PENPOT_STORAGE_STATE=.state/latest-session.json E2E_REPORT=latest.json npm run test:e2e
npm run test:recovery
npm run test:batch
npm run test:pages
npm run test:diagnostics
npm run test:guidance
npm run test:reclamation
E2E_TARGETS_FILE=.state/latest-targets.json PENPOT_STORAGE_STATE=.state/latest-session.json npm run test:multi
# 生命週期故障回歸（需要額外的短逾時 sidecar）：
docker compose -f test/compose.yaml --profile faults up -d penpot-mcp-timeout
npm run test:lifecycle
# 關機訊號、儲存失敗重試與 HTTP 回應送達（先 npm run build）：
npm run test:shutdown

docker compose down
docker compose -f compose.dev.yaml down
docker compose -f test/compose.yaml --profile faults down
```

測試 Compose 的映像固定為本次從官方 `latest` 拉取的 2.18.6 digest；重新驗證新版本時應一起更新 frontend、backend、exporter、MCP。測試帳號與簡化驗證設定只用於 loopback fixture，不能作為正式站設定。

原生測試需要先啟動 `compose.dev.yaml` 的 sidecar。驗收 Docker gateway 時，可在 `test:e2e` 加上 `E2E_HTTP_URL=http://127.0.0.1:4545/mcp`，並指定與 gateway 站點相符的 `E2E_TARGETS_FILE`；測試會從本機 token 檔讀取授權，不會將 token 印出。

`SIGTERM`／`SIGINT`／`SIGHUP` 由 Gateway 統一處理，先等待已接受操作與儲存確認，再關閉瀏覽器與 HTTP／stdio。儲存失敗時保留未能關閉的 editor 與 HTTP 恢復入口，記錄 `shutdown_failed`，每 5 秒重試；已成功關閉的檔案 handles 仍會失效。Compose 預設提供 5 分鐘關機等待，可用 `GATEWAY_STOP_GRACE_PERIOD` 調整。很長的工作佇列需要更長等待，建議停止前先 flush；外部強制終止或超過 Docker 等待期限仍可能中斷未完成工作。

`down` 保留測試資料卷。只有要重置這個隔離 fixture 時才使用 `docker compose -f test/compose.yaml down -v`。內網驗收必須使用明確指定、名稱為 `Headless acceptance …` 的測試檔 manifest；不會自動搜尋或修改正式檔案。結果與截圖保存在未追蹤的 `test-results/`。

大量讀寫比較使用 `npm run test:load`；需明確提供 `E2E_TARGETS_FILE`，在兩個專用檔案各建立 3,000 個圖形。設定 `LOAD_PHASE=optimized` 使用批次模式，完成後會清理自身圖形。需要保留資料重跑時才使用 `LOAD_KEEP_FIXTURE=1`。比較方法、數字及限制見 [performance.md](docs/performance.md)。

## 架構與後續

詳見 [architecture.md](docs/architecture.md)。官方 MCP 仍在瀏覽器 Plugin 中執行；本專案管理登入、開檔、連線路由與回收。它沒有繞過 Penpot 的檔案權限，也沒有將 MCP token 當作後端 PAT 使用。

Gateway 預設記錄每次操作的排隊、啟動、上游、儲存與回收耗時，以及瀏覽器生命週期。欄位、隱私邊界與停用方式見 [diagnostics.md](docs/diagnostics.md)。

實際操作請參考 [Agent 指引](docs/agent-guide.md)：頁面 handle、批次儲存、暫存生命週期及權限錯誤恢復。這些核心規則也會直接隨 MCP 初始化與概覽提供給 Agent。

更新 Gateway 新增工具後，MCP client 需要重新探索工具清單。本次 Codex 驗收中，新連線可見 9 個工具，既有執行中回合仍保留舊清單；請在新對話使用新增的 `open_page`。
