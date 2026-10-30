// API-key providers. Each client has the same interface as the Ollama client
// (listModels, show, chat) and yields Ollama-shaped chunks:
//   { message: { content?, thinking?, tool_calls? }, done?, prompt_eval_count?, eval_count? }
// so the agent loop works unchanged with every provider.

import { Ollama, fetchWithRetry } from './ollama.js';

export const PROVIDERS = {
  ollama: { label: 'Ollama (local, no API key)' },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    env: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5-5',
    contextLength: 200000,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    contextLength: 128000,
    streamUsage: true,
  },
  zai: {
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    env: 'ZAI_API_KEY',
    defaultModel: 'glm-4.6',
    contextLength: 128000,
  },
  'openai-compatible': {
    label: 'OpenAI-compatible endpoint (custom URL, e.g. OpenRouter, LM Studio)',
    env: 'OPENAI_COMPATIBLE_API_KEY',
    contextLength: 128000,
    customUrl: true,
  },
};

const MAX_OUTPUT_TOKENS = 16384;

// Creates the client for a provider. credentials: { apiKey, baseUrl } (or { host } for Ollama).
export function createClient(provider, credentials = {}) {
  if (provider === 'ollama') return new Ollama(credentials.host);
  const info = PROVIDERS[provider];
  if (!info) throw new Error(`Unknown provider "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  const baseUrl = (credentials.baseUrl || info.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error(`${info.label} needs a base URL; run /login to set it`);
  if (!credentials.apiKey && !info.customUrl) throw new Error(`No API key for ${info.label}; run /login or set ${info.env}`);
  const Client = provider === 'anthropic' ? AnthropicClient : OpenAIClient;
  return new Client(provider, baseUrl, credentials.apiKey);
}

// Server-sent events: yields the parsed JSON of each `data:` line.
async function* serverEvents(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const bytes of res.body) {
    buf += decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
}

function parseArguments(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return json; // the agent reports invalid JSON back to the model
  }
}

const argumentsObject = (args) => (typeof args === 'string' ? parseArguments(args) : (args ?? {}));

async function check(res, label) {
  if (res.ok) return;
  let detail = await res.text();
  try {
    detail = JSON.parse(detail).error?.message ?? detail;
  } catch {
    // Not JSON; keep the raw text.
  }
  throw new Error(`${label} ${res.status}: ${detail}`);
}

class BaseClient {
  constructor(provider, baseUrl, apiKey) {
    this.provider = provider;
    this.info = PROVIDERS[provider];
    this.host = baseUrl;
    this.apiKey = apiKey;
  }

  // Vendors' models all support tool calling; the context size comes from the provider table.
  async show() {
    return { capabilities: ['tools'], contextLength: this.info.contextLength };
  }
}

// OpenAI Chat Completions, also used by Z.AI and other OpenAI-compatible APIs.
export class OpenAIClient extends BaseClient {
  get headers() {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async listModels() {
    const res = await fetchWithRetry(`${this.host}/models`, { headers: this.headers });
    await check(res, this.info.label);
    return ((await res.json()).data ?? []).map((m) => m.id).sort();
  }

  async *chat({ model, messages, tools, signal }) {
    const body = { model, messages: toOpenAIMessages(messages), stream: true };
    if (tools?.length) body.tools = tools;
    if (this.info.streamUsage) body.stream_options = { include_usage: true };
    const res = await fetchWithRetry(`${this.host}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    await check(res, this.info.label);

    const calls = [];
    let usage;
    for await (const event of serverEvents(res)) {
      if (event.error) throw new Error(`${this.info.label}: ${event.error.message ?? JSON.stringify(event.error)}`);
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) yield { message: { thinking: delta.reasoning_content } };
      if (delta.content) yield { message: { content: delta.content } };
      for (const tc of delta.tool_calls ?? []) {
        // Some compatible APIs omit `index` and send each call whole.
        const index = tc.index ?? (tc.id && !calls.some((c) => c.id === tc.id) ? calls.length : Math.max(0, calls.length - 1));
        const slot = (calls[index] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name ||= tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
    const tool_calls = calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: parseArguments(c.args) } }));
    yield {
      message: tool_calls.length ? { tool_calls } : {},
      done: true,
      prompt_eval_count: usage?.prompt_tokens,
      eval_count: usage?.completion_tokens,
    };
  }
}

