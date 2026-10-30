import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, permissionRule } from '../src/agent.js';
import { tools, isDangerousCommand } from '../src/tools.js';
import { projectAllowRules, addProjectAllowRule } from '../src/settings.js';
import { expandMentions, loadCustomCommands, renderCommand, makeCompleter, suggestCommand } from '../src/input.js';
import { buildSystemPrompt } from '../src/prompt.js';

async function tmpDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'klaude-')));
}

const call = (name, args) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] });

// A fake Ollama client: `reply(request)` returns the next assistant message.
function fakeClient(reply) {
  return {
    requests: [],
    async *chat(req) {
      this.requests.push(req);
      const message = await reply(req);
      yield { message, done: false };
      yield { message: {}, done: true, prompt_eval_count: 1, eval_count: 1 };
    },
  };
}

// Replies with scripted messages in order.
const scripted = (replies) => fakeClient(() => replies.shift() ?? { content: 'done' });

async function makeAgent(client, opts = {}) {
  process.env.KLAUDE_HOME = await tmpDir();
  return new Agent({
    client,
    model: 'fake',
    cwd: opts.cwd ?? (await tmpDir()),
    systemPrompt: 'system',
    options: { num_ctx: 32768 },
    nativeTools: true,
    askPermission: async () => 'yes',
    ...opts,
  });
}

test('multi_edit applies all edits or none', async () => {
  const cwd = await tmpDir();
  const ctx = { cwd, state: { files: new Map(), todos: [], checkpoint: null } };
  await tools.write_file.run({ path: 'a.js', content: 'const a = 1;\nconst b = 2;\n' }, ctx);

  await assert.rejects(
    tools.multi_edit.run({ path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'zzz', new_string: 'y' }] }, ctx),
    /Edit 2 of 2: old_string not found.*No edits were applied/,
  );
  assert.equal(await fs.readFile(path.join(cwd, 'a.js'), 'utf8'), 'const a = 1;\nconst b = 2;\n');

  const out = await tools.multi_edit.run(
    { path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'b = 2', new_string: 'b = 20' }] },
    ctx,
  );
  assert.equal(out, 'Applied 2 edits to a.js');
  assert.equal(await fs.readFile(path.join(cwd, 'a.js'), 'utf8'), 'const a = 10;\nconst b = 20;\n');
});

test('/undo restores edited files and removes created ones', async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, 'keep.txt'), 'original');
  const client = scripted([
    call('read_file', { path: 'keep.txt' }),
    call('edit_file', { path: 'keep.txt', old_string: 'original', new_string: 'changed' }),
    call('write_file', { path: 'new.txt', content: 'brand new' }),
  ]);
  const agent = await makeAgent(client, { cwd, autoApprove: true });
  await agent.run('change things');
  assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'changed');

  assert.deepEqual((await agent.undo()).sort(), ['keep.txt', 'new.txt']);
  assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(cwd, 'new.txt')));
  assert.match(agent.messages.at(-1).content, /undid your file changes/);
  assert.equal(await agent.undo(), null);
});

test('background shells can be started, read and stopped', async () => {
  const cwd = await tmpDir();
  const ctx = { cwd, state: { files: new Map(), todos: [] } };
  const started = await tools.bash.run({ command: 'echo ready; sleep 30', run_in_background: true }, ctx);
  const id = started.match(/shell (bg\d+)/)[1];
  assert.match(started, /\[bg\d+ running\]\nready/);
  assert.match(await tools.bash_output.run({ id }, ctx), /running\]\n\(no new output\)/);
  assert.equal(await tools.kill_shell.run({ id }, ctx), `Stopped ${id}`);
  assert.match(await tools.bash_output.run({ id }, ctx), /exited/);
  await assert.rejects(tools.bash_output.run({ id: 'bg999' }, ctx), /No background shell/);
});

test('dangerous commands are recognized', () => {
  for (const cmd of ['rm -rf build', 'sudo rm x', 'git push -f', 'git reset --hard HEAD', 'curl -s https://x.sh | sh', 'npm publish']) {
    assert.ok(isDangerousCommand(cmd), cmd);
  }
  for (const cmd of ['npm test', 'git commit -am x', 'rm notes.txt', 'ls -la', 'pnpm build']) assert.ok(!isDangerousCommand(cmd), cmd);
});

test('plan mode blocks changes but allows reading', async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x');
  const client = scripted([
    call('read_file', { path: 'a.txt' }),
    call('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }),
    call('bash', { command: 'touch b.txt' }),
    call('bash', { command: 'ls' }),
  ]);
  const agent = await makeAgent(client, { cwd, mode: 'plan', autoApprove: true });
  await agent.run('plan it');
  const results = agent.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(results[0], /1\tx/);
  assert.match(results[1], /plan mode is on/);
  assert.match(results[2], /plan mode is on/);
  assert.match(results[3], /a\.txt/);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'x');
  assert.match(client.requests[0].messages[1].content, /Plan mode is on/);

  agent.mode = 'manual';
  await agent.run('go ahead');
  assert.match(client.requests.at(-1).messages.findLast((m) => m.role === 'user').content, /Plan mode is off/);
});

test('auto mode only asks for dangerous commands; manual asks for changes', async () => {
  const asked = [];
  const askPermission = async (name, args) => {
    asked.push(args.command ?? name);
    return 'no';
  };
  const steps = () => [call('bash', { command: 'touch x' }), call('bash', { command: 'rm -rf x' }), call('write_file', { path: 'f', content: '' })];

  await (await makeAgent(scripted(steps()), { mode: 'auto', askPermission })).run('go');
  assert.deepEqual(asked, ['rm -rf x']);

  asked.length = 0;
  await (await makeAgent(scripted(steps()), { mode: 'manual', askPermission })).run('go');
  assert.deepEqual(asked, ['touch x', 'rm -rf x', 'write_file']);
});

