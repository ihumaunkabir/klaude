#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Ollama } from '../src/ollama.js';
import { Agent, MODES } from '../src/agent.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { formatTodos, markFileRead, runProcess, listBackground, killAllBackground, tools } from '../src/tools.js';
import {
  newSessionId,
  saveSession,
  latestSession,
  listSessions,
  describeSession,
  findSession,
  formatTranscript,
} from '../src/session.js';
import { allMemories, formatMemories, removeMemory } from '../src/memory.js';
import {
  projectAllowRules,
  addProjectAllowRule,
  readSettings,
  updateSettings,
  userSettingsFile,
  saveCredentials,
  resolveCredentials,
} from '../src/settings.js';
import { PROVIDERS, createClient } from '../src/providers.js';
import { isLocalHost, startOllama, ollamaLogFile } from '../src/server.js';
import { expandMentions, loadCustomCommands, renderCommand, makeCompleter, suggestCommand } from '../src/input.js';
import { CommandMenu } from '../src/command-menu.js';
import { c, write, visibleLength } from '../src/ui.js';

const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_MODEL = 'qwen3-coder';
const SHELL_CONTEXT_CHARS = 10000;

const HELP = `Usage: klaude [options] [prompt]

Klaude: a coding agent for the terminal, powered by local LLMs via Ollama.

Options:
  -m, --model <name>   Model to use (default: $KLAUDE_MODEL, your last choice for the provider, or a default)
      --provider <name> ollama, anthropic, openai, zai or openai-compatible (default: your /login choice, or ollama)
      --mode <mode>    manual (ask before changes), auto (only ask for dangerous commands) or plan (read-only)
  -p, --print          Run the prompt once, print the result and exit
  -c, --continue       Continue the most recent session in this directory (shows its history)
  -r, --resume [name]  Resume a session by name or number, or pick one from a list
  -y, --yes            Never ask for permission, not even for dangerous commands (use with care)
      --host <url>     Ollama host (default: $OLLAMA_HOST or http://localhost:11434)
      --start-ollama   With Ollama: start the local server without asking if it isn't running
      --ctx <tokens>   Context window size (default: $KLAUDE_CTX or min(32768, model max))
      --no-think       Turn off the model's thinking
  -v, --version        Show the version
  -h, --help           Show this help

In the REPL:
  /help  /login  /logout  /mode  /plan  /undo  /clear  /compact  /todos  /memory
  /sessions  /resume [n|name]  /rename <name>  /model  /models  /shells  /context  /exit
  @path attaches a file · !command runs a shell command · / opens the command menu · \\ continues a line
  Shift+Tab cycles modes · Ctrl+O shows thinking · Ctrl+C interrupts · Ctrl+D quits
`;

// [name, usage, description], shown by /help and used for completion.
const COMMANDS = [
  ['help', '', 'Show this help'],
  ['login', '', 'Choose the provider: Ollama, Anthropic, OpenAI, Z.AI or a custom URL'],
  ['logout', '', "Remove the current provider's saved API key and go back to Ollama"],
  ['mode', '[manual|auto|plan]', 'Show or switch the permission mode (also Shift+Tab)'],
  ['plan', '', 'Toggle plan mode: research and propose, no changes'],
  ['undo', '', "Revert the files changed by Klaude's last turn"],
  ['clear', '', 'Start a fresh conversation (the old one stays saved)'],
  ['compact', '', 'Summarize the conversation to free up context'],
  ['todos', '', "Show the agent's task list"],
  ['memory', '[forget <id>]', 'Show saved memories, or delete one'],
  ['sessions', '', 'List saved sessions for this directory'],
  ['resume', '[n|name]', 'Resume a session by number or name, or pick from a list'],
  ['rename', '<name>', 'Name this session, to resume it later with /resume <name>'],
  ['model', '[name]', 'Pick or switch the model (remembered for next time)'],
  ['models', '', 'List installed Ollama models'],
  ['shells', '[kill <id>]', 'List background shells, or stop one'],
  ['context', '', 'Show context window usage'],
  ['exit', '', 'Quit'],
];

const MODE_INFO = {
  manual: { color: c.gray, text: 'asks before edits and commands' },
  auto: { color: c.yellow, text: 'runs edits and commands without asking, except dangerous ones' },
  plan: { color: c.cyan, text: 'read-only: researches and proposes a plan, no changes' },
};

