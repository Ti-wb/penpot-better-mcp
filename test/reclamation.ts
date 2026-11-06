import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Browser } from 'playwright';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { Diagnostics } from '../src/diagnostics.js';
import { Gateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';
import { parseDocument, targetPage } from '../src/document.js';

const targets=JSON.parse(await readFile(process.env.E2E_TARGETS_FILE || '.state/latest-targets.json','utf8'));
assert(targets.files.every((f:{name:string})=>f.name.startsWith('Headless acceptance ')));
const count=Number(process.env.RECLAIM_SHAPES || 3000), rounds=Number(process.env.RECLAIM_ROUNDS || 5);
assert(Number.isInteger(count)&&count>=100&&count<=10000); assert(Number.isInteger(rounds)&&rounds>=3&&rounds<=10);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const events:Record<string,any>[]=[];
const diagnostics=new Diagnostics(record=>events.push(record));
const config=loadConfig({...process.env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:process.env.PENPOT_STORAGE_STATE || '.state/latest-session.json'});
const adapter=new HeadlessAdapter(config,diagnostics), gateway=new Gateway(adapter,targets.base,1500,diagnostics);
const prefix='__reclaim_'+randomUUID()+':';
const select=`penpotUtils.findShapes(s=>s.name.startsWith(${JSON.stringify(prefix)}))`;
const summary=`const a=${select};return {count:a.length,sumX:a.reduce((n,s)=>n+s.x,0)};`;
const report:Record<string,any>={at:new Date().toISOString(),site:targets.base,shapes:count,rounds,idleMs:1500,status:'failed',checks:[],cycles:[]};
let handle:string|undefined, root:string|undefined, extra:string|undefined, rootUrl=targets.files[0].url;
const data=(result:CallToolResult)=>{assert(!result.isError,JSON.stringify(result.content));return JSON.parse((result.content.find(c=>c.type==='text') as {text:string}).text).result;};
const execute=(code:string)=>gateway.execute(handle!,code,'deferred');
const check=(name:string)=>{report.checks.push(name);console.log('PASS',name);};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>,timeout=15000) {const deadline=Date.now()+timeout;while(!await check()){assert(Date.now()<deadline,'reclamation timed out');await delay(100);}}
async function memory(browser:Browser) {
  const session=await browser.newBrowserCDPSession();
  const {processInfo}=await session.send('SystemInfo.getProcessInfo');await session.detach();
  let rssKiB=0;
  for(const p of processInfo){const status=await readFile(`/proc/${p.id}/status`,'utf8').catch(()=>'');rssKiB+=Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0);}
  return {nodeRssMiB:process.memoryUsage().rss/1048576,browserRssSumMiB:rssKiB/1024,processes:processInfo.length,pids:processInfo.map(p=>p.id)};
}
async function gone(pids:number[]) {
  const status=await Promise.all(pids.map(pid=>readFile(`/proc/${pid}/status`,'utf8').catch(()=>'')));
  return status.every(text=>!text||/^State:\s+Z/m.test(text));
}
async function switchTo(pageId:string) {
  const previous=handle!, browser=adapter['browser'], page=adapter['page'];
  const opened=await gateway.openPage(previous,pageId);assert(opened.documentHandle);handle=opened.documentHandle;
  const released=await gateway.closeDocument(previous);
  assert.equal(released.browserReleased,false);assert.equal(released.remainingHandles,1);
  assert.equal(adapter['browser'],browser);assert.equal(adapter['page'],page);
}
try {
  const opened=await gateway.open(rootUrl);handle=opened.documentHandle!;root=data(opened.result).pageId;
  rootUrl=targetPage(parseDocument(rootUrl,targets.base),root!).url;
  await switchTo(root!);
  extra=data(await execute(`const p=penpot.createPage();p.name=${JSON.stringify(prefix+'page')};return p.id;`));
  for(let offset=0;offset<count;offset+=100){
    const end=Math.min(count,offset+100);
    data(await execute(`for(let i=${offset};i<${end};i++){const s=penpot.createRectangle();s.name=${JSON.stringify(prefix)}+i;s.x=(i%100)*12;s.y=Math.floor(i/100)*12;s.resize(10,10);}return true;`));
  }
  await gateway.flush(handle!);
  let expected=data(await execute(summary));assert.equal(expected.count,count);
  const counter=data(await execute(`const s=${select}[0];return {id:s.id,x:s.x};`));
  check(`${count} native shapes created in one dedicated file`);
  for(let cycle=0;cycle<rounds;cycle++) {
    const browser=adapter['browser']!, before=await memory(browser);
    await execute('storage.reclaimAcceptance=42;return true;');
    const writes=await Promise.all(Array.from({length:8},()=>execute(`const s=penpotUtils.findShapeById(${JSON.stringify(counter.id)});s.x+=1;return s.x;`)));
    assert.deepEqual(writes.map(data),Array.from({length:8},(_,i)=>counter.x+cycle*8+i+1));expected.sumX+=8;
    for(let i=0;i<20;i++) {
      const shapes=data(await execute(`return ${select}.map(s=>({id:s.id,name:s.name,x:s.x,y:s.y,width:s.width,height:s.height,fills:s.fills}));`));
      assert.equal(shapes.length,count);assert.equal(shapes.reduce((n:number,s:{x:number})=>n+s.x,0),expected.sumX);
    }
    for(let i=0;i<4;i++)await switchTo(i%2===0?extra!:root!);
    assert.equal(data(await execute('return storage.reclaimAcceptance;')),42);
    await gateway.flush(handle!);
    const after=await memory(browser);
    assert.equal(adapter['context']!.pages().length,1);
    const started=performance.now(), mode=cycle%2===0?'explicit':'idle';
    if(mode==='explicit') {
      const closed=await gateway.closeDocument(handle!);handle=undefined;
      assert.equal(closed.browserReleased,true);assert.equal(closed.remainingHandles,0);
    } else {
      await until(async()=>!browser.isConnected());await gateway['queue'];
      assert(events.some(e=>e.event==='request'&&e.operation==='idle_reclaim'&&e.outcome==='ok'));
    }
    await until(()=>gone(after.pids));assert(!browser.isConnected());assert.equal(adapter['browser'],undefined);assert.equal(adapter['sockets'].size,0);
    const released={nodeRssMiB:process.memoryUsage().rss/1048576,browserProcesses:0,elapsedMs:performance.now()-started};
    // Idle keeps handles; explicit last-close releases all bookkeeping.
    assert.equal(adapter['files'].size,handle?1:0);
    if(!handle)handle=(await gateway.open(rootUrl)).documentHandle!;
    assert.deepEqual(data(await execute(summary)),expected);
    assert.notEqual(adapter['browser'],browser);
    report.cycles.push({cycle:cycle+1,mode,before,after,released});
    console.log('CYCLE',cycle+1,mode,JSON.stringify({browserBeforeMiB:before.browserRssSumMiB,browserAfterMiB:after.browserRssSumMiB,released}));
  }
  check(`${rounds*20} full reads, ${rounds*8} serialized concurrent increments and ${rounds*4} page switches preserved checksums and plugin storage`);
  check('every explicit and idle reclamation retired all observed Chromium processes and relay sockets; cold reads retained all edits');
  report.status='passed';
} finally {
  try {
    if(root) {
      if(!handle)handle=(await gateway.open(rootUrl)).documentHandle!;
      await switchTo(root);
      let left=data(await execute(`return ${select}.length;`));
      while(left>0){const removed=data(await execute(`const a=${select}.slice(0,100);for(const s of a)s.remove();return a.length;`));assert(removed>0);left-=removed;}
      if(extra)await execute(`const p=penpotUtils.getPageById(${JSON.stringify(extra)});if(p)p.remove();return true;`);
      await gateway.closeDocument(handle!);handle=undefined;
      handle=(await gateway.open(rootUrl)).documentHandle!;
      assert.equal(data(await execute(`return ${select}.length;`)),0);
      check('owned shapes and temporary page removed; empty fixture verified after cold reopen');
      await gateway.closeDocument(handle);handle=undefined;
      assert.equal(adapter['files'].size,0);assert.equal(gateway['documents'].size,0);
    }
  } catch(error) {report.status='failed';throw error;}
  finally {
    await gateway.shutdown();
    report.lifecycle={started:events.filter(e=>e.event==='browser_started').length,closed:events.filter(e=>e.event==='browser_closed').length};
    await mkdir('test-results',{recursive:true});
    await writeFile('test-results/'+(process.env.RECLAIM_REPORT || 'reclamation.json'),JSON.stringify(report,null,2));
  }
}
