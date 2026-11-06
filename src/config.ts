import { resolve } from 'node:path';

export interface Config {
  baseUrl: string;
  storageState: string;
  upstreamHttp: string;
  upstreamWs: string;
  pluginWsPath: string;
  timeoutMs: number;
  idleMs: number;
  diagnostics: boolean;
}

export function loadConfig(env = process.env): Config {
  const base = new URL(env.PENPOT_BASE_URL || 'https://penpot.example.com');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('PENPOT_BASE_URL must be an origin');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Use HTTPS, except for a loopback test site');
  const positive = (value: string | undefined, fallback: number) => { const n = Number(value || fallback); if (!Number.isSafeInteger(n) || n < 1000) throw new Error('Timeouts must be integers >= 1000'); return n; };
  if (env.PENPOT_DIAGNOSTICS !== undefined && !['true', 'false'].includes(env.PENPOT_DIAGNOSTICS)) throw new Error('PENPOT_DIAGNOSTICS must be true or false');
  return {
    baseUrl: base.origin,
    storageState: resolve(env.PENPOT_STORAGE_STATE || '.state/session.json'),
    upstreamHttp: env.PENPOT_UPSTREAM_HTTP || 'http://127.0.0.1:14401/mcp',
    upstreamWs: env.PENPOT_UPSTREAM_WS || 'ws://127.0.0.1:14402',
    pluginWsPath: env.PENPOT_PLUGIN_WS_PATH || '/mcp/ws',
    timeoutMs: positive(env.PENPOT_TIMEOUT_MS, 120_000),
    idleMs: positive(env.PENPOT_IDLE_MS, 600_000),
    diagnostics: env.PENPOT_DIAGNOSTICS !== 'false',
  };
}
