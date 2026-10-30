// Line-buffered Markdown renderer for streamed model output. It also hides
// ```tool / <tool_call> blocks emitted by models that call tools via plain text.

import { c, useColor } from './ui.js';

function inline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return c.cyan(part.slice(1, -1));
      return part
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => c.bold(a ?? b))
        .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, (_, pre, t) => pre + c.italic(t))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => `${c.blue(t)} ${c.gray(`(${url})`)}`);
    })
    .join('');
}

export class MarkdownStream {
  constructor(out) {
    this.out = out;
    this.buf = '';
    this.inCode = false;
    this.toolEnd = null; // closing marker while inside a text tool call
  }

  push(text) {
    this.buf += text;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      this.#emit(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  flush() {
    if (this.buf) this.#emit(this.buf);
    this.buf = '';
  }

  #emit(line) {
    const rendered = this.render(line);
    if (rendered !== null) this.out(rendered + '\n');
  }

  // Returns the rendered line, or null to hide it.
  render(line) {
    if (this.toolEnd) {
      if (this.toolEnd.test(line)) this.toolEnd = null;
      return null;
    }
    if (/^\s*```tool\s*$/.test(line)) {
      this.toolEnd = /^\s*```\s*$/;
      return null;
    }
    if (line.includes('<tool_call>')) {
      if (!line.includes('</tool_call>')) this.toolEnd = /<\/tool_call>/;
      return null;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      this.inCode = !this.inCode;
      return c.gray(line);
    }
    if (this.inCode) return c.gray('│ ') + line;
    if (!useColor) return line;

    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)/))) return c.bold(m[1]);
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return c.gray('─'.repeat(40));
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)/))) return `${m[1]}• ${inline(m[2])}`;
    if ((m = line.match(/^\s*>\s?(.*)/))) return c.gray('│ ') + c.italic(m[1]);
    return inline(line);
  }
}
