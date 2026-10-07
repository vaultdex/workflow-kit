import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { TABLE, affectedTests } from '../affected-tests.mjs';

const names = result => result.tests.map(path => path.replace('scripts/tests/', ''));

test('a Markdown change selects only the static file checks', () => {
  assert.deepEqual(names(affectedTests(['docs/parallel-drivers.md', 'README.md'])), ['text-files.test.mjs']);
});

test('a board.mjs change selects the board tests, not the Git hook tests', () => {
  const selected = names(affectedTests(['scripts/board.mjs']));
  assert.ok(selected.includes('board-check.test.mjs') && selected.includes('board-wait.test.mjs'));
  assert.ok(selected.every(name => name.startsWith('board-') || name === 'text-files.test.mjs'), selected.join());
});

test('a hook change selects the hook tests and nothing slower than needed', () => {
  assert.deepEqual(names(affectedTests(['scripts/git-hooks/post-checkout'])), ['git-hooks.test.mjs', 'kit-init-hook.test.mjs']);
});

test('a changed test runs itself; an unmapped script is reported instead of skipped', () => {
  const result = affectedTests(['scripts/tests/setup.test.mjs', 'scripts/setup-github.mjs']);
  assert.ok(names(result).includes('setup.test.mjs'));
  assert.deepEqual(result.unmapped, ['scripts/setup-github.mjs']);
});

test('every table row points at tests that exist', () => {
  const available = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
  for (const [, targets] of TABLE) for (const target of targets)
    assert.ok(available.some(name => (target instanceof RegExp ? target.test(name) : name === target)), String(target));
});