function parseCli() {
  // --resume takes an optional session name: `klaude --resume` or `klaude --resume api-work`.
  const argv = process.argv.slice(2);
  let resumeName;
  const at = argv.findIndex((a) => a === '--resume' || a === '-r');
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('-')) [resumeName] = argv.splice(at + 1, 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        model: { type: 'string', short: 'm' },
        provider: { type: 'string' },
        mode: { type: 'string' },
        host: { type: 'string' },
        print: { type: 'boolean', short: 'p' },
        continue: { type: 'boolean', short: 'c' },
        resume: { type: 'boolean', short: 'r' },
        yes: { type: 'boolean', short: 'y' },
        'start-ollama': { type: 'boolean' },
        ctx: { type: 'string' },
        'no-think': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(c.red(err.message.split('.')[0]) + '. See klaude --help.');
    process.exit(2);
  }
  const args = { ...parsed.values, resumeName, prompt: parsed.positionals.join(' ').trim() };
  if (args.provider && !PROVIDERS[args.provider]) {
    console.error(c.red(`Unknown provider "${args.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`));
    process.exit(2);
  }
  if (args.mode && !MODES.includes(args.mode)) {
    console.error(c.red(`Unknown mode "${args.mode}". Use one of: ${MODES.join(', ')}.`));
    process.exit(2);
  }
  return args;
}

async function describeModel(client, model) {
  const { capabilities, contextLength } = await client.show(model);
  return { nativeTools: capabilities.includes('tools'), thinking: capabilities.includes('thinking'), contextLength };
}

function normalizeHost(host) {
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host;
}

const providerName = (provider) => PROVIDERS[provider].label.split(' (')[0];

// Ollama runs models locally with a modest default window; vendors get their full context.
const contextFor = (provider, info) => (provider === 'ollama' ? Math.min(32768, info.contextLength || 32768) : info.contextLength);

const tildify = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

function banner({ provider, model, mode, cwd, nativeTools }) {
  const width = Math.max(30, Math.min((process.stdout.columns || 80) - 4, 76));
  const fit = (s) => (visibleLength(s) > width ? `${s.slice(0, width - 1)}…` : s);
  const rows = [
    `${c.magenta('✻')} ${c.bold('Klaude')} ${c.gray(`v${VERSION}`)}`,
    '',
    `${c.gray('model')}  ${model} ${c.gray(`· ${providerName(provider)}`)}${nativeTools ? '' : c.yellow(' (text-based tools)')}`,
    `${c.gray('mode ')}  ${MODE_INFO[mode].color(mode)} ${c.gray(`· ${MODE_INFO[mode].text}`)}`,
    `${c.gray('cwd  ')}  ${tildify(cwd)}`,
  ].map(fit);
  const line = (s) => `${c.gray('│')} ${s}${' '.repeat(Math.max(0, width - visibleLength(s)))} ${c.gray('│')}`;
  return [
    c.gray(`╭${'─'.repeat(width + 2)}╮`),
    ...rows.map(line),
    c.gray(`╰${'─'.repeat(width + 2)}╯`),
    c.gray('  Ask for anything: "fix the failing test", "add a --json flag", "explain src/app.js"'),
    c.gray('  @file attach · !cmd shell · / command menu · shift+tab mode · ctrl+o thinking · ctrl+c stop'),
    '',
  ].join('\n');
}

const promptFor = (mode) => (mode === 'manual' ? c.bold('› ') : `${MODE_INFO[mode].color(mode)} ${c.bold('› ')}`);

