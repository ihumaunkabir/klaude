# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1]

### Fixed

- Release tooling: packages now publish from CI on merge to `main` when the
  version is bumped (no code changes; identical to 0.1.0).

## [0.1.0]

First release.

### Added

- Interactive REPL and one-shot mode (`-p`).
- Models from a local Ollama server, or from Anthropic (Claude), OpenAI, Z.AI
  and any OpenAI-compatible API via `/login`. The choice is saved in
  `~/.klaude/settings.json` and keys in `~/.klaude/credentials.json` (mode 600).
  Klaude can start a local Ollama server and download a model on first run.
- Agent loop with streaming output, native tool calling, a text-based fallback
  for models without it, and a system prompt built around an engineering
  workflow with detected project commands and a file map.
- Tools: `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_dir`,
  `glob`, `grep`, `bash` (with background shells, `bash_output`, `kill_shell`),
  `web_fetch`, `todo_write`, `memory` and `task` (read-only sub-agents, run in
  parallel when fanned out).
- Modes: manual, auto (asks only for dangerous commands) and plan (read-only),
  cycled with Shift+Tab. "Always allow" answers are saved to the project's
  `.klaude/settings.json`.
- Safety: edits require a fresh read of the file, repeated identical tool calls
  are refused, shell commands run in their own process group, and `/undo`
  reverts the last turn's file changes.
- Long-term memory (global or per project), sessions saved after every turn,
  `--continue`, named sessions with `/rename` and `--resume <name>`.
- Automatic context compaction and `/compact`.
- `@file` attachments, `!command`, Tab completion and custom slash commands.
- Markdown rendering and collapsible model thinking (Ctrl+O).
- Install via npm, Homebrew tap or `install.sh`.
