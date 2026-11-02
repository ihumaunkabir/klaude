<div align="center">

# ✻ Klaude

**Klaude is a coding agent for the terminal. Run it on local LLMs via [Ollama](https://ollama.com), or bring an API key for Anthropic, OpenAI, Z.AI or any OpenAI-compatible service.**

[![CI](https://github.com/ihumaunkabir/klaude/actions/workflows/ci.yml/badge.svg)](https://github.com/ihumaunkabir/klaude/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/klaude-cli?color=cb3837&logo=npm)](https://www.npmjs.com/package/klaude-cli)
[![npm downloads](https://img.shields.io/npm/dm/klaude-cli?color=cb3837&logo=npm)](https://www.npmjs.com/package/klaude-cli)
[![Node.js](https://img.shields.io/node/v/klaude-cli?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Local by default: with Ollama, your code never leaves your machine. No telemetry.

[Install](#install) · [Quick start](#quick-start) · [Features](#features) · [Usage](#usage) · [Providers](#providers) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

</div>

---

```text
$ klaude
╭──────────────────────────────────────────────────────────╮
│ ✻ Klaude v0.1.1                                          │
│                                                          │
│ model  qwen3-coder · Ollama                              │
│ mode   manual · asks before edits and commands           │
│ cwd    ~/code/calc                                       │
╰──────────────────────────────────────────────────────────╯

› @calc.py add() has a bug, fix it and verify
  ⎿ Attached calc.py (3 lines)

⏺ edit_file(calc.py)
  │ -     return a - b
  │ +     return a + b
  Allow edit_file on calc.py?
  [y]es / [n]o / [a]lways allow edit_file in this project: a
  ✓ Saved "edit_file" to .klaude/settings.json; Klaude won't ask again in this project
  ⎿ Edited calc.py at line 2 (1 replacement)

⏺ bash(python3 -c 'from calc import add; print(add(2, 3))')
  ⎿ 5
    [exit code: 0]

Fixed: add() subtracted instead of adding. Verified: add(2, 3) returns 5.
✻ 19.1s · 2481 in · 96 out
```

Broad research fans out to read-only sub-agents that run **in parallel**, keeping the main context small:

```text
› before migrating to passkeys, map how auth works today

⏺ task(map the login flow)
  ⎿ [map the login flow] POST /login → auth.js:41 issues a signed session
    cookie, verified by requireAuth (middleware.js:18)…
⏺ task(list every auth check)
  ⎿ [list every auth check] 7 call sites: 5 via requireAuth, 2 inline checks
    in admin.js — full list with line numbers below…
⏺ task(find the auth tests)
  ⎿ [find the auth tests] test/auth.test.js (14 tests) covers login and
    expiry; middleware untested…

Here's the full picture, the risks, and a step-by-step passkey migration plan.
✻ 38.4s · 5127 in · 340 out
```

## Features

- **Works like a senior engineer.** Klaude follows a disciplined workflow: understand the code, plan, make small focused changes, verify them with the project's own tests, linter or build, review its diff, and report honestly.
  - It detects how your project builds, tests and lints (npm/pnpm/yarn/bun scripts, Makefile, Python, Cargo, Go).
  - It starts each session with a compact map of your files.
- **Three modes**, switched with <kbd>Shift</kbd>+<kbd>Tab</kbd>:
  - **manual** asks before edits and commands.
  - **auto** runs edits and commands without asking, except dangerous ones such as `rm -rf`, `sudo`, `git push` or `git reset --hard`.
  - **plan** is read-only: Klaude researches and proposes a step-by-step plan, and changes are blocked until you switch back.
- **Remembers your answers.** "Always allow" saves the rule to the project's `.klaude/settings.json`, so you're never asked twice.
- **Sub-agents and fan-out.** Klaude hands broad research to read-only sub-agents with fresh contexts, which keeps the main context small. Several sub-agents run **in parallel**.
- **Undo.** `/undo` restores every file Klaude changed in its last turn, including deleting files it created.
- **Built for real projects.**
  - `multi_edit` makes several changes to one file in a single call; it applies all of them or none.
  - Background shells let it run dev servers and watchers, read their output, and stop them.
  - It can fetch documentation from the web.
- **Easy to drive.**
  - `@file` attaches a file or folder to your message.
  - `!command` runs a shell command yourself; its output goes with your next message.
  - <kbd>Tab</kbd> completes commands and paths.
  - Custom slash commands are prompt templates in `.klaude/commands/*.md`.
- **Any model.**
  - **Ollama (local):** Klaude starts the server for you if it isn't running and offers to download a model on first run. Models without native tool calling get a text-based tool protocol that Klaude parses.
  - **API providers:** `/login` connects Anthropic, OpenAI, Z.AI or an OpenAI-compatible endpoint. Anthropic requests use prompt caching to cut cost.
- **Safe by default.**
  - Read-only commands run without asking.
  - Klaude won't edit a file it hasn't read, or one that changed since it read it.
  - Repeated identical tool calls are refused, so it can't loop forever.
  - Background servers are stopped when Klaude exits.
- **Remembers what matters.** Ask it to remember something ("I prefer pnpm", "tests need Docker") and every future session knows it. Memories can apply to all your projects or to just one.
- **Sessions with history.** Every turn is saved. `klaude -c` continues the latest session and shows the conversation so far. `/rename` names a session, and `klaude --resume <name>` brings it back.
- **Thinking stays out of the way.** The model's reasoning collapses to one line; <kbd>Ctrl</kbd>+<kbd>O</kbd> shows it.
- **Zero dependencies.** Plain Node.js, with nothing to audit beyond the source.

## Install

You need **[Node.js](https://nodejs.org) 22+**. For local models, also install **[Ollama](https://ollama.com)**. Klaude starts it for you and offers to download a model on first run.

| Method | Command |
| --- | --- |
| **npm** | `npm install -g klaude-cli` |
| **Homebrew** | `brew tap ihumaunkabir/klaude https://github.com/ihumaunkabir/klaude && brew install klaude` |
| **curl** | `curl -fsSL https://raw.githubusercontent.com/ihumaunkabir/klaude/main/install.sh \| bash` |
| **npx** (no install) | `npx klaude-cli` |
| **From source** | `git clone https://github.com/ihumaunkabir/klaude && cd klaude && npm link` |

The curl installer needs no sudo. It installs into `~/.klaude/app` and links `klaude` into `~/.local/bin`. You can override these with `KLAUDE_VERSION`, `KLAUDE_INSTALL_DIR` and `KLAUDE_BIN_DIR`.

## Quick start

```sh
cd your-project
klaude                                  # interactive session
klaude "explain how auth works here"    # start with a request
klaude -c                               # continue the last session, with its history
klaude --resume api-work                # resume a named session
klaude -p "fix the failing test" --mode auto   # one-shot, for scripts
```

Describe what you want in plain language, for example *"add input validation to the signup handler and run the tests"*. For bigger changes, press <kbd>Shift</kbd>+<kbd>Tab</kbd> until you're in **plan** mode, review the plan, then switch back and say "go".

## Usage

### Commands

| Command | Description |
| --- | --- |
| `/help` | Show commands, custom commands, keys and modes |
| `/login` | Choose the provider: Ollama, Anthropic, OpenAI, Z.AI or a custom URL |
| `/logout` | Remove the current provider's saved key and go back to Ollama |
| `/mode [manual\|auto\|plan]` | Show or switch the mode (also <kbd>Shift</kbd>+<kbd>Tab</kbd>) |
| `/plan` | Toggle plan mode |
| `/undo` | Revert the files Klaude changed in its last turn |
| `/clear` | Start a fresh conversation (the old one stays saved) |
| `/compact` | Summarize the conversation to free up context |
| `/todos` | Show the agent's task list |
| `/memory` | Show saved memories; `/memory forget <id>` deletes one |
| `/sessions` | List saved sessions for this folder |
| `/resume [n\|name]` | Resume a session by number or name, or pick from a list |
| `/rename <name>` | Name this session |
| `/model [name]` | Pick or switch the model (remembered per provider) |
| `/models` | List the provider's models |
| `/shells [kill <id>]` | List background shells, or stop one |
| `/context` | Show context window usage |
| `/exit` | Quit (the session is saved) |

**Input:** `@path` attaches a file or folder, `!command` runs a shell command, <kbd>Tab</kbd> completes, and a `\` at the end of a line continues on the next one. Typing `/` opens the command menu: it lists every command, filters as you type, <kbd>↑</kbd>/<kbd>↓</kbd> scroll, <kbd>Tab</kbd> completes the highlighted command and <kbd>Esc</kbd> hides it.

**Keys:** <kbd>Shift</kbd>+<kbd>Tab</kbd> cycles the mode. <kbd>Ctrl</kbd>+<kbd>O</kbd> shows or hides the model's thinking. <kbd>Ctrl</kbd>+<kbd>C</kbd> interrupts the agent (press it twice while idle to quit). <kbd>Ctrl</kbd>+<kbd>D</kbd> quits.

### Modes and permissions

| | manual | auto | plan |
| --- | --- | --- | --- |
| Read, search, list, read-only shell commands | ✓ | ✓ | ✓ |
| Edit or write files | asks | ✓ | blocked |
| Other shell commands | asks | ✓ | blocked |
| Dangerous commands (`rm -rf`, `sudo`, `git push`, `git reset --hard`, `curl … \| sh`, `npm publish`, …) | asks | **asks** | blocked |
| Fetch a URL | asks | ✓ | asks |

When Klaude asks, answer `y` (yes, the default), `n` (no) or `a` (always). **"Always" is saved** to the project's `.klaude/settings.json` and applies from then on, in every session:

```json
{ "permissions": { "allow": ["edit_file", "bash(npm test)", "web_fetch"] } }
```

- For file tools the rule covers the tool.
- For shell commands it covers commands starting with the same first two words, e.g. `npm test`.
- A command with `;`, `&`, `|`, `>` or `$` never matches a rule. The exception is a pipe between read-only commands, such as `cat a.txt | grep x`.
- You can edit the file by hand, and commit it to share the rules with your team.
- `--yes` skips every prompt, including for dangerous commands; only use it where you trust the task.

Set your default mode in `~/.klaude/settings.json` (`"mode": "auto"`), or per run with `--mode`.

### Tools

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file with line numbers (supports offset/limit; rejects binary files) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace an exact, unique string in a file |
| `multi_edit` | Several replacements in one file; all or none |
| `list_dir`, `glob`, `grep` | Explore the codebase, respecting `.gitignore` (`grep` uses ripgrep if installed) |
| `bash` | Run a shell command; timeouts and <kbd>Ctrl</kbd>+<kbd>C</kbd> also kill its child processes. `run_in_background` for servers |
| `bash_output`, `kill_shell` | Read from or stop a background shell |
| `task` | Delegate research to a read-only sub-agent; several calls in one reply run in parallel |
| `web_fetch` | Fetch a URL as plain text |
| `todo_write` | Maintain the agent's task list |
| `memory` | Save or remove long-term memories |

### Custom commands

Put prompt templates in `.klaude/commands/<name>.md` (shared with the project) or `~/.klaude/commands/<name>.md` (just for you), and run them as `/<name> [arguments]`. `$ARGUMENTS` is replaced by what you type after the command, and the first line is shown in `/help`.

```markdown
# Review the current changes
Review `git diff` for bugs, missing tests and unclear names. Focus on: $ARGUMENTS
```

## Providers

Run `/login` to choose where the model runs. Klaude asks for the API key with your typing hidden, checks it, and lets you pick a model:

| Provider | Key | Default model |
| --- | --- | --- |
| Ollama (local) | none | your last choice, or the first installed |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5` |
| Z.AI (GLM) | `ZAI_API_KEY` | `glm-4.6` |
| OpenAI-compatible (OpenRouter, LM Studio, vLLM, …) | `OPENAI_COMPATIBLE_API_KEY` | chosen at login, with a custom base URL |

- **Remembered until you change it:** your choice is saved to `~/.klaude/settings.json`.
- **Key storage:** keys go to `~/.klaude/credentials.json`, which only your user can read (mode `600`).
- **Environment variables** win over saved keys, and a key read from one is never written to disk.
- **Switching:**
  - `--provider <name>` overrides the saved choice for one run.
  - `/logout` removes the saved key and switches back to Ollama.
  - `/model` remembers a model for each provider.
- **Ollama only when selected:** Klaude only checks for, starts or downloads anything for Ollama when Ollama is the selected provider.

## Configuration

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--provider` | `KLAUDE_PROVIDER` | your `/login` choice, or `ollama` | `ollama`, `anthropic`, `openai`, `zai`, `openai-compatible` |
| `-m, --model` | `KLAUDE_MODEL` | your last choice for the provider | Model to use |
| `--mode` | | `manual` (or `"mode"` in settings) | `manual`, `auto` or `plan` |
| `--host` | `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `--start-ollama` | | ask | Start a local Ollama server without asking (or `"autoStartOllama": true`) |
| `--ctx` | `KLAUDE_CTX` | Ollama: `32768` (capped at the model's max); APIs: the model's window | Context window in tokens |
| `-p, --print` | | off | Run one prompt, print the result, exit |
| `-c, --continue` | | off | Continue the latest session in this folder |
| `-r, --resume [name]` | | off | Resume a session by name or number, or pick one |
| `-y, --yes` | | off | Never ask for permission |
| `--no-think` | | model default | Turn off the model's thinking (<kbd>Ctrl</kbd>+<kbd>O</kbd> only hides it) |
| `-v, --version` | | | Print the version |
| | `KLAUDE_MAX_PARALLEL` | `4` | Sub-agents that run at once when fanning out |
| | `KLAUDE_HOME` | `~/.klaude` | Where Klaude keeps its data |
| | `NO_COLOR` | | Plain output without colors |

### Files

```text
~/.klaude/                        your user-level configuration
├── settings.json                 provider, model per provider, default mode, autoStartOllama
├── credentials.json              API keys (mode 600)
├── KLAUDE.md                     your instructions for every project
├── commands/<name>.md            your custom slash commands
├── memory/global.json            memories for all projects (g1, g2, …)
├── memory/projects/<folder>.json memories for one project (p1, p2, …)
├── sessions/<id>.json            saved conversations
└── ollama.log                    output of an Ollama server Klaude started

<project>/
├── KLAUDE.md or AGENTS.md        project instructions: conventions, how to build and test
└── .klaude/
    ├── settings.json             saved "always allow" rules
    └── commands/<name>.md        the project's custom slash commands
```

Example `KLAUDE.md`:

```markdown
- Run tests with `pnpm test`; lint with `pnpm lint`.
- Use TypeScript strict mode; no `any`.
- Never edit files under `generated/`.
```

### Choosing a local model

Models with native tool calling are the most reliable. Check with `ollama show <model>`, which should list `tools` under Capabilities.

| Model | Notes |
| --- | --- |
| `qwen3-coder` | Strong coding model with native tools; a good default |
| `glm-4.7-flash` | Fast, native tools and thinking |
| `gpt-oss` | Native tools and reasoning |
| `qwen3` | Good general model |

A larger `--ctx` lets sessions run longer before summarizing, but uses more memory. For parallel sub-agents on Ollama, raise `OLLAMA_NUM_PARALLEL` on the server.

## How it works

```text
 you ─▶ REPL ─▶ Agent loop ── chat (stream) ──▶ provider client ──▶ Ollama / Anthropic / OpenAI / Z.AI / …
                   ▲   │
                   │   ├─ tool calls ─▶ mode + permission check ─▶ run ─▶ trim ─┐
                   │   └─ task calls ─▶ read-only sub-agents (in parallel) ─────┤
                   └──────────────────────── results ◀──────────────────────────┘
```

1. Your message goes to the model with the system prompt: workflow rules, environment, git status, detected project commands, file map, instructions and memories. The reply streams to your terminal.
2. Tool calls are checked against the mode and your saved rules, then run, and their results are sent back. Several `task` calls in one reply fan out to parallel sub-agents.
3. This repeats until the model answers without calling a tool. If the conversation nears the context limit, it is summarized and the work continues.

| Path | Role |
| --- | --- |
| `bin/klaude.js` | CLI: startup, `/login`, REPL, slash commands, permission prompts |
| `src/agent.js` | Agent loop, modes, sub-agents and fan-out, undo, compaction, loop guard |
| `src/tools.js` | Tool schemas and implementations |
| `src/providers.js` | Anthropic, OpenAI, Z.AI and OpenAI-compatible clients |
| `src/ollama.js` | Streaming Ollama client with retries |
| `src/server.js` | Starting a local Ollama server |
| `src/prompt.js` | System prompt, project detection, git context, instruction files |
| `src/input.js` | `@file` mentions, custom commands, tab completion |
| `src/settings.js` | User and project settings, credentials |
| `src/session.js` | Sessions: save, list, find, history |
| `src/memory.js` | Long-term memory storage |
| `src/markdown.js`, `src/thinking.js`, `src/ui.js` | Terminal rendering |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Cannot reach Ollama …` | Answer `y` when Klaude offers to start it, run `ollama serve`, use `--start-ollama`, or `/login` to use an API provider. |
| `No Ollama models installed` | Klaude offers to download one, or run `ollama pull qwen3-coder`. |
| `Model "x" not found` | Run `/models` and pick an exact name, or `/model` to choose from a list. |
| `401` / `invalid key` from a provider | Run `/login` again and enter a new key, or check the environment variable. |
| The agent narrates but never acts | The model is weak at tool calling. Switch to one with native `tools` support, or to an API provider. |
| Replies are slow | Use a smaller model or `--no-think` (skips thinking, not just hides it). The first reply also waits for the model to load. |
| `klaude: command not found` after curl install | Add `~/.local/bin` to your `PATH`; the installer prints the exact line. |

## Uninstall

```sh
npm uninstall -g klaude-cli                                # npm
brew uninstall klaude && brew untap ihumaunkabir/klaude   # Homebrew
rm -rf ~/.klaude/app ~/.local/bin/klaude                   # curl installer
rm -rf ~/.klaude                                           # also remove sessions, memory, settings and keys
```

## Development

```sh
git clone https://github.com/ihumaunkabir/klaude && cd klaude
npm test            # unit, agent, provider and CLI tests (no Ollama or API keys needed)
npm run check       # syntax check
node bin/klaude.js  # run from source
```

CI runs the tests on Linux and macOS with Node 22 and 24. It also lints `install.sh` and installs the packed package through the installer.

### Releasing

Releases are automatic. Bump `"version"` in `package.json` and add a `## [<version>]` section to `CHANGELOG.md` in your pull request; merging it to `main` publishes to npm, creates the tag and GitHub release, and updates the Homebrew formula. Merges that don't bump the version don't release.

The [release workflow](.github/workflows/release.yml) needs an npm granular access token (publish rights, 2FA bypass enabled) stored as the `NPM_TOKEN` repository secret (`gh secret set NPM_TOKEN`).

## License

[MIT](LICENSE)
