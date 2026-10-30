import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/prompt.js';

async function project(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

test('KLAUDE.md is preferred over AGENTS.md', async () => {
  const prompt = await buildSystemPrompt(await project({ 'KLAUDE.md': 'use klaude rules', 'AGENTS.md': 'use agents rules' }));
  assert.match(prompt, /from KLAUDE\.md\)\nuse klaude rules/);
  assert.doesNotMatch(prompt, /use agents rules/);
});

test('AGENTS.md is used when there is no KLAUDE.md', async () => {
  const prompt = await buildSystemPrompt(await project({ 'AGENTS.md': 'use agents rules' }));
  assert.match(prompt, /from AGENTS\.md\)\nuse agents rules/);
});

test('other instruction files are ignored', async () => {
  const prompt = await buildSystemPrompt(await project({ 'CLAUDE.md': 'ignored rules' }));
  assert.doesNotMatch(prompt, /ignored rules|Project instructions/);
});
