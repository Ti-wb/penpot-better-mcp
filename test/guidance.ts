import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HeadlessAdapter } from '../src/headless-adapter.js';
import { parseDocument } from '../src/document.js';
import { loadConfig } from '../src/config.js';

const targets = JSON.parse(await readFile(process.env.E2E_TARGETS_FILE || '.state/latest-targets.json','utf8'));
assert(targets.files.every((file:{name:string}) => file.name.startsWith('Headless acceptance ')));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const adapter = new HeadlessAdapter(loadConfig({...process.env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:process.env.PENPOT_STORAGE_STATE || '.state/latest-session.json'}));
const target = parseDocument(targets.files[0].url,targets.base);
const checks: string[] = [];
try {
  await adapter.open(target);
  const denied = await adapter.execute(target,'return penpot.activeUsers.length;','deferred');
  assert(denied.isError, 'Permission availability changed: update the deployment guidance after review.');
  const error = JSON.parse((denied.content[0] as {text:string}).text);
  assert.equal(error.code,'PLUGIN_PERMISSION_DENIED'); assert.equal(error.permission,'user:read'); assert.equal(error.partialEditsPossible,true);
  checks.push('runtime user:read denial returns a structured plugin permission error');
  const syntax = await adapter.execute(target,'return );','deferred'); assert(syntax.isError);
  assert.equal(JSON.parse((syntax.content[0] as {text:string}).text).code,'SCRIPT_SYNTAX_ERROR');
  checks.push('invalid JavaScript returns a distinct syntax classification');
  const value = await adapter.execute(target,'return penpot.currentFile.id;','deferred'); assert(!value.isError);
  assert.equal(JSON.parse((value.content[0] as {text:string}).text).result,target.fileId);
  await adapter.flush(target);
  checks.push('normal document reads and flush remain available after both failures');
} finally { await adapter.close(); }
const report={at:new Date().toISOString(),site:targets.base,status:'passed',checks};
await mkdir('test-results',{recursive:true});
await writeFile('test-results/'+(process.env.GUIDANCE_REPORT || 'guidance.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
