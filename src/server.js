// Starts a local Ollama server when Klaude can't reach one.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { klaudeHome } from './paths.js';

export const ollamaLogFile = () => path.join(klaudeHome(), 'ollama.log');

export function isLocalHost(host) {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(new URL(host).hostname);
  } catch {
    return false;
  }
}

// Runs `ollama serve` in the background (it keeps running after Klaude exits)
// and waits until the API answers. Output goes to ~/.klaude/ollama.log.
export async function startOllama(client, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(ollamaLogFile()), { recursive: true });
  const log = fs.openSync(ollamaLogFile(), 'a');
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, OLLAMA_HOST: new URL(client.host).host },
  });
  let failed = null;
  child.on('error', (err) => (failed = err));
  child.on('exit', (code) => (failed ??= new Error(`ollama serve exited with code ${code}; see ${ollamaLogFile()}`)));
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failed) {
      throw failed.code === 'ENOENT' ? new Error('the `ollama` command was not found. Install Ollama from https://ollama.com') : failed;
    }
    try {
      await client.listModels();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Ollama did not start within ${timeoutMs / 1000}s; see ${ollamaLogFile()}`);
}
