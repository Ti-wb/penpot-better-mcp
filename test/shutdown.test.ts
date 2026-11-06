import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createShutdownHandler } from '../src/shutdown.js';
import { GatewayError } from '../src/errors.js';

function gate() { let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }

test('failed saving retains the listener and retries without an unhandled rejection', {timeout:2000}, async()=>{
  let attempts=0, closed=false, complete=false;
  const errors:unknown[]=[];
  const stop=createShutdownHandler(async()=>{
    if(++attempts===1)throw new GatewayError('SAVE_UNCONFIRMED','live editor retained',true);
  },async()=>{closed=true;},{onFailure:error=>errors.push(error),onComplete:()=>{complete=true;},retryMs:20});
  await stop();
  assert.equal(closed,false);assert.equal(complete,false);
  assert.equal((errors[0] as GatewayError).code,'SAVE_UNCONFIRMED');
  while(!complete)await delay(5);
  assert.equal(attempts,2);assert.equal(closed,true);
  await stop();await delay(40);assert.equal(attempts,2);
});

test('repeated signals share drain and completion waits for transport output', {timeout:2000}, async()=>{
  const draining=gate(),output=gate();let closed=false,complete=false,attempts=0;
  const stop=createShutdownHandler(async()=>{attempts++;await draining.promise;},async()=>{closed=true;await output.promise;},{
    onFailure:error=>{throw error;},onComplete:()=>{complete=true;},
  });
  const first=stop();assert.equal(stop(),first);assert.equal(closed,false);
  draining.resolve();await delay(0);assert.equal(closed,true);assert.equal(complete,false);
  output.resolve();await first;await stop();assert.equal(complete,true);assert.equal(attempts,1);
});
