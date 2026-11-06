# Testing

**English** | [繁體中文](testing.zh-TW.md) | [README](../README.md)

Run fast checks first, then select integration tests for the changed behavior. Load tests are optional. Tests use dedicated `Headless acceptance …` files, never production designs; results stay in untracked `test-results/`.

## Commands

| Command | Coverage and when to run |
|---|---|
| `npm run check && npm test` | Types and unit/HTTP regressions; routine changes, no Penpot required |
| `npm run test:acceptance` | Build, stdio/HTTP, PNG, persistence, and four clients sharing one or multiple files; routing changes or releases |
| `npm run test:editor` | Deferred saves, SVG/PNG fill, pages, and Plugin errors; adapter changes or Penpot upgrades, isolated fixture only |
| `npm run test:faults` | Startup/navigation/authentication, SDK/sidecar timeouts, browser/page loss, capacity, and shutdown; lifecycle changes, isolated fixture only |
| `npm run test:reads` | Browserless HTTP, ETag validation, saved-data consistency, 3,000-shape comparison and memory; backend-reader changes |
| `npm run test:load` | 3,000 shapes per file, direct/Proxy comparison, concurrent reads, overload, and repeated scans; performance changes |
| `npm run test:reclamation` | Repeated reads/writes, page changes, explicit/idle reclamation, and process resources for a 3,000-shape file; resource-lifecycle changes |
| `npm run test:diagnostics` | ABBA logging on/off comparison for warm reads and 1 MiB responses; logging changes |

Acceptance combines `e2e.ts` and `multi-client.ts`; fault tests also run `shutdown.ts` in a separate process. Fixture validation, session paths, and reports share [test/support.ts](../test/support.ts).

## Isolated fixture

```bash
npm ci
npm run browser:install
docker compose -f compose.dev.yaml up -d
docker compose -f test/compose.yaml --profile faults up -d
# First run: create the test account, two files, and local session.
npm run fixture:setup
npm run check && npm test
npm run test:editor
npm run test:faults
npm run test:acceptance
```

Tests default to `.state/latest-targets.json` and `.state/latest-session.json`. Editor/fault tests require `http://127.0.0.1:19001`. The development sidecar uses ports 14401/14402; the `faults` sidecar uses 14411/14412. Both are separate from the production gateway's private sidecar.

[Test Compose](../test/compose.yaml) pins Penpot 2.18.6 by digest. When upgrading, check frontend, backend, exporter, and MCP versions together. The loopback fixture's simplified authentication and fixed test credentials are for isolated tests only.

## Existing installations

Provide a manifest for two dedicated files and an authorized storageState:

```bash
E2E_TARGETS_FILE=.state/acceptance-targets.json PENPOT_STORAGE_STATE=.state/session.json npm run test:acceptance
# Test the already deployed HTTP gateway instead.
E2E_TARGETS_FILE=.state/acceptance-targets.json E2E_HTTP_URL=http://127.0.0.1:4545/mcp npm run test:acceptance
```

The HTTP token is read from `.state/gateway-token` without logging it. Manifest format: `{ "base": "site origin", "files": [{ "id": "file UUID A", "name": "Headless acceptance A", "url": "workspace URL A" }, { "id": "file UUID B", "name": "Headless acceptance B", "url": "workspace URL B" }] }`. These test files must already exist; scripts do not search user designs.

Load tests require an explicit `E2E_TARGETS_FILE`; also set `PENPOT_STORAGE_STATE` for internal instances. Fixtures are cleaned by default; `LOAD_KEEP_FIXTURE=1` retains load-test shapes. See [performance](performance.md) for workload options and reproduction.

## Coverage and recorded validation

The suite checks same-file serialization and cross-file overlap with four independent clients, page/handle targeting, save confirmation and cold readback, uncertain writes, capacity limits, reclamation, shutdown recovery, error classification, and log redaction. Shutdown coverage includes a 12-second write, repeated SIGTERM, an injected close failure, recovery reads, and automatic retries.

Recorded validation on **2026-11-06** used a headless Linux VM, internal Penpot 2.18.5, and isolated 2.18.6. All passed: 28 fast checks, 16 editor scenarios, 8 fault scenarios, 5 shutdown checks, and 13 acceptance/multi-client checks each for isolated stdio and internal Docker. Test shapes and temporary pages were removed.

The deployed upstream's four public MCP tools were covered; this does not validate every Plugin API, read-only role, or permission-revocation combination. Viewer/share links, multiple tenants/sites, and automatic SSO/MFA renewal remain outside the implementation scope.

Recorded reports in `test-results/`: `acceptance.json`, `multi-client.json`, `editor.json`, `faults.json`, `shutdown.json`, `tidy-internal-acceptance.json`, and `tidy-internal-multi.json`. Benchmark conditions and results live in [performance](performance.md).

## Cleanup

Tests remove their own shapes and pages. Do not run overlapping load tests against the same fixed-prefix fixture. Once test processes finish, stop only the test services:

```bash
docker compose -f compose.dev.yaml down
docker compose -f test/compose.yaml --profile faults down
```

`down` retains volumes; use `down -v` only for an intentional fixture reset. These commands do not stop the production gateway. Its shutdown/save behavior is documented in the [README](../README.md).
