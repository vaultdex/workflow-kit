import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { isolatedGit, run, temporary } from './fixtures.mjs';

const check = root => `import { requireSubmodules } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)}; requireSubmodules(${JSON.stringify(root)}); console.log('continued');`;

test('a clone without initialized submodules stops with the one command that fixes it, and no stack trace', async t => {
  const root = temporary(t, 'submodule hint ');
  const env = isolatedGit(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  mkdirSync(join(root, '.vendor/pin'), { recursive: true });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},.vendor/pin`], { cwd: root, env });
  const missing = await run(process.execPath, ['--input-type=module', '-e', check(root)], { env });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'run: git submodule update --init --recursive\n');

  // An initialized submodule has a .git entry: the check lets the test go on.
  execFileSync('git', ['init', '-q', join(root, '.vendor/pin')], { env });
  const ready = await run(process.execPath, ['--input-type=module', '-e', check(root)], { env });
  assert.equal(ready.status, 0, ready.stderr);
});
