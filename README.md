# Penpot Better MCP

讓 MCP client 提供 Penpot workspace 連結，就能在 Linux VM 的 headless Chromium 中開檔、讀寫及匯出，不需要使用者維持瀏覽器分頁。不同檔案可平行，同檔案的所有頁面與 handles 依序執行。

目前每個 Gateway 對應一位已登入使用者與一個 Penpot 站點。透過官方 MCP／內建 Plugin 執行操作，權限仍由 Penpot 判定。分享／viewer 連結、SSO/MFA 自動登入、多租戶與方案 C 的直接後端 API 尚未實作；SSO 使用者可提供已授權的 Playwright storageState。

## Docker 啟動

需要 Docker Compose、Node.js 22+（初始化 token）及可登入的 Penpot 站點，不需要桌面或 `DISPLAY`。設定以 [.env.example](.env.example) 為參考；站點可在 `.env` 的 `PENPOT_BASE_URL` 調整。

```bash
node scripts/init-state.mjs
docker compose build gateway
# 在自己的互動式 terminal 登入，密碼不回顯；網址須與 Gateway 設定一致。
docker compose run --rm auth --base-url https://penpot.example.com --enable-mcp
docker compose up -d upstream gateway
curl http://127.0.0.1:4545/healthz
```

先登入產生 `.state/session.json` 才啟動 Gateway。`--enable-mcp` 只在必要時啟用帳號的 MCP，不會輪替既有有效金鑰。若主機 UID/GID 不是 `1000:1000`，請設定 `LOCAL_UID`／`LOCAL_GID`。

Session 與 bearer token 保存在本機 `.state`，權限為 `0600`；Git、映像建置排除該目錄，Gateway 僅唯讀掛載。Session 過期後重新執行登入指令；`/healthz` 只表示服務存活，不代表登入仍有效。

## 連接 MCP client

Streamable HTTP endpoint 為 `http://127.0.0.1:4545/mcp`，需帶 `Authorization: Bearer <.state/gateway-token 的內容>`。Token 代表該 Gateway 的完整操作權限；保留 loopback binding，跨主機使用 SSH tunnel。

多個 Agent 請共用同一 HTTP endpoint，才能共用同檔佇列。獨立 stdio processes 不共用鎖。單一 client 也可透過 stdio 啟動：

```bash
docker compose up -d upstream
docker compose run --rm --no-deps -T gateway --stdio
```

Client 啟動命令為 `docker`，arguments 如下；專案路徑請替換為本機絕對路徑：

```json
["compose", "--project-directory", "/absolute/path/to/penpot-better-mcp", "run", "--rm", "--no-deps", "-T", "gateway", "--stdio"]
```

## 工具與使用方式

| Tool | 用途 |
|---|---|
| `open_document(url)` | 自動開檔，取得 `documentHandle` 與文件資訊 |
| `inspect_document(documentHandle)` | 讀取文件資訊與恢復狀態 |
| `open_page(documentHandle, pageId)` | 切頁並取得新 handle，保留舊 handle 的頁面目標 |
| `execute_code(documentHandle, code, save?)` | 執行官方 Plugin API；`save` 為 `wait`（預設）或 `deferred` |
| `flush_document(documentHandle)` | 確認先前批次寫入已儲存 |
| `export_shape(documentHandle, shapeId, format, mode?)` | PNG／SVG；`mode=fill` 可匯出 PNG 原始圖片填色 |
| `close_document(documentHandle)` | 確認儲存並釋放 handle，同檔最後一個 handle 回收瀏覽器 |
| `high_level_overview()` | 官方操作概覽與 Gateway 指引 |
| `penpot_api_info(type, member?)` | 官方型別／成員文件 |

先讀 API 文件，再以明確 handle 操作。高頻讀取或批次修改可用 `save=deferred`，寫入批次結束後 `flush_document`；deferred 成功只表示執行完成。遇到 `EXECUTION_UNKNOWN`／`SAVE_UNCONFIRMED`，先用新 handle 讀回結果，不要直接重送寫入。頁面、暫存、多 Agent 分工及錯誤恢復詳見 [Agent 指引](docs/agent-guide.md)。

| 限制 | 預設／行為 |
|---|---|
| 常駐瀏覽器 | `PENPOT_MAX_WORKERS=2`，可設 1–16；容量不足時確認儲存後回收閒置 worker |
| 接受中的操作 | 每檔 32、全域 128；超量回 `BUSY` |
| Handles | 全域最多 128；重啟 Gateway 後失效 |
| 閒置回收 | 10 分鐘，保留 handles 供重新開檔 |
| 請求大小 | JavaScript 100,000 字元、HTTP body 1 MB；回傳另受上游限制 |

序列化以單次工具呼叫為單位，不提供跨呼叫交易，也不鎖住人類或其他 Gateway 的編輯。Plugin API 已轉送，但不代表每個方法都逐一驗證；官方部署沒有獨立 `import_image` 工具，圖片可透過 Plugin media API 匯入。

## 開發、測試與停止

```bash
npm ci
npm run browser:install
npm run init
npm run auth -- --base-url https://penpot.example.com
docker compose -f compose.dev.yaml up -d
npm run build
npm run check && npm test
npm run dev -- --stdio
```

原生 Node 不會隱式載入 `.env`，請使用 shell 環境或 `node --env-file=.env dist/main.js`；Compose 會載入 `.env`。原生 HTTP 開發可用 `npm run dev -- --http`，預設 `127.0.0.1:3000`。

停止正式服務使用 `docker compose down`。Gateway 處理 SIGINT／SIGTERM／SIGHUP 時會先完成已接受工作與儲存，失敗則保留 HTTP 恢復入口並每 5 秒重試。Compose 預設等待 5 分鐘，可用 `GATEWAY_STOP_GRACE_PERIOD` 調整；外部強制終止仍可能中斷工作。

- [Agent 指引](docs/agent-guide.md)：頁面、批次儲存、多 Agent 與錯誤處理。
- [架構與診斷](docs/architecture.md)：排程、持久化、紀錄及方案 C 邊界。
- [測試指南](docs/testing.md)：必要回歸、隔離 fixture、內網驗收與覆蓋範圍。
- [效能摘要](docs/performance.md)：可重現量測、記憶體與適用限制。

Gateway 新增工具後，MCP client 需重新探索工具清單；既有對話若保留舊清單，請重新連線或開新對話。
