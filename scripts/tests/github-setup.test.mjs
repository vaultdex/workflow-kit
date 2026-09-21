import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const localGit = join(localTools, process.platform === 'win32' ? 'git.exe' : 'git');
  copyFileSync(process.execPath, localGit); chmodSync(localGit, 0o755);
  for (const script of ['check-skills.mjs', 'check-impeccable.mjs', 'tests/impeccable-installation.test.mjs']) {
    const check = spawnSync(process.execPath, [fileURLToPath(new URL('../' + script, import.meta.url)), root], {
      cwd: root, encoding: 'utf8', env: {...process.env, PATH: ['.', localTools].join(delimiter)},
    });
    assert.notEqual(check.status, 0, script);
    assert.match(check.stdout + check.stderr, /Install Git outside the checkout/, script);
  }
});

test('Rejected supplied boards do not poison retries; copied boards survive failures', t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-project-'));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  const checkout = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(checkout); mkdirSync(bin);
  const executable = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
  copyFileSync(process.execPath, executable); chmodSync(executable, 0o755);
  // Node acts as the fixture CLI; command names select disposable response scripts.
  writeFileSync(join(checkout, 'repo'), 'console.log(JSON.stringify({viewerPermission:"ADMIN"}));');
  writeFileSync(join(checkout, 'api'), 'console.log("[[]]");');
  writeFileSync(join(checkout, 'label'), '');
  writeFileSync(join(checkout, 'project'), `
    const args = process.argv.slice(2), number = Number(args[1]);
    if (args[0] === 'view' || args[0] === 'copy')
      console.log(JSON.stringify({number: args[0] === 'copy' ? 3 : number, id: 'fixture', url: 'https://example.invalid/board'}));
    if (args[0] === 'field-list') console.log(JSON.stringify({fields: number === 2 ? [
      {name:'Status',options:['Backlog','Ready','In progress','In review','Done'].map(name=>({name}))},
      {name:'Priority',options:[{name:'High'},{name:'Low'}]}
    ] : []}));
  `);
  const marker = join(checkout, '.github/workflow-project.json');
  const run = (...args) => spawnSync(process.execPath,
    [fileURLToPath(new URL('../setup-github.mjs', import.meta.url)), 'test/example', ...args],
    {cwd: checkout, encoding: 'utf8', env: {...process.env, PATH: bin}});
  assert.notEqual(run('1').status, 0);
  assert.equal(existsSync(marker), false);
  assert.notEqual(run().status, 0);
  assert.equal(JSON.parse(readFileSync(marker)).number, 3, 'New copied board retained for retry');
  const corrected = run('2');
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(JSON.parse(readFileSync(marker)).number, 2, 'Explicit corrected board replaces rejected saved selection');
});
