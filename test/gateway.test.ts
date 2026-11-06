import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { parseDocument } from '../src/document.js';
import { GatewayError, publicError } from '../src/errors.js';
import type { DesignAdapter } from '../src/adapter.js';
import { createHttpApp } from '../src/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { isUpstreamTaskTimeout, normalizeUpstreamResult } from '../src/upstream-result.js';

const base = 'https://penpot.example';
const team = '11111111-1111-4111-8111-111111111111';
const file = '22222222-2222-4222-8222-222222222222';
const page = '33333333-3333-4333-8333-333333333333';
const url = `${base}/#/workspace?team-id=${team}&file-id=${file}&page-id=${page}`;
const ok = { content: [{ type: 'text' as const, text: '{}' }] };
function fake(): DesignAdapter { return { open: async () => ok, openPage: async () => ok, execute: async () => ok, flush: async () => ok, exportShape: async () => ok, documentation: async () => ok, release: () => {}, close: async () => {} }; }

test('page handles keep independent targets and failed page opens release their binding', async () => {
  const adapter = fake(); const seen: (string | undefined)[] = []; let released = 0;
  adapter.execute = async target => { seen.push(target.pageId); return ok; };
  adapter.release = () => { released++; };
  const gateway = new Gateway(adapter, base);
  try {
    const first = await gateway.open(url);
    const second = await gateway.openPage(first.documentHandle!, file);
    assert.notEqual(second.documentHandle, first.documentHandle);
    await gateway.execute(first.documentHandle!, 'read'); await gateway.execute(second.documentHandle!, 'read');
    assert.deepEqual(seen, [page, file]);
    adapter.openPage = async () => { throw new GatewayError('PAGE_NOT_FOUND', 'missing'); };
    await assert.rejects(gateway.openPage(first.documentHandle!, page), /missing/);
    assert.equal(released, 1);
    await assert.rejects(gateway.openPage(first.documentHandle!, 'not-a-uuid'), /UUID/);
  } finally { await gateway.shutdown(); }
});

test('flags official plain-text failures without misclassifying user return values', () => {
  assert.equal(normalizeUpstreamResult({content:[{type:'text',text:'Tool execution failed: Error: connection lost'}]}).isError,true);
  assert(!normalizeUpstreamResult({content:[{type:'text',text:JSON.stringify({result:'Tool execution failed: user data'})}]}).isError);
  const timeout = `Tool execution failed: Error: Task ${file} timed out after 120 seconds`;
  assert(isUpstreamTaskTimeout({content:[{type:'text',text:timeout}]}));
  assert(!isUpstreamTaskTimeout({content:[{type:'text',text:JSON.stringify({result:timeout})}]}));
  assert(!isUpstreamTaskTimeout({content:[{type:'text',text:'Tool execution failed: Error: user timeout'}]}));
});

test('releases bindings on failed opens, closed handles and shutdown', async () => {
  const adapter = fake(); const live = new Set<object>(); let failed = false;
  adapter.open = async target => { live.add(target); return failed ? {...ok,isError:true} : ok; };
  adapter.release = target => { live.delete(target); };
  const gateway = new Gateway(adapter, base);
  try {
    failed = true; await gateway.open(url); assert.equal(live.size,0);
    failed = false; const first=await gateway.open(url); await gateway.open(url); assert.equal(live.size,2);
    await gateway.closeDocument(first.documentHandle!); assert.equal(live.size,1);
  } finally {await gateway.shutdown();}
  assert.equal(live.size,0);
});

test('deferred writes and their flush remain in order, with waiting the default', async () => {
  const adapter=fake(); const seen:string[]=[];
  adapter.execute=async (_target,_code,save)=>{seen.push(save!);return ok;};
  adapter.flush=async()=>{seen.push('flush');return ok;};
  const gateway=new Gateway(adapter,base);
  try {
    const opened=await gateway.open(url);assert(opened.documentHandle);
    await Promise.all([gateway.execute(opened.documentHandle,'write','deferred'),gateway.flush(opened.documentHandle),gateway.execute(opened.documentHandle,'write')]);
    assert.deepEqual(seen,['deferred','flush','wait']);
  } finally {await gateway.shutdown();}
});

