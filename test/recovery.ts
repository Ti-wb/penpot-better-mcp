import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

// Failure injection uses only the disposable, loopback latest-version fixture.
const targets = JSON.parse(await readFile('.state/latest-targets.json', 'utf8'));
assert.equal(targets.base, 'http://127.0.0.1:19001');
assert(targets.files.every((f: {name: string}) => f.name.startsWith('Headless acceptance ')));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const checks: string[] = [];
const check = (name: string) => { checks.push(name); console.log('PASS', name); };
const data = (result: {content: any[]}) => JSON.parse(result.content.find(c => c.type === 'text').text);
async function connect(storage: string) {
  const client = new Client({name:'recovery-acceptance',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/main.js'],stderr:'inherit',env:{...env,PENPOT_BASE_URL:targets.base,PENPOT_STORAGE_STATE:storage,PENPOT_TIMEOUT_MS:'2000'}}));
  return client;
}
async function call(client: Client, name: string, args: Record<string,unknown>) {
  return CallToolResultSchema.parse(await client.callTool({name,arguments:args}, CallToolResultSchema, {timeout:180_000}));
}
const client = await connect('.state/latest-session.json');
try {
  const opened = await call(client,'open_document',{url:targets.files[0].url}); assert(!opened.isError);
  const {documentHandle} = data(opened);
  const slow = await call(client,'execute_code',{documentHandle,code:'await new Promise(resolve=>setTimeout(resolve,10000));return true;'});
  assert(slow.isError); assert.equal(data(slow).code,'EXECUTION_UNKNOWN'); assert.equal(data(slow).outcomeUnknown,true);
  check('upstream timeout returns an uncertain outcome');
  const recovered = await call(client,'inspect_document',{documentHandle}); assert(!recovered.isError);
  assert.equal(data(recovered).result.fileId,targets.files[0].id);
  check('fresh browser recovers the same bound document after timeout');
  await call(client,'close_document',{documentHandle});
} finally { await client.close(); }

const empty = '.state/recovery-empty-session.json';
await writeFile(empty,JSON.stringify({cookies:[],origins:[]}),{mode:0o600});
const unauthenticated = await connect(empty);
try {
  const result = await call(unauthenticated,'open_document',{url:targets.files[0].url});
  assert(result.isError); assert.equal(data(result).code,'AUTH_REQUIRED');
  check('missing browser authentication is reported without dispatching an edit');
} finally { await unauthenticated.close(); await rm(empty,{force:true}); }
await mkdir('test-results',{recursive:true});
await writeFile('test-results/recovery.json',JSON.stringify({at:new Date().toISOString(),site:targets.base,status:'passed',checks},null,2));
