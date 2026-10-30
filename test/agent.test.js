import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, parseTextToolCalls } from '../src/agent.js';
import { MarkdownStream } from '../src/markdown.js';

// A fake Ollama client that replies with scripted messages, in order.
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    async *chat(req) {
      requests.push(structuredClone(req));
      const reply = replies.shift();
      assert.ok(reply, 'unexpected extra chat request');
      yield { message: reply, done: false };
      yield { message: {}, done: true, prompt_eval_count: 10, eval_count: 5 };
    },
  };
}

async function makeAgent(client, opts = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-'));
  return new Agent({
    client,
    model: 'fake',
    cwd,
    systemPrompt: 'system',
    options: { num_ctx: 32768 },
    nativeTools: true,
    autoApprove: true,
    askPermission: async () => 'yes',
    ...opts,
  });
}

test('parseTextToolCalls', () => {
  const { calls, errors } = parseTextToolCalls(
    'ok\n```tool\n{"name": "bash", "arguments": {"command": "ls"}}\n```\n' +
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "a"}}\n</tool_call>\n<tool_call>{bad}</tool_call>\n' +
      '```tool\nlist_dir\n{"path": "."}\n```',
  );
  assert.deepEqual(calls, [
    { function: { name: 'bash', arguments: { command: 'ls' } } },
    { function: { name: 'read_file', arguments: { path: 'a' } } },
    { function: { name: 'list_dir', arguments: { path: '.' } } },
  ]);
  assert.equal(errors.length, 1);
});

test('markdown hides tool calls and keeps code blocks', () => {
  let out = '';
  const md = new MarkdownStream((s) => (out += s));
  md.push('Hi\n<tool_call>\n{"name":"x"}\n</tool_call>\n```tool\n{"name":"y"}\n```\n```js\nconst a = 1;\n```\nbye');
  md.flush();
  assert.equal(out, 'Hi\n```js\n│ const a = 1;\n```\nbye\n');
});

test('native tool calls run and results are sent back as tool messages', async () => {
  const client = fakeClient([
    { content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'echo hi' } } }] },
    { content: 'done' },
  ]);
  const agent = await makeAgent(client);
  await agent.run('say hi');
  const last = client.requests[1].messages.at(-1);
  assert.equal(last.role, 'tool');
  assert.match(last.content, /^hi\n\[exit code: 0\]/);
  assert.ok(client.requests[0].tools.length > 0);
});

test('text-mode tool calls work for models without native tools', async () => {
  const client = fakeClient([
    { content: 'Writing.\n```tool\n{"name": "write_file", "arguments": {"path": "x.txt", "content": "yo"}}\n```' },
    { content: 'done' },
  ]);
  const agent = await makeAgent(client, { nativeTools: false });
  await agent.run('write x');
  assert.equal(await fs.readFile(path.join(agent.cwd, 'x.txt'), 'utf8'), 'yo');
  assert.equal(client.requests[0].tools, undefined);
  assert.match(client.requests[0].messages[0].content, /```tool/);
  const last = client.requests[1].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /^<tool_result name="write_file">/);
});

test('auto-compacts when the context is nearly full', async () => {
  const client = fakeClient([{ content: 'SUMMARY OF WORK' }, { content: 'next answer' }]);
  const agent = await makeAgent(client, { options: { num_ctx: 1000 } });
  agent.messages.push({ role: 'user', content: 'x'.repeat(4000) }, { role: 'assistant', content: 'ok' });
  await agent.run('continue');
  assert.equal(client.requests[0].tools, undefined); // the summary request
  const msgs = client.requests[1].messages;
  assert.equal(msgs.length, 4);
  assert.match(msgs[1].content, /SUMMARY OF WORK/);
  assert.equal(msgs[3].content, 'continue');
});

test('interrupting during tools keeps tool calls paired with results', async () => {
  const client = fakeClient([
    {
      content: '',
      tool_calls: [
        { function: { name: 'bash', arguments: { command: 'sleep 5' } } },
        { function: { name: 'bash', arguments: { command: 'echo never' } } },
      ],
    },
  ]);
  const agent = await makeAgent(client);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(agent.run('go', ac.signal));
  const tail = agent.messages.slice(-2);
  assert.deepEqual(
    tail.map((m) => m.role),
    ['tool', 'tool'],
  );
  assert.equal(tail[1].content, 'Interrupted by the user.');
});

test('refuses identical tool calls repeated in a row', async () => {
  const call = { content: '', tool_calls: [{ function: { name: 'list_dir', arguments: {} } }] };
  const client = fakeClient([call, call, call, { content: 'giving up' }]);
  const agent = await makeAgent(client);
  await agent.run('loop');
  const results = agent.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(results.length, 3);
  assert.match(results[2], /already made this exact list_dir call/);
});

test('asks permission for mutating commands but not read-only ones, and remembers prefixes', async () => {
  const asked = [];
  const bash = (command) => ({ content: '', tool_calls: [{ function: { name: 'bash', arguments: { command } } }] });
  const client = fakeClient([bash('ls'), bash('echo a; true'), bash('true x one'), bash('true x two'), { content: 'done' }]);
  const agent = await makeAgent(client, {
    autoApprove: false,
    askPermission: async (name, args, prefix) => {
      asked.push(args.command);
      return prefix ? 'always' : 'yes';
    },
  });
  await agent.run('go');
  assert.deepEqual(asked, ['echo a; true', 'true x one']);
});

test('snapshot and restore round-trip a session', async () => {
  const client = fakeClient([{ content: 'hello' }]);
  const agent = await makeAgent(client);
  await agent.run('hi');
  agent.state.todos = [{ content: 'x', status: 'pending' }];
  const saved = JSON.parse(JSON.stringify(agent.snapshot()));

  const other = await makeAgent(fakeClient([]), { systemPrompt: 'new system' });
  other.restore(saved);
  assert.equal(other.messages[0].content, 'new system');
  assert.deepEqual(other.messages.slice(1), agent.messages.slice(1));
  assert.deepEqual(other.state.todos, saved.todos);
});
