// Tools the model can call. Each tool has an Ollama/OpenAI-style schema,
// a flag saying whether it needs user permission, and a run() function.
// run() gets a ctx of { cwd, signal, state, runSubagent } where state holds
// per-session data: `files` (path -> mtime when last read/written), `todos`, and
// `checkpoint` (path -> content before this turn's first change, for /undo).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { addMemory, removeMemory } from './memory.js';

const MAX_OUTPUT = 30000;
const MAX_LINE = 2000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n… [truncated ${text.length - MAX_OUTPUT} chars]`;
}

function resolvePath(ctx, p) {
  if (!p) throw new Error('path is required');
  return path.resolve(ctx.cwd, p);
}

function schema(name, description, properties, required = Object.keys(properties)) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

async function mtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

// Refuses to change an existing file the model hasn't read, or that changed since it was read.
async function checkFresh(ctx, file, displayPath) {
  const current = await mtime(file);
  if (current === null) return;
  const seen = ctx.state.files.get(file);
  if (seen === undefined) throw new Error(`${displayPath} exists but has not been read yet. Read it first.`);
  if (seen !== current) throw new Error(`${displayPath} changed since it was last read. Read it again first.`);
}

async function remember(ctx, file) {
  ctx.state.files.set(file, await mtime(file));
}

// Marks a file as read, e.g. when the user attached it with @path.
export async function markFileRead(state, file) {
  state.files.set(file, await mtime(file));
}

// Saves a file's content before its first change this turn, so /undo can restore it.
async function checkpoint(ctx, file) {
  const changes = ctx.state.checkpoint;
  if (!changes || changes.has(file)) return;
  try {
    changes.set(file, await fs.readFile(file));
  } catch {
    changes.set(file, null); // didn't exist yet
  }
}

// Restores files saved by checkpoint(); returns the paths it touched.
export async function restoreCheckpoint(state, changes) {
  for (const [file, content] of changes) {
    if (content === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, content);
    state.files.set(file, await mtime(file));
  }
  return [...changes.keys()];
}

// Applies one exact-string replacement, with errors the model can act on.
function applyEdit(text, { old_string, new_string, replace_all }) {
  const oldStr = String(old_string ?? '');
  const newStr = String(new_string ?? '');
  if (!oldStr) throw new Error('old_string must not be empty');
  if (oldStr === newStr) throw new Error('old_string and new_string are identical');
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error('old_string not found in file. Re-read the file and copy the text exactly.');
  if (count > 1 && !replace_all) throw new Error(`old_string occurs ${count} times; add more context or set replace_all`);
  return {
    text: replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr),
    count: replace_all ? count : 1,
    line: text.slice(0, text.indexOf(oldStr)).split('\n').length,
  };
}

const editPreview = (e) =>
  [
    ...String(e.old_string ?? '').split('\n').map((l) => `- ${l}`),
    ...String(e.new_string ?? '').split('\n').map((l) => `+ ${l}`),
  ].join('\n');

// Converts a glob like "src/**/*.{js,ts}" to a RegExp matched against relative paths.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') re += '(?:';
    else if (ch === '}') re += ')';
    else if (ch === ',') re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function* walk(dir, root = dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walk(full, root);
    } else {
      yield path.relative(root, full);
    }
  }
}

// Lists files under root, respecting .gitignore when root is inside a git repo.
export async function listFiles(root, signal, limit = Infinity) {
  const git = await runProcess('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, signal });
  if (git.code === 0) return git.out.split('\n').filter(Boolean).slice(0, limit);
  const files = [];
  for await (const rel of walk(root)) {
    files.push(rel.split(path.sep).join('/'));
    if (files.length >= limit) break;
  }
  return files;
}

// Runs a command in its own process group so timeouts and Ctrl+C also kill
// its children. Resolves when the main process exits, even if a background
// child still holds stdout open.
export function runProcess(cmd, args, { cwd, signal, timeout }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, out: String(err.message) });
    }
    let out = '';
    let killedBy = null;
    const kill = (reason) => {
      killedBy ??= reason;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = timeout ? setTimeout(() => kill(`timed out after ${timeout / 1000}s`), timeout) : null;
    const onAbort = () => kill('interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => finish(-1, out + String(err.message)));
    child.on('exit', (code) => {
      // Give pipes a moment to drain, then stop waiting on background children.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(killedBy ? `killed (${killedBy})` : code, out);
      }, 50);
    });

    let done = false;
    function finish(code, text) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out: text });
    }
  });
}

// Long-running shells started with bash run_in_background, by id ("bg1", …).
const background = new Map();
let nextShellId = 1;
const MAX_BACKGROUND_OUTPUT = 1_000_000;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function startBackground(command, cwd) {
  const child = spawn('bash', ['-c', command], { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const shell = { id: `bg${nextShellId++}`, command, child, out: '', read: 0, exit: null };
  const onData = (d) => {
    shell.out += d;
    const excess = shell.out.length - MAX_BACKGROUND_OUTPUT;
    if (excess > 0) {
      shell.out = shell.out.slice(excess);
      shell.read = Math.max(0, shell.read - excess);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, sig) => (shell.exit = code ?? `killed (${sig})`));
  child.on('error', (err) => {
    shell.out += err.message;
    shell.exit = -1;
  });
  background.set(shell.id, shell);
  return shell;
}

const shellStatus = (s) => (s.exit === null ? 'running' : `exited with code ${s.exit}`);

// Output since the last read, plus status.
function readShell(shell) {
  const fresh = shell.out.slice(shell.read);
  shell.read = shell.out.length;
  return clip(`[${shell.id} ${shellStatus(shell)}]\n${fresh.trimEnd() || '(no new output)'}`);
}

function getShell(id) {
  const shell = background.get(String(id));
  if (!shell) throw new Error(`No background shell "${id}". Running: ${[...background.keys()].join(', ') || 'none'}`);
  return shell;
}

export function listBackground() {
  return [...background.values()].map((s) => ({ id: s.id, command: s.command, status: shellStatus(s) }));
}

// Called on exit so background servers don't outlive Klaude.
export function killAllBackground() {
  for (const s of background.values()) if (s.exit === null) killGroup(s.child.pid, 'SIGKILL');
}

let hasRipgrep;
async function ripgrepAvailable() {
  hasRipgrep ??= (await runProcess('rg', ['--version'], {})).code === 0;
  return hasRipgrep;
}

// Commands that only read state and can run without asking.
const READ_ONLY_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'which', 'stat', 'du', 'echo']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);

export function isReadOnlyCommand(command) {
  if (/[;&<>`$\n\\]/.test(command) || /--output/.test(command)) return false;
  return command.split('|').every((segment) => {
    const [cmd, sub] = segment.trim().split(/\s+/);
    if (cmd === 'git') return READ_ONLY_GIT.has(sub);
    return READ_ONLY_COMMANDS.has(cmd);
  });
}

