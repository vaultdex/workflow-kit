import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { externalTool, projectRoot } from './checkout-root.mjs';

// Explicit setup: points Git at the project's versioned .githooks, per clone. Automatic hooks never run this file.
// The relative path lets every worktree run the hooks of its own branch. --check only reports.
const root = projectRoot();
const check = process.argv.includes('--check');
const git = externalTool('git', root);
const run = (...args) => {
  const result = spawnSync(git.file, args, { cwd: root, env: git.env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const out = (...args) => {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
/** Value of core.hooksPath in the given config source, or null when unset (git config exits 1).
 * A selected source skips include/includeIf unless --includes is given. */
const get = (...source) => {
  const result = run('config', ...source, '--includes', '--get', 'core.hooksPath');
  assert.ok(result.status <= 1, result.stderr);
  return result.status === 0 ? result.stdout.trim() : null;
};
const report = message => console.log(`core.hooksPath: ${message}`);

if (!existsSync(join(root, '.githooks'))) {
  report('no .githooks directory, nothing to do');
  process.exit(0);
}

// Every worktree's .githooks counts as ours, so an absolute path into another worktree is migrated too.
// Existing paths are canonicalized (symlinks, Windows 8.3 names); missing ones compare as written.
const fold = path => {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch { /* missing or inaccessible: keep as written */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
const tops = out('worktree', 'list', '--porcelain').split(/\r?\n/)
  .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
const ours = new Set(tops.map(top => fold(join(top, '.githooks'))));
const isOurs = value => ours.has(fold(resolve(root, value)));
const common = resolve(root, out('rev-parse', '--git-common-dir'));
const worktreeFiles = [join(common, 'config.worktree'),
  ...(existsSync(join(common, 'worktrees')) ? readdirSync(join(common, 'worktrees')) : [])
    .map(name => join(common, 'worktrees', name, 'config.worktree'))].filter(existsSync);

// Local config wins over global and system; an unset local must not shadow someone's global hooks.
const local = get('--local');
const inherited = local === null ? get('--global') ?? get('--system') : null;
const foreign = local !== null ? !isOurs(local) : inherited !== null && !isOurs(inherited);
if (foreign) {
  report(`kept foreign ${local ?? inherited}; integrate .githooks there by hand`);
} else if (local === '.githooks') {
  report('.githooks');
} else {
  if (!check) out('config', '--local', 'core.hooksPath', '.githooks');
  report(`${check ? 'would set' : 'set'} .githooks${local === null ? '' : ` (was ${local})`}`);
}
for (const file of worktreeFiles) {
  const value = get('--file', file);
  if (value === null) continue;
  if (foreign || !isOurs(value)) {
    report(`kept worktree override ${value} in ${file}`);
  } else {
    if (!check) out('config', '--file', file, '--unset-all', 'core.hooksPath');
    report(`${check ? 'would remove' : 'removed'} worktree override ${value} in ${file}`);
  }
}
