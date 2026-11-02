import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands, moveSelection } from '../src/command-menu.js';

const COMMANDS = [
  { name: 'help', description: 'Show this help' },
  { name: 'memory', description: 'Show saved memories' },
  { name: 'mode', description: 'Show or switch the mode' },
  { name: 'models', description: 'List models' },
];

test('filterCommands matches by prefix, case-insensitive', () => {
  assert.deepEqual(filterCommands('mo', COMMANDS).map((cmd) => cmd.name), ['mode', 'models']);
  assert.deepEqual(filterCommands('MEM', COMMANDS).map((cmd) => cmd.name), ['memory']);
});

test('filterCommands: empty query lists everything, unknown prefix nothing', () => {
  assert.equal(filterCommands('', COMMANDS).length, COMMANDS.length);
  assert.deepEqual(filterCommands('zzz', COMMANDS), []);
});

test('moveSelection stays inside the list', () => {
  assert.equal(moveSelection(3, 1, 1), 2); // normal move
  assert.equal(moveSelection(3, 0, -1), 0); // clamps at the top
  assert.equal(moveSelection(3, 2, 1), 2); // clamps at the bottom
  assert.equal(moveSelection(0, 0, 1), 0); // empty list stays put
});
