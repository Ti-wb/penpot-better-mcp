import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright';
import { WebSocket } from 'ws';
import type { Config } from './config.js';
import type { DocumentTarget } from './document.js';
import type { DesignAdapter, ExportOptions, SaveMode } from './adapter.js';
import { GatewayError } from './errors.js';
import { normalizeUpstreamResult } from './upstream-result.js';

export class HeadlessAdapter implements DesignAdapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private active?: string;
  private client?: Client;
  private devtools?: CDPSession;
  private readonly bridgeToken = randomBytes(32).toString('hex');
  private readonly sockets = new Set<WebSocket>();
  private readonly saves = new Set<Request>();
  private saveActivity = 0;
  private saveFailed = false;
  private needsSaveCheck = true;
  constructor(private readonly config: Config) {}

  private async upstream() {
    if (this.client) return this.client;
    const url = new URL(this.config.upstreamHttp);
    url.searchParams.set('userToken', this.bridgeToken);
    const client = new Client({ name: 'penpot-better-mcp', version: '0.1.0' });
    try { await client.connect(new StreamableHTTPClientTransport(url)); }
    catch { await client.close().catch(() => {}); throw new GatewayError('UPSTREAM_UNAVAILABLE', 'The private official MCP sidecar is unavailable.'); }
    this.client = client;
    return client;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.upstream();
    try {
      const result = normalizeUpstreamResult(CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: this.config.timeoutMs })));
      // The official plugin logs execution results to Chromium's console. Its
      // console cache retains returned object graphs even after GC (over 1 GiB
      // for twenty 3,000-shape reads). MCP already captured the result/logs;
      // release only inspector references, preserving plugin storage/history.
      await this.devtools?.send('Runtime.discardConsoleEntries').catch(() => {});
      return result;
    }
    catch {
      // A timeout is not proof that an edit failed. Never retry dispatched code.
      await this.close(true);
      throw new GatewayError('EXECUTION_UNKNOWN', 'Upstream response was lost or timed out. Reopen and inspect the document before repeating an edit.', true);
    }
  }

  private async launch() {
    if (this.context && this.browser?.isConnected()) return;
    const info = await stat(this.config.storageState).catch(() => null);
    if (!info || !info.isFile()) throw new GatewayError('AUTH_REQUIRED', 'Run npm run auth in your terminal to create the Penpot login session.');
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new GatewayError('INSECURE_SESSION', 'Set the session file permissions to 0600.');
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    this.context = await this.browser.newContext({ storageState: this.config.storageState, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    // Only this browser's MCP socket is relayed; design collaboration sockets remain unchanged.
    await this.context.routeWebSocket(url => url.host === new URL(this.config.baseUrl).host && url.pathname === this.config.pluginWsPath, route => {
      const target = new URL(this.config.upstreamWs);
      target.searchParams.set('userToken', this.bridgeToken);
      const socket = new WebSocket(target, { maxPayload: 20 * 1024 * 1024, handshakeTimeout: 15_000 });
      this.sockets.add(socket);
      const queue: (string | Buffer)[] = [];
      let queuedBytes = 0;
      route.onMessage(message => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message);
        else if (socket.readyState === WebSocket.CONNECTING) {
          queuedBytes += Buffer.byteLength(message);
          if (queuedBytes > 1024 * 1024) { socket.terminate(); void route.close(); return; }
          queue.push(message);
        }
      });
      socket.on('open', () => { for (const message of queue) socket.send(message); queue.length = 0; });
      socket.on('message', (data, binary) => { try { route.send(binary ? Buffer.from(data as Buffer) : data.toString()); } catch { socket.close(); } });
      socket.on('error', () => { void route.close({ code: 1011, reason: 'Private MCP relay unavailable' }).catch(() => {}); });
      socket.on('close', () => { this.sockets.delete(socket); void route.close().catch(() => {}); });
      route.onClose(() => socket.close());
    });
  }

  private async activate(target: DocumentTarget, verify = true) {
    await this.launch();
    // execute_code checks identity inside the dispatched script, avoiding an
    // extra upstream round trip while still refusing edits in the wrong file.
    if (this.active === target.url && this.page && !this.page.isClosed() && (!verify || await this.matches(target))) return;
    if (this.page && !this.page.isClosed()) {
      await this.waitForSave(); await this.page.close();
      // Closing a page starts an asynchronous WS close handshake. Retire its
      // relay sockets before opening another plugin with this routing token.
      for (const socket of this.sockets) socket.terminate();
      this.sockets.clear();
    }
    this.active = undefined;
    this.page = await this.context!.newPage();
    this.devtools = await this.context!.newCDPSession(this.page);
    this.saves.clear(); this.saveFailed = false; this.saveActivity = 0;
    this.needsSaveCheck = true;
    const isSave = (request: Request) => {
      const url = new URL(request.url());
      return url.origin === this.config.baseUrl && ['/api/main/methods/update-file', '/api/rpc/command/update-file'].includes(url.pathname);
    };
    this.page.on('request', request => { if (isSave(request)) { this.saves.add(request); this.saveActivity++; this.needsSaveCheck = true; } });
    this.page.on('response', response => { if (isSave(response.request())) this.saveFailed = !response.ok(); });
    this.page.on('requestfinished', request => { if (this.saves.delete(request)) this.saveActivity++; });
    this.page.on('requestfailed', request => { if (this.saves.delete(request)) { this.saveActivity++; this.saveFailed = true; } });
    this.page.setDefaultTimeout(30_000);
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      const login = this.page.locator('input[type="password"]');
      await this.page.getByTestId('mcp-btn').or(login).first().waitFor({ state: 'visible', timeout: 60_000 });
      if (await login.isVisible()) throw new Error('Login required');
    } catch {
      const login = await this.page.locator('input[type="password"]').count();
      await this.close(true);
      throw new GatewayError(login ? 'AUTH_REQUIRED' : 'DOCUMENT_UNAVAILABLE', login ? 'The Penpot session expired. Run npm run auth again.' : 'The editor is unavailable. Check file access and enable MCP in Penpot Integrations.');
    }
    // The toolbar can briefly show connected and then reset during loading.
    // Treat the plugin identity response as readiness, not one UI snapshot.
    // Poll only this fixed read; user code is never replayed.
    const button = this.page.getByTestId('mcp-btn');
    const action = this.page.getByRole('menuitem').filter({ hasText: /^(Connect(?: here)?|連線|在此連線|连接|在此连接|Conectar)$/i }).first();
    const until = Date.now() + 60_000;
    let lastConnect = 0;
    do {
      if (await this.matches(target)) { this.active = target.url; return; }
      if (Date.now() - lastConnect >= 5000) {
        try {
          await button.evaluate(el => {
            if (!el.querySelector('[class*="__connected"]') && el.getAttribute('aria-pressed') !== 'true') (el as HTMLElement).click();
          });
          if (await action.isVisible()) {
            await action.click({ timeout: 1000 });
            lastConnect = Date.now();
            await this.page.keyboard.press('Escape');
          }
        } catch { /* UI can remount while the editor initializes. */ }
      }
      await new Promise(r => setTimeout(r, 300));
    } while (Date.now() < until);
    await this.close(true);
    throw new GatewayError('CONTEXT_MISMATCH', 'The plugin did not confirm the requested file and page. No edit was dispatched.');
  }

  private async matches(target: DocumentTarget) {
    const result = await this.call('execute_code', { code: 'return {fileId: penpot.currentFile?.id, pageId: penpot.currentPage?.id};' });
    if (result.isError) return false;
    try {
      const text = result.content.find(c => c.type === 'text');
      const data = text?.type === 'text' ? JSON.parse(text.text).result : undefined;
      return data?.fileId === target.fileId && (!target.pageId || data.pageId === target.pageId);
    } catch { return false; }
  }

  private async waitForSave() {
    if (!this.page || this.page.isClosed()) return;
    if (!this.needsSaveCheck && !this.saves.size && !this.saveFailed) return;
    // Penpot 2.18.x debounces its "pending" indicator by 200 ms. A single
    // saved-status lookup can therefore see the previous save and lose edits
    // when we close the page. Require a stable indicator beyond that debounce,
    // with no unfinished or failed update-file request, before releasing it.
    let stableSince = Date.now();
    let activity = this.saveActivity;
    const deadline = Date.now() + 30_000;
    try {
      while (Date.now() < deadline) {
        const saved = await this.page.locator('[class*="__saved-status"]').count();
        if (!saved || this.saves.size || this.saveFailed || activity !== this.saveActivity) stableSince = Date.now();
        else if (Date.now() - stableSince >= 750) { this.needsSaveCheck = false; return; }
        activity = this.saveActivity;
        await new Promise(r => setTimeout(r, 50));
      }
    } catch { /* A closed/crashed page also leaves the save unconfirmed. */ }
    throw new GatewayError('SAVE_UNCONFIRMED', 'Penpot has not confirmed saving. Inspect the document before closing or repeating edits.', true);
  }

  async open(target: DocumentTarget) {
    await this.activate(target);
    return this.call('execute_code', { code: 'return {version: penpot.version, fileId: penpot.currentFile.id, fileName: penpot.currentFile.name, pageId: penpot.currentPage.id, pages: penpotUtils.getPages()};' });
  }

  async execute(target: DocumentTarget, code: string, save: SaveMode = 'wait') {
    await this.activate(target, false);
    const check = `if(penpot.currentFile?.id!==${JSON.stringify(target.fileId)}${target.pageId ? ` || penpot.currentPage?.id!==${JSON.stringify(target.pageId)}` : ''}) throw new Error("DOCUMENT_CONTEXT_CHANGED");`;
    this.needsSaveCheck = true;
    const result = await this.call('execute_code', { code: `${check}\nreturn await (async()=>{\n${code}\n})();` });
    // Tool errors can follow partial edits, so also wait for pending saves on errors.
    if (save === 'wait') await this.waitForSave();
    return { ...result, _meta: { ...result._meta, saveState: save === 'wait' ? 'confirmed' : 'not_confirmed' } };
  }

  async flush(target: DocumentTarget): Promise<CallToolResult> {
    await this.activate(target);
    await this.waitForSave();
    return { content: [{ type: 'text', text: JSON.stringify({ fileId: target.fileId, saved: true }) }] };
  }

  async exportShape(target: DocumentTarget, args: ExportOptions) {
    await this.activate(target);
    return this.call('export_shape', { ...args, mode: args.mode || 'shape' });
  }

  async documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>) { return this.call(name, args); }

  async close(force = false) {
    if (!force) await this.waitForSave();
    this.active = undefined;
    this.page = undefined;
    this.devtools = undefined;
    const context = this.context; this.context = undefined;
    const browser = this.browser; this.browser = undefined;
    const client = this.client; this.client = undefined;
    await context?.close().catch(() => {});
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await browser?.close().catch(() => {});
    await client?.close().catch(() => {});
  }
}
