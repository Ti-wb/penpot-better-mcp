import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { BackendReader } from '../src/backend-reader.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { Gateway } from '../src/gateway.js';
import { Diagnostics } from '../src/diagnostics.js';
import { createHttpApp } from '../src/http.js';
import { data, loadFixture, writeReport } from './support.js';

const {targets,config}=await loadFixture();
const count=Number(process.env.READ_SHAPES||3000),samples=Number(process.env.READ_SAMPLES||12);
assert(Number.isInteger(count)&&count>=100&&count<=10000);assert(Number.isInteger(samples)&&samples>=2&&samples<=100);
const events:Record<string,any>[]=[],diagnostics=new Diagnostics(r=>events.push(r)),reader=new BackendReader(config,diagnostics);
const adapters:HeadlessAdapter[]=[];
const gateway=new Gateway(()=>{const a=new HeadlessAdapter(config,diagnostics);adapters.push(a);return a;},config.baseUrl,600000,diagnostics,2,reader);
const bearer=randomUUID()+randomUUID();
const server=createHttpApp(gateway,bearer).listen(0,'127.0.0.1');
await new Promise<void>(r=>server.once('listening',r));
const client=new Client({name:'browserless-acceptance',version:'1'});
const url=targets.files[0].url,prefix='__browserless_'+randomUUID()+':';
let handle:string|undefined,pageId:string|undefined,temporaryPage:string|undefined,totalPageShapes=count;
const fields=['id','name','x','y','width','height'];
const report:Record<string,any>={at:new Date().toISOString(),site:targets.base.includes('127.0.0.1')?'isolated':'internal',shapeCount:count,samples,metrics:{},checks:[]};
const check=(name:string)=>{report.checks.push(name);console.log('PASS',name);};
const starts=()=>events.filter(e=>e.event==='browser_started').length;
async function tool(name:string,args:Record<string,unknown>){return data(CallToolResultSchema.parse(await client.callTool({name,arguments:args},CallToolResultSchema,{timeout:180000})));}
async function execute(code:string,save='deferred'){return (await tool('execute_code',{documentHandle:handle,code,save})).result;}
async function flush(){await tool('flush_document',{documentHandle:handle});}
async function backendScan(){
  const shapes:Record<string,unknown>[]=[];let offset=0,snapshotId:string|undefined;
  do {const r=await tool('read_document',{url,view:'shapes',pageId,fields,limit:1000,offset,...(snapshotId?{snapshotId}:{})});shapes.push(...r.shapes);snapshotId=r.snapshotId;offset=r.nextOffset;}while(offset!==null);
  return shapes.filter(s=>String(s.name).startsWith(prefix));
}
const browserCode=(offset:number)=>`return penpotUtils.findShapes(s=>s.id!=='00000000-0000-0000-0000-000000000000').sort((a,b)=>a.id.localeCompare(b.id)).slice(${offset},${offset+1000}).map(s=>({id:s.id,name:s.name,x:s.x,y:s.y,width:s.width,height:s.height}));`;
async function browserScan(){const shapes=[];for(let i=0;i<totalPageShapes;i+=1000)shapes.push(...await execute(browserCode(i)));return shapes.filter(s=>s.name.startsWith(prefix));}
function stats(times:number[]){const a=[...times].sort((a,b)=>a-b);return{n:a.length,p50Ms:+a[Math.ceil(a.length*.5)-1].toFixed(2),p95Ms:+a[Math.ceil(a.length*.95)-1].toFixed(2)};}
async function memory(){
  let rss=0;
  for(const a of adapters){const browser=a['browser'];if(!browser)continue;const c=await browser.newBrowserCDPSession();
    try{const result=await c.send('SystemInfo.getProcessInfo');for(const p of result.processInfo){const s=await readFile(`/proc/${p.id}/status`,'utf8').catch(()=>'');rss+=Number(s.match(/VmRSS:\s+(\d+)/)?.[1]||0)*1024;}}finally{await c.detach();}}
  return{nodeRssMiB:+(process.memoryUsage().rss/1048576).toFixed(1),browserRssSumMiB:+(rss/1048576).toFixed(1)};
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+bearer}}}));
  assert((await client.listTools()).tools.some(t=>t.name==='read_document'));
  const initial=await tool('read_document',{url});assert.equal(starts(),0);assert.equal(initial.source,'backend');pageId=initial.pages[0].id;
  totalPageShapes=initial.pages[0].shapeCount+count;report.pageShapes=totalPageShapes;
  assert(events.filter(e=>e.operation==='read_document').every(e=>e.upstreamCalls===0));
  report.metrics.initialReadOnlyMemory=await memory();check('MCP reads work before any browser or upstream connection');
  const open=await tool('open_document',{url});handle=open.documentHandle;assert(handle);report.penpotVersion=data(open.result).result.version;
  for(let offset=0;offset<count;offset+=100){const amount=Math.min(100,count-offset);
    assert.equal(await execute(`for(let i=${offset};i<${offset+amount};i++){const s=penpot.createRectangle();s.name=${JSON.stringify(prefix)}+i;s.x=(i%50)*24;s.y=Math.floor(i/50)*18;s.resize(20,14);}return ${amount};`),amount);
    if((offset+amount)%1000===0)console.log('Fixture shapes:',offset+amount);
  }
  await flush();
  const expected=await browserScan();assert.equal(expected.length,count);await flush();
  assert.deepEqual(await backendScan(),expected);check(`${count} shape fields and IDs match the live Plugin API`);
  const first=expected[0];const snap=await tool('read_document',{url});
  const writeReadStart=performance.now();
  const write=execute(`const s=penpotUtils.findShapeById(${JSON.stringify(first.id)});s.x+=1;return s.x;`);
  const read=tool('read_document',{url,view:'shapes',pageId,shapeIds:[first.id],fields});
  assert.equal((await read).shapes[0].x,await write);first.x+=1;report.metrics.deferredWriteThenReadMs=+(performance.now()-writeReadStart).toFixed(2);
  const stale=await client.callTool({name:'read_document',arguments:{url,snapshotId:snap.snapshotId}});assert(stale.isError);assert.equal(JSON.parse((stale.content as any)[0].text).code,'SNAPSHOT_CHANGED');
  check('deferred writes save before backend reads, invalidate cache and reject old pagination snapshots');
  temporaryPage=await execute(`const p=penpot.createPage();p.name=${JSON.stringify(prefix+'page')};return p.id;`);
  const pageSwitches=events.filter(e=>e.event==='page_selected').length;
  const empty=await tool('read_document',{url,view:'shapes',pageId:temporaryPage});assert.equal(empty.total,0);
  assert.equal(events.filter(e=>e.event==='page_selected').length,pageSwitches);check('other pages can be read without navigating the editor');
  await execute(`penpot.currentFile.pages.find(p=>p.id===${JSON.stringify(temporaryPage)}).remove();`);temporaryPage=undefined;await flush();
  // Close the editor and clear the small cache to measure a cold read of the large file.
  await tool('close_document',{documentHandle:handle});handle=undefined;reader.clear();
  const started=starts(),cold=performance.now();assert.deepEqual(await backendScan(),expected);report.metrics.backendColdScanMs=+(performance.now()-cold).toFixed(2);
  assert.equal(starts(),started);report.metrics.readOnlyMemory=await memory();
  const coldBrowser=performance.now();handle=(await tool('open_document',{url})).documentHandle;
  assert.deepEqual(await browserScan(),expected);report.metrics.browserColdScanMs=+(performance.now()-coldBrowser).toFixed(2);await flush();
  report.metrics.browserMemory=await memory();console.log('Cold scans (backend/browser ms):',report.metrics.backendColdScanMs,report.metrics.browserColdScanMs);
  const timings={backend:[] as number[],browser:[] as number[]};
  for(let i=0;i<samples;i++)for(const mode of (i%2?['browser','backend']:['backend','browser']) as ('backend'|'browser')[]){
    const start=performance.now();assert.deepEqual(await(mode==='backend'?backendScan():browserScan()),expected);timings[mode].push(performance.now()-start);
    if(mode==='browser')await flush(); // Keep the save fence outside both read timings.
  }
  report.samplesMs=timings;report.metrics.backendWarmScan=stats(timings.backend);report.metrics.browserWarmScan=stats(timings.browser);
  const small={backend:[] as number[],browser:[] as number[]};
  for(let i=0;i<samples;i++)for(const mode of (i%2?['browser','backend']:['backend','browser']) as ('backend'|'browser')[]){
    const start=performance.now();
    const value=mode==='backend'
      ? (await tool('read_document',{url,view:'shapes',pageId,shapeIds:[first.id],fields})).shapes[0]
      : await execute(`const s=penpotUtils.findShapeById(${JSON.stringify(first.id)});return {id:s.id,name:s.name,x:s.x,y:s.y,width:s.width,height:s.height};`);
    assert.deepEqual(value,first);small[mode].push(performance.now()-start);
    if(mode==='browser')await flush();
  }
  report.singleShapeSamplesMs=small;report.metrics.backendSingleShape=stats(small.backend);report.metrics.browserSingleShape=stats(small.browser);
  await tool('close_document',{documentHandle:handle});handle=undefined;
  const before=starts(),memorySamples=[],concurrentTimes=[];
  for(let round=0;round<5;round++){
    const start=performance.now();
    await Promise.all(Array.from({length:8},()=>tool('read_document',{url,view:'shapes',pageId,fields,limit:1000})));
    concurrentTimes.push(performance.now()-start);memorySamples.push(await memory());
  }
  assert.equal(starts(),before);report.metrics.readOnlySoakMemory=memorySamples;report.metrics.concurrent8Batch=stats(concurrentTimes);
  const calls=events.filter(e=>e.operation==='read_document'&&e.event==='request');
  assert(calls.some(e=>e.cacheRevalidations===1));report.metrics.backendRequests=calls.length;report.metrics.revalidated=calls.reduce((n,e)=>n+e.cacheRevalidations,0);
  check('40 reads at concurrency 8 use ETag validation without launching a browser');
  console.log('Warm scan p50 (backend/browser ms):',report.metrics.backendWarmScan.p50Ms,report.metrics.browserWarmScan.p50Ms);
  report.status='passed';
} finally {
  // Only remove shapes/pages uniquely owned by this run, even if a comparison failed.
  try {
    if(!handle)handle=(await tool('open_document',{url})).documentHandle;
    if(temporaryPage)await execute(`const p=penpot.currentFile.pages.find(p=>p.id===${JSON.stringify(temporaryPage)});if(p)p.remove();`);
    for(let i=0;i<Math.ceil(count/100)+1;i++){
      const removed=await execute(`const a=penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)})).slice(0,100);for(const s of a)s.remove();return a.length;`);if(!removed)break;
    }
    await flush();const remaining=await execute(`return penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)})).length;`);assert.equal(remaining,0);await flush();
    check('owned test shapes and pages removed');
  }finally{await client.close();await gateway.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  report.slowestOperations=events.filter(e=>e.event==='request').sort((a,b)=>b.totalMs-a.totalMs).slice(0,10);
  await writeReport(`browserless-${report.site}.json`,report);
}
console.log(JSON.stringify(report.metrics,null,2));
