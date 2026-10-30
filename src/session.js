// Saves conversations to ~/.klaude/sessions so they can be resumed with --continue / --resume.

import fs from 'node:fs/promises';
import path from 'node:path';
import { klaudeHome } from './paths.js';
import { tools } from './tools.js';
import { c, truncateLines } from './ui.js';

const sessionsDir = () => path.join(klaudeHome(), 'sessions');

export function newSessionId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveSession(id, data) {
  await fs.mkdir(sessionsDir(), { recursive: true });
  const file = path.join(sessionsDir(), `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }));
}

// Returns the sessions saved for cwd, most recently updated first.
export async function listSessions(cwd) {
  let names;
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(sessionsDir(), name), 'utf8'));
      if (data.cwd === cwd) sessions.push({ id: name.slice(0, -'.json'.length), ...data });
    } catch {
      // Skip unreadable session files.
    }
  }
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// Returns the most recently updated session for cwd, or null.
export async function latestSession(cwd) {
  return (await listSessions(cwd))[0] ?? null;
}

// One-line description of a session: its name or first request, when, and how long.
export function describeSession(session) {
  const first = session.messages.find((m) => m.role === 'user' && !m.content.startsWith('<tool_result'));
  const preview = cleanUserText(first?.content ?? '').replace(/\s+/g, ' ').slice(0, 60);
  const when = new Date(session.updatedAt).toLocaleString();
  const title = session.name ? c.bold(session.name) : preview || '(empty)';
  return `${title} ${c.gray(`· ${when} · ${session.messages.length - 1} messages`)}`;
}

// Finds a session by its number in the list (1 = newest), name, or id prefix.
export function findSession(sessions, query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  if (/^\d+$/.test(q)) return sessions[Number(q) - 1] ?? null;
  const lower = q.toLowerCase();
  return (
    sessions.find((s) => s.name?.toLowerCase() === lower) ??
    sessions.find((s) => s.id.startsWith(q)) ??
    (sessions.filter((s) => s.name?.toLowerCase().includes(lower)).length === 1
      ? sessions.find((s) => s.name?.toLowerCase().includes(lower))
      : null)
  );
}

// The user's own words, without attachments, shell output or mode notes Klaude added.
function cleanUserText(text) {
  return text
    .replace(/^Output of shell commands I ran:\n[\s\S]*?\n\n(?=\S)/, '')
    .split('\n\nAttached by the user:')[0]
    .replace(/\n\n\[Plan mode is (on|off)[^\]]*\]$/, '')
    .trim();
}

// The conversation so far, for showing on resume: user messages, replies and
// one line per tool call. Only the last `limit` messages are shown.
export function formatTranscript(messages, limit = 40) {
  const shown = messages.slice(1).slice(-limit);
  const lines = [];
  const skipped = messages.length - 1 - shown.length;
  lines.push(c.gray(`── previous conversation${skipped > 0 ? ` (last ${shown.length} of ${messages.length - 1} messages)` : ''} ──`));
  for (const m of shown) {
    if (m.role === 'user') {
      if (m.content.startsWith('<tool_result')) continue;
      if (m.content.startsWith('This session continues from an earlier conversation')) {
        lines.push(c.gray('  (earlier messages were summarized)'));
        continue;
      }
      if (m.content.startsWith('[')) continue; // notes Klaude added, e.g. after /undo
      lines.push('', `${c.bold('›')} ${truncateLines(cleanUserText(m.content), 6)}`);
    } else if (m.role === 'assistant') {
      if (m.content?.trim()) lines.push('', truncateLines(m.content.trim(), 12));
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name;
        const args = typeof tc.function?.arguments === 'object' ? tc.function.arguments : {};
        const summary = String(tools[name]?.describe(args) ?? '').split('\n')[0].slice(0, 100);
        lines.push(c.gray(`⏺ ${name}(${summary})`));
      }
    }
  }
  lines.push('', c.gray('── end of history · continue below ──'));
  return lines.join('\n');
}
