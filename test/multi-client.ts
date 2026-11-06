import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadFixture, body, writeReport } from './support.js';
import { parseDocument, targetPage } from '../src/document.js';

const { targets, config } = await loadFixture();
const legacy=!!process.env.MULTI_BASELINE_DIR;
const workers=Number(process.env.MULTI_WORKERS || 2);
const source=legacy?pathToFileURL(resolve(process.env.MULTI_BASELINE_DIR!)+'/'):new URL('../src/',import.meta.url);
const {Gateway}=await import(new URL('gateway.js',source).href);
const {HeadlessAdapter}=await import(new URL('headless-adapter.js',source).href);
const {Diagnostics}=await import(new URL('diagnostics.js',source).href);
const {createHttpApp}=await import(new URL('http.js',source).href);
const events:Record<string,any>[]=[];
const diagnostics=new Diagnostics((event:Record<string,any>)=>events.push(event));
const gateway=legacy?new Gateway(new HeadlessAdapter(config,diagnostics),targets.base,600_000,diagnostics)
  :new Gateway(()=>new HeadlessAdapter(config,diagnostics),targets.base,600_000,diagnostics,workers);
const bearer=randomBytes(32).toString('hex');
const server=createHttpApp(gateway,bearer).listen(0,'127.0.0.1');
await new Promise<void>(r=>server.once('listening',r));
const endpoint=process.env.E2E_HTTP_URL || `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
const token=process.env.E2E_HTTP_URL?(await readFile(process.env.GATEWAY_TOKEN_FILE || '.state/gateway-token','utf8')).trim():bearer;
const clients=Array.from({length:4},(_,i)=>new Client({name:`multi-agent-${i}`,version:'1'}));
const handles=new Set<string>(), pages:string[]=[], roots:string[]=[], urls:string[]=[];
const prefix='__multi_'+randomUUID()+':';
const report:Record<string,any>={at:new Date().toISOString(),site:targets.base,externalProxy:!!process.env.E2E_HTTP_URL,mode:legacy?'legacy-serial':`pool-${workers}`,clients:4,ownedPrefix:prefix,roots,pages,status:'failed',checks:[],timings:{}};
const checkpoint=()=>writeReport(process.env.MULTI_REPORT || 'multi-client.json',report);
const check=(s:string)=>{report.checks.push(s);console.log('PASS',s);};
async function call(i:number,name:string,args:Record<string,unknown>) {
  const result=CallToolResultSchema.parse(await clients[i].callTool({name,arguments:args},CallToolResultSchema,{timeout:180_000}));
  assert(!result.isError,JSON.stringify(result.content));
  if(name==='open_document'||name==='open_page')handles.add(body(result).documentHandle);
  if(name==='close_document')handles.delete(String(args.documentHandle));
  return result;
}
const execute=async(i:number,handle:string,code:string)=>body(await call(i,'execute_code',{documentHandle:handle,code,save:'deferred'})).result;
const open=async(i:number,url:string)=>body(await call(i,'open_document',{url}));
async function closeAll(){for(const documentHandle of [...handles])await call(0,'close_document',{documentHandle});}
type Interval={start:number;end:number;fileId:string;value:number};
function overlap(a:Interval,b:Interval){return Math.min(a.end,b.end)>Math.max(a.start,b.start);}
function assertSerialized(rows:Interval[]) {for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(rows[i].fileId===rows[j].fileId)assert(!overlap(rows[i],rows[j]),'same-file executions overlapped');}
async function edits(documents:string[],counters:string[],rounds:number,label:string,hold:number) {
  const started=performance.now();const rows:Interval[]=[];
  await Promise.all(clients.map(async(_client,i)=>{
    for(let round=0;round<rounds;round++) {
      const row=await execute(i,documents[i],`const start=Date.now();const s=penpotUtils.findShapeById(${JSON.stringify(counters[i])});const value=s.x;await new Promise(r=>setTimeout(r,${hold}));s.x=value+1;
