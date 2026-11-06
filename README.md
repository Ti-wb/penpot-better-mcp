# Penpot Better MCP

**English** | [繁體中文](README.zh-TW.md)

**Give your agent a Penpot link. The gateway handles the browser.**

Penpot Better MCP wraps the official Penpot MCP with automatic file routing, managed headless browsers, and multi-agent scheduling. After setup and login, agents can open, read, edit, and export designs from workspace links. Users do not need to open a browser, connect the Penpot plugin, or keep a design tab active themselves.

The goal is a workflow closer to tools such as Figma: connect once, share a design link, and let agents work in the right file.

## What changes from the official MCP?

The [official Penpot MCP workflow](https://help.penpot.app/mcp/) connects a plugin inside an open Penpot tab and follows its focused page. This gateway manages those editor sessions for you.

| Task | Official plugin workflow | Penpot Better MCP |
|---|---|---|
| Start working | Open a file in a browser and connect MCP | Pass a workspace URL; the gateway opens and connects a headless editor |
| Switch files or pages | Manage the active tab and focused page | Each document handle identifies its file and page; calls activate the correct target automatically |
| Run multiple agents | MCP uses the active tab's context | Different files run in parallel; calls to the same file, including different pages, run in sequence |
| Work on a Linux VM | Arrange a running browser and plugin session | Run the supplied Docker setup without a desktop or `DISPLAY` |

Editing and rendering use the official MCP and Plugin API. The `read_document` MVP reads saved data directly from the backend under the same logged-in account. See the [upstream project](https://github.com/penpot/penpot/tree/develop/mcp) for the underlying protocol and tools.

## Resource requirements

**Editing and rendering automatically run headless Chromium on the gateway host.** Pure `read_document` calls do not launch a browser. It needs CPU and RAM for full Penpot editors. Large files, images, and more simultaneously open files increase that cost; the browser pool limits their number, not each editor's memory usage.

Allow CPU and memory headroom for your files. Measure your own workload before choosing host capacity.

The default is two resident file browsers. For a smaller VM or mostly one large file, start with `PENPOT_MAX_WORKERS=1`. Raising it enables more parallel files but does not make calls within one file parallel. Idle browsers are reclaimed after ten minutes by default and reopened when needed.

## Quick start with Docker

Requires Docker Compose, Node.js 22+ for token initialization, and a Penpot account with access to the target files and permission to enable MCP. The login helper supports email/password login in your terminal.

Create or edit `.env` with your Penpot origin, using [.env.example](.env.example) as a reference:

```dotenv
PENPOT_BASE_URL=https://penpot.example.com
```

Run from the repository directory. Replace the login URL below with the same origin:

```bash
node scripts/init-state.mjs
docker compose build gateway
docker compose run --rm auth --base-url https://penpot.example.com --enable-mcp
docker compose up -d upstream gateway
curl http://127.0.0.1:4545/healthz
```

Run login in your own interactive terminal; the password is hidden and is not saved. `--enable-mcp` enables MCP when needed without rotating an existing valid key. Login must finish before starting the gateway. If your host UID/GID differs from `1000:1000`, set `LOCAL_UID` and `LOCAL_GID` in `.env` first.

The session and gateway token are stored locally in `.state` with mode `0600`, excluded from Git and image builds, and mounted read-only by the gateway. If the session expires, repeat login and recreate the gateway. `/healthz` checks service liveness, not whether the Penpot session is still authorized.

## Connect your MCP client

- **Transport:** Streamable HTTP
- **Endpoint:** `http://127.0.0.1:4545/mcp`
- **Authorization header:** `Bearer <contents of .state/gateway-token>`

Keep the token in the client's secret configuration: it grants access through the gateway's Penpot account. The supplied Compose setup binds to loopback; use an SSH tunnel for clients on another machine.

**All agents must share the same HTTP endpoint to share scheduling.** Agent A can edit file A while Agent B edits file B. If both target the same file, each tool call waits its turn, even when they target different pages. Separate gateway or stdio processes do not share locks.

A single client can also launch the gateway over stdio. Use the repository as its working directory:

```bash
docker compose up -d upstream
docker compose run --rm --no-deps -T gateway --stdio
```

Reconnect or refresh tool discovery after upgrades if your client retains an older tool list.

## Configuration and tradeoffs

Edit these settings in `.env`. The supplied [compose.yaml](compose.yaml) passes them to the relevant services:

| Setting | Default | What it changes |
|---|---|---|
| `PENPOT_BASE_URL` | `https://penpot.example.com` | Set your Penpot origin, without a file path. Use HTTPS except for loopback test sites; sign in to the same origin. |
| `PENPOT_MAX_WORKERS` | `2` | Resident file browsers, from `1` to `16`. More allows more parallel files and consumes more CPU/RAM. |
| `PENPOT_IDLE_MS` | `600000` (10 min) | Idle time before browser reclamation; minimum `1000`. A shorter interval releases resources sooner but causes more editor reloads. |
| `PENPOT_DIAGNOSTICS` | `true` | Set `false` to disable routine operation logs; shutdown failure logs remain available. |
| `GATEWAY_PORT` | `4545` | Host HTTP port. Update the client endpoint when changing it. |
| `GATEWAY_STOP_GRACE_PERIOD` | `5m` | Time Docker allows for accepted work and saves to finish before forcing a stop. Shortening it can interrupt work. |
| `LOCAL_UID` / `LOCAL_GID` | `1000` / `1000` | Container user IDs; match the owner of your local `.state` directory. |

For example, set `PENPOT_MAX_WORKERS=1` and `PENPOT_IDLE_MS=300000` for one resident file and five-minute idle reclamation. After agents finish their current work, apply changes with:

```bash
docker compose up -d --force-recreate gateway
```

Restarting invalidates document handles; clients must reopen documents. Changing the site also requires a session for the new site. `.env.example` includes additional native Node settings; only variables referenced by `compose.yaml` affect this Docker setup. Native Node reads shell environment variables or an explicit `node --env-file=.env dist/main.js`; it does not load `.env` automatically.

To stop the service, use `docker compose down`. The gateway drains accepted operations and confirms saves before closing; failed shutdown saves are retried. Docker's grace period still bounds that wait.

## Tools and everyday use

| Tool | Purpose |
|---|---|
| `read_document` | Read saved file/page summaries and selected shape fields directly over HTTP; no browser or handle |
| `open_document` | Open a workspace URL and return a `documentHandle` |
| `inspect_document` | Inspect document information and recovery status |
| `open_page` | Return a handle for another page, keeping the old handle bound to its original page |
| `execute_code` | Read or modify designs through the official Plugin API |
| `flush_document` | Confirm pending batch changes are saved |
| `export_shape` | Export PNG/SVG; `mode=fill` exports the original PNG image fill |
| `close_document` | Confirm saves and release a handle; closing the last handle for a file releases its browser |
| `high_level_overview` | Read official usage guidance and gateway instructions |
| `penpot_api_info` | Look up Plugin API types and members |

For saved-data reads, start with `read_document({url})`; see the [browserless read guide](docs/browserless-reads.md) for pagination and field selection. For editing, open a document, read the API guidance, inspect the design, then make focused edits. `execute_code` defaults to `save="wait"`. For frequent reads or batched writes, `save="deferred"` avoids waiting for save confirmation on every call; finish writes with `flush_document`. A deferred reply confirms execution, not persistence.

For multi-agent work, put dependent read/compute/write steps in one `execute_code` call. Scheduling protects individual calls, not an entire agent workflow or a transaction. It does not lock human editors or other gateways. On `EXECUTION_UNKNOWN` or `SAVE_UNCONFIRMED`, open a fresh handle and read back before deciding what to do; do not blindly replay writes. See the [agent guide](docs/agent-guide.md).

## Current scope

- One logged-in user and one Penpot site per gateway. Supported inputs are **workspace URLs**; viewer/share links and access to other sites are not supported.
- A valid browser session is required. Automatic SSO/MFA login and multi-tenant isolation are not implemented; an existing authorized Playwright `storageState` can be supplied as `.state/session.json`.
- Per gateway: up to 128 handles and 128 accepted operations, with 32 operations per file. A full operation queue returns `BUSY`; JavaScript is limited to 100,000 characters and HTTP request bodies to 1 MB.
- The gateway forwards Plugin API operations within the deployed plugin's permissions. This does not mean every API method has been verified. Editing uses Chromium. `read_document` exposes saved backend JSON, not computed Plugin state or rendered images.

## Roadmap

- [ ] Faster, lower-cost bulk reads without relying on a browser — [structured read MVP](docs/browserless-reads.md) available; selective backend fetches remain future work.
- [ ] Faster, lower-cost bulk writes.

## Development and documentation

```bash
npm ci
npm run check && npm test
npm run build
```

Each guide is available in English and Traditional Chinese:

- [Agent guide](docs/agent-guide.md): pages, batching, collaboration, and recovery.
- [Architecture and diagnostics](docs/architecture.md): routing, persistence, logs, and extension points.
- [Testing](docs/testing.md): isolated fixtures, real-instance acceptance, and coverage boundaries.
- [Performance](docs/performance.md): read/write overhead, concurrency, and resource measurements.

## License

This project is licensed under the [MIT License](LICENSE). Penpot and other dependencies retain their own licenses.
