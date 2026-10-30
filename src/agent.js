// The agent loop: send the conversation to the model, run any tool calls it
// makes, feed the results back, and repeat until it answers without tools.

import path from 'node:path';
import {
  tools,
  isReadOnlyCommand,
  isDangerousCommand,
  commandPrefix,
  formatTodos,
  restoreCheckpoint,
  SUBAGENT_TOOLS,
} from './tools.js';
import { textToolsPrompt, buildSystemPrompt, COMPACT_PROMPT } from './prompt.js';
import { MarkdownStream } from './markdown.js';
import { ThinkingView } from './thinking.js';
import { c, write, truncateLines, indent } from './ui.js';

const MAX_STEPS = 50;
const COMPACT_THRESHOLD = 0.8;
const TOOL_RESULT_SHARE = 0.25; // max share of the context window one tool result may use
const COMPACT_MESSAGE_CHARS = 2000; // long messages are shortened to this when summarizing
const MAX_REPEATS = 2; // identical consecutive tool calls allowed before refusing
const KEEP_ALIVE = '30m'; // keep the model loaded in Ollama between turns
const MAX_CHECKPOINTS = 20; // turns that /undo can revert
const MAX_PARALLEL = Number(process.env.KLAUDE_MAX_PARALLEL) || 4; // sub-agents run at once when fanning out

export const MODES = ['manual', 'auto', 'plan'];

// The rule stored when the user answers "always": the tool name, or bash(<prefix>).
export function permissionRule(name, args) {
  if (name !== 'bash') return name;
  const prefix = commandPrefix(String(args.command ?? ''));
  return prefix ? `bash(${prefix})` : null;
}

// Runs fn over items with at most `limit` in flight, keeping result order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const PLAN_ON =
  '[Plan mode is on: investigate with read-only tools, then reply with a concrete step-by-step plan. Do not modify files or run commands that change anything; the user will turn plan mode off when the plan is approved.]';
const PLAN_OFF = '[Plan mode is off: you may now make changes.]';

function shorten(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more chars omitted]`;
}

// Extracts ```tool fenced blocks (or <tool_call> tags) with {name, arguments} JSON
// from plain-text model output.
export function parseTextToolCalls(content) {
  const calls = [];
  const errors = [];
  for (const m of content.matchAll(/^\s*```tool[ \t]*\n([\s\S]*?)\n\s*```|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gm)) {
    const body = m[1] ?? m[2];
    try {
      // Also accept `name\n{arguments}`, a common variation.
      const named = body.match(/^([\w-]+)\s*(\{[\s\S]*\})$/);
      const json = named ? { name: named[1], arguments: JSON.parse(named[2]) } : JSON.parse(body);
      if (!json.name) throw new Error('missing "name"');
      calls.push({ function: { name: json.name, arguments: json.arguments ?? json.parameters ?? {} } });
    } catch (err) {
      errors.push(`Invalid tool call (${err.message}): ${body.slice(0, 200)}`);
    }
  }
  return { calls, errors };
}

export class Agent {
  // mode: 'manual' asks before changes, 'auto' only asks for dangerous commands,
  // 'plan' blocks changes. allowRules are saved "always" answers; onAllowRule
  // persists a new one. toolNames limits the tools; readOnly refuses changes;
  // quiet prints one line per tool call, tagged with label (used for sub-agents).
  constructor({
    client,
    model,
    systemPrompt,
    cwd,
    options,
    think,
    nativeTools,
    autoApprove,
    askPermission,
    verbose,
    mode = 'manual',
    allowRules = [],
    onAllowRule,
    toolNames,
    readOnly,
    quiet,
    label,
  }) {
    this.client = client;
    this.model = model;
    this.cwd = cwd;
    this.options = options;
    this.think = think;
    this.nativeTools = nativeTools;
    this.autoApprove = autoApprove;
    this.askPermission = askPermission;
    this.mode = mode;
    this.allowRules = new Set(allowRules);
    this.onAllowRule = onAllowRule;
    this.label = label;
    this.thinking = new ThinkingView({ verbose });
    this.tools = Object.fromEntries(Object.entries(tools).filter(([name]) => !toolNames || toolNames.includes(name)));
    this.toolSchemas = Object.values(this.tools).map((t) => t.schema);
    this.toolsTokens = Math.ceil(JSON.stringify(this.toolSchemas).length / 4);
    this.readOnly = Boolean(readOnly);
    this.quiet = Boolean(quiet);
    this.basePrompt = systemPrompt;
    this.reset();
  }

