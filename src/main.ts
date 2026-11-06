import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { HeadlessAdapter } from './headless-adapter.js';
import { Gateway } from './gateway.js';
import { createMcpServer } from './server.js';
import { createHttpApp } from './http.js';
import { Diagnostics } from './diagnostics.js';
import { GatewayError } from './errors.js';
import { createShutdownHandler } from './shutdown.js';

async function main() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.runtime/browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.runtime/browsers');
  const config = loadConfig();
  const diagnostics = new Diagnostics(config.diagnostics ? record => console.error(JSON.stringify(record)) : undefined);
  const gateway = new Gateway(() => new HeadlessAdapter(config, diagnostics), config.baseUrl, config.idleMs, diagnostics, config.maxWorkers);
  let closeTransport: () => Promise<void>;
  let mcp: ReturnType<typeof createMcpServer> | undefined;
  if (process.argv.includes('--http')) {
    const token = (await readFile(process.env.GATEWAY_TOKEN_FILE || '.state/gateway-token', 'utf8')).trim();
    const app = createHttpApp(gateway, token);
    const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
    closeTransport = () => new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
    console.error('Penpot Better MCP HTTP listener ready');
  } else {
    mcp = createMcpServer(gateway);
    const transport = new StdioServerTransport();
    closeTransport = () => mcp!.close();
    await mcp.connect(transport);
  }
  const stop = createShutdownHandler(() => gateway.shutdown(), closeTransport, {
    onFailure: error => console.error(JSON.stringify({ eventVersion: 1, at: new Date().toISOString(), event: 'shutdown_failed', errorCode: error instanceof GatewayError ? error.code : 'OPERATION_FAILED', retryMs: 5000 })),
    // Let HTTP/stdout finish flushing instead of terminating the process early.
    onComplete: () => { process.exitCode = 0; },
  });
  if (mcp) mcp.server.onclose = () => { void stop(); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void stop(); });
}
main().catch(() => { console.error('Gateway startup failed. Check configuration and required files.'); process.exitCode = 1; });
