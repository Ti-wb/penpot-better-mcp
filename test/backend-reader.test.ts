import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendReader } from '../src/backend-reader.js';
import { parseDocument } from '../src/document.js';
import { Gateway } from '../src/gateway.js';
import type { DesignAdapter } from '../src/adapter.js';
import { Diagnostics } from '../src/diagnostics.js';
import { GatewayError } from '../src/errors.js';
import { data } from './support.js';

const base = 'https://penpot.example.com';
const id = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,'0')}`;
const url = (i = 1) => `${base}/#/workspace?team-id=${id(0)}&file-id=${id(i)}`;
const pageId = id(2), rootId = '00000000-0000-0000-0000-000000000000';
const target = parseDocument(url(), base);
const cookie = {name:'auth-token', value:'synthetic-session', domain:'penpot.example.com', path:'/', secure:true, expires:-1};
const makeFile = (count = 3, fileId = id(1)) => ({id:fileId,name:'Fixture',revn:1,vern:0,data:{pages:[pageId],pagesIndex:{[pageId]:{id:pageId,name:'Page',objects:Object.fromEntries([
  [rootId, {id:rootId,type:'frame'}], ...Array.from({length:count},(_,i)=>[id(10+i),{id:id(10+i),name:`Shape ${i}`,type:'rect',x:i,content:{text:'hello'}}]),
])}}}});
const response = (file = makeFile(), etag = '"v1"') => new Response(JSON.stringify(file), {headers:{'content-type':'application/json',...(etag?{etag}:{})}});
const code = (expected: string) => (error: unknown) => error instanceof GatewayError && error.code === expected;
async function fixture(fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(),'penpot-reader-test-')), storageState = join(dir,'session.json');
  const session = (cookies: unknown[]) => writeFile(storageState,JSON.stringify({cookies}),{mode:0o600});
  await session([cookie]);
  const records: Record<string,unknown>[] = [], diagnostics = new Diagnostics(r=>records.push(r));
  const reader = new BackendReader({baseUrl:base,storageState,timeoutMs:1000},diagnostics,fetcher);
  return {reader,session,storageState,diagnostics,records,close:async()=>{reader.clear();await rm(dir,{recursive:true,force:true});}};
}

test('HTTP-only reads scope cookies, disable redirects, revalidate cached files and never serve denied/stale data',async()=>{
  let calls=0;
  const f=await fixture(async (input, init)=>{
    assert.equal(String(input),base+'/api/rpc/command/get-file');assert.equal(init?.redirect,'error');
    const h=new Headers(init?.headers);assert.equal(h.get('cookie'),'auth-token=synthetic-session');
    assert.deepEqual(JSON.parse(String(init?.body)),{id:id(1)});
    calls++;
    if(calls===1){assert(!h.has('if-none-match'));return response();}
    if(calls===2){assert.equal(h.get('if-none-match'),'"v1"');return new Response(null,{status:304});}
    if(calls===3)return new Response('private upstream failure',{status:403});
    assert(!h.has('if-none-match'));return response();
  });
  try {
    await f.session([cookie,{...cookie,domain:'evil.example',name:'wrong'}, {...cookie,path:'/api/rpc/command/get-files',name:'wrongpath'}, {...cookie,expires:1,name:'expired'}, {...cookie,partitionKey:'https://elsewhere.example',name:'partitioned'}, {...cookie,value:'bad; injection',name:'malformed'}]);
    const first=data(await f.reader.read(target));assert.equal(first.pages[0].shapeCount,3);
    assert.deepEqual(data(await f.reader.read(target)),first);
    await assert.rejects(f.reader.read(target),code('DOCUMENT_UNAVAILABLE'));
    await f.reader.read(target);assert.equal(calls,4);
    await f.session([{...cookie,expires:1}]);await assert.rejects(f.reader.read(target),code('AUTH_REQUIRED'));assert.equal(calls,4);
    if(process.platform!=='win32'){await chmod(f.storageState,0o644);await assert.rejects(f.reader.read(target),code('INSECURE_SESSION'));assert.equal(calls,4);}
  }finally{await f.close();}
});