for(let j=0;j<10;j++){const r=penpot.createRectangle();r.name=${JSON.stringify(prefix+label+':'+i+':'+round+':')}+j;r.x=j*12;r.resize(10,10);}
return {start,end:Date.now(),fileId:penpot.currentFile.id,value:s.x};`);
      rows.push(row);
    }
  }));
  assertSerialized(rows);report.timings[label]={wallMs:performance.now()-started,intervals:rows};return rows;
}
try {
  await checkpoint();
  await Promise.all(clients.map(client=>client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}))));
  for(let i=0;i<2;i++) {
    const opened=await open(0,targets.files[i].url);roots[i]=body(opened.result).result.pageId;
    urls[i]=targetPage(parseDocument(targets.files[i].url,targets.base),roots[i]).url;
  }
  await closeAll();
  const same=await Promise.all(clients.map((_,i)=>open(i,!legacy&&i===1 ? urls[0].replace(targets.files[0].id,targets.files[0].id.toUpperCase()) : urls[0])));
  const sameHandles=same.map(d=>d.documentHandle);
  const counter=await execute(0,sameHandles[0],`const s=penpot.createRectangle();s.name=${JSON.stringify(prefix+'same-counter')};s.x=0;return s.id;`);
  const sameRows=await edits(sameHandles,Array(4).fill(counter),4,'same-file',40);
  assert.deepEqual(sameRows.map(r=>r.value).sort((a,b)=>a-b),Array.from({length:16},(_,i)=>i+1));
  await call(0,'flush_document',{documentHandle:sameHandles[0]});
  check('four independent clients perform 16 read-await-modify writes in one file without overlap or lost increments');

  for(let i=0;i<2;i++)pages.push(await execute(0,sameHandles[0],`const p=penpot.createPage();p.name=${JSON.stringify(prefix+'page-'+i)};return p.id;`));
  await checkpoint();
  const pageHandles:string[]=[];
  for(let i=0;i<4;i++)pageHandles.push(body(await call(i,'open_page',{documentHandle:sameHandles[i],pageId:pages[i%2]})).documentHandle);
  const pageStart=performance.now();
  await Promise.all(clients.map(async(_,i)=>{
    const r=await execute(i,pageHandles[i],`for(let j=0;j<10;j++){const s=penpot.createRectangle();s.name=${JSON.stringify(prefix+'page-shape-'+i+':')}+j;}return {fileId:penpot.currentFile.id,pageId:penpot.currentPage.id};`);
    assert.equal(r.fileId,targets.files[0].id);assert.equal(r.pageId,pages[i%2]);
  }));
  report.timings.pagesMs=performance.now()-pageStart;
  check('independent page handles route concurrent writes to the intended pages in the same file');
  await closeAll();

  const mixed=await Promise.all(clients.map((_,i)=>open(i,urls[i%2])));
  const mixedHandles=mixed.map(d=>d.documentHandle),counterIds:string[]=[];
  for(let i=0;i<2;i++)counterIds[i]=await execute(i,mixedHandles[i],`const s=penpot.createRectangle();s.name=${JSON.stringify(prefix+'cross-counter-'+i)};s.x=0;return s.id;`);
  const mixedRows=await edits(mixedHandles,[counterIds[0],counterIds[1],counterIds[0],counterIds[1]],2,'cross-file',400);
  for(let i=0;i<2;i++)assert.deepEqual(mixedRows.filter(r=>r.fileId===targets.files[i].id).map(r=>r.value).sort((a,b)=>a-b),[1,2,3,4]);
  const parallel=mixedRows.some((a,i)=>mixedRows.slice(i+1).some(b=>a.fileId!==b.fileId&&overlap(a,b)));
  assert.equal(parallel,!legacy&&workers>1,'cross-file execution concurrency does not match the selected architecture');
  report.crossFileParallel=parallel;
  await Promise.all([0,1].map(i=>call(i,'flush_document',{documentHandle:mixedHandles[i]})));
  check(parallel?'different files execute concurrently while each file remains serialized':legacy?'baseline confirms different files also wait in the global serial queue':'capacity 1 serializes different files while safely evicting and reopening their workers');

  await execute(1,mixedHandles[1],'storage.multiClientKeeper=42;return true;');
  await call(0,'close_document',{documentHandle:mixedHandles[0]});
  const lastA=body(await call(2,'close_document',{documentHandle:mixedHandles[2]}));
  if(!legacy)assert.equal(lastA.remainingFileHandles,0);
  assert.equal(await execute(1,mixedHandles[1],'return storage.multiClientKeeper;'),42);
  await clients[3].close();
  assert.equal(await execute(1,mixedHandles[1],`return penpotUtils.findShapeById(${JSON.stringify(counterIds[1])}).x;`),4);
  check('closing another file and disconnecting one client leave the remaining client usable');
  await closeAll();

  for(let i=0;i<2;i++) {
    const d=await open(i,urls[i]);
    assert.equal(await execute(i,d.documentHandle,`return penpotUtils.findShapeById(${JSON.stringify(counterIds[i])}).x;`),4);
    const expected=i===0?202:41;
    assert.equal(await execute(i,d.documentHandle,`return penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)}),penpot.currentPage.root).length;`),expected);
    if(i===0)for(const id of pages)assert.equal(await execute(i,d.documentHandle,`return penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)}),penpotUtils.getPageById(${JSON.stringify(id)}).root).length;`),20);
  }
  check('all 24 increments and owned shape counts persist after all handles close and cold reopen');
  report.status='passed';
} catch(error) {report.failure=String(error);throw error;} finally {
  try {
    await closeAll();
    for(let i=0;i<2;i++)if(roots[i]) {
      const d=await open(0,urls[i]);
      if(i===0)for(const id of pages)await execute(0,d.documentHandle,`const p=penpotUtils.getPageById(${JSON.stringify(id)});if(p)p.remove();return true;`);
      await execute(0,d.documentHandle,`for(const s of penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)}),penpot.currentPage.root))s.remove();return true;`);
      await call(0,'flush_document',{documentHandle:d.documentHandle});
      await closeAll();
      const verified=await open(0,urls[i]);
      assert.equal(await execute(0,verified.documentHandle,`return penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)})).length;`),0);
      await closeAll();
    }
    check('all owned test shapes and pages removed; cleanup confirmed after cold reopen');
  } catch(error){report.status='failed';report.cleanupFailure=String(error);throw error;}
  finally {
    await Promise.allSettled(clients.map(client=>client.close()));await gateway.shutdown();
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    report.requestCount=process.env.E2E_HTTP_URL ? null : events.filter(e=>e.event==='request').length;
    await checkpoint();
  }
}
