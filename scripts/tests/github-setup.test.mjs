import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('GitHub setup refuses checkout-controlled CLI before authentication', t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-github-'));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  const localTools = join(root, 'tools');
  mkdirSync(localTools);
  const executable = join(localTools, process.platform === 'win32' ? 'gh.exe' : 'gh');
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  writeFileSync(join(root, 'repo'), "require('node:fs').writeFileSync('executed', 'unsafe CLI lookup');\n");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../setup-github.mjs', import.meta.url)), 'test/example'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: ['.', localTools].join(delimiter) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Install GitHub CLI in an absolute PATH directory outside/);
  assert.equal(existsSync(join(root, 'executed')), false);
  assert.equal(existsSync(join(root, '.github/workflow-project.json')), false);
});
