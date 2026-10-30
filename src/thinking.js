// Shows the model's "thinking" either streamed in full (verbose) or collapsed
// into a single status line. Verbose mode can be toggled at any time.

import { c, write } from './ui.js';

const HINT = 'ctrl+o to expand';

export class ThinkingView {
  constructor({ verbose = false, live = process.stdout.isTTY, out = write } = {}) {
    this.verbose = verbose;
    this.out = out;
    this.live = live; // can rewrite the status line in place
    this.active = false;
    this.text = ''; // the current, or most recent, thinking block
    this.timer = null;
  }

  push(chunk) {
    if (!this.active) this.#start();
    this.text += chunk;
    if (this.verbose) this.out(c.gray(chunk));
  }

  end() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    if (this.verbose) this.out('\n');
    else this.#status(true);
  }

  // Switches modes. Expanding mid-block prints what was collapsed so far, then streams the rest.
  setVerbose(verbose) {
    if (verbose === this.verbose) return;
    this.verbose = verbose;
    if (!this.active) return;
    clearInterval(this.timer);
    if (verbose) {
      this.out(`${this.live ? '\r\x1b[2K' : '\n'}${c.gray(`✻ thinking…\n${this.text}`)}`);
    } else {
      this.out('\n');
      this.#startStatus();
    }
  }

  #start() {
    this.active = true;
    this.text = '';
    this.started = Date.now();
    this.out('\n');
    if (this.verbose) this.out(c.gray('✻ thinking…\n'));
    else this.#startStatus();
  }

  #startStatus() {
    if (!this.live) return;
    this.#status(false);
    this.timer = setInterval(() => this.#status(false), 1000);
  }

  #status(final) {
    const secs = Math.max(1, Math.round((Date.now() - this.started) / 1000));
    const line = c.gray(`✻ ${final ? `Thought for ${secs}s` : `Thinking… ${secs}s`} · ${HINT}`);
    if (this.live) this.out(`\r\x1b[2K${line}${final ? '\n' : ''}`);
    else if (final) this.out(`${line}\n`);
  }
}
