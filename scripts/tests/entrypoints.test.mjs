// Tests the real project installer with local fixtures: safe retirement, stable entrypoints and read-only checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../init-project.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const legacy = name => `import { execFileSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nexecFileSync(process.execPath, [fileURLToPath(new URL('../.vendor/workflow-kit/scripts/${name}.mjs', import.meta.url)), fileURLToPath(new URL('../', import.meta.url))], { stdio: 'inherit' });\n`;
const retained = ['setup-skills', 'install-ponytail-hooks', 'install-impeccable-hooks'];

function fixture(t, old = true) {
  const base = mkdtempSync(join(tmpdir(), 'kit entrypoints '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer');
  const kit = join(root, '.vendor/workflow-kit');
  for (const path of ['.git', '.github', 'scripts', '.vendor/workflow-kit/scripts', '.vendor/workflow-kit/templates'])
    mkdirSync(join(root, path), { recursive: true });
  copyFileSync(installer, join(kit, 'scripts/init-project.mjs'));
  const files = {};
  if (old) for (const name of [...retained, 'check-skills']) {
    const path = `scripts/${name}.mjs`;
    writeFileSync(join(root, path), legacy(name));
    files[path] = hash(legacy(name));
  }
  const receipt = join(root, '.github/workflow-kit.json');
  writeFileSync(receipt, JSON.stringify({ files, hooks: {} }, null, 2) + '\n');
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), root, '--existing', ...args], {
    cwd: base, encoding: 'utf8', timeout: 10000,
  });
  return { base, root, kit, receipt, run };
}

function succeeds(result) { assert.equal(result.status, 0, result.stderr); }

test('migration retires only the unedited managed checker and repeats without drift', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'scripts/custom.mjs'), '// user-owned\n');
  const before = readFileSync(f.receipt, 'utf8');
  assert.notEqual(f.run('--check').status, 0);
  assert.equal(readFileSync(f.receipt, 'utf8'), before);
  assert.ok(existsSync(join(f.root, 'scripts/check-skills.mjs')));
  succeeds(f.run());
  assert.equal(existsSync(join(f.root, 'scripts/check-skills.mjs')), false);
  assert.equal(readFileSync(join(f.root, 'scripts/custom.mjs'), 'utf8'), '// user-owned\n');
  const after = readFileSync(f.receipt, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(after).files).sort(), retained.map(name => `scripts/${name}.mjs`).sort());
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.equal(readFileSync(f.receipt, 'utf8'), after);
});

for (const name of ['check-skills', 'setup-skills']) test(`edited ${name} is preserved and migration publishes nothing`, t => {
  const f = fixture(t);
  const path = join(f.root, `scripts/${name}.mjs`);
  writeFileSync(path, '// local modification\n');
  const receipt = readFileSync(f.receipt, 'utf8');
  const hook = readFileSync(join(f.root, 'scripts/install-ponytail-hooks.mjs'), 'utf8');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(path, 'utf8'), '// local modification\n');
  assert.equal(readFileSync(f.receipt, 'utf8'), receipt);
  assert.equal(readFileSync(join(f.root, 'scripts/install-ponytail-hooks.mjs'), 'utf8'), hook);
});

test('fresh integration neither creates a checker wrapper nor deletes an unmanaged one', t => {
  const f = fixture(t, false);
  succeeds(f.run());
  assert.equal(existsSync(join(f.root, 'scripts/check-skills.mjs')), false);
  writeFileSync(join(f.root, 'scripts/check-skills.mjs'), '// custom checker\n');
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.equal(readFileSync(join(f.root, 'scripts/check-skills.mjs'), 'utf8'), '// custom checker\n');
});

test('retained entrypoints forward the consumer path from another cwd and preserve failures', t => {
  const f = fixture(t); succeeds(f.run());
  for (const name of retained) {
    writeFileSync(join(f.kit, `scripts/${name}.mjs`), 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.FIXTURE_EXIT ?? 0);\n');
    const call = exit => spawnSync(process.execPath, [join(f.root, `scripts/${name}.mjs`)], {
      cwd: f.base, encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE_EXIT: String(exit) },
    });
    const result = call(0); succeeds(result);
    assert.equal(resolve(JSON.parse(result.stdout)[0]), f.root);
    assert.notEqual(call(7).status, 0);
  }
});
