import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright';
import { WebSocket } from 'ws';
import type { Config } from './config.js';
import type { DocumentTarget } from './document.js';
import type { DesignAdapter, ExportOptions, SaveMode } from './adapter.js';
import { GatewayError, publicError } from './errors.js';
import { Diagnostics } from './diagnostics.js';
import { isUpstreamTaskTimeout, normalizeUpstreamResult } from './upstream-result.js';

interface FileState { epoch: number; handles: number; }
interface Binding { file: FileState; epoch: number; }
interface Editor {
  target: DocumentTarget;
  file: FileState;
  page: Page;
  devtools?: CDPSession;
  ready: boolean;
  lost: boolean;
  lostWrites: boolean;
  pending: boolean;
  saves: Set<Request>;
  saveActivity: number;
  saveFailed: boolean;
  needsSaveCheck: boolean;
}

export class HeadlessAdapter implements DesignAdapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private editor?: Editor;
  private client?: Client;
  private readonly bridgeToken = randomBytes(32).toString('hex');
  private readonly sockets = new Set<WebSocket>();
  private readonly files = new Map<string, FileState>();
  private readonly bindings = new WeakMap<DocumentTarget, Binding>();
  constructor(private readonly config: Config, private readonly diagnostics = new Diagnostics()) {}

  private get page() { return this.editor?.page; }

  private binding(target: DocumentTarget): Binding {
    const existing = this.bindings.get(target);
    if (existing) return existing;
    const file = this.files.get(target.fileId) ?? { epoch: 0, handles: 0 };
    this.files.set(target.fileId, file); file.handles++;
    const binding = { file, epoch: file.epoch };
    this.bindings.set(target, binding);
    return binding;
  }

  release(target: DocumentTarget) {
    const binding = this.bindings.get(target);
    if (!binding) return;
    this.bindings.delete(target); binding.file.handles--;
    this.pruneFile(target.fileId, binding.file);
  }

  private pruneFile(fileId: string, file: FileState) {
    if (!file.handles && this.editor?.file !== file) this.files.delete(fileId);
  }

  private markLost(editor: Editor) {
    if (!editor.lost && (this.editor === editor || editor.pending)) this.diagnostics.lifecycle('editor_lost');
    if (editor.pending) {
      // All handles for this file share an epoch. Reopening with a new handle
      // permits readback; no old handle can silently acknowledge lost writes.
      editor.file.epoch++;
      editor.pending = false;
      editor.lostWrites = true;
    }
    editor.lost = true;
  }

  private observeLoss() {
    const editor = this.editor;
    if (editor && (editor.page.isClosed() || !this.browser?.isConnected())) this.markLost(editor);
  }

  private assertCertain(target: DocumentTarget) {
    this.observeLoss();
    const binding = this.binding(target);
    if (binding.epoch !== binding.file.epoch) throw new GatewayError('SAVE_UNCONFIRMED',
      'An earlier execution or save became uncertain. Call open_document again for a new handle and inspect saved data before editing. This handle cannot confirm those writes.', true);
  }

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

  private call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.diagnostics.count('upstreamCalls');
    return this.diagnostics.span('upstreamMs', () => this.upstreamCall(name, args));
  }

  private async upstreamCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.upstream();
    try {
      const result = normalizeUpstreamResult(CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: this.config.timeoutMs })));
      if (isUpstreamTaskTimeout(result)) throw new Error('Official plugin task timed out');
      // The official plugin logs execution results to Chromium's console. Its
      // console cache retains returned object graphs even after GC (over 1 GiB
      // for twenty 3,000-shape reads). MCP already captured the result/logs;
      // release only inspector references, preserving plugin storage/history.
      await this.editor?.devtools?.send('Runtime.discardConsoleEntries').catch(() => {});
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
    if (this.browser || this.context) await this.close(true);
    const info = await stat(this.config.storageState).catch(() => null);
    if (!info || !info.isFile()) throw new GatewayError('AUTH_REQUIRED', 'Run npm run auth in your terminal to create the Penpot login session.');
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new GatewayError('INSECURE_SESSION', 'Set the session file permissions to 0600.');
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    try {
      const context = await browser.newContext({ storageState: this.config.storageState, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
      await this.routeMcp(context);
      this.browser = browser; this.context = context;
      this.diagnostics.lifecycle('browser_started');
      browser.on('disconnected', () => { if (this.browser === browser && this.editor) this.markLost(this.editor); });
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  private async routeMcp(context: BrowserContext) {
    // Only this browser's MCP socket is relayed; design collaboration sockets remain unchanged.
    await context.routeWebSocket(url => url.host === new URL(this.config.baseUrl).host && url.pathname === this.config.pluginWsPath, route => {
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

  private activate(target: DocumentTarget, verify = true) {
    return this.diagnostics.span('activationMs', () => this.activateEditor(target, verify));
  }

  private async activateEditor(target: DocumentTarget, verify: boolean) {
    this.observeLoss();
    if (this.editor?.lost) await this.close(true);
    await this.launch();
    const binding = this.binding(target);
    // execute_code checks identity inside the dispatched script, avoiding an
    // extra upstream round trip while still refusing edits in the wrong file.
    if (this.editor?.ready && this.editor.target.url === target.url && (!verify || await this.matches(target))) return;
    if (this.editor) {
      await this.waitForSave();
      const previous = this.editor;
      this.editor = undefined; await previous.page.close();
      this.pruneFile(previous.target.fileId, previous.file);
      // Closing a page starts an asynchronous WS close handshake. Retire its
      // relay sockets before opening another plugin with this routing token.
      for (const socket of this.sockets) socket.terminate();
      this.sockets.clear();
    }
    try {
      const page = await this.context!.newPage();
      const editor: Editor = { target, file: binding.file, page, ready: false, lost: false, lostWrites: false,
        pending: false, saves: new Set(), saveActivity: 0, saveFailed: false, needsSaveCheck: true };
      this.editor = editor;
      page.on('close', () => this.markLost(editor));
      page.on('crash', () => this.markLost(editor));
      editor.devtools = await this.context!.newCDPSession(page);
      this.observeSaves(editor);
      page.setDefaultTimeout(30_000);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const login = page.locator('input[type="password"]');
      await page.getByTestId('mcp-btn').or(login).first().waitFor({ state: 'visible', timeout: 60_000 });
      if (await login.isVisible()) throw new GatewayError('AUTH_REQUIRED', 'The Penpot session expired. Run npm run auth again.');
      await this.connectPlugin(editor);
      editor.ready = true;
      this.diagnostics.lifecycle('editor_ready');
    } catch (error) {
      // A failed editor initialization has dispatched no user code. Roll it
      // back immediately; an unloaded page cannot supply a saved indicator.
      await this.close(true);
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('DOCUMENT_UNAVAILABLE', 'Unable to load the editor. Check the network, file access and MCP integration, then retry.');
    }
  }

  private observeSaves(editor: Editor) {
    const isSave = (request: Request) => {
      const url = new URL(request.url());
      return url.origin === this.config.baseUrl && ['/api/main/methods/update-file', '/api/rpc/command/update-file'].includes(url.pathname);
    };
    editor.page.on('request', request => {
      if (!editor.lost && isSave(request)) {
        editor.saves.add(request); editor.saveActivity++;
        editor.needsSaveCheck = true; editor.pending = true;
      }
    });
    editor.page.on('response', response => { if (isSave(response.request())) editor.saveFailed = !response.ok(); });
    editor.page.on('requestfinished', request => { if (editor.saves.delete(request)) editor.saveActivity++; });
    editor.page.on('requestfailed', request => { if (editor.saves.delete(request)) { editor.saveActivity++; editor.saveFailed = true; } });
  }

  private async connectPlugin(editor: Editor) {
    // The toolbar can briefly show connected and then reset during loading.
    // Treat the plugin identity response as readiness, not one UI snapshot.
    // Poll only this fixed read; user code is never replayed.
    const button = editor.page.getByTestId('mcp-btn');
    const action = editor.page.getByRole('menuitem').filter({ hasText: /^(Connect(?: here)?|連線|在此連線|连接|在此连接|Conectar)$/i }).first();
    const until = Date.now() + 60_000;
    let lastConnect = 0;
    do {
      if (await this.matches(editor.target)) return;
      this.diagnostics.count('connectionProbeRetries');
      if (Date.now() - lastConnect >= 5000) {
        try {
          await button.evaluate(el => {
            if (!el.querySelector('[class*="__connected"]') && el.getAttribute('aria-pressed') !== 'true') (el as HTMLElement).click();
          });
          if (await action.isVisible()) {
            await action.click({ timeout: 1000 });
            lastConnect = Date.now();
            await editor.page.keyboard.press('Escape');
          }
        } catch { /* UI can remount while the editor initializes. */ }
      }
      await new Promise(r => setTimeout(r, 300));
    } while (Date.now() < until);
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

  private waitForSave() {
    return this.diagnostics.span('saveMs', () => this.confirmSave());
  }

  private async confirmSave() {
    this.observeLoss();
    const editor = this.editor;
    if (!editor) return;
    if (editor.lost && editor.lostWrites) throw new GatewayError('SAVE_UNCONFIRMED', 'The browser was lost before saving could be confirmed. Open a new handle and inspect saved data.', true);
    if (editor.lost || !editor.ready) return;
    if (!editor.needsSaveCheck && !editor.saves.size && !editor.saveFailed) return;
    // Penpot 2.18.x debounces its "pending" indicator by 200 ms. A single
    // saved-status lookup can therefore see the previous save and lose edits
    // when we close the page. Require a stable indicator beyond that debounce,
    // with no unfinished or failed update-file request, before releasing it.
    let stableSince = Date.now();
    let activity = editor.saveActivity;
    const deadline = Date.now() + 30_000;
    try {
      while (Date.now() < deadline) {
        const saved = await editor.page.locator('[class*="__saved-status"]').count();
        this.observeLoss();
        if (editor.lost || this.editor !== editor) break;
        if (!saved || editor.saves.size || editor.saveFailed || activity !== editor.saveActivity) stableSince = Date.now();
        else if (Date.now() - stableSince >= 750) { editor.needsSaveCheck = false; editor.pending = false; return; }
        activity = editor.saveActivity;
        await new Promise(r => setTimeout(r, 50));
      }
    } catch { /* A closed/crashed page also leaves the save unconfirmed. */ }
    throw new GatewayError('SAVE_UNCONFIRMED', 'Penpot has not confirmed saving. Inspect the document before closing or repeating edits.', true);
  }

  async open(target: DocumentTarget) {
    await this.activate(target);
    const result = await this.call('execute_code', { code: 'return {version: penpot.version, fileId: penpot.currentFile.id, fileName: penpot.currentFile.name, pageId: penpot.currentPage.id, pages: penpotUtils.getPages()};' });
    const binding = this.binding(target);
    return binding.epoch === binding.file.epoch ? result : { ...result, _meta: { ...result._meta, saveState: 'unknown' } };
  }

  private async checkedCall(target: DocumentTarget, code: string, checkPage = true) {
    const marker = randomUUID();
    const expected = { fileId: target.fileId, pageId: checkPage ? target.pageId ?? null : null };
    const guard = `if(penpot.currentFile?.id!==${JSON.stringify(target.fileId)}${checkPage && target.pageId ? ` || penpot.currentPage?.id!==${JSON.stringify(target.pageId)}` : ''}) return {gatewayContext:${JSON.stringify(marker)},actual:{fileId:penpot.currentFile?.id??null,pageId:penpot.currentPage?.id??null}};`;
    const result = await this.call('execute_code', { code: `${guard}\nreturn await (async()=>{\n${code}\n})();` });
    // Only decode the failure marker. Large successful reads keep the same
    // upstream shape and avoid an additional JSON parse or RPC.
    const text = result.content.find(item => item.type === 'text' && item.text.includes(marker));
    if (text?.type === 'text') {
      let value;
      try { value = JSON.parse(text.text).result; } catch { return result; }
      if (value?.gatewayContext === marker) {
        const error = new GatewayError('DOCUMENT_CONTEXT_CHANGED',
          'No user code from this call ran. The editor no longer matches this handle. Use open_page(documentHandle, pageId) to select a page explicitly, or open_document with the intended editor URL for a new handle.', false,
          { expected, actual: value.actual });
        return { content: [{ type: 'text' as const, text: JSON.stringify(publicError(error)) }], isError: true };
      }
    }
    return result;
  }

  async openPage(source: DocumentTarget, target: DocumentTarget) {
    if (source.fileId !== target.fileId || !target.pageId) throw new GatewayError('INVALID_PAGE', 'Select a page in the same file.');
    this.assertCertain(source);
    // The explicit destination supersedes the source handle's page. An older
    // handle in this file should not force a reload of its original page first.
    if (!this.editor?.ready || this.editor.lost || this.editor.target.fileId !== source.fileId) await this.activate(source, false);
    this.assertCertain(source);
    await this.waitForSave();
    const missing = randomUUID();
    const result = await this.checkedCall(source, `const id=${JSON.stringify(target.pageId)};
if(!penpotUtils.getPages().some(p=>p.id===id))return {missingPage:${JSON.stringify(missing)}};
await penpot.openPage(penpotUtils.getPageById(id));
return {fileId:penpot.currentFile.id,pageId:penpot.currentPage.id,pages:penpotUtils.getPages()};`, false);
    if (result.isError) return result;
    const text = result.content.find(item => item.type === 'text');
    const value = text?.type === 'text' ? JSON.parse(text.text).result : undefined;
    if (value?.missingPage === missing) throw new GatewayError('PAGE_NOT_FOUND', 'The requested page is not in this file. Inspect the page list before opening it.');
    if (value?.fileId !== target.fileId || value?.pageId !== target.pageId) throw new GatewayError('DOCUMENT_CONTEXT_CHANGED', 'The requested page did not become active. Open the intended editor URL before editing.');
    this.assertCertain(source);
    this.binding(target);
    this.editor!.target = target;
    this.diagnostics.lifecycle('page_selected');
    return result;
  }

  async execute(target: DocumentTarget, code: string, save: SaveMode = 'wait') {
    this.assertCertain(target);
    await this.activate(target, false);
    this.assertCertain(target);
    this.editor!.needsSaveCheck = true; this.editor!.pending = true;
    const result = await this.checkedCall(target, code);
    // Tool errors can follow partial edits, so also wait for pending saves on errors.
    if (save === 'wait') await this.waitForSave();
    this.assertCertain(target);
    return { ...result, _meta: { ...result._meta, saveState: save === 'wait' ? 'confirmed' : 'not_confirmed' } };
  }

  async flush(target: DocumentTarget): Promise<CallToolResult> {
    this.assertCertain(target);
    await this.activate(target);
    this.assertCertain(target);
    await this.waitForSave();
    this.assertCertain(target);
    return { content: [{ type: 'text', text: JSON.stringify({ fileId: target.fileId, saved: true }) }] };
  }

  async flushPending() {
    this.observeLoss();
    if (this.editor?.lost) await this.close();
    else await this.waitForSave();
  }

  async exportShape(target: DocumentTarget, args: ExportOptions) {
    await this.activate(target);
    return this.call('export_shape', { ...args, mode: args.mode || 'shape' });
  }

  async documentation(name: 'high_level_overview' | 'penpot_api_info', args: Record<string, unknown>) { return this.call(name, args); }

  close(force = false) {
    return this.diagnostics.span('cleanupMs', () => this.closeResources(force));
  }

  private async closeResources(force: boolean) {
    let saveError: unknown;
    if (!force) {
      try { await this.waitForSave(); }
      catch (error) {
        this.observeLoss();
        // Keep a live editor with unsaved work. A lost editor cannot recover
        // those writes, so release its resources while still reporting failure.
        if (!this.editor?.lost) throw error;
        saveError = error;
      }
    }
    const editor = this.editor;
    if (editor && force) this.markLost(editor);
    this.editor = undefined;
    if (editor) this.pruneFile(editor.target.fileId, editor.file);
    const context = this.context; this.context = undefined;
    const browser = this.browser; this.browser = undefined;
    const client = this.client; this.client = undefined;
    await context?.close().catch(() => {});
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await browser?.close().catch(() => {});
    await client?.close().catch(() => {});
    if (browser) this.diagnostics.lifecycle('browser_closed', force);
    if (saveError) throw saveError;
  }
}
