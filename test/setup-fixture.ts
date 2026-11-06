import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { passwordLogin, saveSession, enableMcp } from '../src/auth.js';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
const { chromium } = await import('playwright');
const base = 'http://127.0.0.1:19001';
const email = 'headless-test@example.invalid';
const password = 'disposable-local-test-2026';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  try { await passwordLogin(context, base, email, password); }
  catch {
    execFileSync('docker', ['compose','-f','test/compose.yaml','exec','-T','penpot-backend','./manage.py','create-profile','-e',email,'-p',password,'-n','Headless Test','--skip-tutorial','--skip-walkthrough'], { stdio: 'pipe' });
    await passwordLogin(context, base, email, password);
  }
  const rpc = async (name: string, data = {}) => {
    const response = await context.request.post(base + '/api/rpc/command/' + name, { data, headers: { Accept: 'application/json' } });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()})`);
    return response.json();
  };
  const profile = await rpc('get-profile');
  await enableMcp(context, base);
  await rpc('update-profile-props', { props: { mcpEnabled: true, onboardingViewed: true, releaseNotesViewed: '2.18.6', onboardingQuestionsAnswered: true } });
  const name = 'Penpot Better MCP — disposable latest acceptance';
  const projects = await rpc('get-projects', { teamId: profile.defaultTeamId });
  const project = projects.find((p: {name: string}) => p.name === name) || await rpc('create-project', { teamId: profile.defaultTeamId, name });
  const existing = await rpc('get-project-files', { projectId: project.id });
  const files = [];
  for (const fileName of ['Headless acceptance A','Headless acceptance B']) {
    const file = existing.find((f: {name: string}) => f.name === fileName) || await rpc('create-file', { projectId: project.id, name: fileName });
    files.push({ id: file.id, name: fileName, url: base + '/#/workspace?' + new URLSearchParams({ 'team-id': profile.defaultTeamId, 'file-id': file.id }) });
  }
  await mkdir('.state', { recursive: true, mode: 0o700 });
  await saveSession(context,'.state/latest-session.json');
  await writeFile('.state/latest-targets.json', JSON.stringify({ base, projectId: project.id, files },null,2), { mode: 0o600 });
  console.log('Disposable fixture ready. No real Penpot account or files were used.');
} finally { await browser.close(); }
