import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GatewayApi } from './gateway.js';
import { createMcpServer } from './server.js';

export function createHttpApp(gateway: GatewayApi, token: string) {
  if (token.length < 32) throw new Error('Gateway bearer token must be at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'penpot-better-mcp' }));
  app.use('/mcp', (req, res, next) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.headers.origin) { res.status(403).json({ error: 'browser_origins_not_supported' }); return; }
    next();
  });
  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer(gateway);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' }); }
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).end(); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status === 413 ? 413 : 400).json({ error: 'invalid_request' });
  });
  return app;
}