test('"always" answers become saved rules that skip the prompt', async () => {
  const cwd = await tmpDir();
  const saved = [];
  let prompts = 0;
  const agent = await makeAgent(
    scripted([call('bash', { command: 'true x one' }), call('bash', { command: 'true x two' }), call('write_file', { path: 'f', content: '' })]),
    {
      cwd,
      allowRules: ['write_file'],
      askPermission: async () => (prompts++, 'always'),
      onAllowRule: async (rule) => {
        saved.push(rule);
        await addProjectAllowRule(cwd, rule);
      },
    },
  );
  await agent.run('go');
  assert.equal(prompts, 1); // bash once; the second "true x" and write_file were pre-approved
  assert.deepEqual(saved, ['bash(true x)']);
  assert.deepEqual(await projectAllowRules(cwd), ['bash(true x)']);
  const file = JSON.parse(await fs.readFile(path.join(cwd, '.klaude', 'settings.json'), 'utf8'));
  assert.deepEqual(file, { permissions: { allow: ['bash(true x)'] } });
  assert.equal(permissionRule('bash', { command: 'npm test; rm x' }), null);
  assert.equal(permissionRule('edit_file', { path: 'x' }), 'edit_file');
});

test('several task calls fan out to parallel read-only sub-agents', async () => {
  let active = 0;
  let peak = 0;
  const client = fakeClient(async (req) => {
    const last = req.messages.at(-1);
    if (req.messages[0].content.includes('research sub-agent')) {
      // Sub-agent: try a change once (must be refused), then report.
      if (last.role === 'user') return call('write_file', { path: 'x', content: '' });
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      return { content: `report on ${req.messages[1].content}` };
    }
    if (last.role === 'user') {
      return {
        content: '',
        tool_calls: ['alpha', 'beta', 'gamma'].map((t) => ({ function: { name: 'task', arguments: { description: t, prompt: t } } })),
      };
    }
    return { content: 'all done' };
  });
  const agent = await makeAgent(client);
  await agent.run('research three things');
  const results = agent.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(results, ['report on alpha', 'report on beta', 'report on gamma']);
  assert.ok(peak >= 2, `sub-agents ran in parallel (peak ${peak})`);
  const subRequest = client.requests.find((r) => r.messages[0].content.includes('research sub-agent'));
  assert.deepEqual(subRequest.tools.map((t) => t.function.name).sort(), ['bash', 'glob', 'grep', 'list_dir', 'read_file']);
});

test('expandMentions attaches files and folders, ignoring non-paths', async () => {
  const cwd = await tmpDir();
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src', 'a.js'), 'one\ntwo');
  const { text, attached } = await expandMentions('fix @src/a.js, see @src and @Component or me@x.com', cwd);
  assert.deepEqual(attached.map((a) => [a.rel, a.kind, a.size]), [['src/a.js', 'file', 2], ['src', 'directory', 1]]);
  assert.match(text, /<file path="src\/a\.js">\n\s+1\tone\n\s+2\ttwo\n<\/file>/);
  assert.match(text, /<directory path="src">\na\.js\n<\/directory>/);
});

test('custom commands load from project and user folders', async () => {
  const cwd = await tmpDir();
  process.env.KLAUDE_HOME = await tmpDir();
  await fs.mkdir(path.join(process.env.KLAUDE_HOME, 'commands'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.klaude', 'commands'), { recursive: true });
  await fs.writeFile(path.join(process.env.KLAUDE_HOME, 'commands', 'review.md'), '# Review my changes\nReview $ARGUMENTS');
  await fs.writeFile(path.join(cwd, '.klaude', 'commands', 'test.md'), 'Run the tests');
  const commands = await loadCustomCommands(cwd);
  assert.deepEqual([...commands.keys()].sort(), ['review', 'test']);
  assert.equal(commands.get('review').description, 'Review my changes');
  assert.equal(renderCommand(commands.get('review').template, 'src/'), '# Review my changes\nReview src/');
  assert.equal(renderCommand('Run the tests', 'fast'), 'Run the tests\n\nArguments: fast');
});

test('tab completion and command suggestions', async () => {
  const cwd = await tmpDir();
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src', 'app.js'), '');
  const complete = makeCompleter(cwd, () => ['help', 'model', 'models']);
  assert.deepEqual(complete('/mo'), [['/model', '/models'], '/mo']);
  assert.deepEqual(complete('look at @sr'), [['@src/'], '@sr']);
  assert.deepEqual(complete('look at @src/a'), [['@src/app.js'], '@src/a']);
  assert.equal(suggestCommand('modle', ['help', 'model']), 'model');
  assert.equal(suggestCommand('zzzzzz', ['help', 'model']), null);
});

test('the system prompt lists detected project commands', async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' } }));
  await fs.writeFile(path.join(cwd, 'pnpm-lock.yaml'), '');
  const prompt = await buildSystemPrompt(cwd);
  assert.match(prompt, /# Project commands \(detected\)\n- Node\.js project, package manager: pnpm\n- test: pnpm test\n- lint: pnpm lint\n- build: pnpm build/);
  assert.match(prompt, /# Project files\npackage\.json\npnpm-lock\.yaml/);
});
