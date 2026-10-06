// Zweck: install-git-hooks an echten Git-Repos mit Worktree pruefen, ohne Netzwerk.
// Nutzen: Jeder Clone und Worktree nutzt die Hooks seines Branches; fremde Hooks gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../install-git-hooks.mjs', import.meta.url));

/** A repository with .githooks and one linked worktree; global and system config are isolated. */
function fixture(t, { hooks = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'kit git hooks '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo'), linked = join(base, 'linked'), global = join(base, 'global.gitconfig');
  writeFileSync(global, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git('init', '-q');
  if (hooks) {
    mkdirSync(join(repo, '.githooks'));
    writeFileSync(join(repo, '.githooks/pre-push'), '#!/bin/sh\n');
  }
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('config', 'extensions.worktreeConfig', 'true');
  git('worktree', 'add', '-q', '--detach', linked);
  const linkedConfig = join(repo, '.git/worktrees/linked/config.worktree');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const value = (...source) => spawnSync('git', ['config', ...source, '--get', 'core.hooksPath'],
    { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
  const effective = cwd => spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd, env, encoding: 'utf8' }).stdout.trim();
  return { repo, linked, global, linkedConfig, git, run, value, effective };
}

test('unset or own absolute paths become relative .githooks; --check and reruns change nothing', t => {
  const f = fixture(t);
  f.run('--check');
  assert.equal(f.value('--local'), '');
  f.run();
  assert.equal(f.value('--local'), '.githooks');
  f.run();
  assert.equal(f.value('--local'), '.githooks');

  // Absolute paths into this repo's worktrees, as earlier manual setups wrote them.
  f.git('config', '--local', 'core.hooksPath', join(f.linked, '.githooks'));
  writeFileSync(f.linkedConfig, `[core]\n\thooksPath = ${join(f.repo, '.githooks').replaceAll('\\', '/')}\n`);
  f.run('--check');
  assert.equal(f.value('--local'), join(f.linked, '.githooks'));
  assert.notEqual(f.value('--file', f.linkedConfig), '');
  f.run();
  assert.equal(f.value('--local'), '.githooks');
  assert.equal(f.value('--file', f.linkedConfig), '');
  assert.equal(f.effective(f.linked), '.githooks');
});

test('foreign hook paths stay, local or global; without .githooks nothing changes', t => {
  const f = fixture(t);
  f.git('config', '--local', 'core.hooksPath', '.husky');
  writeFileSync(f.linkedConfig, `[core]\n\thooksPath = ${join(f.repo, '.githooks').replaceAll('\\', '/')}\n`);
  f.run();
  assert.equal(f.value('--local'), '.husky');
  assert.notEqual(f.value('--file', f.linkedConfig), '');

  // Global hooks, here only reachable through an include, are not shadowed by a local entry.
  const g = fixture(t), included = join(g.global, '../included.gitconfig');
  writeFileSync(included, '[core]\n\thooksPath = /shared/hooks\n');
  writeFileSync(g.global, `[include]\n\tpath = ${included.replaceAll('\\', '/')}\n`);
  g.run();
  assert.equal(g.value('--local'), '');

  // An own path that a worktree only includes stays in the included file; the run still completes.
  const i = fixture(t), own = join(i.global, '../own.gitconfig');
  writeFileSync(own, `[core]\n\thooksPath = ${join(i.repo, '.githooks').replaceAll('\\', '/')}\n`);
  writeFileSync(i.linkedConfig, `[include]\n\tpath = ${own.replaceAll('\\', '/')}\n`);
  i.run();
  assert.equal(i.value('--local'), '.githooks');
  assert.equal(i.value('--includes', '--file', i.linkedConfig), join(i.repo, '.githooks').replaceAll('\\', '/'));

  // A foreign entry repeated before an own one in the same file is not lost.
  const m = fixture(t), mixed = `[core]\n\thooksPath = .husky\n\thooksPath = ${join(m.repo, '.githooks').replaceAll('\\', '/')}\n`;
  writeFileSync(m.linkedConfig, mixed);
  m.run();
  assert.equal(readFileSync(m.linkedConfig, 'utf8'), mixed);

  // includeIf applies only on another branch: invisible from here, still kept.
  const c = fixture(t), branch = join(c.global, '../release.gitconfig');
  writeFileSync(branch, '[core]\n\thooksPath = /release/hooks\n');
  writeFileSync(c.global, `[includeIf "onbranch:release"]\n\tpath = ${branch.replaceAll('\\', '/')}\n`);
  c.run();
  assert.equal(c.value('--local'), '');

  // The same file reached first by a worktree's plain include still counts behind the includeIf.
  const d = fixture(t), shared = join(d.global, '../shared.gitconfig').replaceAll('\\', '/');
  writeFileSync(shared, '[core]\n\thooksPath = /release/hooks\n');
  writeFileSync(d.linkedConfig, `[include]\n\tpath = ${shared}\n`);
  writeFileSync(d.global, `[includeIf "onbranch:release"]\n\tpath = ${shared}\n`);
  d.run();
  assert.equal(d.value('--local'), '');

  // An include target this script cannot resolve like Git (~user/) blocks changes.
  const u = fixture(t);
  writeFileSync(u.global, '[includeIf "onbranch:release"]\n\tpath = ~someone/hooks.gitconfig\n');
  u.run();
  assert.equal(u.value('--local'), '');

  const none = fixture(t, { hooks: false });
  none.run();
  assert.equal(none.value('--local'), '');
});
