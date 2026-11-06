import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { HeadlessAdapter } from './headless-adapter.js';
import { Gateway } from './gateway.js';
import { createMcpServer } from './server.js';
import { createHttpApp } from './http.js';

async function main() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.runtime/browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.runtime/browsers');
  const config = loadConfig();
  const gateway = new Gateway(new HeadlessAdapter(config), config.baseUrl, config.idleMs);
  let closeListener: () => void = () => {};
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; closeListener(); await gateway.shutdown(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  if (process.argv.includes('--http')) {
    const token = (await readFile(process.env.GATEWAY_TOKEN_FILE || '.state/gateway-token', 'utf8')).trim();
    const app = createHttpApp(gateway, token);
    const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.error('Penpot Better MCP HTTP listener ready'));
    closeListener = () => { server.close(); };
  } else {
    const server = createMcpServer(gateway);
    const transport = new StdioServerTransport();
    server.server.onclose = () => { void stop(); };
    await server.connect(transport);
  }
}
main().catch(() => { console.error('Gateway startup failed. Check configuration and required files.'); process.exitCode = 1; });
