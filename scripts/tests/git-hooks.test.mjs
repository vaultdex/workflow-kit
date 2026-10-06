// Zweck: install-git-hooks an echten Git-Repos mit Worktree pruefen, ohne Netzwerk.
// Nutzen: Jeder Clone und Worktree nutzt die Hooks seines Branches; fremde Hooks gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../install-git-hooks.mjs', import.meta.url));

/** A repository with .githooks and one linked worktree; global and system config are isolated. */
function fixture(t, { hooks = true, extraEnv = {} } = {}) {
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
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
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

  // A relative path other than .githooks resolves per worktree and may point elsewhere: kept.
  const r = fixture(t);
  writeFileSync(r.linkedConfig, '[core]\n\thooksPath = ../repo/.githooks\n');
  r.run();
  assert.equal(r.value('--file', r.linkedConfig), '../repo/.githooks');

  // An inherited GIT_DIR of another repository neither redirects the write nor touches that repository.
  const other = fixture(t), e = fixture(t, { extraEnv: { GIT_DIR: join(other.repo, '.git') } });
  e.run();
  assert.equal(e.value('--local'), '.githooks');
  assert.equal(other.value('--local'), '');

  const none = fixture(t, { hooks: false });
  none.run();
  assert.equal(none.value('--local'), '');
  writeFileSync(join(none.repo, '.githooks'), '');
  none.run();
  assert.equal(none.value('--local'), '');
});

test('an own worktree path with a newline is still migrated', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), odd = join(f.linked, '../line\nbreak');
  f.git('worktree', 'add', '-q', '--detach', odd);
  f.git('config', '--local', 'core.hooksPath', join(odd, '.githooks'));
  f.run();
  assert.equal(f.value('--local'), '.githooks');
});

/** A consumer with the kit as submodule: main pins kit commit one, `other` pins commit two; the kit's own main is a third, newer commit. The installer ran in it. */
function kitFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kit post checkout '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const global = join(base, 'global.gitconfig');
  // The submodule is a local path; Git blocks that transport for submodules unless allowed.
  writeFileSync(global, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const kit = join(base, 'kit'), repo = join(base, 'repo');
  for (const dir of [kit, repo]) { mkdirSync(dir); sh(dir, 'init', '-q', '-b', 'main'); }
  const pin = (n) => { writeFileSync(join(kit, 'AGENT_RULES.md'), `rules ${n}\n`); if (n === 2) writeFileSync(join(kit, 'new.txt'), 'tracked\n'); sh(kit, 'add', '.'); sh(kit, 'commit', '-q', '-am', `kit ${n}`); return sh(kit, 'rev-parse', 'HEAD').stdout.trim(); };
  writeFileSync(join(kit, 'AGENT_RULES.md'), 'rules 0\n');
  sh(kit, 'add', '.');
  const [one, two] = [pin(1), pin(2)];
  pin(3);
  mkdirSync(join(repo, '.githooks'));
  writeFileSync(join(repo, '.githooks/pre-push'), '#!/bin/sh\n');
  const installed = spawnSync(process.execPath, [script], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  sh(repo, 'submodule', '-q', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
  sh(repo, '-C', '.vendor/workflow-kit', 'checkout', '-q', one);
  sh(repo, 'add', '--chmod=+x', '.githooks/post-checkout');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'pin one');
  sh(repo, 'switch', '-q', '-c', 'other');
  sh(repo, '-C', '.vendor/workflow-kit', 'checkout', '-q', two);
  sh(repo, 'commit', '-q', '-am', 'pin two');
  sh(repo, 'switch', '-q', 'main');
  sh(repo, 'submodule', '-q', 'update', '--init');
  const rules = join(repo, '.vendor/workflow-kit/AGENT_RULES.md');
  return { repo, sh, rules, status: () => sh(repo, 'status', '--porcelain').stdout, switchTo: branch => spawnSync('git', ['switch', '-q', branch], { cwd: repo, env, encoding: 'utf8' }) };
}

test('switching branches with another kit gitlink leaves no modified submodule', t => {
  const f = kitFixture(t);
  assert.equal(f.status(), '');
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 1\n');
  assert.equal(f.switchTo('other').status, 0);
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 2\n');
  assert.equal(f.status(), '');
  assert.equal(f.switchTo('main').status, 0);
  assert.equal(readFileSync(f.rules, 'utf8'), 'rules 1\n');
  assert.equal(f.status(), '');
  // A new worktree starts with an empty kit directory; the same hook fills it.
  const linked = join(f.repo, '../linked');
  f.sh(f.repo, 'worktree', 'add', '-q', '--detach', linked, 'other');
  assert.equal(readFileSync(join(linked, '.vendor/workflow-kit/AGENT_RULES.md'), 'utf8'), 'rules 2\n');
});

test('a kit with local changes keeps them, prints a hint and does not fail the switch', t => {
  const f = kitFixture(t);
  writeFileSync(f.rules, 'my edit\n');
  const result = f.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
  assert.equal(readFileSync(f.rules, 'utf8'), 'my edit\n');
});

test('a failing kit update prints the command and does not fail the switch', t => {
  const f = kitFixture(t);
  // The kit is not cloned (empty directory) and its source is gone, so the update cannot succeed.
  renameSync(join(f.repo, '../kit'), join(f.repo, '../kit-gone'));
  rmSync(join(f.repo, '.vendor/workflow-kit'), { recursive: true, force: true });
  rmSync(join(f.repo, '.git/modules'), { recursive: true, force: true });
  mkdirSync(join(f.repo, '.vendor/workflow-kit'));
  const result = f.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
});

test('local commits and ignored files are kept; a clean published kit still follows', t => {
  const kit = f => join(f.repo, '.vendor/workflow-kit');
  // An unpublished commit would be left behind by the checkout.
  const a = kitFixture(t);
  a.sh(kit(a), 'commit', '-q', '--allow-empty', '-m', 'local');
  const local = a.sh(kit(a), 'rev-parse', 'HEAD').stdout;
  const result = a.switchTo('other');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr.trim(), '', 'a diagnostic is printed');
  assert.equal(a.sh(kit(a), 'rev-parse', 'HEAD').stdout, local);

  // An ignored file that the target revision tracks would be overwritten without a word.
  const b = kitFixture(t);
  writeFileSync(join(kit(b), 'new.txt'), 'mine\n');
  appendFileSync(resolve(kit(b), b.sh(kit(b), 'rev-parse', '--git-path', 'info/exclude').stdout.trim()), 'new.txt\n');
  assert.equal(b.status(), '');
  assert.equal(b.switchTo('other').status, 0);
  assert.equal(readFileSync(join(kit(b), 'new.txt'), 'utf8'), 'mine\n');

  // A clean kit that is not the old pin but is published (stale) still follows the new gitlink.
  const c = kitFixture(t);
  c.sh(kit(c), 'checkout', '-q', 'origin/main');
  assert.equal(c.switchTo('other').status, 0);
  assert.equal(readFileSync(c.rules, 'utf8'), 'rules 2\n');
});

test('an existing, different post-checkout hook of the project is kept', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, '.githooks/post-checkout'), '#!/bin/sh\necho mine\n');
  f.run();
  assert.equal(readFileSync(join(f.repo, '.githooks/post-checkout'), 'utf8'), '#!/bin/sh\necho mine\n');
});
