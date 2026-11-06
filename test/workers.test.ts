import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesignAdapter } from '../src/adapter.js';
import { Gateway } from '../src/gateway.js';
import { GatewayError } from '../src/errors.js';
import { Diagnostics } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';

const base = 'https://penpot.example';
const id = (i: number) => `abcdefab-1111-4111-8111-${String(i).padStart(12, '0')}`;
const url = (i: number) => `${base}/#/workspace?team-id=${id(0)}&file-id=${id(i)}&page-id=${id(9)}`;
const ok = {content: [{type: 'text' as const, text: '{}'}]};
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
function fixture(limit = 2, idleMs = 600_000) {
  const live = new Set<string>(), adapters = new Map<string, DesignAdapter>();
  const counts = new Map<string, number>(), generations = new Map<string, number>(), executions: string[] = [];
  const events: Record<string, unknown>[] = [];
  let peak = 0;
  const gateway = new Gateway(file => {
    assert(file); assert(!live.has(file), 'duplicate live file worker');
    let busy = false, resident = false;
    const activate = () => {
      if (!resident) { resident = true; live.add(file); generations.set(file, (generations.get(file) || 0) + 1); peak = Math.max(peak, live.size); }
      assert(live.size <= limit);
    };
    const adapter: DesignAdapter = {
      get hasResources() { return resident; },
      open: async target => { assert.equal(target.fileId, file); activate(); return ok; },
      openPage: async () => { activate(); return ok; },
      execute: async target => {
        assert.equal(target.fileId, file); activate(); assert(!busy, 'same file executed concurrently'); busy = true;
        const before = counts.get(file) || 0;
        try { executions.push(file); await delay(1); counts.set(file, before + 1); return ok; } finally { busy = false; }
      },
      flush: async () => ok, flushPending: async () => {}, exportShape: async () => ok, documentation: async () => ok,
      release: () => {}, close: async () => { assert(!busy, 'reclaimed active code'); resident = false; live.delete(file); },
    };
    adapters.set(file, adapter); return adapter;
  }, base, idleMs, new Diagnostics(e => events.push(e)), limit);
  return {gateway, live, adapters, counts, generations, executions, events, peak: () => peak};
}

test('distinct files overlap; aliases of one file share one queue, adapter and page handles', {timeout: 5000}, async () => {
  const f = fixture(), g = f.gateway, started = gate(), release = gate();
  try {
    const [a,b] = await Promise.all([g.open(url(1)),g.open(url(2))]);
    const alias = await g.open(url(1).replace(id(0), id(8)));
    const upper = await g.open(url(1).replace(id(1), id(1).toUpperCase()));
    const page = await g.openPage(a.documentHandle!, id(7).toUpperCase());
    assert.equal(upper.fileId,id(1));assert.equal(page.pageId,id(7));
    assert.equal(f.adapters.size,2);
    const adapter = f.adapters.get(id(1))!, execute = adapter.execute;
    adapter.execute = async (...args) => { started.resolve(); await release.promise; return execute(...args); };
    const first = g.execute(a.documentHandle!, 'increment'); await started.promise;
    const queued = g.execute(alias.documentHandle!, 'increment');
    await g.execute(b.documentHandle!, 'increment');
    assert.equal(f.counts.get(id(2)),1); assert.equal(f.counts.get(id(1)),undefined);
    release.resolve(); await Promise.all([first,queued]);
    await Promise.all(Array.from({length:16},(_,i)=>g.execute(i%2 ? alias.documentHandle! : page.documentHandle!, 'increment')));
    assert.equal(f.counts.get(id(1)),18); assert.equal(f.peak(),2);
    assert.equal(new Set(f.events.filter(e=>e.operation==='execute_code').map(e=>e.workerId)).size,2);
  } finally { release.resolve(); await g.shutdown(); }
  assert.equal(f.live.size,0);
});

test('LRU reclaims only idle files, reopens retained handles, and closing an evicted file needs no slot', {timeout:5000}, async () => {
  const f = fixture(), g = f.gateway, started = gate(), release = gate();
  try {
    const a = (await g.open(url(1))).documentHandle!, b = (await g.open(url(2))).documentHandle!;
    const adapter = f.adapters.get(id(1))!, execute = adapter.execute;
    adapter.execute = async (...args) => { started.resolve(); await release.promise; return execute(...args); };
    const active = g.execute(a,'increment'); await started.promise;
    const c = (await g.open(url(3))).documentHandle!;
    assert.deepEqual([...f.live].sort(),[id(1),id(3)]);
    release.resolve(); await active;
    await g.execute(a,'increment'); // A is now the most recently used worker.
    await g.execute(b,'increment');
    assert.deepEqual([...f.live].sort(),[id(1),id(2)]);
    assert.equal(f.generations.get(id(2)),2);
    const closes = f.events.filter(e=>e.operation==='worker_eviction').length;
    await g.closeDocument(c);
    assert.equal(f.events.filter(e=>e.operation==='worker_eviction').length,closes);
    assert.equal(f.peak(),2);
  } finally { release.resolve(); await g.shutdown(); }
});

