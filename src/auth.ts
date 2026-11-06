import { mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext } from 'playwright';

export async function passwordLogin(context: BrowserContext, baseUrl: string, email: string, password: string) {
  const response = await context.request.post(new URL('/api/rpc/command/login-with-password', baseUrl).href, {
    data: { email, password },
    headers: { Accept: 'application/json' },
    timeout: 30_000,
    maxRedirects: 0,
  });
  if (!response.ok()) throw new Error(`Penpot login failed (HTTP ${response.status()}); check the URL, account and password-login policy.`);
  const cookies = await context.cookies(baseUrl);
  if (!cookies.some(c => c.name === 'auth-token' && c.value)) throw new Error('Penpot did not issue an auth-token session cookie.');
}

export async function saveSession(context: BrowserContext, path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(await context.storageState()), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Explicit first-time setup only; never rotate an existing unexpired MCP key. */
export async function enableMcp(context: BrowserContext, baseUrl: string) {
  const rpc = async (name: string, data: object = {}) => {
    const response = await context.request.post(new URL('/api/rpc/command/' + name, baseUrl).href, { data, headers: { Accept: 'application/json' }, maxRedirects: 0 });
    if (!response.ok()) throw new Error('MCP setup failed');
    return response.json();
  };
  const tokens = await rpc('get-access-tokens');
  const existing = tokens.find((t: {type: string; expiresAt?: string}) => t.type === 'mcp' && (!t.expiresAt || Date.parse(t.expiresAt) > Date.now()));
  if (!existing) await rpc('create-access-token', { name: 'MCP', type: 'mcp' });
  const profile = await rpc('get-profile');
  if (!profile.props?.mcpEnabled) await rpc('update-profile-props', { props: { mcpEnabled: true } });
}
