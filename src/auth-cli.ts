import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { passwordLogin, saveSession, enableMcp } from './auth.js';

function option(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }

async function hiddenPassword(): Promise<string> {
  stdout.write('Password (hidden): ');
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const finish = () => { stdin.off('data', receive); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    const receive = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); resolvePassword(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', receive);
  });
}

async function main() {
  if (!stdin.isTTY) throw new Error('Run this command in your own interactive terminal. Do not pipe credentials.');
  const baseUrl = option('--base-url') || process.env.PENPOT_BASE_URL;
  if (!baseUrl) throw new Error('Usage: npm run auth -- --base-url https://your-penpot.example');
  const url = new URL(baseUrl);
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid Penpot base URL');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for remote login.');
  const path = resolve(option('--output') || '.state/session.json');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.runtime/browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.runtime/browsers');
  const { chromium } = await import('playwright');
  const prompt = createInterface({ input: stdin, output: stdout });
  const email = (await prompt.question(`Penpot: ${url.origin}\nEmail: `)).trim();
  prompt.close();
  let password = await hiddenPassword();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await passwordLogin(context, url.origin, email, password);
    password = '';
    if (process.argv.includes('--enable-mcp')) await enableMcp(context, url.origin);
    await saveSession(context, path);
    stdout.write(`Login succeeded. Session saved with mode 0600: ${path}\nPassword was not saved. Do not commit or share the session file.\n`);
  } finally { password = ''; await browser.close(); }
}
main().catch(() => { console.error('Login did not complete. Check the site URL, network, credentials and password-login policy. No password was saved.'); process.exitCode = 1; });
