// Renovate regenerate holds contents: write and actions: write. These tests pin who defines the workflow, who
// sees the token, and that the dispatched CI must run on the pushed commit.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const yaml = read('renovate-regenerate');
const steps = yaml.split(/^      - (?=name:|uses:)/m).slice(1);
const name = step => step.match(/name: (.+)/)?.[1];

test('the write-capable definition comes from main, not from the branch, and only the last two steps see the token', () => {
  // pull_request would load this file from the PR's merge commit, so a branch could add its own steps to it.
  assert.match(yaml, /^  pull_request_target:$/m);
  assert.doesNotMatch(yaml, /^  pull_request:/m);
  assert.match(yaml, /^permissions: \{\}$/m);
  assert.match(yaml, /sender\.login == 'renovate\[bot\]'/);
  assert.match(yaml, /^          persist-credentials: false$/m);
  // The job runs the scripts of main (copied over the branch's), never a script of the checked-out branch.
  for (const [, script] of yaml.matchAll(/\bnode (\S+\.mjs)/g)) assert.match(script, /^scripts\//);
  assert.ok(yaml.includes("':(exclude).github/workflows'"), 'a generated or changed workflow is never staged');
  const withToken = steps.filter(step => step.includes('github.token')).map(name);
  assert.deepEqual(withToken, ['Commit and push', 'Start the repository CI']);
  assert.deepEqual(steps.slice(-2).map(name), withToken);
  // The dispatched run is repository.yml; its changelog-free checks need no history beyond a shallow checkout.
  const repository = read('repository');
  assert.match(repository, /^  workflow_dispatch:/m);
  assert.doesNotMatch(repository, /origin\//);
});

const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
const head = 'a'.repeat(40), other = 'b'.repeat(40);
const block = steps.find(step => name(step) === 'Start the repository CI').split('        run: |\n')[1].replace(/^          /gm, '');

/** Runs the step with gh, git, date and sleep replaced; gh answers as its three queries would after their jq filters. */
function start({ onHead = 0, live = head, dispatched = [], dispatchFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'renovate regenerate '));
  const log = join(dir, 'gh.log').replaceAll('\\', '/');
  const result = spawnSync(bash, ['-c', `
    git() { echo ${head}; }
    date() { echo 2000-01-01T00:00:00Z; }
    sleep() { :; }
    gh() {
      echo "$*" >> "${log}"
      case "$*" in
        "run list"*--commit*) echo ${onHead} ;;
        "api "*) echo ${live} ;;
        "workflow run"*) return ${dispatchFails ? 1 : 0} ;;
        "run list"*--event*) printf '%s' "$DISPATCHED" ;;
        "run cancel"*) return 1 ;; # a run that already ended cannot be cancelled
      esac
    }
    ${block}
  `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, DISPATCHED: dispatched.join('\n'), GITHUB_REPOSITORY: 'o/r', BRANCH: 'renovate/x' } });
  let ghCalls = '';
  try { ghCalls = readFileSync(log, 'utf8'); } catch { /* gh was never called */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, ghCalls };
}

test('the dispatched run must exist on exactly the pushed commit; any other run is an error, even an ended one', () => {
  const dispatches = result => result.ghCalls.split('\n').filter(call => call.startsWith('workflow run')).length;
  // A run on the head already exists: nothing is dispatched.
  const present = start({ onHead: 1 });
  assert.equal(present.status, 0, present.stderr);
  assert.equal(dispatches(present), 0);

  const ok = start({ dispatched: [`7 ${head}`] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(dispatches(ok), 1);
  // A run on another commit that already ended cannot be cancelled, but it still fails the job.
  const wrong = start({ dispatched: [`7 ${other}`] });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout, /another commit/);
  assert.equal(dispatches(wrong), 1);
  // The poll lists runs by creation time, not by status: the status filter is what let an ended run through.
  const poll = ok.ghCalls.split('\n').find(call => call.includes('--event workflow_dispatch'));
  assert.match(poll, /createdAt >= env\.STARTED/);
  assert.doesNotMatch(poll, /\.status/);
  // One right and one wrong run: the wrong one fails the job.
  assert.notEqual(start({ dispatched: [`7 ${head}`, `8 ${other}`] }).status, 0);
  // No run ever appears: the job fails instead of trusting the dispatch.
  const none = start();
  assert.notEqual(none.status, 0);
  assert.match(none.stdout, /did not appear/);
  // The branch moved after the push: nothing is dispatched.
  const moved = start({ live: other });
  assert.notEqual(moved.status, 0);
  assert.equal(dispatches(moved), 0);
  assert.notEqual(start({ dispatchFails: true }).status, 0);
});

const check = steps.find(step => name(step) === 'Check who changed the branch').split('        run: |\n')[1].replace(/^          /gm, '');

/** The guard step in a real repository: main with some files, then one branch commit by `author`. */
function guard(change, author = 'renovate[bot]') {
  const dir = mkdtempSync(join(tmpdir(), 'renovate guard '));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  const put = (path, text = 'x\n') => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  git('init', '-q', '-b', 'main');
  for (const path of ['.github/workflows/repository.yml', 'scripts/a.mjs', 'scripts/ponytail/adaptations.patch', 'renovate.json', '.vendor/pin']) put(path);
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  change({ put, git, rename: (from, to) => { mkdirSync(join(dir, to, '..'), { recursive: true }); renameSync(join(dir, from), join(dir, to)); } });
  git('add', '-A');
  git('commit', '-q', '--author', `${author} <a@a>`, '-m', 'branch');
  const env = join(dir, 'env');
  writeFileSync(env, '');
  const result = spawnSync(bash, ['-c', check], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: env.replaceAll('\\', '/') } });
  const skipped = readFileSync(env, 'utf8').includes('SKIP=true');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, skipped };
}

test('a branch may change the pin and the generated data, nothing that decides what runs with which rights', () => {
  const ok = guard(({ put }) => { put('.vendor/pin', 'new\n'); put('scripts/ponytail/adaptations.patch', 'new\n'); });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.skipped, false);
  for (const path of ['.github/workflows/repository.yml', 'scripts/a.mjs', 'renovate.json']) {
    const changed = guard(({ put }) => put(path, 'changed\n'));
    assert.notEqual(changed.status, 0, path);
    assert.match(changed.stdout, /not running with write access/);
  }
  // A rename lists only its new path unless renames are switched off: the moved-away workflow must still count.
  const renamed = guard(({ rename }) => rename('.github/workflows/repository.yml', 'docs/repository.yml'));
  assert.notEqual(renamed.status, 0);
  assert.match(renamed.stdout, /\.github\/workflows\/repository\.yml/);
  // Commits by someone else: the branch is theirs, the job skips instead of running.
  const foreign = guard(({ put }) => put('scripts/a.mjs', 'changed\n'), 'Mallory');
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.skipped, true);
});