test('credential rotation, missing ETags, errors and the four-file LRU invalidate cached authorization',async()=>{
  const seen:{id:string;conditional:boolean}[]=[];let etag=true,fail=false;
  const f=await fixture(async(_input,init)=>{
    if(fail)throw new Error('private network failure');
    const fileId=JSON.parse(String(init?.body)).id;
    seen.push({id:fileId,conditional:new Headers(init?.headers).has('if-none-match')});
    return response(makeFile(3,fileId),etag?'"v1"':'');
  });
  try {
    await f.reader.read(target);await f.reader.read(target);assert(seen.at(-1)!.conditional);
    await f.session([{...cookie,value:'replacement-session'}]);await f.reader.read(target);assert(!seen.at(-1)!.conditional);
    etag=false;await f.reader.read(target);await f.reader.read(target);assert(!seen.at(-1)!.conditional);
    etag=true;for(let n=1;n<=5;n++)await f.reader.read(parseDocument(url(n),base));
    await f.reader.read(target);assert(!seen.at(-1)!.conditional);
    fail=true;await assert.rejects(f.reader.read(target),code('BACKEND_UNAVAILABLE'));fail=false;
    await f.reader.read(target);assert(!seen.at(-1)!.conditional);
  }finally{await f.close();}
});

test('large shape reads paginate deterministically, project fields and detect changed snapshots',async()=>{
  let file=makeFile(3000);
  const f=await fixture(async()=>response(file));
  try {
    const first=data(await f.reader.read(target,{view:'shapes',limit:1000,fields:['name','content']}));
    assert.equal(first.total,3000);assert.equal(first.nextOffset,1000);assert.equal(first.shapes.length,1000);
    assert.deepEqual(Object.keys(first.shapes[0]),['id','name','content']);assert.equal(first.shapes[0].content.text,'hello');
    const second=data(await f.reader.read(target,{view:'shapes',offset:1000,limit:1000,snapshotId:first.snapshotId}));
    assert.equal(new Set([...first.shapes,...second.shapes].map(s=>s.id)).size,2000);
    const last=data(await f.reader.read(target,{view:'shapes',offset:2000,limit:1000,snapshotId:first.snapshotId}));assert.equal(last.nextOffset,null);
    const selected=data(await f.reader.read(target,{view:'shapes',shapeIds:[id(10),id(9000)]}));assert.equal(selected.total,1);assert.deepEqual(selected.missingShapeIds,[id(9000)]);
    await assert.rejects(f.reader.read(target,{pageId:id(99)}),code('INVALID_PAGE'));
    await assert.rejects(f.reader.read(target,{limit:1001}),code('INVALID_READ'));
    file={...file,revn:2};await assert.rejects(f.reader.read(target,{snapshotId:first.snapshotId}),code('SNAPSHOT_CHANGED'));
  }finally{await f.close();}
});

test('incompatible responses, backend limits, auth, timeouts and response/output sizes fail explicitly',async()=>{
  let reply:()=>Promise<Response>=async()=>response();
  const f=await fixture(()=>reply());
  try {
    for(const [status,expected] of [[401,'AUTH_REQUIRED'],[404,'DOCUMENT_UNAVAILABLE'],[429,'BACKEND_BUSY'],[500,'BACKEND_READ_FAILED'],[304,'BACKEND_READ_FAILED']] as const){
      reply=async()=>new Response(null,{status});await assert.rejects(f.reader.read(target),code(expected));
    }
    reply=async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}});await assert.rejects(f.reader.read(target),code('BACKEND_INCOMPATIBLE'));
    reply=async()=>response({...makeFile(),data:{pages:[pageId],pagesIndex:{}}});await assert.rejects(f.reader.read(target),code('BACKEND_INCOMPATIBLE'));
    reply=async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(33*1024*1024)}});await assert.rejects(f.reader.read(target),code('READ_TOO_LARGE'));
    let canceled=false;
    reply=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}});
    await assert.rejects(f.reader.read(target),code('READ_TOO_LARGE'));assert(canceled);
    const huge=makeFile();huge.data.pagesIndex[pageId].objects[id(10)].content={text:'x'.repeat(4*1024*1024)};
    reply=async()=>response(huge);await assert.rejects(f.reader.read(target,{view:'shapes',fields:['content']}),code('READ_OUTPUT_TOO_LARGE'));
    reply=async()=>{throw new DOMException('private endpoint','TimeoutError');};await assert.rejects(f.reader.read(target),code('READ_TIMEOUT'));
  }finally{await f.close();}
});

