// The live /command menu: while the input line is a bare /command prefix,
// the matching commands are listed under the prompt, filtered as the user
// types. Up/Down move through the list (Tab completes the highlighted one,
// Esc hides it). Drawn below readline's own input line, so readline keeps
// handling editing, history and submission.

import { c, visibleLength } from './ui.js';

const MAX_ROWS = 8;
const IS_COMMAND = /^\/[\w-]*$/; // a slash command prefix, with no arguments yet

// The commands whose name starts with the typed text, in display order.
export function filterCommands(typed, commands) {
  const q = String(typed ?? '').toLowerCase();
  return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(q));
}

// Moves the selection by delta, staying inside [0, count).
export function moveSelection(count, selected, delta) {
  if (!count) return 0;
  return Math.min(count - 1, Math.max(0, selected + delta));
}

export class CommandMenu {
  // getCommands() returns [{ name, description }]; prompt() the prompt string
  // currently shown by readline (used to place the cursor after redraws).
  constructor(rl, getCommands, prompt) {
    this.rl = rl;
    this.getCommands = getCommands;
    this.prompt = prompt;
    this.enabled = false;
    this.armed = false; // only the main input shows the menu, not sub-prompts
    this.items = [];
    this.selected = 0;
    this.rows = 0; // menu rows currently on screen
    this.dismissed = null; // line the menu was Esc'd on; reopen once it changes
    this.lastLine = null;
    this.patched = false; // whether readline's history keys are neutralized
  }

  enable() {
    if (this.enabled || !this.rl.terminal) return;
    this.enabled = true;
    this.onKey = (_, key) => this.handleKey(key);
    this.onLine = () => {
      this.dismissed = null;
      this.close();
    };
    this.onResize = () => this.close();
    this.rl.input.on('keypress', this.onKey);
    this.rl.on('line', this.onLine);
    this.rl.output.on('resize', this.onResize);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.armed = false;
    this.rl.input.removeListener('keypress', this.onKey);
    this.rl.removeListener('line', this.onLine);
    this.rl.output.removeListener('resize', this.onResize);
    this.close();
  }

  arm() {
    this.armed = true;
  }

  disarm() {
    this.armed = false;
    this.close();
  }

  get visible() {
    return this.rows > 0;
  }

  handleKey(key) {
    if (!this.enabled || !this.armed || !key) return;
    const nav =
      key.name === 'down' || (key.ctrl && key.name === 'n')
        ? 1
        : key.name === 'up' || (key.ctrl && key.name === 'p')
          ? -1
          : 0;
    if (nav && this.visible) {
      this.selected = moveSelection(this.items.length, this.selected, nav);
      this.erase();
      this.draw();
      return;
    }
    if (key.name === 'escape' && this.visible) {
      this.dismissed = this.rl.line;
      this.close();
      return;
    }
    if (key.name === 'tab' && !key.shift) {
      // Readline is completing the line asynchronously; redraw once it has.
      setTimeout(() => this.update(), 0);
      return;
    }
    this.update();
  }

  // Recomputes the menu from the current input line, after readline applied a key.
  update() {
    if (!this.enabled || !this.armed) return;
    const line = this.rl.line;
    const open = line !== this.dismissed && this.rl.cursor === line.length && IS_COMMAND.test(line);
    if (!open) return this.close();
    this.items = filterCommands(line.slice(1), this.getCommands());
    if (!this.items.length) return this.close();
    if (line !== this.lastLine) this.selected = 0; // a new query restarts at the top
    this.lastLine = line;
    this.erase();
    this.draw();
    this.neutralizeHistory();
  }

  close() {
    this.items = [];
    this.rows = 0;
    this.lastLine = null;
    this.erase();
    this.restoreHistory();
  }

  // Up/Down move the menu selection, not readline's history. Neutralized by
  // swapping the history handlers while the menu is open; harmless if node
  // renames them (arrows would then also move history, visibly, never crash).
  #historyPrev = null;
  #historyNext = null;
  neutralizeHistory() {
    if (this.patched || !this.rl._historyPrev) return;
    this.patched = true;
    this.#historyPrev = this.rl._historyPrev;
    this.#historyNext = this.rl._historyNext;
    this.rl._historyPrev = this.rl._historyNext = () => {};
  }

  restoreHistory() {
    if (!this.patched) return;
    this.patched = false;
    this.rl._historyPrev = this.#historyPrev;
    this.rl._historyNext = this.#historyNext;
  }

  #out = (s) => this.rl.output.write(s);

  // Column of the cursor on the input line: prompt width + cursor offset.
  #column() {
    return visibleLength(this.prompt()) + this.rl.cursor;
  }

  // Draws the menu below the input line, then puts the cursor back on it.
  draw() {
    const width = this.rl.output.columns || 80;
    const shown = this.items.slice(0, MAX_ROWS);
    const rows = shown.map((cmd, i) => {
      const name = `/${cmd.name}`;
      const marker = i === this.selected ? '❯ ' : '  ';
      const desc = String(cmd.description ?? '');
      const maxDesc = Math.max(0, width - marker.length - name.length - 3);
      const label = i === this.selected ? c.bold(c.cyan(name)) : name;
      return `${marker}${label}  ${c.gray(desc.slice(0, maxDesc))}`;
    });
    if (this.items.length > MAX_ROWS) rows.push(c.gray(`  … ${this.items.length - MAX_ROWS} more`));
    const col = this.#column();
    this.#out('\r\n'); // to the start of the first menu row
    rows.forEach((row, i) => {
      if (i > 0) this.#out('\r\n');
      this.#out(`\x1b[2K${row}`);
    });
    this.#out(`\r\x1b[${rows.length}A`); // back up to the input line
    if (col > 0) this.#out(`\x1b[${col}C`);
    this.rows = rows.length;
  }

  // Clears the menu rows drawn by draw(), restoring the cursor.
  erase() {
    if (!this.rows) return;
    const col = this.#column();
    this.#out('\r\x1b[B'); // to the first menu row
    for (let i = 0; i < this.rows; i++) {
      this.#out('\x1b[2K');
      if (i < this.rows - 1) this.#out('\n');
    }
    this.#out(`\r\x1b[${this.rows}A`);
    if (col > 0) this.#out(`\x1b[${col}C`);
    this.rows = 0;
  }
}
