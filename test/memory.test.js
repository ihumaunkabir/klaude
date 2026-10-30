import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addMemory, removeMemory, allMemories, formatMemories } from '../src/memory.js';
import { saveSession, listSessions, latestSession, describeSession } from '../src/session.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { tools } from '../src/tools.js';

// Each test gets its own ~/.klaude and project folder.
async function sandbox() {
  process.env.KLAUDE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-home-'));
  return fs.mkdtemp(path.join(os.tmpdir(), 'klaude-proj-'));
}

test('memories are scoped, deduplicated and removable', async () => {
  const cwd = await sandbox();
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-proj-'));

  const g = await addMemory('global', cwd, 'User prefers pnpm');
  const p = await addMemory('project', cwd, 'Tests need   Docker running');
  assert.deepEqual([g.id, p.id, p.text], ['g1', 'p1', 'Tests need Docker running']);
  assert.equal((await addMemory('global', cwd, 'user prefers PNPM')).duplicate, true);

  // Global memories show up everywhere; project memories only in their project.
  assert.deepEqual((await allMemories(other)).global.map((m) => m.id), ['g1']);
  assert.deepEqual((await allMemories(other)).project, []);

  assert.equal(await removeMemory(cwd, 'p1'), true);
  assert.equal(await removeMemory(cwd, 'p1'), false);
  assert.equal((await addMemory('project', cwd, 'next')).id, 'p1');
  await assert.rejects(addMemory('project', cwd, 'x'.repeat(501)), /at most 500/);
  await assert.rejects(addMemory('team', cwd, 'x'), /scope/);
});

test('saved memories are loaded into the system prompt', async () => {
  const cwd = await sandbox();
  await addMemory('global', cwd, 'User prefers tabs');
  await addMemory('project', cwd, 'Run tests with make test');
  assert.equal(formatMemories(await allMemories(cwd)), 'Global (all projects):\n- [g1] User prefers tabs\n\nThis project:\n- [p1] Run tests with make test');
  const prompt = await buildSystemPrompt(cwd);
  assert.match(prompt, /# Saved memories \(from earlier sessions\)\nGlobal \(all projects\):\n- \[g1\] User prefers tabs/);
});

test('the memory tool adds and removes memories', async () => {
  const cwd = await sandbox();
  const ctx = { cwd, state: { files: new Map(), todos: [] } };
  assert.equal(await tools.memory.run({ action: 'add', text: 'Uses Vite' }, ctx), 'Saved project memory p1: Uses Vite');
  assert.equal(await tools.memory.run({ action: 'add', text: 'Uses Vite' }, ctx), 'Already remembered as p1');
  assert.equal(await tools.memory.run({ action: 'remove', id: 'p1' }, ctx), 'Removed memory p1');
  await assert.rejects(tools.memory.run({ action: 'remove' }, ctx), /id is required/);
});

test('sessions are listed per directory, newest first', async () => {
  const cwd = await sandbox();
  const msgs = (text) => [{ role: 'system', content: 's' }, { role: 'user', content: text }];
  await saveSession('a', { cwd, messages: msgs('first task') });
  await new Promise((r) => setTimeout(r, 10));
  await saveSession('b', { cwd, messages: [...msgs('second task'), { role: 'user', content: '<tool_result>x' }] });
  await saveSession('c', { cwd: '/elsewhere', messages: msgs('other') });

  const sessions = await listSessions(cwd);
  assert.deepEqual(sessions.map((s) => s.id), ['b', 'a']);
  assert.equal((await latestSession(cwd)).id, 'b');
  assert.match(describeSession(sessions[0]), /^second task · .+ · 2 messages$/);
  assert.match(describeSession({ ...sessions[0], name: 'api-work' }), /^api-work · /);
});
