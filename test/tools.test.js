import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tools, globToRegExp, isReadOnlyCommand, commandPrefix, runProcess } from '../src/tools.js';

async function tmpCtx() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-')));
  return { cwd, state: { files: new Map(), todos: [] } };
}

test('globToRegExp', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegExp('**/*.js').test('c.js'));
  assert.ok(!globToRegExp('*.js').test('a/c.js'));
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.tsx'));
  assert.ok(!globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.js'));
});

test('write, read and edit a file', async () => {
  const ctx = await tmpCtx();
  await tools.write_file.run({ path: 'a/b.txt', content: 'one\ntwo\nthree' }, ctx);
  const read = await tools.read_file.run({ path: 'a/b.txt' }, ctx);
  assert.match(read, /^\s+1\tone\n\s+2\ttwo\n\s+3\tthree$/);

  await tools.edit_file.run({ path: 'a/b.txt', old_string: 'two', new_string: '2' }, ctx);
  assert.equal(await fs.readFile(path.join(ctx.cwd, 'a/b.txt'), 'utf8'), 'one\n2\nthree');
});

test('edit_file rejects missing and ambiguous matches', async () => {
  const ctx = await tmpCtx();
  await tools.write_file.run({ path: 'f.txt', content: 'x x' }, ctx);
  await assert.rejects(tools.edit_file.run({ path: 'f.txt', old_string: 'y', new_string: 'z' }, ctx), /not found/);
  await assert.rejects(tools.edit_file.run({ path: 'f.txt', old_string: 'x', new_string: 'z' }, ctx), /2 times/);
  await tools.edit_file.run({ path: 'f.txt', old_string: 'x', new_string: '$&', replace_all: true }, ctx);
  assert.equal(await fs.readFile(path.join(ctx.cwd, 'f.txt'), 'utf8'), '$& $&');
});

test('glob, grep and bash', async () => {
  const ctx = await tmpCtx();
  await tools.write_file.run({ path: 'src/main.js', content: 'const hello = 1;\n' }, ctx);
  await tools.write_file.run({ path: 'node_modules/x/index.js', content: 'hello\n' }, ctx);

  assert.equal(await tools.glob.run({ pattern: '**/*.js' }, ctx), path.join('src', 'main.js'));
  assert.match(await tools.grep.run({ pattern: 'hel+o' }, ctx), /src\/main\.js:1:const hello/);
  assert.equal(await tools.grep.run({ pattern: 'nope' }, ctx), 'No matches');
  assert.equal(await tools.bash.run({ command: 'echo hi; exit 3' }, ctx), 'hi\n[exit code: 3]');
  assert.equal(await tools.bash.run({ command: 'echo " M x"' }, ctx), ' M x\n[exit code: 0]');
  assert.equal(await tools.bash.run({ command: 'true' }, ctx), '[exit code: 0]');
});

test('edits require a fresh read', async () => {
  const ctx = await tmpCtx();
  await fs.writeFile(path.join(ctx.cwd, 'f.txt'), 'hello');
  await assert.rejects(tools.edit_file.run({ path: 'f.txt', old_string: 'hello', new_string: 'bye' }, ctx), /not been read/);
  await assert.rejects(tools.write_file.run({ path: 'f.txt', content: 'x' }, ctx), /not been read/);

  await tools.read_file.run({ path: 'f.txt' }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(ctx.cwd, 'f.txt'), 'hello world'); // changed behind the agent's back
  await assert.rejects(tools.edit_file.run({ path: 'f.txt', old_string: 'hello', new_string: 'bye' }, ctx), /changed since/);

  await tools.read_file.run({ path: 'f.txt' }, ctx);
  await tools.edit_file.run({ path: 'f.txt', old_string: 'hello', new_string: 'bye' }, ctx);
  await tools.edit_file.run({ path: 'f.txt', old_string: 'world', new_string: 'all' }, ctx); // own edits keep it fresh
  assert.equal(await fs.readFile(path.join(ctx.cwd, 'f.txt'), 'utf8'), 'bye all');
});

test('read_file rejects binary files and truncates huge lines', async () => {
  const ctx = await tmpCtx();
  await fs.writeFile(path.join(ctx.cwd, 'b.bin'), Buffer.from([1, 0, 2]));
  await assert.rejects(tools.read_file.run({ path: 'b.bin' }, ctx), /binary/);
  await fs.writeFile(path.join(ctx.cwd, 'min.js'), 'x'.repeat(5000));
  assert.match(await tools.read_file.run({ path: 'min.js' }, ctx), /line truncated/);
});

test('bash does not wait for background processes and honours timeouts', async () => {
  const ctx = await tmpCtx();
  let t = Date.now();
  assert.equal(await tools.bash.run({ command: 'sleep 30 & echo started' }, ctx), 'started\n[exit code: 0]');
  assert.ok(Date.now() - t < 3000);

  t = Date.now();
  assert.match(await tools.bash.run({ command: 'sleep 30', timeout: 1 }, ctx), /killed \(timed out after 1s\)/);
  assert.ok(Date.now() - t < 3000);
});

test('runProcess kills the whole process group on abort', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t = Date.now();
  const { code } = await runProcess('bash', ['-c', 'sleep 30; echo done'], { signal: ac.signal });
  assert.equal(code, 'killed (interrupted)');
  assert.ok(Date.now() - t < 3000);
});

test('read-only command detection and permission prefixes', () => {
  for (const cmd of ['ls -la', 'git status', 'git diff HEAD~1', 'cat a.txt | grep x', 'pwd']) assert.ok(isReadOnlyCommand(cmd), cmd);
  for (const cmd of ['rm -rf x', 'ls; rm x', 'echo hi > f', 'git push', 'cat $(whoami)', 'git diff --output=x', 'ls && rm x'])
    assert.ok(!isReadOnlyCommand(cmd), cmd);
  assert.equal(commandPrefix('npm test -- --watch'), 'npm test');
  assert.equal(commandPrefix('npm test; rm -rf /'), null);
});

test('glob respects .gitignore in git repos', async () => {
  const ctx = await tmpCtx();
  await runProcess('git', ['init', '-q'], { cwd: ctx.cwd });
  await fs.writeFile(path.join(ctx.cwd, '.gitignore'), 'out/\n');
  await tools.write_file.run({ path: 'src/a.js', content: '' }, ctx);
  await tools.write_file.run({ path: 'out/b.js', content: '' }, ctx);
  assert.equal(await tools.glob.run({ pattern: '**/*.js' }, ctx), 'src/a.js');
});

test('todo_write stores the list', async () => {
  const ctx = await tmpCtx();
  const out = await tools.todo_write.run(
    { todos: [{ content: 'plan', status: 'completed' }, { content: 'build', status: 'in_progress' }] },
    ctx,
  );
  assert.equal(out, '☒ plan\n◐ build');
  assert.equal(ctx.state.todos.length, 2);
});

test('web_fetch converts HTML to text', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><script>x()</script><h1>Title</h1><p>Hello &amp; welcome</p></html>');
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const ctx = await tmpCtx();
    const out = await tools.web_fetch.run({ url: `http://localhost:${server.address().port}/` }, ctx);
    assert.equal(out, '[200 text/html]\nTitle\nHello & welcome');
  } finally {
    server.close();
  }
});