  get systemPrompt() {
    return this.nativeTools ? this.basePrompt : `${this.basePrompt}\n\n${textToolsPrompt(this.toolSchemas)}`;
  }

  // Replaces the system prompt (e.g. after memories change), keeping the conversation.
  setBasePrompt(prompt) {
    this.basePrompt = prompt;
    this.messages[0] = { role: 'system', content: this.systemPrompt };
  }

  setModel(model, { nativeTools }) {
    this.model = model;
    this.nativeTools = nativeTools;
    this.messages[0] = { role: 'system', content: this.systemPrompt };
  }

  reset() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.reportedTokens = 0;
    this.state = { files: new Map(), todos: [], checkpoint: null };
    this.checkpoints = []; // [{ input, changes }] for /undo, oldest first
    this.lastCall = null;
    this.planNoted = false; // whether the conversation was last told plan mode is on
  }

  // Serializable session state, for saving and --continue.
  snapshot() {
    return { model: this.model, messages: this.messages, todos: this.state.todos };
  }

  restore({ messages, todos }) {
    this.reset();
    this.messages = [{ role: 'system', content: this.systemPrompt }, ...messages.slice(1)];
    this.state.todos = todos ?? [];
  }

  // Best guess at the prompt size: Ollama's own count from the last response,
  // or a chars/4 estimate when that is stale or missing.
  get contextTokens() {
    const estimate = Math.ceil(JSON.stringify(this.messages).length / 4) + (this.nativeTools ? this.toolsTokens : 0);
    return Math.max(this.reportedTokens, estimate);
  }

  async run(userInput, signal) {
    this.lastUserInput = userInput;
    this.stats = { start: Date.now(), promptTokens: 0, outputTokens: 0 };
    this.state.checkpoint = new Map();
    try {
      await this.#loop(userInput, signal);
    } finally {
      if (this.state.checkpoint.size) {
        this.checkpoints.push({ input: userInput, changes: this.state.checkpoint });
        if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
      }
      this.state.checkpoint = null;
      const secs = ((Date.now() - this.stats.start) / 1000).toFixed(1);
      if (!this.quiet) write(c.gray(`\n✻ ${secs}s · ${this.stats.promptTokens} in · ${this.stats.outputTokens} out\n`));
    }
  }

  // Reverts the file changes of the most recent turn that made any.
  // Returns the restored paths (relative to cwd), or null if there is nothing to undo.
  async undo() {
    const last = this.checkpoints.pop();
    if (!last) return null;
    const files = (await restoreCheckpoint(this.state, last.changes)).map((f) => path.relative(this.cwd, f));
    this.messages.push({
      role: 'user',
      content: `[The user undid your file changes for the request "${shorten(last.input, 200)}". Restored to their earlier content: ${files.join(', ')}. Re-read them before editing again.]`,
    });
    return files;
  }

  // Runs a read-only sub-agent with a fresh context and returns its final report.
  async #runSubagent(prompt, label, signal) {
    const sub = new Agent({
      client: this.client,
      model: this.model,
      cwd: this.cwd,
      options: this.options,
      think: this.think,
      nativeTools: this.nativeTools,
      systemPrompt: await buildSystemPrompt(this.cwd, { subagent: true }),
      toolNames: SUBAGENT_TOOLS,
      readOnly: true,
      quiet: true,
      label,
    });
    try {
      await sub.run(prompt, signal);
    } finally {
      this.stats.promptTokens += sub.stats.promptTokens;
      this.stats.outputTokens += sub.stats.outputTokens;
    }
    const report = sub.messages.findLast((m) => m.role === 'assistant' && m.content?.trim())?.content.trim();
    return report || 'The sub-agent finished without a report.';
  }

  async #loop(userInput, signal) {
    await this.#maybeCompact(signal);
    let content = userInput;
    if (this.mode === 'plan') content += `\n\n${PLAN_ON}`;
    else if (this.planNoted) content += `\n\n${PLAN_OFF}`;
    this.planNoted = this.mode === 'plan';
    this.messages.push({ role: 'user', content });

    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0) await this.#maybeCompact(signal);

      let { content, toolCalls } = await this.#streamResponse(signal);
      const native = toolCalls.length > 0;
      let errors = [];
      if (!native) ({ calls: toolCalls, errors } = parseTextToolCalls(content));

      const msg = { role: 'assistant', content };
      if (native) msg.tool_calls = toolCalls;
      this.messages.push(msg);

      if (!toolCalls.length) {
        if (!errors.length) return;
        write(c.red(`  ⎿ ${errors.join('\n')}\n`));
        this.messages.push({ role: 'user', content: `${errors.join('\n')}\nFix the JSON and try again.` });
        continue;
      }

      const results = [];
      try {
        // Consecutive task calls fan out: those sub-agents run in parallel.
        for (let i = 0; i < toolCalls.length; ) {
          let j = i;
          while (j < toolCalls.length && toolCalls[j].function?.name === 'task') j++;
          if (j - i > 1) {
            results.push(...(await mapLimit(toolCalls.slice(i, j), MAX_PARALLEL, (call) => this.#runTool(call, signal))));
            i = j;
          } else {
            results.push(await this.#runTool(toolCalls[i], signal));
            i++;
          }
        }
      } finally {
        // Keep every tool call paired with a result, even when interrupted.
        while (results.length < toolCalls.length) results.push('Interrupted by the user.');
        this.#pushToolResults(toolCalls, results, native);
      }
    }
    if (!this.quiet) write(c.yellow(`\nStopped after ${MAX_STEPS} steps.\n`));
  }

  #pushToolResults(toolCalls, results, native) {
    if (native) {
      toolCalls.forEach((call, i) =>
        this.messages.push({ role: 'tool', tool_name: call.function.name, content: results[i] }),
      );
    } else {
      const content = toolCalls
        .map((call, i) => `<tool_result name="${call.function.name}">\n${results[i]}\n</tool_result>`)
        .join('\n\n');
      this.messages.push({ role: 'user', content });
    }
  }

  async #maybeCompact(signal) {
    if (this.contextTokens > this.options.num_ctx * COMPACT_THRESHOLD && this.messages.length > 2) {
      await this.compact(signal);
    }
  }

  // Replaces the conversation with a model-written summary of it.
  async compact(signal) {
    write(c.gray(`\n✻ Compacting conversation (~${this.contextTokens} tokens)…\n`));
    let summary = '';
    // Shorten big messages (mostly tool output) so the summary request itself fits.
    const transcript = this.messages.slice(1).map((m) => ({ ...m, content: shorten(m.content ?? '', COMPACT_MESSAGE_CHARS) }));
    const stream = this.client.chat({
      model: this.model,
      messages: [this.messages[0], ...transcript, { role: 'user', content: COMPACT_PROMPT }],
      options: this.options,
      think: this.think,
      keepAlive: KEEP_ALIVE,
      signal,
    });
    for await (const chunk of stream) summary += chunk.message?.content ?? '';
    summary = summary.trim();
    if (!summary) throw new Error('Compaction failed: the model returned an empty summary');

    this.messages = [
      { role: 'system', content: this.systemPrompt },
      {
        role: 'user',
        content:
          `This session continues from an earlier conversation that was compacted to save context. Summary:\n\n${summary}` +
          (this.lastUserInput ? `\n\nThe user's most recent request, verbatim:\n${this.lastUserInput}` : ''),
      },
      { role: 'assistant', content: 'Understood. I will continue from this summary.' },
    ];
    this.reportedTokens = 0;
    write(c.gray(`  ⎿ Compacted to ~${this.contextTokens} tokens\n`));
  }

  async #streamResponse(signal) {
    let content = '';
    let mode = null; // 'thinking' | 'text'
    const toolCalls = [];
    const md = new MarkdownStream(write);

    const stream = this.client.chat({
      model: this.model,
      messages: this.messages,
      tools: this.nativeTools ? this.toolSchemas : undefined,
      options: this.options,
      think: this.think,
      keepAlive: KEEP_ALIVE,
      signal,
    });

    try {
      for await (const chunk of stream) {
        const m = chunk.message ?? {};
        if (m.thinking && !this.quiet) {
          if (mode !== 'thinking') md.flush();
          mode = 'thinking';
          this.thinking.push(m.thinking);
        }
        if (m.content) {
          if (!this.quiet) {
            if (mode !== 'text') {
              this.thinking.end();
              write('\n');
            }
            md.push(m.content);
          }
          mode = 'text';
          content += m.content;
        }
        if (m.tool_calls) toolCalls.push(...m.tool_calls);
        if (chunk.done) {
          this.reportedTokens = (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0);
          this.stats.promptTokens += chunk.prompt_eval_count ?? 0;
          this.stats.outputTokens += chunk.eval_count ?? 0;
        }
      }
    } finally {
      this.thinking.end();
      md.flush();
    }
    return { content, toolCalls };
  }

  async #runTool(call, signal) {
    signal?.throwIfAborted();
    const name = call.function?.name;
    let args = call.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return `Error: arguments for ${name} are not valid JSON`;
      }
    }

    const tool = this.tools[name];
    if (!tool) return `Error: unknown tool "${name}". Available tools: ${Object.keys(this.tools).join(', ')}`;

    const summary = truncateLines(String(tool.describe(args) ?? ''), 3);
    if (this.quiet) write(c.gray(`    ↳ ${this.label ? `[${this.label}] ` : ''}${name}(${summary.split('\n')[0]})\n`));
    else write(`\n${c.cyan('⏺')} ${c.bold(name)}${c.gray(`(${summary})`)}\n`);
    const say = (text) => this.quiet || write(text);

    // Local models sometimes loop on the same call; stop that early.
    const key = `${name}:${JSON.stringify(args)}`;
    this.lastCall = this.lastCall?.key === key ? { key, count: this.lastCall.count + 1 } : { key, count: 1 };
    if (this.lastCall.count > MAX_REPEATS) {
      say(c.yellow('  ⎿ Skipped: repeated identical call\n'));
      return `Error: you already made this exact ${name} call ${MAX_REPEATS} times in a row and the result will not change. Use a different approach, or tell the user what is blocking you.`;
    }

    const mutates = tool.mutates || (name === 'bash' && !isReadOnlyCommand(String(args.command ?? '')));
    if (mutates && (this.readOnly || this.mode === 'plan')) {
      say(c.yellow(`  ⎿ Blocked: ${this.readOnly ? 'read-only sub-agent' : 'plan mode'}\n`));
      return this.readOnly
        ? 'Error: sub-agents can only read. Do not try to change anything; report your findings instead.'
        : 'Error: plan mode is on, so changes are blocked. Finish investigating and present your plan; the user will turn plan mode off to let you carry it out.';
    }

    if (tool.needsPermission && !this.#isPreApproved(name, args)) {
      if (tool.preview) write(this.#formatPreview(tool.preview(args)) + '\n');
      const rule = permissionRule(name, args);
      const answer = await this.askPermission(name, args, rule);
      if (answer === 'always' && rule) {
        this.allowRules.add(rule);
        await this.onAllowRule?.(rule);
      }
      if (answer === 'no') {
        write(c.red('  ⎿ Denied by user\n'));
        return 'The user denied permission for this tool call. Ask them how to proceed instead of retrying.';
      }
    }

    try {
      const maxChars = Math.floor(this.options.num_ctx * 4 * TOOL_RESULT_SHARE);
      const ctx = { cwd: this.cwd, signal, state: this.state };
      if (!this.readOnly) ctx.runSubagent = (prompt, sig) => this.#runSubagent(prompt, args.description, sig);
      const result = shorten(await tool.run(args, ctx), maxChars);
      signal?.throwIfAborted();
      if (name === 'todo_write') say(indent(formatTodos(this.state.todos), '    ').replace(/^ {4}/, '  ⎿ ') + '\n');
      else if (name === 'task') say(c.gray(`  ⎿ [${args.description ?? 'sub-agent'}] ` + indent(truncateLines(result, 4), '    ').slice(4)) + '\n');
      else say(c.gray('  ⎿ ' + indent(truncateLines(result, 6), '    ').slice(4)) + '\n');
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      say(c.red(`  ⎿ Error: ${err.message}\n`));
      return `Error: ${err.message}`;
    }
  }

  #isPreApproved(name, args) {
    if (this.autoApprove) return true;
    const command = name === 'bash' ? String(args.command ?? '') : null;
    if (command !== null && isReadOnlyCommand(command)) return true;
    // Auto mode runs everything except dangerous commands, which always ask.
    if (this.mode === 'auto') return command === null || !isDangerousCommand(command);
    const rule = permissionRule(name, args);
    return rule !== null && this.allowRules.has(rule);
  }

  #formatPreview(text) {
    return truncateLines(text, 30)
      .split('\n')
      .map((l) => (l.startsWith('- ') ? c.red(`  │ ${l}`) : l.startsWith('+ ') ? c.green(`  │ ${l}`) : c.gray(`  │ ${l}`)))
      .join('\n');
  }
}
