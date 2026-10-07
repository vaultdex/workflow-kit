import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TABLE, affectedTests, projectCommands, readProjectMap } from '../affected-tests.mjs';
import { run, temporary } from './fixtures.mjs';

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

test('a project map names the commands of the changed paths, each once', () => {
  const map = { 'backend/domain/**': './gradlew :domain:test', 'frontend/web/**': ['npm test', './gradlew :domain:test'], '*.md': [] };
  assert.deepEqual(projectCommands(['backend/domain/src/A.java', 'frontend/web/a.ts'], map), ['./gradlew :domain:test', 'npm test']);
  assert.deepEqual(projectCommands(['backend/api/A.java', 'x/frontend/web/a.ts', 'README.md'], map), []);
});

test('with a project file the command lists its entries; without one nothing changes', async t => {
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.git'));
  const ask = () => run(process.execPath, [fileURLToPath(new URL('../affected-tests.mjs', import.meta.url)), 'backend/domain/A.java', 'scripts/board.mjs'], { cwd: project });
  const without = await ask();
  assert.deepEqual([without.status, without.stdout], [0, '']); // the project's scripts/board.mjs is no kit file
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'backend/domain/**': './gradlew :domain:test' }));
  assert.equal((await ask()).stdout, './gradlew :domain:test\n');
});

test('a project entry without a command is refused', t => {
  const project = temporary(t, 'affected-tests-');
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.github/affected-tests.json'), JSON.stringify({ 'backend/**': 3 }));
  assert.throws(() => readProjectMap(project), /"backend\/\*\*" needs a command/);
});

test('every table row points at tests that exist', () => {
  const available = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
  for (const [, targets] of TABLE) for (const target of targets)
    assert.ok(available.some(name => (target instanceof RegExp ? target.test(name) : name === target)), String(target));
});
