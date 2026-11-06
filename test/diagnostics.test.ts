import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics } from '../src/diagnostics.js';
import { DocumentWorker } from '../src/document-worker.js';
import { GatewayError } from '../src/errors.js';
import type { DesignAdapter } from '../src/adapter.js';
import { loadConfig } from '../src/config.js';

const ok = { content: [{ type: 'text' as const, text: 'private-design-content' }] };
const base = 'https://private.example';
const url = base + '/#/workspace?team-id=11111111-1111-4111-8111-111111111111&file-id=22222222-2222-4222-8222-222222222222';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function fake(): DesignAdapter { return { open: async () => ok, openPage: async () => ok, execute: async () => ok, flush: async () => ok, flushPending: async () => {}, exportShape: async () => ok, documentation: async () => ok, release: () => {}, close: async () => {} }; }

test('diagnostics separate queued time and nested phases without logging payloads', async () => {
  const records: Record<string, any>[] = [];
  const diagnostics = new Diagnostics(record => records.push(record));
  const adapter = fake();
  adapter.execute = () => diagnostics.span('activationMs', async () => {
    diagnostics.lifecycle('editor_ready');
    await delay(5);
    await diagnostics.span('upstreamMs', async () => { diagnostics.count('upstreamCalls'); await delay(15); });
    await diagnostics.span('saveMs', () => delay(5));
    return ok;
  });
  const gateway = new DocumentWorker(adapter, base, 600_000, diagnostics);
  try {
    const opened = await gateway.open(url);
    await Promise.all([gateway.execute(opened.documentHandle!, 'private-user-code'), gateway.execute(opened.documentHandle!, 'private-user-code')]);
    const calls = records.filter(r => r.event === 'request' && r.operation === 'execute_code');
    assert.equal(calls.length, 2); assert.equal(calls[1].queuedAhead, 1); assert(calls[1].queueMs >= 20);
    for (const call of calls) {
      assert.equal(call.upstreamCalls, 1); assert(call.upstreamMs >= 10); assert(call.saveMs >= 3);
      assert(call.activationMs + call.upstreamMs + call.saveMs + call.cleanupMs <= call.totalMs - call.queueMs + 1);
      assert.equal(call.responseContentBytes, Buffer.byteLength(ok.content[0].text));
      assert.equal(records.find(r => r.event === 'editor_ready' && r.requestId === call.requestId)?.operation, 'execute_code');
    }
    const logs = JSON.stringify(records);
    for (const secret of ['private-user-code', 'private-design-content', 'private.example', opened.documentHandle!, '22222222-2222-4222-8222-222222222222']) assert(!logs.includes(secret));
  } finally { await gateway.shutdown(); }
});

test('diagnostics record overload and failures but never raw error messages', async () => {
  const records: Record<string, any>[] = [], diagnostics = new Diagnostics(record => records.push(record));
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const adapter = fake(); adapter.execute = async () => { await held; throw new GatewayError('EXECUTION_UNKNOWN', 'secret-token', true); };
  const gateway = new DocumentWorker(adapter, base, 600_000, diagnostics);
  try {
    const opened = await gateway.open(url);
    const pending = Promise.allSettled(Array.from({length: 33}, () => gateway.execute(opened.documentHandle!, 'secret-code')));
    release(); await pending;
    assert.equal(records.filter(r => r.errorCode === 'BUSY').length, 1);
    assert.equal(records.filter(r => r.errorCode === 'EXECUTION_UNKNOWN').length, 32);
    adapter.execute = async () => ({isError: true, content: [{type: 'text', text: JSON.stringify({code:'DOCUMENT_CONTEXT_CHANGED', details:{private:'secret'}})}]});
    await gateway.execute(opened.documentHandle!, 'read');
    assert.equal(records.at(-1)?.errorCode, 'DOCUMENT_CONTEXT_CHANGED');
    assert(!JSON.stringify(records).includes('secret'));
  } finally { await gateway.shutdown(); }
});

test('disabled or failed logging never changes results; config explicitly controls logging', async () => {
  for (const diagnostics of [new Diagnostics(), new Diagnostics(() => { throw new Error('disk full'); })]) {
    assert.equal(await diagnostics.run('execute_code', performance.now(), 0, async () => ok), ok);
    await assert.rejects(diagnostics.run('execute_code', performance.now(), 0, async () => { throw new Error('original'); }), /original/);
  }
  assert(loadConfig({}).diagnostics); assert(!loadConfig({PENPOT_DIAGNOSTICS:'false'}).diagnostics);
  assert.throws(() => loadConfig({PENPOT_DIAGNOSTICS:'no'}));
});
