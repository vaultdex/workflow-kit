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
/** core.hooksPath in the given config source as { value, file }, or null when unset (git config exits 1).
 * A selected source skips include/includeIf unless --includes is given; file is where the value is defined,
 * the only place this script may change it. */
const get = (...source) => {
  // --null prints the origin unquoted; Git quotes paths with backslashes or special characters otherwise.
  const result = run('config', ...source, '--includes', '--show-origin', '--null', '--get', 'core.hooksPath');
  assert.ok(result.status <= 1, result.stderr);
  if (result.status === 1) return null;
  const [origin, value] = result.stdout.split('\0');
  return { value, file: origin.startsWith('file:') ? fold(resolve(root, origin.slice(5))) : origin };
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
const current = local ?? get('--global') ?? get('--system');
let relative = false;
if (current && !isOurs(current.value)) {
  report(`kept foreign ${current.value}; integrate .githooks there by hand`);
} else if (local?.value === '.githooks') {
  relative = true;
  report('.githooks');
} else if (local && local.file !== fold(join(common, 'config'))) {
  report(`kept ${local.value} from included ${local.file}; change it there by hand`);
} else {
  if (!check) out('config', '--local', 'core.hooksPath', '.githooks');
  relative = true;
  report(`${check ? 'would set' : 'set'} .githooks${local ? ` (was ${local.value})` : ''}`);
}
// Own overrides go only once the local path is relative; included ones stay where they are defined.
for (const file of worktreeFiles) {
  const entry = get('--file', file);
  if (!entry) continue;
  if (relative && isOurs(entry.value) && entry.file === fold(file)) {
    if (!check) out('config', '--file', file, '--unset-all', 'core.hooksPath');
    report(`${check ? 'would remove' : 'removed'} worktree override ${entry.value} in ${file}`);
  } else {
    report(`kept worktree override ${entry.value} from ${entry.file}`);
  }
}
