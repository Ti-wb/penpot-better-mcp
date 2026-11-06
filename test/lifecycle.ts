import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mock } from 'node:test';
import type { Browser } from 'playwright';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { DocumentWorker } from '../src/document-worker.js';
import { Gateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';
import { GatewayError } from '../src/errors.js';

// Fault injection stays on the disposable loopback fixture. The optional
// Compose `faults` profile supplies a sidecar whose own timeout is 2 seconds.
const targets = JSON.parse(await readFile('.state/latest-targets.json', 'utf8'));
assert.equal(targets.base, 'http://127.0.0.1:19001');
assert(targets.files.every((file: {name: string}) => file.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const { chromium } = await import('playwright');
const config = loadConfig({...process.env, PENPOT_BASE_URL: targets.base, PENPOT_STORAGE_STATE: '.state/latest-session.json'});
const checks: string[] = [];
const check = (name: string) => { checks.push(name); console.log('PASS', name); };
function data(result: CallToolResult) {
  assert(!result.isError, JSON.stringify(result.content));
  const text = result.content.find(c => c.type === 'text'); assert(text?.type === 'text');
  return JSON.parse(text.text);
}
const errorCode = (code: string) => (error: unknown) => error instanceof GatewayError && error.code === code;
const count = (name: string) => `return penpotUtils.findShapes(s=>s.name===${JSON.stringify(name)}).length;`;
const create = (name: string) => `const s=penpot.createRectangle();s.name=${JSON.stringify(name)};return s.id;`;
const remove = (name: string) => `for(const s of penpotUtils.findShapes(s=>s.name===${JSON.stringify(name)}))s.remove();return true;`;

async function initialization() {
  const invalid = `.state/lifecycle-invalid-${process.pid}.json`;
  await writeFile(invalid, '{invalid-json', {mode: 0o600});
  const adapter = new HeadlessAdapter({...config, storageState: resolve(invalid)});
  const gateway = new DocumentWorker(adapter, config.baseUrl);
  const browsers: Browser[] = [];
  const launch = chromium.launch.bind(chromium);
  const spy = mock.method(chromium, 'launch', async options => {
    const browser = await launch(options); browsers.push(browser); return browser;
  });
  try {
    for (let i=0; i<3; i++) await assert.rejects(gateway.open(targets.files[0].url), SyntaxError);
    assert.equal(browsers.length, 3);
    assert(browsers.every(browser => !browser.isConnected()));
    assert.equal(adapter['browser'], undefined); assert.equal(adapter['context'], undefined);
    assert.equal(adapter['files'].size, 0);
    // Context creation can succeed but relay installation can still fail.
    const routed = new HeadlessAdapter(config);
    const routeGateway = new DocumentWorker(routed, config.baseUrl);
    const fault = mock.method(routed as any, 'routeMcp', async () => { throw new Error('relay setup fault'); });
    try {
      await assert.rejects(routeGateway.open(targets.files[0].url), /relay setup fault/);
      assert(browsers.every(browser => !browser.isConnected()));
      assert.equal(routed['files'].size, 0);
    } finally { fault.mock.restore(); await routeGateway.shutdown(); }
    check('context and relay initialization failures close every launched browser and release bindings');
  } finally {
    spy.mock.restore(); await gateway.shutdown();
    for (const browser of browsers) await browser.close();
    await rm(invalid, {force: true});
  }
}

async function navigation() {
  const adapter = new HeadlessAdapter(config);
  const gateway = new DocumentWorker(adapter, config.baseUrl);
  try {
    await adapter['launch']();
    const browser = adapter['browser']!;
    await adapter['context']!.route('**/*', route => route.request().isNavigationRequest() ? route.abort('connectionrefused') : route.continue());
    await assert.rejects(gateway.open(targets.files[0].url), errorCode('DOCUMENT_UNAVAILABLE'));
    assert(!browser.isConnected()); assert.equal(adapter['page'], undefined);
    assert.equal(adapter['files'].size, 0);
    const opened = await gateway.open(targets.files[0].url);
    assert.equal(data(opened.result).result.fileId, targets.files[0].id);
    check('failed editor navigation rolls back and the next open recovers without manual cleanup');
  } finally { await gateway.shutdown(); }
}

async function browserLoss(loss: 'browser' | 'page', capacity = 2) {
  const adapter = new HeadlessAdapter(config);
  const otherAdapter = new HeadlessAdapter(config);
  const gateway = new Gateway(file => file === targets.files[0].id ? adapter : otherAdapter, config.baseUrl, 600_000, undefined, capacity);
  const marker = `lifecycle-loss-${randomUUID()}`;
  let release = () => {};
  let cleanupHandle: string | undefined;
  try {
    const other = await gateway.open(targets.files[1].url); assert(other.documentHandle);
    const otherBrowser = otherAdapter['browser'];
    await gateway.execute(other.documentHandle, 'storage.faultIsolation=42;return true;', 'deferred');
    const first = await gateway.open(targets.files[0].url); assert(first.documentHandle);
    const alias = await gateway.open(targets.files[0].url); assert(alias.documentHandle);
    let observed = () => {};
    const savedRequest = new Promise<void>(resolve => { observed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await adapter['context']!.route(/\/api\/(?:main\/methods|rpc\/command)\/update-file(?:\?|$)/,
      async route => { observed(); await gate; await route.continue().catch(() => {}); });
    const result = await gateway.execute(first.documentHandle, create(marker), 'deferred');
    assert.equal(result._meta?.saveState, 'not_confirmed');
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([savedRequest, new Promise((_, reject) => { timer=setTimeout(() => reject(new Error('save request not observed')), 20_000); })]);
    } finally { clearTimeout(timer!); }
    if (loss === 'browser') await adapter['browser']!.close();
    else await adapter['page']!.close();
    if (capacity === 2) {
      assert.equal(data(await gateway.execute(other.documentHandle, 'return storage.faultIsolation;', 'deferred')).result, 42);
      assert.equal(otherAdapter['browser'], otherBrowser);
    } else {
      assert.equal(data(await gateway.execute(other.documentHandle, 'return penpot.currentFile.id;', 'deferred')).result, targets.files[1].id);
      assert.notEqual(otherAdapter['browser'], otherBrowser);
      assert.equal(adapter.hasResources, false);
    }
    for (const documentHandle of [first.documentHandle, alias.documentHandle]) {
      await assert.rejects(gateway.flush(documentHandle), errorCode('SAVE_UNCONFIRMED'));
      await assert.rejects(gateway.execute(documentHandle, 'throw new Error("must not dispatch");'), errorCode('SAVE_UNCONFIRMED'));
    }
    if (capacity === 2) await assert.rejects(gateway.closeDocument(first.documentHandle), errorCode('SAVE_UNCONFIRMED'));
    assert.equal(adapter['browser'], undefined); assert.equal(adapter['context'], undefined);
    const inspected = await gateway.inspect(first.documentHandle);
    // Keep the request blocked until the abandoned context is gone: closing
    // only a page need not cancel network requests owned by its live context.
    release();
    assert.equal(inspected._meta?.saveState, 'unknown');
    // Inspecting or saving through a fresh handle must not rehabilitate old ones.
    await assert.rejects(gateway.flush(alias.documentHandle), errorCode('SAVE_UNCONFIRMED'));
    const fresh = await gateway.open(targets.files[0].url); cleanupHandle=fresh.documentHandle; assert(cleanupHandle);
    const retained = data(await gateway.execute(cleanupHandle, count(marker))).result;
    // Page unload can trigger a final save outside the held fetch. Neither
    // outcome may rehabilitate an old handle; the fresh read is reconciliation.
    assert([0, 1].includes(retained));
    if (loss === 'browser') assert.equal(retained, 0);
    await gateway.execute(cleanupHandle, remove(marker));
    await gateway.execute(cleanupHandle, create(marker));
    await gateway.flush(cleanupHandle);
    await assert.rejects(gateway.flush(first.documentHandle), errorCode('SAVE_UNCONFIRMED'));
    await gateway.execute(cleanupHandle, remove(marker));
    assert.equal(data(await gateway.execute(other.documentHandle, 'return penpot.currentFile.id;')).result, targets.files[1].id);
    check(`${loss} loss at capacity ${capacity} invalidates old handles; unrelated files keep working and retired resources release capacity`);
  } finally {
    release();
    if (cleanupHandle) await gateway.execute(cleanupHandle, remove(marker)).catch(() => {});
    await adapter.close(true); await gateway.shutdown();
    assert.equal(adapter['files'].size, 0);
  }
}

async function upstreamTimeout() {
  const adapter = new HeadlessAdapter({...config, upstreamHttp:'http://127.0.0.1:14411/mcp', upstreamWs:'ws://127.0.0.1:14412', timeoutMs:30_000});
  const otherAdapter = new HeadlessAdapter(config);
  const gateway = new Gateway(file => file === targets.files[0].id ? adapter : otherAdapter, config.baseUrl);
  const marker = `lifecycle-timeout-${randomUUID()}`;
  let handle: string | undefined;
  try {
    const other = await gateway.open(targets.files[1].url); assert(other.documentHandle);
    const otherBrowser = otherAdapter['browser'];
    const opened = await gateway.open(targets.files[0].url); assert(opened.documentHandle);
    const browser = adapter['browser']!;
    const start = Date.now();
    const results = await Promise.allSettled([
      gateway.execute(opened.documentHandle, `await new Promise(r=>setTimeout(r,6000));${create(marker)}`),
      gateway.execute(opened.documentHandle, create(marker+'-queued')),
      gateway.execute(other.documentHandle, 'return penpot.currentFile.id;', 'deferred'),
    ]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'rejected');
    if (results[0].status === 'rejected') { assert(errorCode('EXECUTION_UNKNOWN')(results[0].reason)); assert(results[0].reason.outcomeUnknown); }
    if (results[1].status === 'rejected') assert(errorCode('SAVE_UNCONFIRMED')(results[1].reason));
    assert(!browser.isConnected());
    assert.equal(results[2].status, 'fulfilled');
    if (results[2].status === 'fulfilled') assert.equal(data(results[2].value).result, targets.files[1].id);
    assert.equal(otherAdapter['browser'], otherBrowser); assert(otherBrowser!.isConnected());
    const fresh = await gateway.open(targets.files[0].url); handle=fresh.documentHandle; assert(handle);
    const remaining = 6500 - (Date.now()-start);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    assert.equal(data(await gateway.execute(handle, count(marker))).result, 0);
    assert.equal(data(await gateway.execute(handle, count(marker+'-queued'))).result, 0);
    check('sidecar timeout retires only the affected browser before its queue advances; other file stays usable and late/queued edits never execute');
  } finally {
    if (handle) { await gateway.execute(handle, remove(marker)); await gateway.execute(handle, remove(marker+'-queued')); }
    await gateway.shutdown();
  }
}

let status = 'failed';
try {
  await initialization(); await navigation();
  await browserLoss('browser'); await browserLoss('page');
  await browserLoss('browser', 1);
  await upstreamTimeout(); status='passed';
} finally {
  await mkdir('test-results', {recursive:true});
  await writeFile('test-results/lifecycle.json', JSON.stringify({at:new Date().toISOString(),site:targets.base,status,checks},null,2));
}
