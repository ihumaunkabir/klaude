import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess, listFiles } from './tools.js';
import { klaudeHome } from './paths.js';
import { allMemories, formatMemories } from './memory.js';

// Project instruction files, in order of preference; the first one found is used.
const PROJECT_INSTRUCTION_FILES = ['KLAUDE.md', 'AGENTS.md'];

const BASE_PROMPT = `You are Klaude, an expert software engineer working as a coding agent in the user's terminal.
You complete software tasks end to end: understand the code, make the change, and prove that it works.

# Workflow
1. Understand: find the relevant code before changing anything (glob, grep, read_file). Read enough of it to know the conventions, how it is used, and how it is tested. For broad questions about a large codebase, delegate to a sub-agent with task; for several independent questions, call task several times in one reply so they run in parallel.
2. Plan: for anything beyond a small change, write a plan with todo_write first. Keep exactly one item in_progress and mark items completed as soon as they are done.
3. Implement: make small, focused changes that match the existing style, naming and structure. Use edit_file for one change, multi_edit for several changes to one file, and write_file only for new files or complete rewrites. Don't add features, abstractions or refactors that weren't asked for.
4. Verify: run the project's tests, type checker, linter or build (see Project commands), or run the program. When fixing a bug, reproduce it first if practical and confirm it's gone. If verification fails, find and fix the cause, then run it again.
5. Review: before finishing, look over your changes (e.g. git diff) for mistakes, leftover debug code and unintended edits.
6. Report: say briefly what you changed, how you verified it, and anything left undone or uncertain. Never claim something works without having checked it.

# Engineering rules
- Never guess file contents or APIs: read the code, or check the installed version's source or docs. Edits to files you haven't read, or that changed since you read them, are rejected.
- Fix root causes, not symptoms. Don't silence errors, skip tests or weaken assertions to make things pass.
- Write secure code: no hard-coded secrets, validate untrusted input, avoid shell and SQL injection.
- Respect the user's machine: no destructive commands (deleting data, force-pushing, rewriting history) unless asked, and don't commit or push unless asked.
- Long-running processes (dev servers, watchers): use bash with run_in_background, then bash_output and kill_shell. Avoid interactive commands.
- If a tool call fails, change your approach; never repeat the exact same call.
- If the request is ambiguous, or a decision has real trade-offs, ask one short question instead of guessing. Otherwise keep going until the task is done.

# Memory
- Use the memory tool to save durable facts that will help in future sessions: the user's preferences, project conventions, how to build/test/run, recurring gotchas. Save right away when the user asks you to remember something.
- Use scope "global" for facts about the user that apply everywhere, "project" for facts about this codebase.
- Don't save temporary task details, things already in the code or instruction files, or secrets.
- If a saved memory turns out to be wrong or outdated, remove it (and add a corrected one).

# Communication
- Be concise and direct. Output is shown in a terminal; use short Markdown where helpful.
- Don't narrate every step. Reference code locations as path:line.`;

const SUBAGENT_PROMPT = `You are a research sub-agent working for Klaude, a coding agent. You have a fresh context and read-only tools.
Investigate the codebase to complete the task you are given, then reply with a concise, factual report: what you found, with file paths and line numbers, and anything relevant you could not determine.
You cannot modify files or ask questions. Stay focused on the task, and don't stop before you have an answer.`;

// Tool instructions for models without native tool calling.
export function textToolsPrompt(schemas) {
  const docs = schemas
    .map(({ function: f }) => `## ${f.name}\n${f.description}\nParameters (JSON Schema): ${JSON.stringify(f.parameters)}`)
    .join('\n\n');
  return `# Tools
You can call tools. To call one, output a block in exactly this format (valid JSON, strings escaped), then stop and wait:

\`\`\`tool
{"name": "read_file", "arguments": {"path": "src/index.js"}}
\`\`\`

You may output several tool blocks in one reply. Results come back in <tool_result> blocks in the next message.
When the task is done, reply normally without any tool block.

${docs}`;
}

export const COMPACT_PROMPT = `The conversation is about to exceed the context window. Write a summary that lets you continue the work in a fresh context. Include:
- The user's requests and goals, in their own words where it matters
- Key decisions and constraints
- Files read or changed (paths) and the important details in them
- Commands run and their outcomes, including errors
- Current state of the task and the exact next steps
Be concise but complete. Reply with only the summary.`;

