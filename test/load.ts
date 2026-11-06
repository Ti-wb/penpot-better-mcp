import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.js';

// Two explicit, dedicated fixtures; never search or mutate ordinary designs.
assert(process.env.E2E_TARGETS_FILE, 'Set E2E_TARGETS_FILE to two dedicated acceptance files.');
const targets = JSON.parse(await readFile(process.env.E2E_TARGETS_FILE, 'utf8'));
assert.equal(targets.files.length, 2);
assert(targets.files.every((f: {name: string}) => f.name.startsWith('Headless acceptance ')));
const count = Number(process.env.LOAD_SHAPES || 3000);
assert(Number.isInteger(count) && count >= 100 && count <= 10000);
const phase = process.env.LOAD_PHASE || 'optimized';
const samples = Number(process.env.LOAD_SAMPLES || (phase === 'baseline' ? 12 : 60));
const prefix = '__better_mcp_load_v1__:';
const config = loadConfig({...process.env, PENPOT_BASE_URL: targets.base});
const source = process.env.LOAD_BASELINE_DIR ? pathToFileURL(resolve(process.env.LOAD_BASELINE_DIR)+'/') : new URL('../src/',import.meta.url);
const {HeadlessAdapter}=await import(new URL('headless-adapter.js',source).href);
const {Gateway}=await import(new URL('gateway.js',source).href);
const {createHttpApp}=await import(new URL('http.js',source).href);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const { chromium } = await import('playwright');
let adapter = new HeadlessAdapter(config);
const gateway = new Gateway(process.env.LOAD_BASELINE_DIR ? adapter : (fileId?: string) => {
  const instance = new HeadlessAdapter(config);
  if (fileId === targets.files[1].id) adapter = instance;
  return instance;
}, config.baseUrl);
const bearer = randomBytes(32).toString('hex');
const listener = createHttpApp(gateway, bearer).listen(0, '127.0.0.1');
await new Promise<void>(r => listener.once('listening', r));
const proxy = new Client({name:'load-proxy',version:'1'});
const direct = new Client({name:'load-direct',version:'1'});
const token = randomBytes(32).toString('hex');
const directUrl = new URL(config.upstreamHttp); directUrl.searchParams.set('userToken',token);
const browser = await chromium.launch({headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--allow-running-insecure-content']});
const context = await browser.newContext({storageState:config.storageState,locale:'en-US',viewport:{width:1440,height:1000}});
await context.grantPermissions(['local-network-access'], {origin:config.baseUrl});
// Baseline uses Chromium's native socket, no Node/Playwright message relay.
// Only its constructor destination/token changes; the official plugin and
// sidecar are identical to the proxy path. Loopback ws requires the flag above.
await context.addInitScript(({base,path,upstream,token}) => {
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(input: string | URL, protocols?: string | string[]) {
      let url = new URL(input.toString(), location.href);
      if (url.host === new URL(base).host && url.pathname === path) { url = new URL(upstream); url.searchParams.set('userToken',token); }
      super(url,protocols);
    }
  };
}, {base:config.baseUrl,path:config.pluginWsPath,upstream:config.upstreamWs,token});
const page = await context.newPage();
const resultData = (r: CallToolResult) => JSON.parse((r.content.find(c=>c.type==='text') as {text:string}).text);
const handles=new Set<string>();
async function tool(client: Client, name: string, args: Record<string,unknown>) {
  const r = CallToolResultSchema.parse(await client.callTool({name,arguments:args},CallToolResultSchema,{timeout:180_000}));
  if (r.isError) throw new Error(JSON.stringify(r.content));
  if(client===proxy && name==='open_document'){const h=resultData(r).documentHandle;if(typeof h==='string')handles.add(h);}
  if(client===proxy && name==='close_document')handles.delete(String(args.documentHandle));
  return r;
}
async function raw(code: string) { return tool(direct,'execute_code',{code}); }
let handle: string;
async function through(code: string) {
  return tool(proxy,'execute_code',{documentHandle:handle,code,...(phase !== 'baseline' ? {save:'deferred'} : {})});
}
async function directSave() {
  let since=Date.now(); const until=since+30000;
  while(Date.now()<until) {
    if (!await page.locator('[class*="__saved-status"]').count()) since=Date.now();
    else if(Date.now()-since>=750) return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('Direct baseline save unconfirmed');
}
async function flush() {
  if(phase==='baseline') await adapter['waitForSave']();
  else await tool(proxy,'flush_document',{documentHandle:handle});
}
function stats(values: number[]) {
  const sorted=[...values].sort((a,b)=>a-b);
  const percentile=(p:number)=>Number(sorted[Math.max(0,Math.ceil(p*sorted.length)-1)].toFixed(2));
  return {n:values.length,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:percentile(1),totalMs:Number(values.reduce((a,b)=>a+b,0).toFixed(2))};
}
const report: Record<string,any> = {at:new Date().toISOString(),phase,site:targets.base,shapesPerFile:count,externalProxy:!!process.env.LOAD_PROXY_URL,display:process.env.DISPLAY||null,metrics:{},checks:[],sourceHash:createHash('sha256').update(await readFile(process.env.LOAD_BASELINE_DIR ? resolve(process.env.LOAD_BASELINE_DIR,'headless-adapter.js') : 'src/headless-adapter.ts')).digest('hex')};
let peakRss=process.memoryUsage().rss;
const monitor=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},1000).unref();
const check=(name:string)=>{report.checks.push(name);console.log('PASS',name);};
async function measure(name:string,n:number,fn:(i:number)=>Promise<unknown>) {
  const values=[];
  for(let i=0;i<n;i++){const start=performance.now();await fn(i);values.push(performance.now()-start);}
  const result=stats(values); report.metrics[name]=result;console.log(name,JSON.stringify(result));return result;
}
async function memory(name:string,browser:Browser,p:Page) {
  const cdp=await p.context().newCDPSession(p);await cdp.send('Performance.enable');
  const data=await cdp.send('Performance.getMetrics');await cdp.detach();
  const system=await browser.newBrowserCDPSession();const {processInfo}=await system.send('SystemInfo.getProcessInfo');await system.detach();
  let rssKb=0;
  for(const info of processInfo){const status=await readFile(`/proc/${info.id}/status`,'utf8').catch(()=>'');rssKb+=Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0);}
  report.metrics[name]={nodeRssMiB:Number((process.memoryUsage().rss/1048576).toFixed(1)),nodeHeapMiB:Number((process.memoryUsage().heapUsed/1048576).toFixed(1)),browserRssSumMiB:Number((rssKb/1024).toFixed(1)),rendererHeapMiB:Number(((data.metrics.find(x=>x.name==='JSHeapUsedSize')?.value||0)/1048576).toFixed(1))};
}
const select=`penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)}))`;
const summary=`const a=${select};return {count:a.length,unique:new Set(a.map(s=>s.name)).size,sumX:a.reduce((n,s)=>n+s.x,0),sumY:a.reduce((n,s)=>n+s.y,0)};`;
async function setup(exec:(code:string)=>Promise<CallToolResult>,label:string) {
  const existing=resultData(await exec(summary)).result;assert([0,count].includes(existing.count),'Unexpected fixture size; inspect before rerunning.');
  if(existing.count===count)return;
  for(let offset=0;offset<count;offset+=100){
    const amount=Math.min(100,count-offset);
    const r=await exec(`for(let i=${offset};i<${offset+amount};i++){const s=penpot.createRectangle();s.name=${JSON.stringify(prefix)}+i;s.x=(i%50)*24;s.y=Math.floor(i/50)*18;s.resize(20,14);s.fills=[{fillColor:'#3366FF',fillOpacity:1}];}return ${amount};`);
    assert.equal(resultData(r).result,amount);
    if((offset+amount)%500===0)console.log(`fixture ${label}: ${offset+amount}/${count}`);
  }
}
try {
  const proxyUrl=process.env.LOAD_PROXY_URL || `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  const proxyToken=process.env.LOAD_PROXY_URL ? (await readFile(process.env.GATEWAY_TOKEN_FILE||'.state/gateway-token','utf8')).trim() : bearer;
  await proxy.connect(new StreamableHTTPClientTransport(new URL(proxyUrl),{requestInit:{headers:{Authorization:`Bearer ${proxyToken}`}}}));
  await direct.connect(new StreamableHTTPClientTransport(directUrl));
  report.upstreamTools=(await direct.listTools()).tools.map(t=>t.name);
  const started=performance.now();await page.goto(targets.files[0].url,{waitUntil:'domcontentloaded'});
  const button=page.getByTestId('mcp-btn');await button.waitFor({timeout:60000});
  await button.evaluate(el=>{if(!el.querySelector('[class*="__connected"]'))(el as HTMLElement).click();});
  const connect=page.getByRole('menuitem').filter({hasText:/^Connect(?: here)?$/}).first();
  await button.locator('[class*="__connected"]').or(connect).first().waitFor({timeout:15000});
  if(await connect.isVisible())await connect.click();await page.keyboard.press('Escape');
  let ready=false;
  for(let i=0;i<40;i++){const r=await direct.callTool({name:'execute_code',arguments:{code:'return {id:penpot.currentFile.id,version:penpot.version};'}});if(!r.isError){let d;try{d=resultData(CallToolResultSchema.parse(r)).result;}catch{}if(d){assert.equal(d.id,targets.files[0].id);report.penpotVersion=d.version;ready=true;break;}}await new Promise(r=>setTimeout(r,250));}
  assert(ready,'Native direct WebSocket did not connect');report.metrics.directColdMs=performance.now()-started;
  const begin=performance.now();const opened=resultData(await tool(proxy,'open_document',{url:targets.files[1].url}));handle=opened.documentHandle;assert(handle);report.metrics.proxyColdMs=performance.now()-begin;
  check(process.env.LOAD_PROXY_URL ? 'direct native WebSocket and Docker proxy HTTP use the same pinned official sidecar version' : 'direct native WebSocket and proxy HTTP use the same official sidecar instance');
  await setup(raw,'direct');await directSave();await setup(through,'proxy');await flush();
  assert.equal(resultData(await raw(summary)).result.count,count);assert.equal(resultData(await through(summary)).result.count,count);check('both dedicated files contain the requested native shapes');
  if(process.env.LOAD_MEMORY_ONLY==='1'){
    assert(!process.env.LOAD_PROXY_URL,'Memory probe requires the local adapter');
    const full=`return ${select}.map(s=>({id:s.id,name:s.name,x:s.x,y:s.y,width:s.width,height:s.height,fills:s.fills}));`;
    for(const [label,exec,worker,editor] of [['direct',raw,browser,page],['proxy',through,adapter['browser']!,adapter['page']!]] as const){
      const cdp=await editor.context().newCDPSession(editor);
      await cdp.send('HeapProfiler.collectGarbage');await memory(label+'MemoryStart',worker,editor);
      await measure(label+'MemoryWarmReads',60,async()=>assert.equal(resultData(await exec('return penpot.currentFile.id;')).result,targets.files[label==='direct'?0:1].id));
      await measure(label+'MemoryLargeReads',20,async()=>assert.equal(resultData(await exec(full)).result.length,count));
      await measure(label+'MemoryScans',20,async()=>assert.equal(resultData(await exec(summary)).result.count,count));
      await cdp.send('HeapProfiler.collectGarbage');await memory(label+'MemoryRetained',worker,editor);
      await cdp.send('Runtime.discardConsoleEntries');await cdp.send('HeapProfiler.collectGarbage');await memory(label+'MemoryAfterConsoleClear',worker,editor);
      await cdp.detach();
      console.log(label+'Memory',JSON.stringify({start:report.metrics[label+'MemoryStart'],retained:report.metrics[label+'MemoryRetained'],afterClear:report.metrics[label+'MemoryAfterConsoleClear']}));
    }
    report.status='passed';
  } else {
  for(let i=0;i<3;i++){await raw('return 1;');await through('return 1;');}
  if(!process.env.LOAD_PROXY_URL)await memory('before',adapter['browser']!,adapter['page']!);
  // Interleave read paths to reduce warm-up and host-load bias.
  const times={direct:[] as number[],proxy:[] as number[]};
  for(let i=0;i<samples;i++)for(const name of (i%2?['proxy','direct']:['direct','proxy']) as ('direct'|'proxy')[]){const start=performance.now();const r=await(name==='direct'?raw:through)('return penpot.currentFile.id;');assert.equal(resultData(r).result,targets.files[name==='direct'?0:1].id);times[name].push(performance.now()-start);}
  for(const name of ['direct','proxy'] as const){report.metrics[name+'Read']=stats(times[name]);console.log(name+'Read',JSON.stringify(report.metrics[name+'Read']));}
  const large=`return ${select}.map(s=>({id:s.id,name:s.name,x:s.x,y:s.y,width:s.width,height:s.height,fills:s.fills}));`;
  const largeSamples=Number(process.env.LOAD_LARGE_READS||Math.min(samples,20));
  await measure('directLargeRead',largeSamples,async()=>{const r=await raw(large);assert.equal(resultData(r).result.length,count);report.largeResultBytes=Buffer.byteLength(JSON.stringify(r));});
  await measure('proxyLargeRead',largeSamples,async()=>{const r=await through(large);assert.equal(resultData(r).result.length,count);report.proxyLargeResultBytes=Buffer.byteLength(JSON.stringify(r));});
  const write=(i:number)=>`const a=${select}.sort((a,b)=>Number(a.name.split(':').pop())-Number(b.name.split(':').pop())).slice(0,100);for(const s of a)s.x+=1;return a.length;`;
  const writes=Number(process.env.LOAD_WRITES||(phase==='baseline'?5:10));
  await measure('directWriteAck',writes,async i=>assert.equal(resultData(await raw(write(i))).result,100));await directSave();
  await measure('proxyWriteAck',writes,async i=>assert.equal(resultData(await through(write(i))).result,100));
  await measure('proxyFinalFlush',1,flush);
  const concurrentStart=performance.now();
  await measure('proxyConcurrent8',Number(process.env.LOAD_CONCURRENT_ROUNDS||(phase==='baseline'?2:10)),async()=>{
    const values=await Promise.all(Array.from({length:8},()=>through(summary)));
    for(const r of values)assert.equal(resultData(r).result.count,count);
  });
  report.metrics.concurrentElapsedMs=performance.now()-concurrentStart;
  if(phase!=='baseline'){
    const counter=resultData(await through(`const s=${select}[0];return {id:s.id,x:s.x};`)).result;
    for(let round=0;round<3;round++){
      const results=await Promise.all(Array.from({length:8},()=>through(`const s=penpotUtils.findShapeById(${JSON.stringify(counter.id)});s.x+=1;return s.x;`)));
      assert.deepEqual(results.map(r=>resultData(r).result).sort((a,b)=>a-b),Array.from({length:8},(_,i)=>counter.x+round*8+i+1));
    }
    await flush();check('24 concurrent increments serialize without lost or duplicate writes');
  }
  const burst=await Promise.all(Array.from({length:64},()=>proxy.callTool({name:'execute_code',arguments:{documentHandle:handle,code:'await new Promise(r=>setTimeout(r,50));return 1;',...(phase!=='baseline'?{save:'deferred'}:{})}},CallToolResultSchema,{timeout:180000})));
  const errors=burst.filter(r=>r.isError).map(r=>resultData(CallToolResultSchema.parse(r)).code);
  assert(errors.every(c=>c==='BUSY'));assert(errors.length>0);assert(burst.some(r=>!r.isError));
  report.metrics.burst64={accepted:64-errors.length,busy:errors.length};check('overload is bounded and rejects explicitly without losing accepted calls');
  if(phase!=='baseline'){
    await measure('proxySoakRead',Number(process.env.LOAD_SOAK||200),async()=>assert.equal(resultData(await through(summary)).result.count,count));
    if(!process.env.LOAD_PROXY_URL){
      await memory('afterSoak',adapter['browser']!,adapter['page']!);
      const cdp=await adapter['page']!.context().newCDPSession(adapter['page']!);await cdp.send('HeapProfiler.collectGarbage');await cdp.detach();
      await memory('afterGc',adapter['browser']!,adapter['page']!);
    }
  }
  const before=resultData(await through(summary)).result;assert.equal(before.unique,count);
  for(const documentHandle of [...handles])await tool(proxy,'close_document',{documentHandle});
  handle=resultData(await tool(proxy,'open_document',{url:targets.files[1].url})).documentHandle;
  assert.deepEqual(resultData(await through(summary)).result,before);check('bulk writes survive full browser teardown with count, uniqueness and coordinate checksum intact');
  await measure('crossFileOpen',4,async i=>{const d=resultData(await tool(proxy,'open_document',{url:targets.files[i%2].url}));assert(d.documentHandle);});
  handle=resultData(await tool(proxy,'open_document',{url:targets.files[1].url})).documentHandle;
  if(process.env.LOAD_KEEP_FIXTURE!=='1'){
    for(const [name,exec] of [['direct',raw],['proxy',through]] as const){
      let left=count;
      while(left>0){const r=resultData(await exec(`const a=${select}.slice(0,100);for(const s of a)s.remove();return a.length;`)).result;assert(r>0);left-=r;}
      console.log('cleaned',name);
    }
    await directSave();await flush();
    for(const documentHandle of [...handles])await tool(proxy,'close_document',{documentHandle});
    for(const file of targets.files){
      const d=resultData(await tool(proxy,'open_document',{url:file.url}));handle=d.documentHandle;
      assert.equal(resultData(await through(summary)).result.count,0);
    }
    check('all owned load-test shapes removed and cleanup read back from the backend');
  }
  report.status='passed';
  }
} catch(error) {
  report.status='failed';report.failure=error instanceof Error ? error.name : 'unknown error';
  throw error;
} finally {
  clearInterval(monitor);report.metrics.harnessNodePeakRssMiB=Number((peakRss/1048576).toFixed(1));
  for(const documentHandle of [...handles])await tool(proxy,'close_document',{documentHandle}).catch(()=>{});
  await gateway.shutdown().catch(()=>{});await proxy.close().catch(()=>{});await direct.close().catch(()=>{});await browser.close();
  listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));
  await mkdir('test-results',{recursive:true});await writeFile(`test-results/load-${phase}.json`,JSON.stringify(report,null,2));
}
