import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('stack-sync merges the base into each layer from the bottom up and pushes; a real conflict stops with the files (#412)', t => {
  const { checkout, run, env } = fixture(t);
  const root = dirname(checkout), origin = join(root, 'origin.git');
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const isolated = isolatedGit(root);
  // The board runs git with this environment too; its temporary worktree goes under the test's directory.
  Object.assign(env, identity, { GIT_CONFIG_GLOBAL: isolated.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', TMPDIR: root, TEMP: root, TMP: root });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...isolated, ...identity } }).trim();
  const commit = (file, text) => { writeFileSync(join(checkout, file), text); git(checkout, 'add', file); git(checkout, 'commit', '-q', '-m', file); };
  const files = branch => git(origin, 'ls-tree', '-r', '--name-only', branch).split('\n');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'remote', 'add', 'origin', origin);
  commit('base.txt', 'base');
  git(checkout, 'checkout', '-q', '-b', 'layer1');
  commit('one.txt', '1');
  git(checkout, 'checkout', '-q', '-b', 'layer2');
  commit('two.txt', '2');
  git(checkout, 'checkout', '-q', 'main');
  commit('moved.txt', 'main moved');
  git(checkout, 'push', '-q', 'origin', 'main', 'layer1', 'layer2');
  const member = (number, ref) => ({ number, state: 'open', head: { ref } });
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ number: 1, base: { ref: 'main' }, pull_requests: [member(5, 'layer1'), member(7, 'layer2')] }]));

  const synced = run('stack-sync', '7');
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.deepEqual(files('layer2'), ['base.txt', 'moved.txt', 'one.txt', 'two.txt'], 'the base reached the top through the layer below');
  assert.equal(run('stack-sync', '7').stdout.match(/already up to date/g).length, 2, 'a second run changes nothing');

  commit('one.txt', 'main too');
  git(checkout, 'push', '-q', 'origin', 'main');
  const before = git(origin, 'rev-parse', 'layer2');
  const conflict = run('stack-sync', '7');
  assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
  assert.match(conflict.stdout, /^blocker: merging origin\/main into PR #5 \(layer1\) conflicts in one\.txt/m);
  assert.equal(git(origin, 'rev-parse', 'layer2'), before, 'nothing is pushed above a layer that stopped');
});