test('backend concurrency is bounded independently of browser capacity and diagnostics omit design/session data',async()=>{
  const release=gate(),started=gate();let active=0,peak=0,calls=0;
  const f=await fixture(async()=>{active++;peak=Math.max(peak,active);if(++calls===2)started.resolve();await release.promise;active--;return response();});
  try {
    const pending=Array.from({length:8},()=>f.diagnostics.run('read_document',performance.now(),0,()=>f.reader.read(target)));
    await started.promise;assert.equal(calls,2);release.resolve();await Promise.all(pending);assert.equal(peak,2);
    await f.diagnostics.run('read_document',performance.now(),0,()=>f.reader.read(target));
    assert(f.records.every(r=>r.backendCalls===1&&r.upstreamCalls===0));
    const logs=JSON.stringify(f.records);for(const secret of [base,id(1),'synthetic-session','Fixture','Shape 0'])assert(!logs.includes(secret));
  }finally{release.resolve();await f.close();}
});

const ok={content:[{type:'text' as const,text:'{}'}]};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
function adapter():DesignAdapter{return{hasResources:false,open:async()=>ok,openPage:async()=>ok,execute:async()=>ok,flush:async()=>ok,flushPending:async()=>{},exportShape:async()=>ok,documentation:async()=>ok,release:()=>{},close:async()=>{}};}

test('saved reads launch no browser, share the write/save queue and allow other files through a full browser pool',async()=>{
  const started=gate(),release=gate(),adapters=new Map<string,DesignAdapter>(),seen:string[]=[];
  const reader={read:async(t:typeof target)=>{seen.push('read:'+t.fileId);return ok;},clear:()=>{}};
  const g=new Gateway(file=>{const a=adapter();let resident=false;Object.defineProperty(a,'hasResources',{get:()=>resident});
    a.open=async()=>{resident=true;return ok;};a.close=async()=>{resident=false;};
    a.execute=async()=>{started.resolve();await release.promise;seen.push('write');return ok;};
    a.flushPending=async()=>{seen.push('flush:'+file);};adapters.set(file!,a);return a;
  },base,600000,undefined,1,reader);
  try {
    await g.read(url());assert(!adapters.get(id(1))!.hasResources);
    const h=(await g.open(url())).documentHandle!;
    const write=g.execute(h,'write','deferred');await started.promise;
    const read=g.read(url());
    await g.read(url(3));assert(seen.includes('read:'+id(3)));assert(!seen.includes('write'));
    release.resolve();await Promise.all([write,read]);
    assert.deepEqual(seen.slice(-3),['write','flush:'+id(1),'read:'+id(1)]);
    const reads=seen.length;adapters.get(id(1))!.flushPending=async()=>{throw new GatewayError('SAVE_UNCONFIRMED','uncertain',true);};
    await assert.rejects(g.read(url()),code('SAVE_UNCONFIRMED'));assert.equal(seen.length,reads);
    await assert.rejects(g.read(url().replace(base,'https://evil.example')),code('SITE_NOT_ALLOWED'));
  }finally{release.resolve();await g.shutdown();}
});
