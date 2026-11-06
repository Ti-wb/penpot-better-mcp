import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.state', { recursive: true, mode: 0o700 });
try { await writeFile('.state/gateway-token', randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
console.log('Gateway token ready in .state/gateway-token (not printed).');
