import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { externalTool, projectRoot } from './checkout-root.mjs';

// Explicit setup: points Git at the project's versioned .githooks, per clone, and adds its post-checkout kit sync.
// Automatic hooks never run this file. The relative path lets every worktree run the hooks of its own branch. --check only reports.
const root = projectRoot();
const check = process.argv.includes('--check');
const git = externalTool('git', root);
// Inherited repository selection (e.g. when called from a Git hook) would redirect Git away from root.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete git.env[name];
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

if (!statSync(join(root, '.githooks'), { throwIfNoEntry: false })?.isDirectory()) {
  report('no .githooks directory, nothing to do');
  process.exit(0);
}

// The project versions its own post-checkout (kit sync). A differing existing file is the project's: kept.
const hookSource = readFileSync(new URL('./git-hooks/post-checkout', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hookFile = join(root, '.githooks', 'post-checkout');
const existingHook = lstatSync(hookFile, { throwIfNoEntry: false });
if (!existingHook) {
  if (!check) writeFileSync(hookFile, hookSource, { flag: 'wx', mode: 0o755 });
  console.log(`post-checkout: ${check ? 'would create' : 'created'} .githooks/post-checkout (kit sync after branch checkout); commit it with: git add --chmod=+x .githooks/post-checkout`);
} else if (existingHook.isFile() && readFileSync(hookFile, 'utf8').replaceAll('\r\n', '\n') === hookSource) {
  // Git skips a hook without the executable bit; Windows has none to check, there only the index mode counts.
  const runnable = process.platform === 'win32' || (existingHook.mode & 0o111) !== 0;
  if (!runnable && !check) chmodSync(hookFile, 0o755);
  console.log(`post-checkout: .githooks/post-checkout is current${runnable ? '' : check ? ' (would make it executable)' : ' (made executable)'}`);
  if (out('ls-files', '-s', '--', '.githooks/post-checkout').startsWith('100644'))
    console.log('post-checkout: tracked without executable bit, so Git skips it elsewhere; run: git update-index --chmod=+x .githooks/post-checkout');
} else {
  console.log('post-checkout: kept existing .githooks/post-checkout; integrate scripts/git-hooks/post-checkout there by hand');
}

// Every worktree's .githooks counts as ours, so an absolute path into another worktree is migrated too.
// Existing paths are canonicalized (symlinks, Windows 8.3 names); missing ones compare as written.
const fold = path => {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch { /* missing or inaccessible: keep as written */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};
// -z: NUL-separated attributes, so worktree paths may contain newlines.
const tops = out('worktree', 'list', '--porcelain', '-z').split('\0')
  .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
const ours = new Set(tops.map(top => fold(join(top, '.githooks'))));
// Git resolves a relative hooks path in whichever worktree runs the hook, so only .githooks itself is
// ours in every worktree; any other relative value may point elsewhere there and stays foreign.
const isOurs = value => isAbsolute(value) ? ours.has(fold(value)) : normalize(value) === '.githooks';

/** Every core.hooksPath entry of one config source as { value, origin }, including include/includeIf
 * files (a selected source skips them without --includes). --null keeps origins unquoted. */
const entries = (...source) => {
  const result = run('config', ...source, '--includes', '--show-origin', '--null', '--get-all', 'core.hooksPath');
  assert.ok(result.status <= 1, result.stderr);
  const fields = result.status === 0 ? result.stdout.split('\0').slice(0, -1) : [];
  const list = [];
  for (let i = 0; i < fields.length; i += 2) {
    const origin = fields[i];
    list.push({ value: fields[i + 1], origin: origin.startsWith('file:') ? fold(resolve(root, origin.slice(5))) : origin });
  }
  return list;
};
/** A file is changed only when every entry it yields is ours and written in the file itself;
 * foreign, repeated foreign and included entries stay untouched and are reported. */
const owned = (file, list) => list.every(entry => isOurs(entry.value) && entry.origin === fold(file));
const describe = list => list.map(entry => `${entry.value} (${entry.origin})`).join(', ');

const common = resolve(root, out('rev-parse', '--git-common-dir'));
const localFile = join(common, 'config');
const worktreeFiles = [join(common, 'config.worktree'),
  ...(existsSync(join(common, 'worktrees')) ? readdirSync(join(common, 'worktrees')) : [])
    .map(name => join(common, 'worktrees', name, 'config.worktree'))].filter(existsSync);

/** Lines of `git var NAME` (the global or system config files Git reads), none when disabled. */
const configFiles = name => {
  const result = run('var', name);
  assert.ok(result.status <= 1, result.stderr);
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
};
// Git evaluates includeIf (gitdir, onbranch, ...) only for the invoking worktree and branch, so a
// foreign path that applies elsewhere is invisible above. Read every include target with its
// condition ignored and keep everything when any target reachable through includeIf sets a foreign path.
// A file is read once per state: reached first unconditionally, it may still be behind an includeIf elsewhere.
// Targets this script cannot resolve like Git (~user/, %(prefix)/) block every change instead.
const conditional = [];
const scanned = new Set();
const scan = (file, underCondition) => {
  const key = `${underCondition}:${fold(file)}`;
  if (scanned.has(key) || !existsSync(file)) return;
  scanned.add(key);
  const own = run('config', '--file', file, '--no-includes', '--null', '--get-all', 'core.hooksPath');
  assert.ok(own.status <= 1, own.stderr);
  if (underCondition && own.status === 0)
    conditional.push(...own.stdout.split('\0').slice(0, -1).map(value => ({ value, origin: fold(file) })));
  const includes = run('config', '--file', file, '--no-includes', '--null', '--get-regexp', '^include(if\\..*)?\\.path$');
  assert.ok(includes.status <= 1, includes.stderr);
  for (const entry of includes.status === 0 ? includes.stdout.split('\0').slice(0, -1) : []) {
    const name = entry.slice(0, entry.indexOf('\n')), path = entry.slice(entry.indexOf('\n') + 1);
    if (/^(~(?!\/)|%\()/.test(path)) {
      conditional.push({ value: `unresolved include ${path}`, origin: fold(file) });
      continue;
    }
    const target = path.startsWith('~/') ? join(process.env.HOME ?? homedir(), path.slice(2)) : resolve(dirname(file), path);
    scan(target, underCondition || name.startsWith('includeif.'));
  }
};
for (const file of [localFile, ...worktreeFiles, ...configFiles('GIT_CONFIG_GLOBAL'), ...configFiles('GIT_CONFIG_SYSTEM')])
  scan(file, false);
const foreignConditional = conditional.filter(entry => !isOurs(entry.value));
if (foreignConditional.length) {
  report(`kept as is: includeIf may set ${describe(foreignConditional)}; integrate .githooks there by hand`);
  process.exit(0);
}

// Local config wins over global and system; an unset local must not shadow someone's global hooks.
const local = entries('--file', localFile);
const inherited = local.length ? [] : [...entries('--global'), ...entries('--system')];
let relative = false;
if (inherited.some(entry => !isOurs(entry.value))) {
  report(`kept foreign ${describe(inherited)}; integrate .githooks there by hand`);
} else if (local.length && local.every(entry => entry.value === '.githooks')) {
  relative = true;
  report('.githooks');
} else if (local.length && !owned(localFile, local)) {
  report(`kept ${describe(local)}; integrate .githooks there by hand`);
} else {
  if (!check) out('config', '--file', localFile, '--replace-all', 'core.hooksPath', '.githooks');
  relative = true;
  report(`${check ? 'would set' : 'set'} .githooks${local.length ? ` (was ${describe(local)})` : ''}`);
}
// Own overrides go only once the local path is relative.
for (const file of worktreeFiles) {
  const list = entries('--file', file);
  if (!list.length) continue;
  if (relative && owned(file, list)) {
    if (!check) out('config', '--file', file, '--unset-all', 'core.hooksPath');
    report(`${check ? 'would remove' : 'removed'} worktree override ${describe(list)}`);
  } else {
    report(`kept worktree override ${describe(list)}`);
  }
}
