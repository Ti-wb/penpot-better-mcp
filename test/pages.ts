import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { Gateway } from '../src/gateway.js';
import { GatewayError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

const targets = JSON.parse(await readFile(process.env.E2E_TARGETS_FILE || '.state/latest-targets.json', 'utf8'));
assert(targets.files.every((file: {name: string}) => file.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const adapter = new HeadlessAdapter(loadConfig({...process.env, PENPOT_BASE_URL: targets.base,
  PENPOT_STORAGE_STATE: process.env.PENPOT_STORAGE_STATE || '.state/latest-session.json'}));
const gateway = new Gateway(adapter, targets.base);
const checks: string[] = [], switchMs: number[] = [];
const created: string[] = [];
let rootHandle: string | undefined, rootPage: string | undefined;
function data(result: CallToolResult) {
  assert(!result.isError, JSON.stringify(result.content));
  const text = result.content.find(item => item.type === 'text'); assert(text?.type === 'text');
  return JSON.parse(text.text);
}
const check = (name: string) => { checks.push(name); console.log('PASS', name); };
try {
  const opened = await gateway.open(targets.files[0].url); rootHandle = opened.documentHandle!;
  rootPage = data(opened.result).result.pageId;
  // Pin the initial page even when the fixture URL contains no page-id.
  rootHandle = (await gateway.openPage(rootHandle, rootPage!)).documentHandle!;
  for (let i = 0; i < 2; i++) created.push(data(await gateway.execute(rootHandle,
    `const p=penpot.createPage();p.name=${JSON.stringify('page-acceptance-' + randomUUID())};return p.id;`)).result);
  let current = (await gateway.openPage(rootHandle, created[0])).documentHandle!;
  const browser = adapter['browser'], editor = adapter['page'];
  await gateway.execute(current, 'storage.pageAcceptance=42;return true;', 'deferred');
  for (let i = 0; i < 12; i++) {
    const pageId = created[(i + 1) % 2], start = performance.now();
    const next = await gateway.openPage(current, pageId); switchMs.push(performance.now() - start);
    assert.notEqual(next.documentHandle, current); assert.equal(next.pageId, pageId);
    current = next.documentHandle!;
    assert.equal(data(next.result).result.pageId, pageId);
    assert.equal(adapter['browser'], browser); assert.equal(adapter['page'], editor);
  }
  assert.equal(data(await gateway.execute(current, 'return storage.pageAcceptance;', 'deferred')).result, 42);
  check('12 explicit page switches reuse the browser, editor and plugin storage with new bound handles');

  const before = data(await gateway.execute(current, 'return penpot.currentPage.id;', 'deferred')).result;
  await assert.rejects(gateway.openPage(current, randomUUID()), error => error instanceof GatewayError && error.code === 'PAGE_NOT_FOUND');
  assert.equal(data(await gateway.execute(current, 'return penpot.currentPage.id;', 'deferred')).result, before);
  check('a nonexistent page is rejected without changing the active page');

  const other = created.find(id => id !== before)!;
  await gateway.execute(current, `await penpot.openPage(penpotUtils.getPageById(${JSON.stringify(other)}));return true;`);
  const denied = await gateway.execute(current, 'const s=penpot.createRectangle();s.name="page-guard-must-not-run";return s.id;', 'deferred');
  assert(denied.isError);
  const failure = JSON.parse((denied.content[0] as {text: string}).text);
  assert.equal(failure.code, 'DOCUMENT_CONTEXT_CHANGED'); assert.equal(failure.outcomeUnknown, false);
  assert.equal(failure.details.expected.pageId, before); assert.equal(failure.details.actual.pageId, other);
  current = (await gateway.openPage(current, other)).documentHandle!;
  assert.equal(data(await gateway.execute(current, 'return penpotUtils.findShapes(s=>s.name==="page-guard-must-not-run").length;', 'deferred')).result, 0);
  check('raw page navigation rejects old context before user code; open_page explicitly recovers');

  const shape = data(await gateway.execute(current, 'const s=penpot.createRectangle();s.name="page-save-acceptance";return s.id;', 'deferred')).result;
  current = (await gateway.openPage(current, before)).documentHandle!;
  await adapter.close();
  current = (await gateway.openPage(current, other)).documentHandle!;
  assert.equal(data(await gateway.execute(current, `return penpotUtils.findShapeById(${JSON.stringify(shape)})?.name;`, 'deferred')).result, 'page-save-acceptance');
  check('page switching flushes deferred writes that survive a cold browser reopen');
} finally {
  if (rootHandle && rootPage) {
    const cleanup = (await gateway.openPage(rootHandle, rootPage)).documentHandle!;
    for (const id of created) await gateway.execute(cleanup, `const p=penpotUtils.getPageById(${JSON.stringify(id)});if(p)p.remove();return true;`);
  }
  await gateway.shutdown();
}
await mkdir('test-results', {recursive: true});
await writeFile('test-results/' + (process.env.PAGES_REPORT || 'pages.json'), JSON.stringify({at: new Date().toISOString(), site: targets.base, status: 'passed', checks, switchMs}, null, 2));
