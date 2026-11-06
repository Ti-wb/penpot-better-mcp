import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { DocumentWorker } from '../src/document-worker.js';
import { GatewayError } from '../src/errors.js';
import { parseDocument } from '../src/document.js';
import { loadFixture, body, data, writeReport } from './support.js';

// Held saves and unexpected navigation belong only to the disposable fixture.
const { targets, config } = await loadFixture({ localOnly: true });
const checks: string[] = [];
const check = (name: string) => { checks.push(name); console.log('PASS', name); };
const value = (result: CallToolResult) => data(result).result;

async function batch() {
  const adapter=new HeadlessAdapter(config), marker="__editor_"+randomUUID();
  const alternate=new URL(targets.files[0].url);alternate.search=alternate.hash.split('?')[1];alternate.hash='';alternate.searchParams.set('screen','workspace');
  const a=parseDocument(alternate.href,targets.base);
  const b=parseDocument(targets.files[1].url,targets.base);
  let release=()=>{};
  let shapeId:string|undefined;
  let imageId:string|undefined;
  try {
    await adapter.open(a);
    check('alternate query URL opens the released hash-router editor');
    const denied = await adapter.execute(a,'return penpot.activeUsers.length;','deferred');
    assert(denied.isError, 'Permission availability changed: update the deployment guidance after review.');
    const error = body(denied);
    assert.equal(error.code,'PLUGIN_PERMISSION_DENIED'); assert.equal(error.permission,'user:read'); assert.equal(error.partialEditsPossible,true);
    check('runtime user:read denial returns a structured plugin permission error');
    const syntax = await adapter.execute(a,'return );','deferred'); assert(syntax.isError);
    assert.equal(body(syntax).code,'SCRIPT_SYNTAX_ERROR');
    check('invalid JavaScript returns a distinct syntax classification');
    const readback = await adapter.execute(a,'return penpot.currentFile.id;','deferred'); assert(!readback.isError);
    assert.equal(data(readback).result,a.fileId);
    await adapter.flush(a);
    check('normal document reads and flush remain available after both failures');

    const logged=await adapter.execute(a,'storage.batchAcceptance=42;console.log("preserve-mcp-user-log");return true;','deferred');
    assert(JSON.stringify(logged.content).includes('preserve-mcp-user-log'));
    assert.equal(value(await adapter.execute(a,'const value=storage.batchAcceptance;delete storage.batchAcceptance;return value;','deferred')),42);
    check('console memory cleanup preserves returned user logs and plugin storage');
    const failed=await adapter.execute(a,'throw new Error("intentional batch acceptance failure");','deferred');
    assert(failed.isError);check('official script exceptions surface as MCP errors');

    const gate=new Promise<void>(r=>{release=r;});
    let requested=()=>{};const request=new Promise<void>(r=>{requested=r;});
    const page=adapter['page']!;
    const saveRoute=/\/api\/(?:main\/methods|rpc\/command)\/update-file(?:\?|$)/;
    await page.context().route(saveRoute,async route=>{requested();await gate;await route.continue();});
    const created=await adapter.execute(a,`const r=penpot.createRectangle();r.name=${JSON.stringify(marker)};return r.id;`,'deferred');
    shapeId=value(created);assert.equal(created._meta?.saveState,'not_confirmed');
    let settled=false;
    const pending=adapter.flush(a).then(r=>{settled=true;return r;});
    let timer:NodeJS.Timeout;
    try {await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected a backend save request')),20000);})]);}
    finally {clearTimeout(timer!);}
    await new Promise(r=>setTimeout(r,1000));assert(!settled,'Flush must not succeed while the backend write is held');
    release();assert(!((await pending).isError));await page.context().unroute(saveRoute);
    check('deferred execution returns before persistence; flush waits for the held backend write');
    await adapter.close();await adapter.open(a);
    assert.equal(value(await adapter.execute(a,`return penpotUtils.findShapes(s=>s.id===${JSON.stringify(shapeId)}).length;`,'deferred')),1);
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
    imageId=value(await adapter.execute(a,`const r=await penpotUtils.importImage(${JSON.stringify(png.data)},"image/png","batch-fill.png",0,0,10,10);return r.id;`));
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
    assert.equal(value(await adapter.execute(b,'return penpotUtils.findShapes(s=>s.name==="must-not-exist-context-guard").length;','deferred')),0);
    check('inline identity guard blocks writes after unexpected navigation');

    await adapter.open(a);
    await adapter.execute(a,`penpotUtils.findShapeById(${JSON.stringify(imageId)}).remove();return true;`);imageId=undefined;
    await adapter.execute(a,`penpotUtils.findShapeById(${JSON.stringify(shapeId)}).remove();return true;`);
    shapeId=undefined;
  } finally {
    release();
    if(shapeId){await adapter.execute(a,`const s=penpotUtils.findShapeById(${JSON.stringify(shapeId)});if(s)s.remove();return true;`).catch(()=>{});}
    if(imageId){await adapter.execute(a,`const s=penpotUtils.findShapeById(${JSON.stringify(imageId)});if(s)s.remove();return true;`).catch(()=>{});}
    await adapter.close();
  }
}

async function pages() {
  const adapter=new HeadlessAdapter(config);
  const gateway = new DocumentWorker(adapter, targets.base);
  const created: string[] = [];
  let rootHandle: string | undefined, rootPage: string | undefined;
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
    for (let i = 0; i < 2; i++) {
      const pageId = created[(i + 1) % 2];
      const next = await gateway.openPage(current, pageId);
      assert.notEqual(next.documentHandle, current); assert.equal(next.pageId, pageId);
      current = next.documentHandle!;
      assert.equal(data(next.result).result.pageId, pageId);
      assert.equal(adapter['browser'], browser); assert.equal(adapter['page'], editor);
    }
    assert.equal(data(await gateway.execute(current, 'return storage.pageAcceptance;', 'deferred')).result, 42);
    current = (await gateway.openPage(rootHandle, created[0])).documentHandle!;
    assert.equal(adapter['browser'], browser); assert.equal(adapter['page'], editor);
    assert.equal(data(await gateway.execute(current, 'return storage.pageAcceptance;', 'deferred')).result, 42);
    check('explicit page switches reuse the browser, editor and plugin storage with new bound handles');

    const retained = current;
    const another = (await gateway.openPage(current, created[1])).documentHandle!;
    for (let i = 0; i < 2; i++) {
      current = i % 2 ? another : retained;
      assert.equal(data(await gateway.execute(current, 'return storage.pageAcceptance;', 'deferred')).result, 42);
      assert.equal(adapter['browser'], browser); assert.equal(adapter['page'], editor);
    }
    check('alternating retained page handles also reuse the editor and plugin storage');

    const before = data(await gateway.execute(current, 'return penpot.currentPage.id;', 'deferred')).result;
    await assert.rejects(gateway.openPage(current, randomUUID()), error => error instanceof GatewayError && error.code === 'PAGE_NOT_FOUND');
    assert.equal(data(await gateway.execute(current, 'return penpot.currentPage.id;', 'deferred')).result, before);
    check('a nonexistent page is rejected without changing the active page');

    const other = created.find(id => id !== before)!;
    await gateway.execute(current, `await penpot.openPage(penpotUtils.getPageById(${JSON.stringify(other)}));return true;`);
    const denied = await gateway.execute(current, 'const s=penpot.createRectangle();s.name="page-guard-must-not-run";return s.id;', 'deferred');
    assert(denied.isError);
    const failure = body(denied);
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
}

let status = 'failed';
try { await batch(); await pages(); status = 'passed'; }
finally { await writeReport('editor.json', { at: new Date().toISOString(), site: targets.base, status, checks }); }