// Converts the agent's messages to Chat Completions format. Tool results are
// matched to the preceding assistant's tool calls in order.
export function toOpenAIMessages(messages) {
  const out = [];
  let pending = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc, j) => ({
          id: tc.id || `call_${i}_${j}`,
          type: 'function',
          function: { name: tc.function.name, arguments: JSON.stringify(argumentsObject(tc.function.arguments)) },
        }));
        pending = msg.tool_calls.map((tc) => tc.id);
      } else {
        msg.content ??= '';
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const id = pending.shift();
      out.push(id ? { role: 'tool', tool_call_id: id, content: m.content } : { role: 'user', content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  });
  return out;
}

// Anthropic Messages API, with prompt caching on the system prompt and the
// latest message so long agent loops don't resend the whole history at full price.
export class AnthropicClient extends BaseClient {
  get headers() {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };
  }

  async listModels() {
    const res = await fetchWithRetry(`${this.host}/models?limit=100`, { headers: this.headers });
    await check(res, this.info.label);
    return ((await res.json()).data ?? []).map((m) => m.id);
  }

  async *chat({ model, messages, tools, signal }) {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const last = converted.at(-1)?.content.at(-1);
    if (last) last.cache_control = { type: 'ephemeral' };
    const body = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: converted,
      stream: true,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    }
    const res = await fetchWithRetry(`${this.host}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    await check(res, this.info.label);

    const toolBlocks = new Map(); // content block index -> { id, name, json }
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const event of serverEvents(res)) {
      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage ?? {};
          inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          break;
        }
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
          }
          break;
        case 'content_block_delta': {
          const d = event.delta ?? {};
          if (d.type === 'text_delta') yield { message: { content: d.text } };
          else if (d.type === 'thinking_delta') yield { message: { thinking: d.thinking } };
          else if (d.type === 'input_json_delta') toolBlocks.get(event.index).json += d.partial_json;
          break;
        }
        case 'message_delta':
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        case 'error':
          throw new Error(`${this.info.label}: ${event.error?.message ?? 'stream error'}`);
      }
    }
    const tool_calls = [...toolBlocks.values()].map((b) => ({ id: b.id, function: { name: b.name, arguments: parseArguments(b.json) } }));
    yield { message: tool_calls.length ? { tool_calls } : {}, done: true, prompt_eval_count: inputTokens, eval_count: outputTokens };
  }
}

// Converts the agent's messages to Anthropic format: the system prompt is
// separate, tool calls become tool_use blocks, tool results become tool_result
// blocks in the next user turn, and consecutive same-role turns are merged.
export function toAnthropicMessages(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out = [];
  const push = (role, blocks) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  let pending = [];
  messages.forEach((m, i) => {
    if (m.role === 'system') return;
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content });
      (m.tool_calls ?? []).forEach((tc, j) => {
        const input = argumentsObject(tc.function.arguments);
        blocks.push({ type: 'tool_use', id: tc.id || `toolu_${i}_${j}`, name: tc.function.name, input: typeof input === 'object' ? input : {} });
      });
      pending = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no response)' }]);
    } else if (m.role === 'tool') {
      const id = pending.shift();
      push('user', [id ? { type: 'tool_result', tool_use_id: id, content: m.content || '(empty)' } : { type: 'text', text: m.content || '(empty)' }]);
    } else {
      push('user', [{ type: 'text', text: m.content || '(empty)' }]);
    }
  });
  return { system, messages: out };
}
