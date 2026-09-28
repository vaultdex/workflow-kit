import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const temporary = (t, name) => {
  const path = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

test('setup-skills links every provider in a fresh checkout and reruns cleanly', t => {
  const fixture = temporary(t, 'workflow-kit setup ');
  execFileSync('git', ['init', '--quiet', fixture]);
  copyFileSync(join(kit, '.gitattributes'), join(fixture, '.gitattributes'));
  const setup = name => spawnSync(process.execPath, [join(kit, 'scripts', name)], { cwd: fixture, encoding: 'utf8' });
  for (let run = 0; run < 2; run++) {
    const result = setup('setup-skills.mjs');
    assert.equal(result.status, 0, result.stderr);
  }
  for (const provider of ['.agent', '.agents', '.claude', '.opencode', '.pi'])
    for (const skill of ['ponytail', 'impeccable']) assert.ok(lstatSync(join(fixture, provider, 'skills', skill)).isSymbolicLink());
});

test('setup never runs a Git from the checkout or the working directory', t => {
  const root = temporary(t, 'workflow-kit git ');
  mkdirSync(join(root, '.git'));
  const tools = join(root, 'tools'), git = join(tools, process.platform === 'win32' ? 'git.exe' : 'git');
  mkdirSync(tools);
  copyFileSync(process.execPath, git);
  chmodSync(git, 0o755);
  const result = spawnSync(process.execPath, [join(kit, 'scripts/setup-ponytail.mjs')],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: [tools, '.'].join(delimiter) } });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(root, '.workflow-kit')), false, 'Refused before any write');
});