test('failed eviction preserves the editor, tries another victim, and never dispatches when all slots are unconfirmed', {timeout:5000}, async () => {
  const f=fixture(),g=f.gateway;
  const refuse=async()=>{throw new GatewayError('SAVE_UNCONFIRMED','unsaved',true);};
  const restore: (()=>void)[]=[];
  try {
    const a=(await g.open(url(1))).documentHandle!,b=(await g.open(url(2))).documentHandle!;
    for(const file of [id(1),id(2)]) { const adapter=f.adapters.get(file)!,close=adapter.close;adapter.close=refuse;restore.push(()=>{adapter.close=close;}); }
    await assert.rejects(g.open(url(3)),e=>e instanceof GatewayError&&e.code==='WORKER_CAPACITY');
    assert.deepEqual([...f.live].sort(),[id(1),id(2)]);
    await g.execute(a,'increment');await g.execute(b,'increment');
    restore[1]();
    // A new file avoids relying on asynchronous disposal of the rejected open.
    const c=(await g.open(url(4))).documentHandle!;
    assert.deepEqual([...f.live].sort(),[id(1),id(4)]);
    await g.execute(c,'increment');
  } finally { restore.forEach(r=>r());await g.shutdown(); }
});

test('a slow eviction does not block a different resident file; requests for the victim wait for its close', {timeout:5000}, async () => {
  const f=fixture(),g=f.gateway,closing=gate(),release=gate();
  try {
    const a=(await g.open(url(1))).documentHandle!,b=(await g.open(url(2))).documentHandle!;
    const adapter=f.adapters.get(id(1))!,close=adapter.close;
    adapter.close=async()=>{closing.resolve();await release.promise;await close();};
    const opening=g.open(url(3));await closing.promise;
    const victim=g.execute(a,'increment');
    await g.execute(b,'increment');assert.equal(f.counts.get(id(2)),1);assert(!f.counts.has(id(1)));
    release.resolve();await opening;await victim;
    assert.equal(f.counts.get(id(1)),1);assert.equal(f.generations.get(id(1)),2);
  } finally { release.resolve();await g.shutdown(); }
});

test('single-slot pool serializes different files and per-file last close leaves other files usable', {timeout:5000}, async () => {
  const f=fixture(1),g=f.gateway;
  try {
    const a=(await g.open(url(1))).documentHandle!,alias=(await g.open(url(1))).documentHandle!,b=(await g.open(url(2))).documentHandle!;
    await Promise.all([g.execute(a,'a'),g.execute(b,'b'),g.execute(alias,'a'),g.execute(b,'b')]);
    assert.equal(f.counts.get(id(1)),2);assert.equal(f.counts.get(id(2)),2);
    const first=await g.closeDocument(a);assert.equal(first.browserReleased,false);assert.equal(first.remainingFileHandles,1);assert.equal(first.remainingHandles,2);
    const last=await g.closeDocument(alias);assert.equal(last.browserReleased,true);assert.equal(last.remainingFileHandles,0);assert.equal(last.remainingHandles,1);
    await g.execute(b,'b');assert.equal(f.counts.get(id(2)),3);assert.equal(f.peak(),1);
  } finally { await g.shutdown(); }
});

test('shutdown is idempotent, drains accepted requests and cancels idle reclamation', {timeout:5000}, async () => {
  const f=fixture(1,20),g=f.gateway,started=gate(),release=gate();
  const a=(await g.open(url(1))).documentHandle!;
  const adapter=f.adapters.get(id(1))!,execute=adapter.execute;
  adapter.execute=async(...args)=>{started.resolve();await release.promise;return execute(...args);};
  const active=g.execute(a,'increment');await started.promise;
  const queued=g.open(url(2));
  const shutdown=g.shutdown();assert.equal(g.shutdown(),shutdown);
  await assert.rejects(g.execute(a,'rejected'),e=>e instanceof GatewayError&&e.code==='SHUTTING_DOWN');
  release.resolve();await Promise.all([active,queued,shutdown]);
  assert.equal(f.live.size,0);
  const events=f.events.length;await delay(50);assert.equal(f.events.length,events);
});