// Detects how to build, test and lint the project, so the agent doesn't have to guess.
async function projectCommands(cwd) {
  const exists = async (f) => (await readIfExists(path.join(cwd, f))) !== null;
  const lines = [];

  const pkg = await readIfExists(path.join(cwd, 'package.json'));
  if (pkg) {
    let scripts = {};
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      // Invalid package.json; skip scripts.
    }
    const pm = (await exists('pnpm-lock.yaml')) ? 'pnpm' : (await exists('yarn.lock')) ? 'yarn' : (await exists('bun.lockb')) ? 'bun' : 'npm';
    const run = (name) => (pm === 'npm' && !['test', 'start'].includes(name) ? `npm run ${name}` : `${pm} ${name}`);
    const names = Object.keys(scripts).filter((n) => /^(test|build|lint|typecheck|type-check|check|format|dev|start)(:|$)/.test(n));
    lines.push(`- Node.js project, package manager: ${pm}`);
    for (const name of names.slice(0, 12)) lines.push(`- ${name}: ${run(name)}`);
  }
  const makefile = await readIfExists(path.join(cwd, 'Makefile'));
  if (makefile) {
    const targets = [...makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map((m) => m[1]);
    if (targets.length) lines.push(`- make targets: ${[...new Set(targets)].slice(0, 15).join(', ')}`);
  }
  if ((await exists('pyproject.toml')) || (await exists('setup.py')) || (await exists('requirements.txt'))) {
    const pyproject = (await readIfExists(path.join(cwd, 'pyproject.toml'))) ?? '';
    const tool = (await exists('uv.lock')) ? 'uv run ' : (await exists('poetry.lock')) ? 'poetry run ' : '';
    lines.push(`- Python project${pyproject.includes('pytest') || (await exists('tests')) ? `; tests: ${tool}pytest` : ''}${pyproject.includes('ruff') ? `; lint: ${tool}ruff check .` : ''}`);
  }
  if (await exists('Cargo.toml')) lines.push('- Rust project: cargo build, cargo test, cargo clippy');
  if (await exists('go.mod')) lines.push('- Go project: go build ./..., go test ./..., go vet ./...');
  return lines.length ? lines.join('\n') : null;
}

// A compact overview of the project's files (directories with counts when it's large).
async function repoMap(cwd) {
  const files = await listFiles(cwd, undefined, 5000);
  if (!files.length) return null;
  if (files.length <= 60) return files.sort().join('\n');
  const counts = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : parts[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (k.endsWith('/') ? `${k} (${n} files)` : k));
  const more = lines.length > 80 ? `\n… (${lines.length - 80} more)` : '';
  return `${files.length >= 5000 ? '5000+' : files.length} files:\n${lines.slice(0, 80).join('\n')}${more}`;
}

async function readIfExists(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function gitContext(cwd) {
  const git = async (...args) => {
    const { code, out } = await runProcess('git', args, { cwd, timeout: 5000 });
    return code === 0 ? out.trimEnd() : null;
  };
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === null) return '- Git repository: no';
  const status = (await git('status', '--short')) ?? '';
  const statusLines = status.split('\n').filter(Boolean);
  const log = await git('log', '--oneline', '-5');
  return [
    `- Git repository: yes, branch ${branch}`,
    `- Git status: ${statusLines.length ? `\n${statusLines.slice(0, 20).join('\n')}${statusLines.length > 20 ? `\n… (${statusLines.length - 20} more)` : ''}` : 'clean'}`,
    log ? `- Recent commits:\n${log}` : '- Recent commits: none',
  ].join('\n');
}

export async function buildSystemPrompt(cwd, { subagent = false } = {}) {
  const env = [
    `# Environment`,
    `- Working directory: ${cwd}`,
    `- Platform: ${os.platform()} (${os.release()})`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    await gitContext(cwd),
  ].join('\n');

  let prompt = `${subagent ? SUBAGENT_PROMPT : BASE_PROMPT}\n\n${env}`;
  const commands = await projectCommands(cwd);
  if (commands) prompt += `\n\n# Project commands (detected)\n${commands}`;
  const map = await repoMap(cwd);
  if (map) prompt += `\n\n# Project files\n${map}`;
  const global = await readIfExists(path.join(klaudeHome(), 'KLAUDE.md'));
  if (global) prompt += `\n\n# User instructions (from ~/.klaude/KLAUDE.md)\n${global}`;
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const text = await readIfExists(path.join(cwd, name));
    if (text) {
      prompt += `\n\n# Project instructions (from ${name})\n${text}`;
      break;
    }
  }
  const memories = formatMemories(await allMemories(cwd));
  if (memories) prompt += `\n\n# Saved memories (from earlier sessions)\n${memories}`;
  return prompt;
}
