// Print the test files that belong to the changed files; `--run` runs them with `node --test` instead.
// Without file arguments the changed files are everything that differs from the merge base with origin/main
// (commits, working tree, new files); with arguments those files are used instead.
// The mapping is the plain table below: explicit, no import analysis. CI keeps running the whole suite.
// A project adds its own map in .github/affected-tests.json (see README); its commands are printed after the kit's tests
// (`--base REF` replaces origin/main as the merge base, for projects that target release branches).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { projectRoot } from './checkout-root.mjs';

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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Files that differ from the merge base with `base`, plus untracked ones, in the Git checkout `cwd`. */
export function changedFiles(base = 'origin/main', cwd = kit) {
  const [from] = git(cwd, 'merge-base', base, 'HEAD');
  return [...new Set([...git(cwd, 'diff', '--name-only', from), ...git(cwd, 'ls-files', '--others', '--exclude-standard')])];
}

export const PROJECT_FILE = '.github/affected-tests.json';

/** The project's map from path pattern (`*` within a folder, `**` across folders) to a command or a list of commands. */
export function readProjectMap(root) {
  const file = resolve(root, PROJECT_FILE);
  if (!existsSync(file)) return {};
  const map = JSON.parse(readFileSync(file, 'utf8'));
  for (const [pattern, value] of Object.entries(map))
    assert.ok([value].flat().every(command => typeof command === 'string' && command), `${PROJECT_FILE}: "${pattern}" needs a command or a list of commands`);
  return map;
}

const glob = pattern => new RegExp('^' + pattern.split('**').map(part => part.split('*').map(text => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$');

/** The project commands for a list of changed files (paths relative to the project root), each once, in table order. */
export function projectCommands(files, map) {
  return [...new Set(Object.entries(map).filter(([pattern]) => files.some(file => glob(pattern).test(file))).flatMap(([, value]) => [value].flat()))];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values, positionals: given } = parseArgs({ allowPositionals: true, options: { run: { type: 'boolean' }, base: { type: 'string', default: 'origin/main' } } });
  // A project that uses the kit as a submodule: kit tests follow the kit's own changes, the project map the project's.
  const root = projectRoot(), inKit = realpathSync.native(root) === realpathSync.native(kit);
  const kitFiles = given.length ? (inKit ? given : []) : changedFiles(inKit ? values.base : undefined, kit);
  const commands = projectCommands(inKit ? kitFiles : given.length ? given : changedFiles(values.base, root), readProjectMap(root));
  const { tests: selected, unmapped } = affectedTests(kitFiles);
  for (const file of unmapped) console.error(`no test mapped for ${file}; add a row to scripts/affected-tests.mjs or run the suite`);
  if (!values.run) { if (selected.length || commands.length) console.log([...selected, ...commands].join('\n')); }
  else if (!selected.length && !commands.length) console.log('no affected tests');
  else {
    if (selected.length) process.exitCode = spawnSync(process.execPath, ['--test', ...selected], { cwd: kit, stdio: 'inherit' }).status ?? 1;
    for (const command of commands) if (!process.exitCode) process.exitCode = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' }).status ?? 1;
  }
}