test('handle reservations and both queue bounds reject overload without leaking capacity', {timeout:5000}, async () => {
  const f=fixture(),g=f.gateway;
  try {
    const first=(await g.open(url(1))).documentHandle!;
    for(let i=0;i<124;i++)await g.open(url(1));
    const opens=await Promise.allSettled(Array.from({length:4},()=>g.open(url(1))));
    assert.equal(opens.filter(r=>r.status==='fulfilled').length,3);
    const rejected=opens.find(r=>r.status==='rejected');assert(rejected?.status==='rejected');assert.equal(rejected.reason.code,'DOCUMENT_LIMIT');
    await g.closeDocument(first);await g.open(url(2));
  } finally {await g.shutdown();}
  const h=fixture(1),release=gate();
  try {
    const handles=[];for(let i=1;i<=4;i++)handles.push((await h.gateway.open(url(i))).documentHandle!);
    for(const adapter of h.adapters.values()){const execute=adapter.execute;adapter.execute=async(...args)=>{await release.promise;return execute(...args);};}
    const accepted=Array.from({length:32},()=>h.gateway.execute(handles[0],'increment'));
    await assert.rejects(h.gateway.execute(handles[0],'overload'),e=>e instanceof GatewayError&&e.code==='BUSY');
    for(let i=1;i<4;i++)for(let j=0;j<32;j++)accepted.push(h.gateway.execute(handles[i],'increment'));
    await assert.rejects(h.gateway.inspect(handles[1]),e=>e instanceof GatewayError&&e.code==='BUSY');
    release.resolve();await Promise.all(accepted);
    assert.equal(h.executions.length,128);
  } finally {release.resolve();await h.gateway.shutdown();}
});

test('invalid worker capacity fails configuration before opening resources',()=>{
  for(const value of ['0','17','1.5','bad'])assert.throws(()=>loadConfig({PENPOT_MAX_WORKERS:value}),/WORKERS/);
  assert.equal(loadConfig({}).maxWorkers,2);assert.equal(loadConfig({PENPOT_MAX_WORKERS:'1'}).maxWorkers,1);
});

test('retired browser releases capacity even when its earlier save remains unknown', {timeout:5000}, async()=>{
  const f=fixture(1),g=f.gateway;
  let restore=()=>{};
  try {
    const first=(await g.open(url(1))).documentHandle!;
    const adapter=f.adapters.get(id(1))!,close=adapter.close;restore=()=>{adapter.close=close;};
    adapter.close=async()=>{await close();throw new GatewayError('SAVE_UNCONFIRMED','browser already lost',true);};
    const next=await g.open(url(2));
    assert(next.documentHandle);assert.deepEqual([...f.live],[id(2)]);
    adapter.close=close;
    await g.closeDocument(first);
  } finally {restore();await g.shutdown();}
});

test('a slow eviction does not block another queued file from using a released slot', {timeout:5000}, async()=>{
  const f=fixture(),g=f.gateway,closing=gate(),releaseClose=gate(),working=gate(),releaseWork=gate();
  const requests:Promise<unknown>[]=[];
  try {
    await g.open(url(1));const b=(await g.open(url(2))).documentHandle!;
    const first=f.adapters.get(id(1))!,close=first.close;
    first.close=async()=>{closing.resolve();await releaseClose.promise;await close();};
    const second=f.adapters.get(id(2))!,execute=second.execute;
    second.execute=async(...args)=>{working.resolve();await releaseWork.promise;return execute(...args);};
    const busy=g.execute(b,'increment');requests.push(busy);await working.promise;
    const cold=g.open(url(3));requests.push(cold);await closing.promise;
    releaseWork.resolve();await busy;
    await delay(0);
    assert(f.live.has(id(2)),'one waiting file caused unnecessary eviction of a second warm browser');
    requests.push(g.open(url(4)));
    assert(await Promise.race([cold.then(()=>true),delay(200).then(()=>false)]),'available capacity waited behind unrelated slow eviction');
  } finally {releaseWork.resolve();releaseClose.resolve();await Promise.allSettled(requests);await g.shutdown();}
});

test('shutdown drains an accepted reopen waiting for empty-worker disposal', {timeout:5000}, async()=>{
  const f=fixture(),g=f.gateway,disposing=gate(),release=gate();
  const a=(await g.open(url(1))).documentHandle!;
  const adapter=f.adapters.get(id(1))!,close=adapter.close;
  let closes=0;
  adapter.close=async()=>{if(++closes===2){disposing.resolve();await release.promise;}await close();};
  await g.closeDocument(a);await disposing.promise;
  const opened=g.open(url(1)),shutdown=g.shutdown();
  release.resolve();await opened;await shutdown;
  assert.equal(f.live.size,0);assert.notEqual(f.adapters.get(id(1)),adapter);
});

test('failed shutdown keeps the unsaved file recoverable and discards successfully closed workers', {timeout:5000},async()=>{
  const f=fixture(),g=f.gateway;
  const a=(await g.open(url(1))).documentHandle!,b=(await g.open(url(2))).documentHandle!;
  const adapter=f.adapters.get(id(1))!,close=adapter.close;
  adapter.close=async()=>{throw new GatewayError('SAVE_UNCONFIRMED','unsaved',true);};
  await assert.rejects(g.shutdown(),e=>e instanceof GatewayError&&e.code==='SAVE_UNCONFIRMED');
  await assert.rejects(g.execute(b,'closed'),e=>e instanceof GatewayError&&e.code==='UNKNOWN_DOCUMENT');
  await g.execute(a,'recover');await g.open(url(2));
  adapter.close=close;await g.shutdown();assert.equal(f.live.size,0);
});
