import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { Diagnostics } from '../src/diagnostics.js';
import { Gateway } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';

const targets = JSON.parse(await readFile(process.env.E2E_TARGETS_FILE || '.state/latest-targets.json', 'utf8'));
assert(targets.files.every((file: {name: string}) => file.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
await mkdir('test-results', {recursive:true});
const output = createWriteStream('test-results/diagnostics.ndjson');
const samples = { enabled: [] as number[], disabled: [] as number[] };
const large = { enabled: [] as number[], disabled: [] as number[] };
try {
  // ABBA order; separate cold starts, each followed by warm-up outside timing.
  for (const enabled of [false, true, true, false]) {
    const diagnostics = new Diagnostics(enabled ? record => { output.write(JSON.stringify(record) + '\n'); } : undefined);
    const config = loadConfig({...process.env, PENPOT_BASE_URL: targets.base, PENPOT_STORAGE_STATE: process.env.PENPOT_STORAGE_STATE || '.state/latest-session.json'});
    const adapter = new HeadlessAdapter(config, diagnostics);
    const gateway = new Gateway(adapter, targets.base, 600_000, diagnostics);
    try {
      const {documentHandle: handle} = await gateway.open(targets.files[0].url); assert(handle);
      for (let i = 0; i < 10; i++) assert(!(await gateway.execute(handle, 'return 1;', 'deferred')).isError);
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        assert(!(await gateway.execute(handle, 'return penpot.currentFile.id;', 'deferred')).isError);
        samples[enabled ? 'enabled' : 'disabled'].push(performance.now() - start);
      }
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        assert(!(await gateway.execute(handle, 'return "x".repeat(1024*1024);', 'deferred')).isError);
        large[enabled ? 'enabled' : 'disabled'].push(performance.now() - start);
      }
      await gateway.flush(handle);
    } finally { await gateway.shutdown(); }
  }
} finally { await new Promise<void>((resolve, reject) => { output.on('error', reject); output.end(resolve); }); }
const stats = (values: number[]) => { const a = values.toSorted((a,b) => a-b); return {n:a.length,p50Ms:a[Math.ceil(a.length*.5)-1],p95Ms:a[Math.ceil(a.length*.95)-1]}; };
const records = (await readFile('test-results/diagnostics.ndjson', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert(records.some(r => r.event === 'browser_started')); assert.equal(records.filter(r => r.event === 'browser_closed').length, 2);
assert(records.some(r => r.event === 'request' && r.operation === 'execute_code' && r.responseContentBytes >= 1024*1024));
for (const r of records.filter(r => r.event === 'request')) assert(r.activationMs + r.upstreamMs + r.saveMs + r.cleanupMs <= r.totalMs - r.queueMs + 1);
const report = {at:new Date().toISOString(),status:'passed',site:targets.base,method:'ABBA, 200 warm reads and 20 synthetic 1 MiB results per mode; cold starts and warm-up excluded',warm:{enabled:stats(samples.enabled),disabled:stats(samples.disabled)},large:{enabled:stats(large.enabled),disabled:stats(large.disabled)}};
await writeFile('test-results/diagnostics.json', JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
