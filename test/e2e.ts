import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadFixture, data, writeReport } from './support.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const { targets, config } = await loadFixture();
const client = new Client({ name: 'headless-acceptance', version: '1.0.0' });
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const transport = process.env.E2E_HTTP_URL
  ? new StreamableHTTPClientTransport(new URL(process.env.E2E_HTTP_URL), { requestInit: { headers: { Authorization: `Bearer ${(await readFile(process.env.GATEWAY_TOKEN_FILE || '.state/gateway-token', 'utf8')).trim()}` } } })
  : new StdioClientTransport({ command: process.execPath, args: ['dist/main.js'], env: { ...env, PENPOT_BASE_URL: targets.base, PENPOT_STORAGE_STATE: config.storageState, PENPOT_DIAGNOSTICS: env.PENPOT_DIAGNOSTICS || 'false' }, stderr: 'inherit' });
await client.connect(transport);
const evidence: Record<string, unknown> = { at: new Date().toISOString(), site: targets.base, transport: process.env.E2E_HTTP_URL ? 'http' : 'stdio', display: process.env.DISPLAY || null, checks: [] };
const handles = new Set<string>();
const check = (name: string) => { (evidence.checks as string[]).push(name); console.log('PASS', name); };
async function call(name: string, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 180_000 }));
  if (result.isError) throw new Error(JSON.stringify(result.content));
  if (name === 'open_document') handles.add(data(result).documentHandle);
  if (name === 'close_document') handles.delete(String(args.documentHandle));
  return result;
}
try {
  const listed = await client.listTools();
  assert(listed.tools.some(t => t.name === 'open_document')); check('MCP initialization and tools/list');
  const a = data(await call('open_document', { url: targets.files[0].url }));
  assert(a.documentHandle); const initial = data(a.result).result;
  assert.equal(initial.fileId, targets.files[0].id); evidence.penpotVersion = initial.version; check('cold headless open and file identity');
  const marker = `headless-${Date.now()}`;
  const created = data(await call('execute_code', { documentHandle: a.documentHandle, code: `const r=penpot.createRectangle();r.name=${JSON.stringify(marker)};r.resize(160,80);r.fills=[{fillColor:'#3366FF',fillOpacity:1}];return {id:r.id,fileId:penpot.currentFile.id};` })).result;
  assert.equal(created.fileId, targets.files[0].id); check('native editable shape creation and saved indicator');
  const b = data(await call('open_document', { url: targets.files[1].url }));
  assert.equal(data(b.result).result.fileId, targets.files[1].id);
  const reads = await Promise.all([a, b, a].map(doc => call('execute_code', { documentHandle: doc.documentHandle, code: `return {fileId:penpot.currentFile.id,count:penpotUtils.findShapes(s=>s.name===${JSON.stringify(marker)}).length};` })));
  assert.deepEqual(reads.map(r => data(r).result.fileId), [targets.files[0].id, targets.files[1].id, targets.files[0].id]);
  assert.deepEqual(reads.map(r => data(r).result.count), [1,0,1]); check('concurrent requests retain file identity and persist across file workers');
  const exported = await call('export_shape', { documentHandle: a.documentHandle, shapeId: created.id, format: 'png' });
  const image = exported.content.find(c => c.type === 'image'); assert(image && image.type === 'image');
  const bytes = Buffer.from(image.data, 'base64'); assert.equal(bytes.subarray(1,4).toString(), 'PNG');
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/${(process.env.E2E_REPORT || 'acceptance.json').replace('.json','')}-export.png`, bytes); check('PNG export through official MCP');
  for (const documentHandle of [...handles]) await call('close_document', { documentHandle });
  const reopened = data(await call('open_document', { url: targets.files[0].url }));
  const found = data(await call('execute_code', { documentHandle: reopened.documentHandle, code: `return penpotUtils.findShapes(s=>s.id===${JSON.stringify(created.id)}).map(s=>({id:s.id,name:s.name}));` })).result;
  assert.equal(found.length, 1); assert.equal(found[0].name, marker); check('browser teardown and cold reopen retain saved changes');
  await call('execute_code', { documentHandle: reopened.documentHandle, code: `penpotUtils.findShapeById(${JSON.stringify(created.id)}).remove();return true;` }); check('owned test shape cleanup');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  throw error;
} finally {
  let cleanupFailed = false;
  for (const documentHandle of handles) {
    try { await call('close_document', { documentHandle }); }
    catch { cleanupFailed = true; evidence.status = 'failed'; }
  }
  await client.close();
  await writeReport(process.env.E2E_REPORT || 'acceptance.json', evidence);
  if (cleanupFailed) throw new Error('Unable to release an acceptance-test document handle.');
}