test('normalizes accepted workspace URLs without forwarding arbitrary parameters', () => {
  const target = parseDocument(url + '&plugin=untrusted', base);
  assert.equal(target.fileId, file); assert.equal(target.pageId, page); assert(!target.url.includes('plugin'));
  const queryLink=parseDocument(`${base}/?screen=workspace&team-id=${team}&file-id=${file}`, base);
  assert.equal(queryLink.fileId,file);assert(queryLink.url.includes('/#/workspace?'));
  assert.equal(parseDocument(`${base}/#/workspace/${team}/${file}`, base).fileId, file);
});
test('rejects cross-site, share-link and conflicting file references before opening a browser', () => {
  for (const bad of [url.replace('penpot.example','evil.example'), url + '&share-id=' + file, url.replace(file,'not-a-uuid'), `${base}/?file-id=${page}#/workspace?team-id=${team}&file-id=${file}`, `https://secret@penpot.example/#/workspace?team-id=${team}&file-id=${file}`]) assert.throws(() => parseDocument(bad, base), GatewayError);
});
test('serializes concurrent requests, preserves bound targets, and continues after a failure', async () => {
  const adapter = fake(); const seen: string[] = []; let running = 0;
  adapter.execute = async (target, code) => {
    assert.equal(++running, 1); seen.push(target.fileId + ':' + code);
    await new Promise(r => setTimeout(r, 10)); running--;
    if (code === 'fail') throw new Error('failure'); return ok;
  };
  const gateway = new Gateway(adapter, base);
  try {
    const a = await gateway.open(url); const other = '44444444-4444-4444-8444-444444444444'; const b = await gateway.open(url.replace(file,other));
    assert(a.documentHandle && b.documentHandle);
    const results = await Promise.allSettled([gateway.execute(a.documentHandle,'fail'),gateway.execute(b.documentHandle,'read'),gateway.execute(a.documentHandle,'again')]);
    assert.deepEqual(results.map(r=>r.status),['rejected','fulfilled','fulfilled']);
    assert.deepEqual(seen,[file+':fail',other+':read',file+':again']);
    await gateway.closeDocument(a.documentHandle); await assert.rejects(gateway.inspect(a.documentHandle), /valid handle/);
  } finally { await gateway.shutdown(); }
});
test('does not retry an uncertain write and does not expose raw exception credentials', async () => {
  const adapter = fake(); let calls = 0;
  adapter.execute = async () => { calls++; throw new GatewayError('EXECUTION_UNKNOWN','Inspect before retrying',true); };
  const gateway = new Gateway(adapter, base);
  try { const doc = await gateway.open(url); await assert.rejects(gateway.execute(doc.documentHandle!,'write'), /Inspect/); assert.equal(calls,1); }
  finally { await gateway.shutdown(); }
  assert(!JSON.stringify(publicError(new Error('userToken=private-secret'))).includes('private-secret'));
});
test('HTTP requires bearer auth, rejects browser origins and serves a real MCP client', async () => {
  const adapter = fake(); const gateway = new Gateway(adapter,base); const token = 't'.repeat(40);
  const server = createHttpApp(gateway,token).listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const client = new Client({name:'test',version:'1'});
  try {
    assert.equal((await fetch(endpoint,{method:'POST'})).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}})).status,403);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    assert((await client.listTools()).tools.some(t=>t.name==='open_document'));
    assert((await client.listTools()).tools.some(t=>t.name==='open_page'));
    const result = await client.callTool({name:'open_document',arguments:{url}});
    assert(!result.isError);
    const opened = JSON.parse((result.content as {text: string}[])[0].text);
    const selected = await client.callTool({name:'open_page',arguments:{documentHandle:opened.documentHandle,pageId:page}});
    assert(!selected.isError);
    adapter.open = async () => ({...ok,isError:true});
    const failed = await client.callTool({name:'open_document',arguments:{url}});
    assert.equal(failed.isError,true);
  } finally { await client.close(); await gateway.shutdown(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
});
