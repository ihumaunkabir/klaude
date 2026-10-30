// Minimal streaming client for the Ollama HTTP API.

const RETRIES = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]); // rate limited, overloaded or restarting

// Retries requests that fail to connect or hit a busy/restarting server.
export async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!RETRY_STATUSES.has(res.status) || attempt >= RETRIES) return res;
    } catch (err) {
      if (init.signal?.aborted || attempt >= RETRIES) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    init.signal?.throwIfAborted();
  }
}

export class Ollama {
  constructor(host) {
    this.provider = 'ollama';
    this.host = host.replace(/\/$/, '');
  }

  async listModels() {
    const res = await fetch(`${this.host}/api/tags`);
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const { models } = await res.json();
    return models.map((m) => m.name);
  }

  // Returns the model's capabilities (e.g. "tools", "thinking") and max context length.
  async show(model) {
    const res = await fetch(`${this.host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const info = await res.json();
    const ctxKey = Object.keys(info.model_info ?? {}).find((k) => k.endsWith('.context_length'));
    return {
      capabilities: info.capabilities ?? [],
      contextLength: ctxKey ? info.model_info[ctxKey] : undefined,
    };
  }

  // Yields parsed NDJSON chunks from /api/chat.
  async *chat({ model, messages, tools, options, think, keepAlive, signal }) {
    yield* this.#stream('/api/chat', { model, messages, tools, options, think, keep_alive: keepAlive, stream: true }, signal);
  }

  // Downloads a model; yields progress chunks like { status, completed, total }.
  async *pull(model, signal) {
    yield* this.#stream('/api/pull', { model, stream: true }, signal);
  }

  async *#stream(endpoint, body, signal) {
    const res = await fetchWithRetry(`${this.host}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

    const decoder = new TextDecoder();
    let buf = '';
    for await (const bytes of res.body) {
      buf += decoder.decode(bytes, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
        yield chunk;
      }
    }
  }
}
