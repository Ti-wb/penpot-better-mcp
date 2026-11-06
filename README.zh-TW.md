# Penpot Better MCP

[English](README.md) | **繁體中文**

**把 Penpot 連結交給 Agent，瀏覽器交給 Gateway 處理。**

Penpot Better MCP 在官方 Penpot MCP 之上，加入自動開檔與切檔、受管 headless 瀏覽器及多 Agent 排程。完成設定與登入後，Agent 就能透過 workspace 連結開啟、讀取、編輯及匯出設計。使用者不用自己開啟瀏覽器、連接 Penpot Plugin，或一直維持設計分頁。

目標是讓 Penpot MCP 的操作體驗更接近 Figma 等工具：設定好連線，提供設計連結，Agent 就能在正確的檔案裡工作。

## 和官方 MCP 有什麼不同？

[官方 Penpot MCP 流程](https://help.penpot.app/mcp/) 透過開啟中的 Penpot 分頁連接 Plugin，操作對象跟著目前聚焦的頁面切換。這個 Gateway 會自動管理這些編輯器工作階段。

| 工作 | 官方 Plugin 流程 | Penpot Better MCP |
|---|---|---|
| 開始操作 | 用瀏覽器開啟檔案，再連接 MCP | 提供 workspace URL，自動開啟 headless 編輯器並連線 |
| 切換檔案或頁面 | 管理作用中的分頁與頁面 | 每個 document handle 綁定檔案與頁面，呼叫時自動切到正確目標 |
| 多 Agent 作業 | MCP 使用作用中分頁的操作情境 | 不同檔案真正平行；同檔案的呼叫依序執行，包含不同頁面 |
| 在 Linux VM 運作 | 自行安排瀏覽器與 Plugin 工作階段 | 使用附帶的 Docker 設定，不需要桌面或 `DISPLAY` |

操作仍透過官方 MCP 與 Plugin API 執行，存取權限由已登入的 Penpot 帳號決定。底層協定與工具可參考[官方專案](https://github.com/penpot/penpot/tree/develop/mcp)。

## 主機資源需求

**執行這支程式的電腦會自動啟動 headless Chromium。** 主機需要負擔完整 Penpot 編輯器的 CPU 與記憶體用量。大型檔案、圖片及更多同時開啟的檔案都會增加資源需求；瀏覽器池限制的是數量，並不限制每個編輯器的記憶體。

請預留數 GiB 的可用記憶體與 CPU 餘裕。既有四 client／PNG 測試中，**Gateway 容器峰值約為 2.3 GiB**；這是特定負載的觀測值，並非最低需求或用量上限。量測方式與限制詳見[效能摘要](docs/performance.zh-TW.md)。

預設最多保留兩個檔案的瀏覽器。較小的 VM，或以單一大型檔案為主時，可先設 `PENPOT_MAX_WORKERS=1`。調高可增加同時處理的檔案數，但不會讓同檔案的呼叫平行執行。預設閒置十分鐘後回收瀏覽器，需要時再自動開啟。

## 使用 Docker 快速啟動

需要 Docker Compose、Node.js 22+（初始化 token），以及對目標檔案有權限、可啟用 MCP 的 Penpot 帳號。登入工具支援在終端機輸入電子郵件與密碼。

以 [.env.example](.env.example) 為參考，在 `.env` 新增或修改 Penpot 站點 origin：

```dotenv
PENPOT_BASE_URL=https://penpot.example.com
```

在專案目錄執行，並將下方登入網址替換成相同站點：

```bash
node scripts/init-state.mjs
docker compose build gateway
docker compose run --rm auth --base-url https://penpot.example.com --enable-mcp
docker compose up -d upstream gateway
curl http://127.0.0.1:4545/healthz
```

請在自己的互動式終端機登入；密碼不回顯，也不會儲存。`--enable-mcp` 只在必要時啟用 MCP，不會輪替既有有效金鑰。登入完成後才能啟動 Gateway。若主機 UID/GID 不是 `1000:1000`，請先在 `.env` 設定 `LOCAL_UID` 與 `LOCAL_GID`。

Session 與 Gateway token 儲存在本機 `.state`，權限為 `0600`，Git 與映像建置均排除該目錄，Gateway 僅唯讀掛載。Session 過期後，重新登入並重建 Gateway 容器。`/healthz` 只檢查服務是否存活，不代表 Penpot session 仍有存取權限。

## 連接 MCP client

- **傳輸方式：** Streamable HTTP
- **Endpoint：** `http://127.0.0.1:4545/mcp`
- **Authorization header：** `Bearer <.state/gateway-token 的內容>`

請將 token 存在 client 的機密設定中；持有它就能透過 Gateway 的 Penpot 帳號操作。附帶的 Compose 設定僅綁定 loopback；其他電腦上的 client 請透過 SSH tunnel 連入。

**所有 Agent 必須共用同一個 HTTP endpoint，才能共用排程。** Agent A 可編輯檔案 A，同時由 Agent B 編輯檔案 B。如果都操作同一檔案，各次工具呼叫會依序執行，即使指定不同頁面也一樣。獨立的 Gateway 或 stdio processes 之間沒有共享鎖。

單一 client 也可透過 stdio 啟動 Gateway，請將工作目錄設為本專案：

```bash
docker compose up -d upstream
docker compose run --rm --no-deps -T gateway --stdio
```

升級後若 client 仍保留舊工具清單，請重新連線或重新探索工具。

## 可調整設定與取捨

在 `.env` 調整下列設定，附帶的 [compose.yaml](compose.yaml) 會將它們套用到對應服務：

| 設定 | 預設值 | 調整效果 |
|---|---|---|
| `PENPOT_BASE_URL` | `https://penpot.example.com` | 改成自己的 Penpot origin，不含檔案路徑。除 loopback 測試站外須使用 HTTPS，登入網址也要一致。 |
| `PENPOT_MAX_WORKERS` | `2` | 常駐檔案瀏覽器數，可設 `1`–`16`。提高可讓更多檔案平行作業，也會增加 CPU／RAM 用量。 |
| `PENPOT_IDLE_MS` | `600000`（10 分鐘） | 閒置多久後回收瀏覽器，最小 `1000`。縮短可較早釋放資源，但會增加重新載入編輯器的次數。 |
| `PENPOT_DIAGNOSTICS` | `true` | 設為 `false` 可停用一般操作紀錄，關機失敗紀錄仍保留。 |
| `GATEWAY_PORT` | `4545` | 主機 HTTP port，修改後也要更新 client endpoint。 |
| `GATEWAY_STOP_GRACE_PERIOD` | `5m` | Docker 強制停止前，允許既有工作與儲存完成的等待時間。縮短可能中斷工作。 |
| `LOCAL_UID` / `LOCAL_GID` | `1000` / `1000` | 容器使用者 ID，應與本機 `.state` 目錄擁有者一致。 |

例如設定 `PENPOT_MAX_WORKERS=1`、`PENPOT_IDLE_MS=300000`，即可只保留一個檔案的瀏覽器，並在閒置五分鐘後回收。等待 Agent 完成目前工作，再套用變更：

```bash
docker compose up -d --force-recreate gateway
```

重啟會讓 document handles 失效，client 需要重新開檔。切換站點也需要該站點的 session。`.env.example` 還包含原生 Node 設定；只有 `compose.yaml` 引用的變數會影響這套 Docker 部署。原生 Node 請使用 shell 環境變數，或明確執行 `node --env-file=.env dist/main.js`，不會自動載入 `.env`。

停止服務使用 `docker compose down`。Gateway 會先完成已接受的操作並確認儲存，再關閉連線；關機儲存失敗時會重試，但仍受 Docker 等待時間上限約束。

## 工具與日常操作

| 工具 | 用途 |
|---|---|
| `open_document` | 開啟 workspace URL，取得 `documentHandle` |
| `inspect_document` | 查看文件資訊與恢復狀態 |
| `open_page` | 取得另一頁的新 handle，舊 handle 仍綁定原本頁面 |
| `execute_code` | 透過官方 Plugin API 讀取或修改設計 |
| `flush_document` | 確認批次變更已儲存 |
| `export_shape` | 匯出 PNG／SVG；`mode=fill` 可匯出 PNG 原始圖片填色 |
| `close_document` | 確認儲存並釋放 handle，同檔最後一個 handle 關閉時釋放該瀏覽器 |
| `high_level_overview` | 讀取官方操作概覽與 Gateway 指引 |
| `penpot_api_info` | 查詢 Plugin API 型別與成員文件 |

先開啟文件、閱讀相關 API 指引並查看現有設計，再進行範圍明確的修改。`execute_code` 預設 `save="wait"`。高頻讀取或批次寫入可用 `save="deferred"`，省去逐次等待儲存確認的時間，寫入批次結束時再呼叫 `flush_document`。Deferred 回覆只表示執行完成，不代表已儲存。

多 Agent 作業時，將彼此相依的「讀取、計算、寫入」放在同一次 `execute_code`。排程保護的是單次呼叫，不是整段 Agent 工作流程，也不提供交易保證；人類或其他 Gateway 的編輯不受這條佇列保護。遇到 `EXECUTION_UNKNOWN` 或 `SAVE_UNCONFIRMED`，先用新 handle 讀回確認，再決定後續處理，不要直接重送寫入。詳見 [Agent 指引](docs/agent-guide.zh-TW.md)。

## 目前範圍

- 每個 Gateway 對應一位已登入使用者與一個 Penpot 站點。支援 **workspace URL**，尚未支援 viewer／分享連結或跨站存取。
- 需要有效的瀏覽器 session，尚未實作 SSO/MFA 自動登入與多租戶隔離；可將既有且已授權的 Playwright `storageState` 放在 `.state/session.json`。
- 每個 Gateway 最多 128 個 handles、128 個接受中的操作，每檔上限 32 個操作。操作佇列已滿時回覆 `BUSY`；JavaScript 上限 100,000 字元，HTTP request body 上限 1 MB。
- Gateway 在已部署 Plugin 的權限範圍內轉送 API 操作，不代表每個 API 方法均經驗證。目前編輯仍透過 Chromium，直接存取後端 API 是後續擴充方向。

## 開發與文件

```bash
npm ci
npm run check && npm test
npm run build
```

詳細指南提供英文與繁體中文，可在各頁切換：

- [Agent 指引](docs/agent-guide.zh-TW.md)：頁面、批次處理、協作與恢復。
- [架構與診斷](docs/architecture.zh-TW.md)：路由、持久化、紀錄與擴充方向。
- [測試指南](docs/testing.zh-TW.md)：隔離 fixture、真實站點驗收與覆蓋邊界。
- [效能摘要](docs/performance.zh-TW.md)：讀寫開銷、併發與資源量測。
