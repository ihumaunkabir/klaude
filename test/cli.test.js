// End-to-end tests of the real CLI entry point (no Ollama needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const BIN = new URL('../bin/klaude.js', import.meta.url).pathname;
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function klaude(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

test('--help lists options and commands', async () => {
  const { code, stdout } = await klaude('--help');
  assert.equal(code, 0);
  for (const s of ['--model', '--print', '--continue', '--resume', '--yes', '--ctx', '--version', '/compact', '/todos', '/memory', '/sessions', '/resume']) {
    assert.ok(stdout.includes(s), `help mentions ${s}`);
  }
});

test('--version prints the package version', async () => {
  for (const flag of ['--version', '-v']) {
    const { code, stdout } = await klaude(flag);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), version);
  }
});

test('unknown flags fail with a short message', async () => {
  const { code, stderr } = await klaude('--bogus');
  assert.equal(code, 2);
  assert.match(stderr, /Unknown option '--bogus'/);
  assert.doesNotMatch(stderr, /\bat \w/); // no stack trace
});

test('an unreachable Ollama host gives a helpful error', async () => {
  const { code, stderr } = await klaude('--host', '127.0.0.1:9', '-p', 'hi');
  assert.equal(code, 1);
  assert.match(stderr, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:9/);
  assert.match(stderr, /ollama serve/);
});