async function main() {
  const args = parseCli();
  if (args.help) return write(HELP);
  if (args.version) return write(`${VERSION}\n`);

  process.on('exit', killAllBackground); // don't leave background servers running

  const ollamaHost = normalizeHost(args.host || process.env.OLLAMA_HOST || 'http://localhost:11434');
  const cwd = process.cwd();
  const userSettings = await readSettings(userSettingsFile());
  const interactive = process.stdin.isTTY;
  const oneShot = Boolean(args.print || (!interactive && args.prompt));

  let customCommands = await loadCustomCommands(cwd);
  const commandNames = () => [...COMMANDS.map(([n]) => n), ...customCommands.keys()];
  const commandList = () => [
    ...COMMANDS.map(([name, , description]) => ({ name, description })),
    ...[...customCommands].map(([name, cmd]) => ({ name, description: cmd.description })),
  ];
  let menu = null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    completer: interactive ? makeCompleter(cwd, commandNames, () => (menu?.visible ? menu.items[menu.selected]?.name : null)) : undefined,
  });
  const askRaw = async (question) => (await rl.question(question)).trim();
  const ask = async (question) => (await askRaw(question)).toLowerCase();

  // Reads a line without echoing it (for API keys): terminal output is muted
  // while readline would echo the keystrokes.
  async function askSecret(question) {
    write(question);
    const stdoutWrite = process.stdout.write;
    process.stdout.write = (_chunk, ...rest) => {
      rest.find((a) => typeof a === 'function')?.();
      return true;
    };
    try {
      return (await rl.question('')).trim();
    } finally {
      process.stdout.write = stdoutWrite;
      write('\n');
    }
  }

  // Connects to Ollama, offering to start it when it runs on this machine, and
  // offers to download a model on first run. Returns the installed models, or
  // null (after explaining why) when Ollama can't be used.
  async function connectOllama(ollama) {
    let installed;
    try {
      installed = await ollama.listModels();
    } catch (err) {
      const local = isLocalHost(ollama.host);
      const start =
        local &&
        (args['start-ollama'] ||
          userSettings.autoStartOllama ||
          (interactive && ['', 'y', 'yes'].includes(await ask(c.yellow(`Ollama isn't running at ${ollama.host}. Start it now? [Y/n] `)))));
      if (!start) {
        console.error(c.red(`Cannot reach Ollama at ${ollama.host}: ${err.cause?.message || err.message}`));
        console.error(
          local
            ? 'Start it with `ollama serve`, run klaude with --start-ollama, or use /login to choose an API provider.'
            : 'Check --host / OLLAMA_HOST.',
        );
        return null;
      }
      write(c.gray('Starting Ollama…\n'));
      try {
        await startOllama(ollama);
        installed = await ollama.listModels();
        write(c.green('✓ Ollama is running') + c.gray(` (log: ${tildify(ollamaLogFile())})\n`));
      } catch (startErr) {
        console.error(c.red(`Could not start Ollama: ${startErr.message}`));
        return null;
      }
    }
    if (installed.length) return installed;

    // First run without models: offer to download one.
    if (!interactive) {
      console.error(c.red(`No Ollama models installed. Pull one first, e.g. \`ollama pull ${DEFAULT_MODEL}\`.`));
      return null;
    }
    const answer = await ask(c.yellow(`No models installed yet. Download one? Model name [${DEFAULT_MODEL}], or "n" to skip: `));
    if (answer === 'n' || answer === 'no') return null;
    const name = answer || DEFAULT_MODEL;
    try {
      for await (const p of ollama.pull(name)) {
        const pct = p.total ? ` ${Math.floor(((p.completed ?? 0) / p.total) * 100)}%` : '';
        write(`\r\x1b[2K${c.gray(`⬇ ${name}: ${p.status}${pct}`)}`);
      }
      write(`\r\x1b[2K${c.green(`✓ Downloaded ${name}`)}\n`);
    } catch (err) {
      console.error(c.red(`\nDownload failed: ${err.message}`));
      return null;
    }
    return ollama.listModels();
  }

  const savedModel = (provider) => userSettings.models?.[provider] ?? (provider === 'ollama' ? userSettings.model : undefined);

  // Asks which model to use from `models`, defaulting to `fallback`.
  async function pickModel(models, fallback) {
    if (!models.length) return (await askRaw(c.yellow(`Model [${fallback}]: `))) || fallback;
    const shown = models.slice(0, 40);
    shown.forEach((m, i) => write(`${c.bold(String(i + 1).padStart(3))}. ${m}${m === fallback ? c.green(' ●') : ''}\n`));
    if (models.length > shown.length) write(c.gray(`  … ${models.length - shown.length} more; type a name to use one of them\n`));
    const answer = await askRaw(c.yellow(`Model [1-${shown.length} or a name, Enter for ${fallback}]: `));
    return shown[Number(answer) - 1] ?? (answer && !/^\d+$/.test(answer) ? answer : fallback);
  }

  // /login: choose a provider, enter its key, pick a model. The choice goes to
  // ~/.klaude/settings.json and the key to ~/.klaude/credentials.json, and they
  // stay until changed. Returns { provider, client, model }, or null if cancelled.
  async function login(current) {
    const names = Object.keys(PROVIDERS);
    write(c.bold('Choose a provider\n'));
    names.forEach((n, i) => write(`${c.bold(String(i + 1).padStart(3))}. ${PROVIDERS[n].label}${n === current ? c.green(' ●') : ''}\n`));
    const answer = await ask(c.yellow(`Provider [1-${names.length}${current ? `, Enter to keep ${providerName(current)}` : ''}]: `));
    const provider = names[Number(answer) - 1] ?? (answer ? null : current);
    if (!provider) {
      write(c.red('No provider chosen.\n'));
      return null;
    }
    const info = PROVIDERS[provider];

    if (provider === 'ollama') {
      const ollama = new Ollama(ollamaHost);
      const installed = await connectOllama(ollama);
      if (!installed) return null;
      const model = await pickModel(installed, installed.includes(savedModel('ollama')) ? savedModel('ollama') : installed[0]);
      await updateSettings(userSettingsFile(), (s) => {
        s.provider = 'ollama';
        s.models = { ...s.models, ollama: model };
      });
      return { provider, client: ollama, model };
    }

    const saved = await resolveCredentials(provider, info.env);
    let baseUrl;
    if (info.customUrl) {
      baseUrl = (await askRaw(c.yellow(`Base URL${saved.baseUrl ? ` [${saved.baseUrl}]` : ' (e.g. https://openrouter.ai/api/v1)'}: `))) || saved.baseUrl;
      if (!baseUrl) {
        write(c.red('A base URL is required.\n'));
        return null;
      }
    }
    const keyHint = saved.apiKey ? `, Enter to keep …${saved.apiKey.slice(-4)}` : info.customUrl ? ', Enter if none' : '';
    const typed = await askSecret(c.yellow(`API key for ${providerName(provider)} (hidden${keyHint}): `));
    const apiKey = typed || saved.apiKey;
    if (!apiKey && !info.customUrl) {
      write(c.red(`An API key is required. Get one from your ${providerName(provider)} account.\n`));
      return null;
    }

    const client = createClient(provider, { apiKey, baseUrl });
    write(c.gray('Checking the key…\n'));
    let models;
    try {
      models = await client.listModels();
      write(c.green(`✓ Connected to ${providerName(provider)}\n`));
    } catch (err) {
      write(c.red(`Could not connect: ${err.message}\n`));
      return null;
    }
    const model = await pickModel(models, savedModel(provider) || info.defaultModel || models[0]);
    // Keys that come from an environment variable stay there, not on disk.
    const fromEnv = !typed && info.env && process.env[info.env] === apiKey;
    await saveCredentials(provider, { ...(fromEnv ? {} : { apiKey }), ...(baseUrl ? { baseUrl } : {}) });
    await updateSettings(userSettingsFile(), (s) => {
      s.provider = provider;
      s.models = { ...s.models, [provider]: model };
    });
    return { provider, client, model };
  }

  // Startup: the selected provider decides everything else. Only Ollama needs
  // a running server (offered to start) and installed models.
  let provider = args.provider || process.env.KLAUDE_PROVIDER || (PROVIDERS[userSettings.provider] ? userSettings.provider : 'ollama');
  let client;
  let model;
  if (provider === 'ollama') {
    client = new Ollama(ollamaHost);
    const installed = await connectOllama(client);
    if (!installed) process.exit(1);
    const remembered = installed.includes(savedModel('ollama')) ? savedModel('ollama') : null;
    model = args.model || process.env.KLAUDE_MODEL || remembered || installed[0];
  } else {
    try {
      client = createClient(provider, await resolveCredentials(provider, PROVIDERS[provider].env));
      model = args.model || process.env.KLAUDE_MODEL || savedModel(provider) || PROVIDERS[provider].defaultModel;
    } catch (err) {
      if (!interactive) {
        console.error(c.red(err.message));
        process.exit(1);
      }
      write(c.yellow(`${err.message.replace(/; run \/login.*$/, '')}. Let's set it up.\n`));
      const chosen = await login(provider);
      if (!chosen) process.exit(1);
      ({ provider, client, model } = chosen);
    }
  }

  let info;
  try {
    info = await describeModel(client, model);
  } catch {
    console.error(c.red(`Model "${model}" not found. Run /models or /login to pick another.`));
    process.exit(1);
  }
  const thinkFor = (i) => (args['no-think'] && i.thinking ? false : undefined);

  let controller = null;

  async function askPermission(name, toolArgs, rule) {
    if (!interactive) {
      write(c.yellow('  (non-interactive: denied; use --mode auto or --yes to allow)\n'));
      return 'no';
    }
    const what =
      name === 'bash' ? 'Run this command' : name === 'web_fetch' ? 'Fetch this URL' : `Allow ${name} on ${toolArgs.path}`;
    const scope = rule?.startsWith('bash(') ? `"${rule.slice(5, -1)}" commands` : `${name}`;
    const always = rule ? ` / [a]lways allow ${scope} in this project` : '';
    const answer = await rl.question(c.yellow(`  ${what}? `) + c.gray(`[y]es / [n]o${always}: `), {
      signal: controller?.signal,
    });
    const a = answer.trim().toLowerCase();
    if ((a === 'a' || a === 'always') && always) return 'always';
    if (a === 'y' || a === 'yes' || a === '') return 'yes';
    return 'no';
  }

  const startMode = args.yes ? 'auto' : args.mode || (MODES.includes(userSettings.mode) ? userSettings.mode : 'manual');
  const agent = new Agent({
    client,
    model,
    cwd,
    systemPrompt: await buildSystemPrompt(cwd),
    options: { num_ctx: Number(args.ctx || process.env.KLAUDE_CTX) || contextFor(provider, info) },
    think: thinkFor(info),
    nativeTools: info.nativeTools,
    autoApprove: Boolean(args.yes),
    askPermission,
    mode: startMode,
    allowRules: await projectAllowRules(cwd),
    onAllowRule: async (rule) => {
      await addProjectAllowRule(cwd, rule);
      write(c.gray(`  ✓ Saved "${rule}" to .klaude/settings.json; Klaude won't ask again in this project\n`));
    },
  });

  // The live /command menu, drawn under the input line while typing a command.
  menu = new CommandMenu(rl, commandList, () => promptFor(agent.mode));
  if (interactive) menu.enable();

  let sessionId = newSessionId();
  let sessionName;

  // Rebuilds the system prompt so it includes memories saved since startup.
  const refreshPrompt = async () => agent.setBasePrompt(await buildSystemPrompt(cwd));

  // Loads a saved session into the agent and shows the conversation so far.
  async function resumeSession(saved) {
    sessionId = saved.id;
    sessionName = saved.name;
    agent.restore(saved);
    await refreshPrompt();
    if (!oneShot) write(`${formatTranscript(saved.messages)}\n`);
    write(c.gray(`Resumed ${saved.name ? `"${saved.name}"` : 'session'} from ${new Date(saved.updatedAt).toLocaleString()}\n`));
  }

  // Shows the sessions for this directory and asks which one to resume.
  async function pickSession(sessions) {
    printSessions(sessions);
    const answer = await askRaw(c.yellow(`Resume which session? [number or name, Enter for a new one]: `));
    const picked = findSession(sessions, answer);
    if (picked) await resumeSession(picked);
    else write(c.gray(answer ? `No session "${answer}"; starting a new one.\n` : 'Starting a new session.\n'));
  }

  const saveCurrentSession = () =>
    saveSession(sessionId, { cwd, name: sessionName, ...agent.snapshot() }).catch((err) =>
      write(c.red(`Could not save session: ${err.message}\n`)),
    );

  function printSessions(sessions) {
    sessions.slice(0, 20).forEach((s, i) => {
      const current = s.id === sessionId ? c.green(' ●') : '';
      write(`${c.bold(String(i + 1).padStart(3))}. ${describeSession(s)}${current}\n`);
    });
    if (sessions.length > 20) write(c.gray(`  … ${sessions.length - 20} older sessions\n`));
  }

  function setMode(mode) {
    agent.mode = mode;
    write(`\n${MODE_INFO[mode].color(`⏵ ${mode} mode`)} ${c.gray(`· ${MODE_INFO[mode].text}`)}\n`);
    rl.setPrompt(promptFor(mode));
  }

  // Switches the running session to another provider/model.
  async function useProvider(chosen) {
    let next;
    try {
      next = await describeModel(chosen.client, chosen.model);
    } catch (err) {
      write(c.red(`Model "${chosen.model}" is not available: ${err.message}\n`));
      return;
    }
    ({ provider, client } = chosen);
    agent.client = client;
    agent.setModel(chosen.model, next);
    agent.think = thinkFor(next);
    if (!args.ctx && !process.env.KLAUDE_CTX) agent.options.num_ctx = contextFor(provider, next);
    write(c.green(`✓ Using ${providerName(provider)} · ${chosen.model}`) + c.gray(' (saved to ~/.klaude/settings.json)\n'));
  }

  let closed = false;
  async function runAgentTask(task) {
    controller = new AbortController();
    try {
      await task(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        write(c.yellow('\n⎿ Interrupted\n'));
      } else {
        write(c.red(`\nError: ${err.cause?.message || err.message}\n`));
      }
    } finally {
      controller = null;
      if (agent.messages.length > 1) await saveCurrentSession();
      if (closed) process.exit(0);
    }
  }

  // Output of !commands, attached to the next message so the agent sees it.
  const shellContext = [];

  async function send(input) {
    const { text, attached } = await expandMentions(input, cwd);
    for (const a of attached) {
      if (a.kind === 'too-large') {
        write(c.yellow(`  ⎿ Not attached: ${a.rel} is too large (${Math.round(a.size / 1024)} KB); Klaude can read it with read_file\n`));
        continue;
      }
      if (a.kind === 'file') await markFileRead(agent.state, a.file);
      write(c.gray(`  ⎿ Attached ${a.rel} (${a.size} ${a.kind === 'file' ? 'lines' : 'entries'})\n`));
    }
    let message = text;
    if (shellContext.length) {
      message = `Output of shell commands I ran:\n${shellContext.join('\n\n')}\n\n${text}`;
      shellContext.length = 0;
    }
    await runAgentTask((signal) => agent.run(message, signal));
  }

  async function runShell(command) {
    controller = new AbortController();
    try {
      const { code, out } = await runProcess('bash', ['-c', command], { cwd, signal: controller.signal });
      if (out.trim()) write(`${out.trimEnd()}\n`);
      write(c.gray(`[exit code: ${code}] · output will be shared with Klaude in your next message\n`));
      const trimmed = out.length > SHELL_CONTEXT_CHARS ? `${out.slice(0, SHELL_CONTEXT_CHARS)}\n… [truncated]` : out;
      shellContext.push(`$ ${command}\n${trimmed.trimEnd()}\n[exit code: ${code}]`);
    } finally {
      controller = null;
    }
  }

  // Ctrl+O toggles verbose thinking (at the prompt it also shows the last block);
  // Shift+Tab cycles manual → auto → plan.
  process.stdin.on('keypress', (_, key) => {
    if (key?.name === 'tab' && key.shift) {
      setMode(MODES[(MODES.indexOf(agent.mode) + 1) % MODES.length]);
      if (!controller) rl.prompt(true);
      return;
    }
    if (!key?.ctrl || key.name !== 'o') return;
    const view = agent.thinking;
    view.setVerbose(!view.verbose);
    if (controller) return; // mid-turn: the view handles its own output
    if (view.verbose && view.text) write(`\n${c.gray(`✻ Last thinking:\n${view.text.trim()}`)}\n`);
    write(c.gray(`\n(thinking ${view.verbose ? 'shown' : 'collapsed'} · ctrl+o to toggle)\n`));
    rl.prompt(true);
  });

  // Ctrl+C: interrupt a running turn, or quit when pressed twice while idle.
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    if (controller) return controller.abort();
    if (Date.now() - lastSigint < 1500) process.exit(0);
    lastSigint = Date.now();
    write(c.gray('\n(press Ctrl+C again to exit)\n'));
    menu?.close();
    rl.write(null, { ctrl: true, name: 'u' });
    rl.prompt();
  });
  // Ctrl+D / end of input: quit, after interrupting and saving a running turn.
  rl.on('close', () => {
    closed = true;
    if (controller) controller.abort();
    else if (!oneShot) process.exit(0);
  });

  if (!oneShot) {
    write(banner({ provider, model, mode: agent.mode, cwd, nativeTools: info.nativeTools }));
    if (args.yes) write(c.yellow('  --yes: Klaude will not ask before any change, including dangerous commands.\n'));
  }

  if (args.continue) {
    const saved = await latestSession(cwd);
    if (saved) await resumeSession(saved);
    else write(c.gray('No previous session in this directory; starting a new one.\n'));
  } else if (args.resume) {
    const sessions = await listSessions(cwd);
    if (args.resumeName) {
      const picked = findSession(sessions, args.resumeName);
      if (!picked) {
        console.error(c.red(`No session "${args.resumeName}" in this directory.`) + ' Run `klaude --resume` to see them.');
        process.exit(2);
      }
      await resumeSession(picked);
    } else if (!sessions.length) {
      write(c.gray('No previous sessions in this directory; starting a new one.\n'));
    } else if (!interactive) {
      console.error('--resume without a name needs an interactive terminal; use --continue or --resume <name>.');
      process.exit(2);
    } else {
      await pickSession(sessions);
    }
  }

  if (oneShot) {
    if (!args.prompt) {
      console.error('Provide a prompt, e.g. klaude -p "explain this repo"');
      process.exit(1);
    }
    await send(args.prompt);
    process.exit(0);
  }


  if (args.prompt) await send(args.prompt);

  const showHelp = () => {
    const pad = Math.max(...COMMANDS.map(([n, u]) => n.length + u.length)) + 3;
    write(`${c.bold('Commands')}\n`);
    for (const [name, usage, desc] of COMMANDS) {
      write(`  ${`/${name}${usage ? ` ${usage}` : ''}`.padEnd(pad + 1)} ${c.gray(desc)}\n`);
    }
    if (customCommands.size) {
      write(`${c.bold('Custom commands')}\n`);
      for (const [name, cmd] of customCommands) write(`  ${`/${name}`.padEnd(pad + 1)} ${c.gray(`${cmd.description} (${cmd.source})`)}\n`);
    }
    write(`${c.bold('Input')}
  @path            Attach a file or folder (Tab completes paths)
  !command         Run a shell command yourself; its output goes with your next message
  \\ at line end    Continue on the next line
${c.bold('Keys')}
  /                Command menu: it filters as you type; ↑↓ scroll, Tab completes, Esc hides
  Shift+Tab        Cycle mode: manual → auto → plan
  Ctrl+O           Show/hide the model's thinking
  Ctrl+C           Interrupt the agent (twice when idle to quit)
  Ctrl+D           Quit
${c.bold('Modes')}
${MODES.map((m) => `  ${MODE_INFO[m].color(m.padEnd(16))} ${c.gray(MODE_INFO[m].text)}`).join('\n')}
`);
  };

  while (true) {
    let input = '';
    menu?.arm();
    let line = await rl.question(`\n${promptFor(agent.mode)}`);
    menu?.disarm();
    while (line.endsWith('\\')) {
      input += line.slice(0, -1) + '\n';
      line = await rl.question(c.gray('. '));
    }
    input = (input + line).trim();
    if (!input) continue;

    if (input.startsWith('!')) {
      if (input.slice(1).trim()) await runShell(input.slice(1).trim());
      continue;
    }

    if (!input.startsWith('/')) {
      await send(input);
      continue;
    }

    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help':
        customCommands = await loadCustomCommands(cwd);
        showHelp();
        break;
      case 'login': {
        const chosen = await login(provider);
        if (chosen) await useProvider(chosen);
        break;
      }
      case 'logout': {
        if (provider === 'ollama') {
          write(c.gray('Ollama needs no login. Use /login to choose an API provider.\n'));
          break;
        }
        await saveCredentials(provider, null);
        await updateSettings(userSettingsFile(), (s) => (s.provider = 'ollama'));
        write(c.gray(`Removed the saved ${providerName(provider)} key.\n`));
        if (PROVIDERS[provider].env && process.env[PROVIDERS[provider].env]) {
          write(c.yellow(`${PROVIDERS[provider].env} is still set in your environment.\n`));
        }
        const ollama = new Ollama(ollamaHost);
        const installed = await connectOllama(ollama);
        if (installed) {
          const name = installed.includes(savedModel('ollama')) ? savedModel('ollama') : installed[0];
          await useProvider({ provider: 'ollama', client: ollama, model: name });
        } else {
          write(c.gray('Klaude will use Ollama next time it starts; /login to choose another provider.\n'));
        }
        break;
      }
      case 'mode':
        if (!arg) write(`${MODE_INFO[agent.mode].color(agent.mode)} ${c.gray(`· ${MODE_INFO[agent.mode].text} (modes: ${MODES.join(', ')})`)}\n`);
        else if (MODES.includes(arg)) setMode(arg);
        else write(c.red(`Unknown mode "${arg}". Use one of: ${MODES.join(', ')}.\n`));
        break;
      case 'plan':
        setMode(agent.mode === 'plan' ? 'manual' : 'plan');
        break;
      case 'undo': {
        const files = await agent.undo();
        if (!files) write(c.gray('Nothing to undo. (Changes made by shell commands cannot be undone.)\n'));
        else write(c.green(`✓ Restored ${files.join(', ')}\n`));
        break;
      }
      case 'clear':
        await refreshPrompt();
        agent.reset();
        sessionId = newSessionId(); // keep the previous conversation's saved file intact
        sessionName = undefined;
        write(c.gray('Conversation cleared.\n'));
        break;
      case 'sessions': {
        const sessions = await listSessions(cwd);
        if (sessions.length) printSessions(sessions);
        else write(c.gray('No saved sessions in this directory yet.\n'));
        break;
      }
      case 'resume': {
        const sessions = await listSessions(cwd);
        if (!sessions.length) write(c.gray('No saved sessions in this directory yet.\n'));
        else if (!arg) await pickSession(sessions);
        else {
          const picked = findSession(sessions, arg);
          if (picked) await resumeSession(picked);
          else write(c.red(`No session "${arg}".`) + c.gray(' See /sessions.\n'));
        }
        break;
      }
      case 'rename':
        if (!arg) {
          write(c.red('Usage: /rename <name>\n'));
          break;
        }
        sessionName = arg;
        if (agent.messages.length > 1) await saveCurrentSession();
        write(c.gray(`Session named "${arg}". Resume it later with /resume ${arg} or klaude --resume ${arg}.\n`));
        break;
      case 'memory': {
        const [action, id] = rest;
        if (action === 'forget' && id) {
          if (await removeMemory(cwd, id)) {
            await refreshPrompt();
            write(c.gray(`Forgot memory ${id}.\n`));
          } else {
            write(c.red(`No memory with id ${id}.\n`));
          }
        } else if (action) {
          write(c.red('Usage: /memory, or /memory forget <id>\n'));
        } else {
          write((formatMemories(await allMemories(cwd)) || c.gray('No memories saved yet. Ask Klaude to remember something.')) + '\n');
        }
        break;
      }
      case 'model': {
        let name = arg;
        if (!name) {
          const models = await client.listModels().catch(() => []);
          models.forEach((m, i) => write(`${c.bold(String(i + 1).padStart(3))}. ${m}${m === agent.model ? c.green(' ●') : ''}\n`));
          const answer = await ask(c.yellow(`Switch to which model? [1-${models.length}, Enter to keep ${agent.model}]: `));
          name = models[Number(answer) - 1] ?? '';
        }
        if (name) {
          try {
            const next = await describeModel(client, name);
            agent.setModel(name, next);
            agent.think = thinkFor(next);
            await updateSettings(userSettingsFile(), (s) => (s.models = { ...s.models, [provider]: name }));
            if (!next.nativeTools) write(c.yellow('No native tool calling; using text-based tool calls.\n'));
          } catch {
            write(c.red(`Model "${name}" not found. See /models.\n`));
          }
        }
        write(c.gray(`Model: ${agent.model}\n`));
        break;
      }
      case 'compact':
        if (agent.messages.length > 2) await runAgentTask((signal) => agent.compact(signal));
        else write(c.gray('Nothing to compact.\n'));
        break;
      case 'todos':
        write(formatTodos(agent.state.todos) + '\n');
        break;
      case 'models':
        try {
          for (const m of await client.listModels()) write(`${m === agent.model ? c.green('● ') : '  '}${m}\n`);
        } catch (err) {
          write(c.red(`Error: ${err.message}\n`));
        }
        break;
      case 'shells':
        if (rest[0] === 'kill' && rest[1]) {
          write(c.gray(`${await tools.kill_shell.run({ id: rest[1] }).catch((err) => err.message)}\n`));
        } else {
          const shells = listBackground();
          if (!shells.length) write(c.gray('No background shells.\n'));
          for (const s of shells) write(`  ${c.bold(s.id)} ${c.gray(s.status)}  ${s.command}\n`);
        }
        break;
      case 'context':
        write(c.gray(`~${agent.contextTokens} / ${agent.options.num_ctx} tokens, ${agent.messages.length} messages\n`));
        break;
      case 'exit':
      case 'quit':
        process.exit(0);
      default: {
        customCommands = await loadCustomCommands(cwd);
        const custom = customCommands.get(cmd);
        if (custom) {
          await send(renderCommand(custom.template, arg));
          break;
        }
        const guess = suggestCommand(cmd, commandNames());
        write(c.red(`Unknown command /${cmd}.`) + c.gray(guess ? ` Did you mean /${guess}?` : ' Type /help.') + '\n');
      }
    }
  }
}

main().catch((err) => {
  console.error(c.red(err.stack || String(err)));
  process.exit(1);
});
