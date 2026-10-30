import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingView } from '../src/thinking.js';

function view(opts) {
  const v = new ThinkingView({ live: false, ...opts, out: (s) => (v.output += s) });
  v.output = '';
  return v;
}

test('collapsed by default: only a summary line, text kept for later', () => {
  const v = view();
  v.push('step one ');
  v.push('step two');
  v.end();
  assert.match(v.output, /^\n✻ Thought for 1s · ctrl\+o to expand\n$/);
  assert.equal(v.text, 'step one step two');
});

test('verbose streams the thinking', () => {
  const v = view({ verbose: true });
  v.push('step one');
  v.end();
  assert.equal(v.output, '\n✻ thinking…\nstep one\n');
});

test('expanding mid-block prints what was collapsed, then streams the rest', () => {
  const v = view();
  v.push('hidden part ');
  v.setVerbose(true);
  v.push('live part');
  v.end();
  assert.equal(v.output, '\n\n✻ thinking…\nhidden part live part\n');
});

test('a new block replaces the previous text', () => {
  const v = view();
  v.push('first');
  v.end();
  v.push('second');
  v.end();
  assert.equal(v.text, 'second');
});
