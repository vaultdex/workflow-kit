// Helpers for the slow, Git-heavy tests. Each test works in its own temporary directory, never in the
// checkout that runs the suite (its .git/modules), so concurrent runs and concurrent tests do not interfere (#207).
// Scenarios that do not share state run side by side (#239): child processes are the cost, not the code.
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** spawnSync's result shape for an asynchronous child. stdin is closed at once, as spawnSync does without input. */
export const run = (file, args = [], { input, ...options } = {}) => new Promise(resolve => {
  const child = execFile(file, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options }, (error, stdout, stderr) =>
    resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr, error }));
  child.stdin.on('error', () => {}); // a child that exits without reading its input is no error, as with spawnSync
  child.stdin.end(input);
});

/** A temporary directory that is removed with the test. */
export function temporary(t, name) {
  const path = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** Environment for Git children that read neither the user's nor the system's configuration. */
export function isolatedGit(dir) {
  const global = join(dir, 'isolated.gitconfig');
  writeFileSync(global, '');
  return { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
}

const kit = fileURLToPath(new URL('../../', import.meta.url));

/** Tests that clone the pinned vendor sources call this first: a fresh clone has them empty, and Git would fail
 * deep inside a test with "does not appear to be a git repository" (#229). One line, no stack trace. */
export function requireSubmodules(root = kit) {
  const paths = execFileSync('git', ['ls-files', '-s', '--', '.vendor'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(line => line.split(/\s+/)[3]);
  if (paths.every(path => existsSync(join(root, path, '.git')))) return;
  writeSync(2, 'run: git submodule update --init --recursive\n');
  process.exit(1);
}

/** A throwaway kit for scripts that write to the kit they live in (`git submodule update --init` registers
 * submodules in its .git): this checkout's scripts and data, its pinned vendor sources as shared clones,
 * and a Git repository of its own. The suite's own checkout and its .git/modules stay untouched. */
export function kitCheckout(t) {
  requireSubmodules();
  const root = temporary(t, 'kit checkout ');
  const env = isolatedGit(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q');
  for (const path of ['.gitattributes', '.gitmodules', '.agents/skills/find-skills', 'scripts'])
    cpSync(join(kit, path), join(root, path), { recursive: true, filter: source => !source.endsWith('tests') });
  for (const line of git(kit, 'ls-files', '-s', '--', '.vendor').split('\n')) {
    const [mode, sha, , path] = line.split(/\s+/);
    git(root, '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--shared', join(kit, path), join(root, path));
    git(root, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`);
  }
  return root;
}
