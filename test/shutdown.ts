import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { loadConfig } from '../src/config.js';
import { parseDocument } from '../src/document.js';

const targets=JSON.parse(await readFile('.state/latest-targets.json','utf8'));
assert.equal(targets.base,'http://127.0.0.1:19001');
assert(targets.files.every((f:{name:string})=>f.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const config=loadConfig({...process.env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:'.state/latest-session.json'});
const portServer=createServer().listen(0,'127.0.0.1');await once(portServer,'listening');
const port=(portServer.address() as AddressInfo).port;await new Promise<void>(r=>portServer.close(()=>r()));
const token=randomBytes(32).toString('hex'),tokenFile=resolve(`.runtime/shutdown-token-${randomUUID()}`);
await writeFile(tokenFile,token,{mode:0o600});
const child=spawn(process.execPath,['--import',resolve('test/fixtures/retain-on-close.mjs'),'dist/main.js','--http'],{
  env:{...process.env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:config.storageState,PENPOT_DIAGNOSTICS:'true',GATEWAY_TOKEN_FILE:tokenFile,HOST:'127.0.0.1',PORT:String(port)},
  stdio:['ignore','ignore','pipe'],
});
const exited=once(child,'exit');let output='';child.stderr.on('data',chunk=>{output+=chunk;});
const marker='__shutdown_'+randomUUID(),checks:string[]=[];
const report:Record<string,unknown>={at:new Date().toISOString(),site:targets.base,status:'failed',marker,checks};
const client=new Client({name:'shutdown-acceptance',version:'1'});
const cleanup=new HeadlessAdapter(config),target=parseDocument(targets.files[0].url,targets.base);
function data(result:CallToolResult){assert(!result.isError,JSON.stringify(result.content));return JSON.parse((result.content.find(c=>c.type==='text') as {text:string}).text);}
async function call(name:string,args:Record<string,unknown>){return CallToolResultSchema.parse(await client.callTool({name,arguments:args},CallToolResultSchema,{timeout:180_000}));}
async function until(predicate:()=>boolean,timeout=30_000){const end=Date.now()+timeout;while(!predicate()){assert(Date.now()<end,'shutdown acceptance timed out');assert(child.exitCode===null,'child exited before recovery: '+output.slice(-1000));await delay(25);}}
const check=(s:string)=>{checks.push(s);console.log('PASS',s);};
try {
  await until(()=>output.includes('HTTP listener ready'));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const opened=data(await call('open_document',{url:targets.files[0].url}));
  console.log('Ready: child gateway opened the dedicated fixture');
  const write=call('execute_code',{documentHandle:opened.documentHandle,code:`const s=penpot.createRectangle();s.name=${JSON.stringify(marker)};storage.shutdownMarker=${JSON.stringify(marker)};await new Promise(r=>setTimeout(r,12000));return s.id;`});
  await delay(1000);const signaled=Date.now();child.kill('SIGTERM');
  await delay(100);child.kill('SIGTERM');
  const shape=data(await write).result;
  assert(Date.now()-signaled>=10_000);check('SIGTERM drains an accepted long write and delivers its HTTP response');
  await until(()=>output.includes('"event":"shutdown_failed"'));
  assert.equal(child.exitCode,null);
  assert.equal(data(await call('execute_code',{documentHandle:opened.documentHandle,code:'return storage.shutdownMarker;',save:'deferred'})).result,marker);
  check('failed save confirmation keeps the original browser, handle and HTTP recovery path available');
  await client.close();
  let deadline:NodeJS.Timeout;
  let exit;
  try {exit=await Promise.race([exited,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('automatic shutdown retry timed out')),30_000);})]);}
  finally {clearTimeout(deadline!);}
  assert.deepEqual(exit,[0,null]);report.shutdownMs=Date.now()-signaled;
  check('automatic retry confirms saving, closes resources and exits normally');
  data(await cleanup.open(target));
  assert.equal(data(await cleanup.execute(target,`return penpotUtils.findShapeById(${JSON.stringify(shape)})?.name;`,'deferred')).result,marker);
  check('the completed write survives process exit and a cold browser reopen');
  report.status='passed';
} catch(error){report.failure=String(error);throw error;} finally {
  await client.close().catch(()=>{});
  if(child.exitCode===null){child.kill('SIGKILL');await exited;}
  try {
    data(await cleanup.open(target));
    data(await cleanup.execute(target,`for(const s of penpotUtils.findShapes(s=>s.name===${JSON.stringify(marker)},penpot.currentPage.root))s.remove();return true;`));
    await cleanup.close();data(await cleanup.open(target));
    assert.equal(data(await cleanup.execute(target,`return penpotUtils.findShapes(s=>s.name===${JSON.stringify(marker)}).length;`,'deferred')).result,0);
    check('owned shutdown test shape removed and cleanup verified after cold reopen');
  } catch(error){report.status='failed';throw error;}
  finally {await cleanup.close();await rm(tokenFile,{force:true});await mkdir('test-results',{recursive:true});await writeFile('test-results/shutdown-review.json',JSON.stringify(report,null,2));await writeFile('test-results/shutdown-review.log',output);}
}
