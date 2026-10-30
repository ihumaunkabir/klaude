import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createClient, toOpenAIMessages, toAnthropicMessages } from '../src/providers.js';
import { saveCredentials, resolveCredentials, credentialsFile } from '../src/settings.js';
import { findSession, formatTranscript } from '../src/session.js';

// A conversation in the agent's format: a tool call, its result, a follow-up.
const conversation = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: 'read a.txt' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
  { role: 'tool', tool_name: 'read_file', content: '1\thello' },
  { role: 'assistant', content: 'It says hello.' },
  { role: 'user', content: 'thanks' },
];

test('converts the conversation to OpenAI format with matching tool call ids', () => {
  const out = toOpenAIMessages(conversation);
  assert.deepEqual(out[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_2_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'call_2_0', content: '1\thello' });
  assert.equal(out.length, 6);
});

test('converts the conversation to Anthropic format', () => {
  const { system, messages } = toAnthropicMessages(conversation);
  assert.equal(system, 'be helpful');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(messages[1].content, [{ type: 'tool_use', id: 'toolu_2_0', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_2_0', content: '1\thello' }]);
});

// Serves canned server-sent events and records the requests it gets.
async function mockServer(events) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
    res.setHeader('content-type', 'text/event-stream');
    for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

test('OpenAI-compatible client streams text, reasoning and tool calls', async () => {
  const server = await mockServer([
    { choices: [{ delta: { reasoning_content: 'hmm' } }] },
    { choices: [{ delta: { content: 'Let me look.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    '[DONE]',
  ]);
  try {
    const client = createClient('openai-compatible', { apiKey: 'sk-test', baseUrl: server.url });
    assert.deepEqual(await client.listModels(), ['model-a', 'model-b']);
    const chunks = await collect(client.chat({ model: 'm', messages: conversation, tools: [] }));
    assert.deepEqual(chunks.slice(0, 2), [{ message: { thinking: 'hmm' } }, { message: { content: 'Let me look.' } }]);
    assert.deepEqual(chunks.at(-1), {
      message: { tool_calls: [{ id: 'call_x', function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      done: true,
      prompt_eval_count: 12,
      eval_count: 5,
    });
    assert.equal(server.requests[1].headers.authorization, 'Bearer sk-test');
    assert.equal(server.requests[1].url, '/chat/completions');
  } finally {
    server.close();
  }
});

test('Anthropic client streams text and tool calls, with prompt caching', async () => {
  const server = await mockServer([
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
    { type: 'message_delta', usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]);
  try {
    process.env.KLAUDE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-home-'));
    const client = createClient('anthropic', { apiKey: 'sk-ant-test', baseUrl: server.url });
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }];
    const chunks = await collect(client.chat({ model: 'claude-x', messages: conversation, tools }));
    assert.deepEqual(chunks[0], { message: { content: 'Reading.' } });
    assert.deepEqual(chunks.at(-1), {
      message: { tool_calls: [{ id: 'toolu_1', function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      done: true,
      prompt_eval_count: 100,
      eval_count: 7,
    });
    const req = server.requests[0];
    assert.equal(req.headers['x-api-key'], 'sk-ant-test');
    assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
    assert.equal(req.body.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
    assert.deepEqual(req.body.tools, [{ name: 'read_file', description: 'Read', input_schema: { type: 'object' } }]);
  } finally {
    server.close();
  }
});

test('provider errors are reported with their message', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const client = createClient('anthropic', { apiKey: 'bad', baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(client.listModels(), /Anthropic \(Claude\) 401: invalid x-api-key/);
  } finally {
    server.close();
  }
  assert.throws(() => createClient('openai', {}), /No API key for OpenAI; run \/login or set OPENAI_API_KEY/);
});

test('API keys are stored privately and environment variables win', async () => {
  process.env.KLAUDE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-home-'));
  await saveCredentials('openai', { apiKey: 'sk-saved' });
  assert.equal((await fs.stat(credentialsFile())).mode & 0o777, 0o600);
  assert.equal((await resolveCredentials('openai', 'KLAUDE_TEST_KEY')).apiKey, 'sk-saved');
  process.env.KLAUDE_TEST_KEY = 'sk-env';
  assert.equal((await resolveCredentials('openai', 'KLAUDE_TEST_KEY')).apiKey, 'sk-env');
  delete process.env.KLAUDE_TEST_KEY;
  await saveCredentials('openai', null);
  assert.deepEqual(await resolveCredentials('openai'), { apiKey: undefined });
});

test('sessions can be found by number, name or id, and shown as history', () => {
  const sessions = [
    { id: '2026-b', name: 'api-work', messages: [] },
    { id: '2026-a', name: 'docs', messages: [] },
  ];
  assert.equal(findSession(sessions, '2').id, '2026-a');
  assert.equal(findSession(sessions, 'API-work').id, '2026-b');
  assert.equal(findSession(sessions, '2026-a').id, '2026-a');
  assert.equal(findSession(sessions, 'api').id, '2026-b');
  assert.equal(findSession(sessions, 'nope'), null);

  const history = formatTranscript([
    ...conversation.slice(0, 5),
    { role: 'user', content: 'thanks\n\nAttached by the user:\n<file path="x">…</file>' },
  ]);
  assert.match(history, /› read a\.txt\n⏺ read_file\(a\.txt\)\n\nIt says hello\.\n\n› thanks\n/);
  assert.doesNotMatch(history, /Attached by the user|1\thello/);
});
