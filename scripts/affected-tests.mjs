// Print the test files that belong to the changed files; `--run` runs them with `node --test` instead.
// Without file arguments the changed files are everything that differs from the merge base with origin/main
// (commits, working tree, new files); with arguments those files are used instead.
// The mapping is the plain table below: explicit, no import analysis. CI keeps running the whole suite.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('..', import.meta.url));
const tests = 'scripts/tests/';

const ALL = /\.test\.mjs$/;
const BOARD = /^board-.*\.test\.mjs$/;
const NOT_BOARD = /^(?!board-).*\.test\.mjs$/;

// Source path pattern -> test files (names inside scripts/tests, or a pattern over those names).
// A changed test file always runs itself; a file that matches no row is reported on stderr.
export const TABLE = [
  [/^scripts\/(board|quota)\.mjs$|^scripts\/tests\/(board-(fixture|runner|worker)|fake-gh)\.mjs$/, [BOARD]],
  [/^scripts\/affected-tests\.mjs$/, ['affected-tests.test.mjs']],
  [/^scripts\/checkout-root\.mjs$/, [ALL]],
  [/^scripts\/provider-links\.mjs$/, [NOT_BOARD]],
  [/^scripts\/tests\/fixtures\.mjs$/, ['git-hooks', 'kit-init-hook', 'ponytail-batch', 'ponytail-hooks', 'renovate-regenerate', 'setup'].map(n => `${n}.test.mjs`)],
  [/^scripts\/(install-git-hooks\.mjs|git-hooks\/)/, ['git-hooks.test.mjs', 'kit-init-hook.test.mjs']],
  [/^scripts\/init-project\.mjs$|^templates\//, ['entrypoints.test.mjs', 'kit-init-hook.test.mjs', 'impeccable-update.test.mjs']],
  [/^scripts\/setup-ponytail\.mjs$/, ['ponytail-batch.test.mjs', 'setup.test.mjs', 'matt-pocock.test.mjs']],
  [/^scripts\/(update-ponytail\.mjs|ponytail\/)/, ['update-ponytail.test.mjs', 'ponytail-batch.test.mjs']],
  [/^scripts\/install-ponytail-hooks\.mjs$|^\.agents\/hooks\/|^\.github\/hooks\/ponytail\.json$/, ['ponytail-hooks.test.mjs']],
  [/^scripts\/install-impeccable-hooks\.mjs$/, ['impeccable-install.test.mjs']],
  [/^\.github\/hooks\/impeccable\.json$/, ['impeccable-hooks.test.mjs']],
  [/^scripts\/(update-impeccable\.mjs|impeccable\/)|^\.vendor\/impeccable$/, ['impeccable-update.test.mjs']],
  [/^scripts\/setup-impeccable\.mjs$/, ['impeccable-update.test.mjs', 'matt-pocock.test.mjs']],
  [/^scripts\/(setup-matt-pocock|setup-skills)\.mjs$/, ['matt-pocock.test.mjs', 'setup.test.mjs']],
  [/^\.github\/skills\/|^\.vendor\/matt-pocock-skills$/, ['matt-pocock.test.mjs']],
  [/^scripts\/check-submodule-sources\.mjs$|^\.gitmodules$/, ['check-submodule-sources.test.mjs']],
  [/^\.github\/workflows\/renovate-regenerate\.yml$|^renovate\.json$/, ['renovate-regenerate.test.mjs']],
];

// Static checks over sources and docs; fast, so every such change runs them (they do not count as coverage).
const STATIC = /^(scripts|docs)\/.*\.(mjs|js|md|json|ya?ml|patch)$|^[^/]+\.md$/;
// Changes here need no row; they stay silent.
const UNTESTED = /^(docs\/|[^/]+\.md$|scripts\/tests\/)/;

/** { tests, unmapped } for a list of changed files (paths relative to the kit root). */
export function affectedTests(files, directory = kit) {
  const available = readdirSync(resolve(directory, tests)).filter(name => ALL.test(name));
  const found = new Set(), unmapped = [];
  for (const file of files) {
    let hit = false;
    if (STATIC.test(file)) found.add('text-files.test.mjs');
    if (file.startsWith(tests) && ALL.test(file)) { found.add(basename(file)); hit = true; }
    for (const [pattern, targets] of TABLE) {
      if (!pattern.test(file)) continue;
      hit = true;
      for (const target of targets) for (const name of available.filter(a => (target instanceof RegExp ? target.test(a) : a === target))) found.add(name);
    }
    if (!hit && !UNTESTED.test(file) && /^(scripts|templates)\//.test(file)) unmapped.push(file);
  }
  return { tests: [...found].sort().filter(name => existsSync(resolve(directory, tests, name))).map(name => tests + name), unmapped };
}

const git = (...args) => execFileSync('git', args, { cwd: kit, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Files that differ from the merge base with origin/main, plus untracked ones. */
export function changedFiles(base = 'origin/main') {
  const [from] = git('merge-base', base, 'HEAD');
  return [...new Set([...git('diff', '--name-only', from), ...git('ls-files', '--others', '--exclude-standard')])];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2), run = args.includes('--run'), given = args.filter(arg => arg !== '--run');
  const { tests: selected, unmapped } = affectedTests(given.length ? given : changedFiles());
  for (const file of unmapped) console.error(`no test mapped for ${file}; add a row to scripts/affected-tests.mjs or run the suite`);
  if (!run) { if (selected.length) console.log(selected.join('\n')); }
  else if (selected.length) process.exitCode = spawnSync(process.execPath, ['--test', ...selected], { cwd: kit, stdio: 'inherit' }).status ?? 1;
  else console.log('no affected tests');
}