// Commands that always ask for permission, even in auto mode: they delete or
// overwrite a lot, rewrite git history, publish, or run downloaded code.
const DANGEROUS_PATTERNS = [
  /\brm\s+(-\w*\s+)*-\w*[rf]/, // rm -r / rm -f
  /\bsudo\b/,
  /\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch)/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\b(mkfs|fdisk|diskutil|shutdown|reboot)\b/,
  /\bdd\s+if=/,
  /\bch(mod|own)\s+-R\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bdocker\s+(system\s+prune|rm|rmi)\b/,
  /\bkill(all)?\s+-9\b/,
  />\s*\/dev\/(sd|disk)/,
];

export function isDangerousCommand(command) {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

// The prefix used for "always allow" of bash commands, e.g. "npm test".
// Commands with shell operators get none, so "npm test; rm -rf /" can't ride along.
export function commandPrefix(command) {
  if (/[;&|<>`$\n\\]/.test(command)) return null;
  return command.trim().split(/\s+/).slice(0, 2).join(' ');
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|pre)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

const TODO_MARKS = { pending: '☐', in_progress: '◐', completed: '☒' };

export function formatTodos(todos) {
  return todos.map((t) => `${TODO_MARKS[t.status] ?? '☐'} ${t.content}`).join('\n') || '(no todos)';
}

export const tools = {
  read_file: {
    schema: schema(
      'read_file',
      'Read a text file. Returns contents with line numbers. Use offset/limit for large files. You must read a file before editing or overwriting it.',
      {
        path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
        offset: { type: 'number', description: '1-based line to start from (optional)' },
        limit: { type: 'number', description: 'Max number of lines to read (optional, default 2000)' },
      },
      ['path'],
    ),
    needsPermission: false,
    describe: (a) => a.path,
    async run(a, ctx) {
      const file = resolvePath(ctx, a.path);
      const buf = await fs.readFile(file);
      if (buf.subarray(0, 8000).includes(0)) throw new Error(`${a.path} looks like a binary file`);
      await remember(ctx, file);
      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, Number(a.offset) || 1);
      const end = Math.min(lines.length, start - 1 + (Number(a.limit) || 2000));
      const numbered = [];
      for (let i = start; i <= end; i++) {
        let line = lines[i - 1];
        if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}… [line truncated]`;
        numbered.push(`${String(i).padStart(6)}\t${line}`);
      }
      let result = numbered.join('\n');
      if (end < lines.length) result += `\n… (file has ${lines.length} lines; use offset to read more)`;
      return clip(result) || '(empty file)';
    },
  },

  write_file: {
    schema: schema(
      'write_file',
      'Create or overwrite a file with the given content. Parent directories are created. Existing files must be read first.',
      {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
    ),
    needsPermission: true,
    mutates: true,
    describe: (a) => a.path,
    preview: (a) => String(a.content ?? ''),
    async run(a, ctx) {
      const file = resolvePath(ctx, a.path);
      await checkFresh(ctx, file, a.path);
      await checkpoint(ctx, file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(a.content ?? ''));
      await remember(ctx, file);
      return `Wrote ${String(a.content ?? '').split('\n').length} lines to ${a.path}`;
    },
  },

  edit_file: {
    schema: schema(
      'edit_file',
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
      {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (optional)' },
      },
      ['path', 'old_string', 'new_string'],
    ),
    needsPermission: true,
    mutates: true,
    describe: (a) => a.path,
    preview: editPreview,
    async run(a, ctx) {
      const file = resolvePath(ctx, a.path);
      await checkFresh(ctx, file, a.path);
      const { text, count, line } = applyEdit(await fs.readFile(file, 'utf8'), a);
      await checkpoint(ctx, file);
      await fs.writeFile(file, text);
      await remember(ctx, file);
      return `Edited ${a.path} at line ${line} (${count} replacement${count > 1 ? 's' : ''})`;
    },
  },

  multi_edit: {
    schema: schema(
      'multi_edit',
      'Make several exact-string replacements in one file at once. Edits apply in order, each to the result of the previous one; if any edit fails, none are applied. Prefer this over repeated edit_file calls on the same file.',
      {
        path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          description: 'The replacements to make, in order',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to replace' },
              new_string: { type: 'string', description: 'Replacement text' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (optional)' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
    ),
    needsPermission: true,
    mutates: true,
    describe: (a) => `${a.path}, ${Array.isArray(a.edits) ? a.edits.length : 0} edits`,
    preview: (a) => (Array.isArray(a.edits) ? a.edits.map(editPreview).join('\n…\n') : ''),
    async run(a, ctx) {
      if (!Array.isArray(a.edits) || !a.edits.length) throw new Error('edits must be a non-empty array');
      const file = resolvePath(ctx, a.path);
      await checkFresh(ctx, file, a.path);
      let text = await fs.readFile(file, 'utf8');
      a.edits.forEach((edit, i) => {
        try {
          text = applyEdit(text, edit).text;
        } catch (err) {
          throw new Error(`Edit ${i + 1} of ${a.edits.length}: ${err.message} No edits were applied.`);
        }
      });
      await checkpoint(ctx, file);
      await fs.writeFile(file, text);
      await remember(ctx, file);
      return `Applied ${a.edits.length} edits to ${a.path}`;
    },
  },

  list_dir: {
    schema: schema(
      'list_dir',
      'List entries in a directory (directories end with /).',
      { path: { type: 'string', description: 'Directory path (default: cwd)' } },
      [],
    ),
    needsPermission: false,
    describe: (a) => a.path || '.',
    async run(a, ctx) {
      const entries = await fs.readdir(resolvePath(ctx, a.path || '.'), { withFileTypes: true });
      return (
        entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n') || '(empty directory)'
      );
    },
  },

  glob: {
    schema: schema(
      'glob',
      'Find files by glob pattern, e.g. "**/*.js" or "src/**/*.{ts,tsx}". Respects .gitignore.',
      {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      },
      ['pattern'],
    ),
    needsPermission: false,
    describe: (a) => a.pattern,
    async run(a, ctx) {
      const root = resolvePath(ctx, a.path || '.');
      const re = globToRegExp(String(a.pattern));
      const matches = (await listFiles(root, ctx.signal)).filter((f) => re.test(f)).sort();
      if (!matches.length) return 'No files matched';
      const more = matches.length > 500 ? `\n… (${matches.length - 500} more)` : '';
      return matches.slice(0, 500).join('\n') + more;
    },
  },

  grep: {
    schema: schema(
      'grep',
      'Search file contents with a regular expression. Returns file:line:text matches. Respects .gitignore when ripgrep is installed.',
      {
        pattern: { type: 'string', description: 'Regex to search for' },
        path: { type: 'string', description: 'File or directory to search (default: cwd)' },
        include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py" (optional)' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search (optional)' },
      },
      ['pattern'],
    ),
    needsPermission: false,
    describe: (a) => `${a.pattern}${a.include ? ` (${a.include})` : ''}`,
    async run(a, ctx) {
      const target = resolvePath(ctx, a.path || '.');
      let cmd;
      let args;
      if (await ripgrepAvailable()) {
        cmd = 'rg';
        args = ['-n', '--no-heading', '--color', 'never', '--max-columns', '500'];
        if (a.ignore_case) args.push('-i');
        if (a.include) args.push('-g', a.include);
      } else {
        cmd = 'grep';
        args = ['-rnIE'];
        if (a.ignore_case) args.push('-i');
        for (const d of IGNORED_DIRS) args.push(`--exclude-dir=${d}`);
        if (a.include) args.push(`--include=${a.include}`);
      }
      args.push('-e', String(a.pattern), target);
      const { code, out } = await runProcess(cmd, args, { cwd: ctx.cwd, signal: ctx.signal });
      if (code === 1) return 'No matches';
      const rel = out.split(ctx.cwd + path.sep).join('');
      const lines = rel.trimEnd().split('\n');
      const more = lines.length > 300 ? `\n… (${lines.length - 300} more matches)` : '';
      return clip(lines.slice(0, 300).join('\n') + more);
    },
  },

  bash: {
    schema: schema(
      'bash',
      'Run a shell command in the working directory and return combined stdout/stderr and exit code. Avoid interactive commands. For long-running processes (dev servers, watchers) set run_in_background, then use bash_output to read their output and kill_shell to stop them.',
      {
        command: { type: 'string', description: 'The command to run' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional, default 120; ignored in the background)' },
        run_in_background: { type: 'boolean', description: 'Start it in the background and return a shell id (optional)' },
      },
      ['command'],
    ),
    needsPermission: true,
    describe: (a) => `${a.command}${a.run_in_background ? ' &' : ''}`,
    async run(a, ctx) {
      if (a.run_in_background) {
        const shell = startBackground(String(a.command), ctx.cwd);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // catch immediate output or failure
        return `Started background shell ${shell.id}. Read its output with bash_output, stop it with kill_shell.\n${readShell(shell)}`;
      }
      const { code, out } = await runProcess('bash', ['-c', String(a.command)], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeout: (Number(a.timeout) || 120) * 1000,
      });
      const text = out.trimEnd();
      return clip(`${text ? `${text}\n` : ''}[exit code: ${code}]`);
    },
  },

  bash_output: {
    schema: schema('bash_output', 'Read new output from a background shell started with bash run_in_background.', {
      id: { type: 'string', description: 'Shell id, e.g. "bg1"' },
    }),
    needsPermission: false,
    describe: (a) => a.id,
    async run(a) {
      return readShell(getShell(a.id));
    },
  },

  kill_shell: {
    schema: schema('kill_shell', 'Stop a background shell started with bash run_in_background.', {
      id: { type: 'string', description: 'Shell id, e.g. "bg1"' },
    }),
    needsPermission: false,
    describe: (a) => a.id,
    async run(a) {
      const shell = getShell(a.id);
      if (shell.exit !== null) return `${shell.id} already ${shellStatus(shell)}`;
      killGroup(shell.child.pid, 'SIGTERM');
      for (let i = 0; i < 20 && shell.exit === null; i++) await new Promise((r) => setTimeout(r, 100));
      if (shell.exit === null) killGroup(shell.child.pid, 'SIGKILL');
      return `Stopped ${shell.id}`;
    },
  },

  web_fetch: {
    schema: schema('web_fetch', 'Fetch a URL (e.g. documentation) and return its content as text.', {
      url: { type: 'string', description: 'http(s) URL' },
    }),
    needsPermission: true,
    describe: (a) => a.url,
    async run(a, ctx) {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://');
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)].filter(Boolean));
      const res = await fetch(url, { signal, headers: { 'User-Agent': 'klaude' } });
      const type = res.headers.get('content-type') ?? '';
      let body = await res.text();
      if (type.includes('html')) body = htmlToText(body);
      return clip(`[${res.status} ${type}]\n${body}`);
    },
  },

  todo_write: {
    schema: schema(
      'todo_write',
      'Create or update your task list for multi-step work. Send the full list each time. Keep exactly one item in_progress while working, and mark items completed as soon as they are done.',
      {
        todos: {
          type: 'array',
          description: 'The complete todo list',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What needs to be done' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
    ),
    needsPermission: false,
    describe: (a) => `${Array.isArray(a.todos) ? a.todos.length : 0} items`,
    async run(a, ctx) {
      if (!Array.isArray(a.todos)) throw new Error('todos must be an array');
      ctx.state.todos = a.todos.map((t) => ({ content: String(t.content ?? ''), status: t.status ?? 'pending' }));
      return formatTodos(ctx.state.todos);
    },
  },

  memory: {
    schema: schema(
      'memory',
      'Save or remove a long-term memory: a short fact that will be shown to you in future sessions. Use action "add" with text and scope, or "remove" with the memory id (e.g. "p3").',
      {
        action: { type: 'string', enum: ['add', 'remove'] },
        text: { type: 'string', description: 'The fact to remember, one short sentence (for add)' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: '"project" for this codebase, "global" for the user across all projects (default: project)',
        },
        id: { type: 'string', description: 'Memory id to remove (for remove)' },
      },
      ['action'],
    ),
    needsPermission: false,
    describe: (a) => (a.action === 'remove' ? `remove ${a.id}` : `${a.scope ?? 'project'}: ${a.text}`),
    async run(a, ctx) {
      if (a.action === 'remove') {
        if (!a.id) throw new Error('id is required to remove a memory');
        return (await removeMemory(ctx.cwd, String(a.id))) ? `Removed memory ${a.id}` : `No memory with id ${a.id}`;
      }
      if (a.action !== 'add') throw new Error('action must be "add" or "remove"');
      const m = await addMemory(a.scope ?? 'project', ctx.cwd, a.text);
      return m.duplicate ? `Already remembered as ${m.id}` : `Saved ${m.scope} memory ${m.id}: ${m.text}`;
    },
  },

  task: {
    schema: schema(
      'task',
      'Delegate a research task to a sub-agent that has a fresh context and read-only tools (read_file, list_dir, glob, grep, read-only shell commands). It returns a written report. Use it for broad exploration, e.g. "find where X is implemented and explain how it works", to keep your own context small. The sub-agent sees nothing of this conversation, so put every detail it needs in the prompt.',
      {
        description: { type: 'string', description: 'A 3-5 word summary of the task' },
        prompt: { type: 'string', description: 'Complete, self-contained instructions, including what to report back' },
      },
    ),
    needsPermission: false,
    describe: (a) => a.description ?? 'sub-agent',
    async run(a, ctx) {
      if (!ctx.runSubagent) throw new Error('sub-agents cannot start other sub-agents');
      if (!a.prompt) throw new Error('prompt is required');
      return ctx.runSubagent(String(a.prompt), ctx.signal);
    },
  },
};

// Tools a sub-agent gets: read-only exploration (bash is limited to read-only commands).
export const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'bash'];

export const toolSchemas = Object.values(tools).map((t) => t.schema);
