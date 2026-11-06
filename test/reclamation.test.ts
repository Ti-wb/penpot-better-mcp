import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesignAdapter } from '../src/adapter.js';
import { DocumentWorker } from '../src/document-worker.js';
import { GatewayError } from '../src/errors.js';
import { Diagnostics } from '../src/diagnostics.js';

const ok = {content: [{type:'text' as const,text:'{}'}]};
const base = 'https://penpot.example', url = base + '/#/workspace?team-id=11111111-1111-4111-8111-111111111111&file-id=22222222-2222-4222-8222-222222222222';
function fake(): DesignAdapter { return {open:async()=>ok,openPage:async()=>ok,execute:async()=>ok,flush:async()=>ok,flushPending:async()=>{},exportShape:async()=>ok,documentation:async()=>ok,release:()=>{},close:async()=>{}}; }
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean) { const end=Date.now()+2000; while(!check()) { assert(Date.now()<end,'timed out'); await delay(5); } }

test('closing a superseded handle flushes without retiring other handles; last close releases worker', async () => {
  const adapter=fake(); let flushes=0, closes=0, releases=0;
  adapter.flushPending=async()=>{flushes++;}; adapter.close=async()=>{closes++;}; adapter.release=()=>{releases++;};
  const gateway=new DocumentWorker(adapter,base);
  try {
    const a=(await gateway.open(url)).documentHandle!, b=(await gateway.open(url)).documentHandle!;
    assert.deepEqual(await gateway.closeDocument(a),{closed:true,browserReleased:false,remainingHandles:1});
    assert.equal(flushes,1); assert.equal(closes,0); assert.equal(releases,1);
    await assert.rejects(gateway.inspect(a), /valid handle/); assert(!(await gateway.inspect(b)).isError);
    adapter.close=async()=>{throw new GatewayError('SAVE_UNCONFIRMED','unsaved',true);};
    await assert.rejects(gateway.closeDocument(b),/unsaved/); assert.equal(releases,1);
    assert(!(await gateway.inspect(b)).isError);
    adapter.close=async()=>{closes++;};
    assert.deepEqual(await gateway.closeDocument(b),{closed:true,browserReleased:true,remainingHandles:0});
    assert.equal(closes,1); assert.equal(releases,2);
  } finally {await gateway.shutdown();}
});

test('idle save failure retries later and does not close during accepted work or after shutdown', async () => {
  const adapter=fake(); let attempts=0, release!:()=>void;
  const events:Record<string,any>[]=[];
  adapter.close=async()=>{attempts++;if(attempts===1)throw new GatewayError('SAVE_UNCONFIRMED','hold',true);};
  const gateway=new DocumentWorker(adapter,base,20,new Diagnostics(record=>events.push(record)));
  try {
    const handle=(await gateway.open(url)).documentHandle!;
    await until(()=>events.some(e=>e.operation==='idle_reclaim'&&e.outcome==='ok'));
    assert.equal(attempts,2); assert(events.some(e=>e.operation==='idle_reclaim'&&e.errorCode==='SAVE_UNCONFIRMED'));
    const gate=new Promise<void>(r=>{release=r;}); adapter.execute=async()=>{await gate;return ok;};
    const pending=gateway.execute(handle,'held'); await delay(60); assert.equal(attempts,2);
    const stopped=gateway.shutdown();
    await assert.rejects(gateway.inspect(handle),/shutting down/);
    release(); await pending; await stopped;
    assert.equal(attempts,3); await delay(60); assert.equal(attempts,3);
  } finally {release?.();await gateway.shutdown();}
});
