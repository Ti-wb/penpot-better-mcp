import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { parseDocument } from '../src/document.js';

// Browser faults are injected only into the disposable latest-version site.
const targets=JSON.parse(await readFile('.state/latest-targets.json','utf8'));
assert.equal(targets.base,'http://127.0.0.1:19001');
assert(targets.files.every((f:{name:string})=>f.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const adapter=new HeadlessAdapter(loadConfig({...process.env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:'.state/latest-session.json'}));
const alternate=new URL(targets.files[0].url);alternate.search=alternate.hash.split('?')[1];alternate.hash='';alternate.searchParams.set('screen','workspace');
const a=parseDocument(alternate.href,targets.base);
const b=parseDocument(targets.files[1].url,targets.base);
const checks:string[]=[];
const check=(name:string)=>{checks.push(name);console.log('PASS',name);};
const data=(r:any)=>{assert(!r.isError,JSON.stringify(r.content));return JSON.parse(r.content.find((c:any)=>c.type==='text').text).result;};
let release=()=>{};
let shapeId:string|undefined;
let imageId:string|undefined;
try {
  await adapter.open(a);
  check('alternate query URL opens the released hash-router editor');
  await adapter.execute(a,'for(const s of penpotUtils.findShapes(s=>s.name==="batch-persistence-acceptance"))s.remove();return true;');
  const logged=await adapter.execute(a,'storage.batchAcceptance=42;console.log("preserve-mcp-user-log");return true;','deferred');
  assert(JSON.stringify(logged.content).includes('preserve-mcp-user-log'));
  assert.equal(data(await adapter.execute(a,'const value=storage.batchAcceptance;delete storage.batchAcceptance;return value;','deferred')),42);
  check('console memory cleanup preserves returned user logs and plugin storage');
  const failed=await adapter.execute(a,'throw new Error("intentional batch acceptance failure");','deferred');
  assert(failed.isError);check('official script exceptions surface as MCP errors');

  const gate=new Promise<void>(r=>{release=r;});
  let requested=()=>{};const request=new Promise<void>(r=>{requested=r;});
  const page=adapter['page']!;
  const saveRoute=/\/api\/(?:main\/methods|rpc\/command)\/update-file(?:\?|$)/;
  await page.context().route(saveRoute,async route=>{requested();await gate;await route.continue();});
  const created=await adapter.execute(a,'const r=penpot.createRectangle();r.name="batch-persistence-acceptance";return r.id;','deferred');
  shapeId=data(created);assert.equal(created._meta?.saveState,'not_confirmed');
  let settled=false;
  const pending=adapter.flush(a).then(r=>{settled=true;return r;});
  let timer:NodeJS.Timeout;
  try {await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected a backend save request')),20000);})]);}
  finally {clearTimeout(timer!);}
  await new Promise(r=>setTimeout(r,1000));assert(!settled,'Flush must not succeed while the backend write is held');
  release();assert(!((await pending).isError));await page.context().unroute(saveRoute);
  check('deferred execution returns before persistence; flush waits for the held backend write');
  await adapter.close();await adapter.open(a);
  assert.equal(data(await adapter.execute(a,`return penpotUtils.findShapes(s=>s.id===${JSON.stringify(shapeId)}).length;`,'deferred')),1);
  check('flushed write survives a cold browser reopen exactly once');
  const exported=await adapter.exportShape(a,{shapeId:shapeId!,format:'svg'});
  assert(!exported.isError);
  const svg=exported.content.find(c=>c.type==='text' && c.text.includes('<svg'));
  assert(svg && svg.type==='text');
  assert(await adapter['page']!.evaluate(xml=>{
    const parsed=new DOMParser().parseFromString(xml,'image/svg+xml');
    return parsed.documentElement.localName==='svg' && !parsed.querySelector('parsererror');
  },svg.text));
  check('SVG export returns actual SVG content');
  const raster=await adapter.exportShape(a,{shapeId:shapeId!,format:'png'});
  const png=raster.content.find(c=>c.type==='image');assert(png && png.type==='image');
  imageId=data(await adapter.execute(a,`const r=await penpotUtils.importImage(${JSON.stringify(png.data)},"image/png","batch-fill.png",0,0,10,10);return r.id;`));
  const filled=await adapter.exportShape(a,{shapeId:imageId!,format:'png',mode:'fill'});
  assert(!filled.isError);const image=filled.content.find(c=>c.type==='image');assert(image && image.type==='image');
  const original=Buffer.from(png.data,'base64');const actual=Buffer.from(image.data,'base64');
  assert.equal(actual.subarray(1,4).toString(),'PNG');
  assert.deepEqual([actual.readUInt32BE(16),actual.readUInt32BE(20)],[original.readUInt32BE(16),original.readUInt32BE(20)]);
  check('PNG image-fill export preserves original image dimensions');

  // Simulate an unexpected workspace navigation between calls. The inline
  // identity guard must reject before the sentinel creation can run.
  await adapter['page']!.goto(b.url,{waitUntil:'domcontentloaded'});
  await adapter['page']!.getByTestId('mcp-btn').waitFor({timeout:60000});
  // Use a fixed identity read to wait for the new page's plugin, without
  // changing the adapter's cached binding to A.
  let ready=false;
  for(let i=0;i<80;i++){
    if(await adapter['matches'](b)){ready=true;break;}
    await new Promise(r=>setTimeout(r,250));
  }
  assert(ready);
  const wrong=await adapter.execute(a,'const s=penpot.createRectangle();s.name="must-not-exist-context-guard";return s.id;','deferred');
  assert(wrong.isError);
  await adapter.open(b);
  assert.equal(data(await adapter.execute(b,'return penpotUtils.findShapes(s=>s.name==="must-not-exist-context-guard").length;','deferred')),0);
  check('inline identity guard blocks writes after unexpected navigation');

  await adapter.open(a);
  await adapter.execute(a,`penpotUtils.findShapeById(${JSON.stringify(imageId)}).remove();return true;`);imageId=undefined;
  await adapter.execute(a,`penpotUtils.findShapeById(${JSON.stringify(shapeId)}).remove();return true;`);
  shapeId=undefined;
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/batch.json',JSON.stringify({at:new Date().toISOString(),site:targets.base,status:'passed',checks},null,2));
} finally {
  release();
  if(shapeId){await adapter.execute(a,`const s=penpotUtils.findShapeById(${JSON.stringify(shapeId)});if(s)s.remove();return true;`).catch(()=>{});}
  if(imageId){await adapter.execute(a,`const s=penpotUtils.findShapeById(${JSON.stringify(imageId)});if(s)s.remove();return true;`).catch(()=>{});}
  await adapter.close();
}
