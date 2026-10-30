// Long-term memory: short facts the agent saves for future sessions, stored in
// ~/.klaude/memory as global.json (all projects) and projects/<folder>.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { klaudeHome } from './paths.js';

const MAX_TEXT = 500;
const MAX_PER_SCOPE = 100;
const PREFIX = { global: 'g', project: 'p' };

const memoryDir = () => path.join(klaudeHome(), 'memory');

export function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

function memoryFile(scope, cwd) {
  if (scope === 'global') return path.join(memoryDir(), 'global.json');
  return path.join(memoryDir(), 'projects', `${projectKey(cwd)}.json`);
}

export async function loadMemories(scope, cwd) {
  try {
    return JSON.parse(await fs.readFile(memoryFile(scope, cwd), 'utf8'));
  } catch {
    return [];
  }
}

async function saveMemories(scope, cwd, memories) {
  const file = memoryFile(scope, cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(memories, null, 2));
}

export async function addMemory(scope, cwd, text) {
  if (!PREFIX[scope]) throw new Error('scope must be "project" or "global"');
  text = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('text is required');
  if (text.length > MAX_TEXT) throw new Error(`a memory must be at most ${MAX_TEXT} characters; keep it short`);

  const memories = await loadMemories(scope, cwd);
  const existing = memories.find((m) => m.text.toLowerCase() === text.toLowerCase());
  if (existing) return { ...existing, scope, duplicate: true };
  if (memories.length >= MAX_PER_SCOPE) throw new Error(`${scope} memory is full (${MAX_PER_SCOPE}); remove outdated memories first`);

  const next = Math.max(0, ...memories.map((m) => Number(m.id.slice(1)) || 0)) + 1;
  const memory = { id: `${PREFIX[scope]}${next}`, text, createdAt: new Date().toISOString() };
  await saveMemories(scope, cwd, [...memories, memory]);
  return { ...memory, scope };
}

// Removes a memory by id ("g3" or "p7"); returns false if there was none.
export async function removeMemory(cwd, id) {
  const scope = Object.keys(PREFIX).find((s) => String(id).startsWith(PREFIX[s]));
  if (!scope) return false;
  const memories = await loadMemories(scope, cwd);
  const rest = memories.filter((m) => m.id !== id);
  if (rest.length === memories.length) return false;
  await saveMemories(scope, cwd, rest);
  return true;
}

export async function allMemories(cwd) {
  return { global: await loadMemories('global', cwd), project: await loadMemories('project', cwd) };
}

export function formatMemories({ global, project }) {
  const list = (items) => items.map((m) => `- [${m.id}] ${m.text}`).join('\n');
  const parts = [];
  if (global.length) parts.push(`Global (all projects):\n${list(global)}`);
  if (project.length) parts.push(`This project:\n${list(project)}`);
  return parts.join('\n\n');
}
