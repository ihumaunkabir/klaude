// User input helpers: @file mentions, custom slash commands, tab completion.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { klaudeHome } from './paths.js';

const MAX_ATTACH_BYTES = 100_000;
const MENTION = /(^|\s)@([^\s@]+)/g;

// Appends the contents of every @path in the input that exists: files with line
// numbers, directories as listings. Tokens that aren't paths, like @decorators
// or emails, are left alone.
export async function expandMentions(input, cwd) {
  const attached = [];
  const blocks = [];
  for (const [, , raw] of input.matchAll(MENTION)) {
    const rel = raw.replace(/[.,;:!?)]+$/, ''); // trailing punctuation
    const file = path.resolve(cwd, rel);
    if (attached.some((a) => a.file === file)) continue;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const entries = (await fsp.readdir(file, { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      blocks.push(`<directory path="${rel}">\n${entries.sort().join('\n')}\n</directory>`);
      attached.push({ file, rel, kind: 'directory', size: entries.length });
    } else if (stat.size <= MAX_ATTACH_BYTES) {
      const buf = await fsp.readFile(file);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n');
      blocks.push(`<file path="${rel}">\n${numbered}\n</file>`);
      attached.push({ file, rel, kind: 'file', size: lines.length });
    } else {
      attached.push({ file, rel, kind: 'too-large', size: stat.size });
    }
  }
  const text = blocks.length ? `${input}\n\nAttached by the user:\n${blocks.join('\n')}` : input;
  return { text, attached };
}

// Loads prompt templates from ~/.klaude/commands/*.md and <project>/.klaude/commands/*.md
// (project wins). Returns Map name -> { description, template, source }.
export async function loadCustomCommands(cwd) {
  const commands = new Map();
  for (const [dir, source] of [
    [path.join(klaudeHome(), 'commands'), 'user'],
    [path.join(cwd, '.klaude', 'commands'), 'project'],
  ]) {
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      const template = (await fsp.readFile(path.join(dir, name), 'utf8')).trim();
      const first = template.split('\n').find((l) => l.trim()) ?? '';
      commands.set(name.slice(0, -3), { description: first.replace(/^#+\s*/, '').slice(0, 70), template, source });
    }
  }
  return commands;
}

// Fills $ARGUMENTS in a template; without the placeholder, arguments are appended.
export function renderCommand(template, args) {
  if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', args);
  return args ? `${template}\n\nArguments: ${args}` : template;
}

// Readline completer for /commands and @paths.
export function makeCompleter(cwd, commandNames) {
  return (line) => {
    const mention = line.match(/(?:^|\s)@([^\s@]*)$/);
    if (mention) {
      const typed = mention[1];
      const dir = typed.includes('/') ? typed.slice(0, typed.lastIndexOf('/') + 1) : '';
      const base = typed.slice(dir.length);
      let entries = [];
      try {
        entries = fs.readdirSync(path.resolve(cwd, dir || '.'), { withFileTypes: true });
      } catch {
        return [[], `@${typed}`];
      }
      const hits = entries
        .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')) && e.name !== 'node_modules')
        .map((e) => `@${dir}${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      return [hits, `@${typed}`];
    }
    if (/^\/\S*$/.test(line)) {
      const all = commandNames().map((n) => `/${n}`);
      const hits = all.filter((n) => n.startsWith(line));
      return [hits.length ? hits : all, line];
    }
    return [[], line];
  };
}

// The closest known command, for "did you mean" hints (edit distance ≤ 2).
export function suggestCommand(name, names) {
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  const best = names.map((n) => [n, distance(name, n)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}
