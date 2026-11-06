import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.js';
import { parseDocument } from '../src/document.js';

interface Fixture { base: string; files: { id: string; name: string; url: string }[]; }
const localBase = 'http://127.0.0.1:19001';

/** Explicit dedicated files only; fault injection must stay on the local fixture. */
export async function loadFixture({ localOnly = false } = {}) {
  const targets: Fixture = JSON.parse(await readFile(process.env.E2E_TARGETS_FILE || '.state/latest-targets.json', 'utf8'));
  if (localOnly) assert.equal(targets.base, localBase, 'Fault injection requires the disposable loopback fixture.');
  assert.equal(targets.files.length, 2);
  for (const file of targets.files) {
    assert(file.name.startsWith('Headless acceptance '), 'Use dedicated acceptance files.');
    assert.equal(parseDocument(file.url, targets.base).fileId, file.id);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.runtime/browsers');
  const config = loadConfig({ ...process.env, PENPOT_BASE_URL: targets.base,
    PENPOT_STORAGE_STATE: process.env.PENPOT_STORAGE_STATE || (targets.base === localBase ? '.state/latest-session.json' : '.state/session.json') });
  return { targets, config };
}

export function body(result: CallToolResult) {
  const text = result.content.find(item => item.type === 'text');
  assert(text?.type === 'text');
  return JSON.parse(text.text);
}

export function data(result: CallToolResult) {
  assert(!result.isError, JSON.stringify(result.content));
  return body(result);
}

export async function writeReport(name: string, report: unknown) {
  await mkdir('test-results', { recursive: true });
  await writeFile(resolve('test-results', name), JSON.stringify(report, null, 2));
}
