import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSubmoduleSources } from '../check-submodule-sources.mjs';

const module = (name, url, extra = '') => `[submodule ".vendor/${name}"]\n\tpath = .vendor/${name}\n\turl = ${url}\n${extra}`;
const main = module('ponytail', 'https://github.com/example/ponytail.git') + module('impeccable', 'https://github.com/example/impeccable.git', '\tbranch = skill-v1.0.0\n');

test('the submodule source gate accepts the sources of main and rejects any other set', t => {
  const dir = mkdtempSync(join(tmpdir(), 'submodule sources '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const base = file('main.gitmodules', main);
  const accepts = text => assert.doesNotThrow(() => checkSubmoduleSources(file('branch.gitmodules', text), base));
  const rejects = text => assert.throws(() => checkSubmoduleSources(file('branch.gitmodules', text), base));

  accepts(main);
  // Renovate moves the tag a submodule follows; that is no change of source.
  accepts(main.replace('skill-v1.0.0', 'skill-v2.0.0'));
  rejects(main.replace('example/ponytail', 'evil/ponytail'));
  rejects(main + module('extra', 'https://github.com/example/extra.git'));
  rejects(module('ponytail', 'https://github.com/example/ponytail.git'));
  rejects('');

  // The same check as the workflow runs it: a command line with the file of main.
  const cli = () => spawnSync(process.execPath, [resolve(fileURLToPath(new URL('../check-submodule-sources.mjs', import.meta.url))), base],
    { cwd: dir, encoding: 'utf8', env: process.env }).status;
  writeFileSync(join(dir, '.gitmodules'), main);
  assert.equal(cli(), 0);
  writeFileSync(join(dir, '.gitmodules'), main.replace('example/impeccable', 'evil/impeccable'));
  assert.equal(cli(), 1);
});
