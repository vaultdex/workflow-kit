// Lokale CI (README, "Lokale CI"): führt die PR-Prüfungen eines Projekts auf diesem Rechner aus und meldet sie als
// Commit-Status. Der Status stammt von diesem Skript, kein Agent behauptet ihn. Nur REST, keine GraphQL-Punkte.
// Aufruf: local-ci.mjs [--cwd DIR] PR | --watch
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';

export const AGGREGATE = 'local-ci'; // Status über alle Prüfungen eines Heads; auch "keine Prüfung betroffen" meldet sich hier
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const globRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\?]|\*\*\/|\*\*|\*/g,
  token => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*' })[token] ?? `\\${token}`) + '$');

/** Pfad-Filter wie bei GitHub: der Reihe nach, "!" nimmt zurück, "*" bleibt im Ordner, "**" geht darunter. */
export const matches = (paths, file) => paths.reduce((hit, path) => path.startsWith('!')
  ? (globRegExp(path.slice(1)).test(file) ? false : hit)
  : hit || globRegExp(path).test(file), false);

/** Die Prüfungen, deren Filter mindestens eine geänderte Datei treffen. */
export const select = (checks, files) => checks.filter(check => files.some(file => matches(check.paths, file)));

/** `localChecks` aus .github/workflow-project.json: Pfad zu einer JSON-Datei mit checks, optional setup und push. `read(pfad)` liefert den Inhalt. */
export function loadConfig(read) {
  const project = JSON.parse(read('.github/workflow-project.json'));
  assert.ok(project.localChecks, '.github/workflow-project.json hat kein "localChecks"');
  const { checks, setup = [], push = [] } = JSON.parse(read(project.localChecks));
  for (const check of checks) {
    assert.ok(check.context && check.paths?.every?.(path => typeof path === 'string') && check.run?.length && check.timeoutMinutes > 0,
      `localChecks: "${check.context}" braucht context, paths, run und timeoutMinutes`);
  }
  return { repository: project.repository, checks, setup, push };
}

/** Die Konfiguration von origin/<branch> nach frischem Fetch: nie aus dem eigenen Checkout und nie aus dem PR, dem man nicht traut. */
export function branchConfig({ git, root }, branch) {
  try { git(root, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { throw new Error(`origin/${branch} ist nicht abrufbar`); }
  return loadConfig(path => {
    try { return git(root, 'show', `origin/${branch}:${path}`); } catch { throw new Error(`${path} fehlt auf origin/${branch}`); }
  });
}

/** Sperrdatei: ein Läufer pro Rechner und Projekt. Eine Datei eines toten Prozesses wird übernommen. */
export function lock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    try { writeFileSync(file, String(process.pid), { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = !Number.isInteger(pid); // eine Datei, die gerade geschrieben wird
      try { process.kill(pid, 0); alive = true; } catch (kill) { alive ||= kill.code === 'EPERM'; }
      assert.ok(!alive, `Die lokale CI läuft schon (PID ${pid}, ${file})`);
      rmSync(file, { force: true });
    }
  }
  const release = () => rmSync(file, { force: true });
  process.once('exit', release);
  return release;
}

const killTree = child => {
  try {
    if (child?.pid) process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : process.kill(-child.pid, 'SIGKILL');
  } catch { /* der Prozess ist schon weg */ }
};

/** Windows: das bash.exe von Git for Windows (`<git-root>/bin/bash.exe`, aus `git --exec-path` abgeleitet), nie das erste `bash` im PATH:
 * aus PowerShell ist das WSL ohne node. Fehlt es, bricht der Start ab, bevor ein Status gemeldet wird. */
export function gitBash(execPath, platform = process.platform) {
  if (platform !== 'win32') return 'bash';
  const bash = win32.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  assert.ok(existsSync(bash), `Git Bash fehlt (${bash}); installiere Git for Windows`);
  return bash;
}

/** Ein Befehl über `bash -c`; Ausgabe an das Protokoll. `state.child` ist der laufende Prozess, den ein Abbruch beendet. */
function shell(command, { cwd, env, log, timeoutMs, state, bash = 'bash' }) {
  return new Promise(done => {
    const child = spawn(bash, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => appendFileSync(log, chunk)); // ein gemeinsamer Dateihandle für beide Ströme bricht unter Windows ab
    state.child = child;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(timeoutMs, 0));
    const finish = code => { clearTimeout(timer); state.child = null; done({ code, timedOut }); };
    child.once('error', error => { appendFileSync(log, `${error.message}\n`); finish(127); });
    child.once('close', code => finish(code ?? 1));
  });
}

const firstError = log => {
  const lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('$ '));
  return (lines.find(line => /error|fail|exception/i.test(line)) ?? lines.at(-1) ?? 'ohne Ausgabe').trim().slice(0, 90);
};

/** Holt den Merge-Stand des PRs in den eigenen Worktree (HEAD^1 ist die Basis wie in der Actions-CI) und nennt die geänderten Dateien. */
async function checkout(ctx, pr) {
  const { git, root, work } = ctx, ref = `refs/pull/${pr.number}/merge`;
  let merge;
  for (let attempt = 1; !merge; attempt++) {
    try {
      git(root, 'fetch', '--quiet', 'origin', ref);
      const [commit, , head] = git(root, 'rev-list', '--parents', '-n1', 'FETCH_HEAD').split(' ');
      if (head === pr.head.sha) merge = commit;
    } catch { /* kein Merge-Stand, solange der PR Konflikte hat */ }
    if (merge) break;
    // GitHub baut den Merge-Stand verzögert nach einem Push.
    if (attempt === ctx.mergeAttempts) throw new Error(`${ref} fehlt oder ist nicht der aktuelle Head (Konflikt mit ${pr.base.ref}?)`);
    ctx.api('GET', `pulls/${pr.number}`);
    await pause(ctx.mergeWaitMs);
  }
  if (existsSync(join(work, '.git'))) git(work, 'checkout', '--quiet', '--detach', '--force', merge);
  else { mkdirSync(dirname(work), { recursive: true }); git(root, 'worktree', 'prune'); git(root, 'worktree', 'add', '--quiet', '--detach', work, merge); }
  git(work, 'clean', '-ffdxq'); // auch Ignoriertes (node_modules) und verschachtelte Repos: der Ordner ist genau der PR-Stand, das Setup stellt Abhängigkeiten wieder her
  return { base: git(work, 'rev-parse', 'HEAD^1'), files: git(work, 'diff', '--name-only', '-z', 'HEAD^1', 'HEAD').split('\0').filter(Boolean) };
}

/**
 * Prüft den Head eines PRs einmal. Ändert sich der Head oder schließt der PR, bricht die Prüfung ab (wie cancel-in-progress);
 * `next` ist dann der PR mit dem neuen Head. `ok` heißt: alles Gewählte grün.
 */
export async function checkPullRequest(ctx, pr) {
  const { api, work } = ctx, sha = pr.head.sha, host = hostname(), started = Date.now();
  const took = () => `${Math.round((Date.now() - started) / 1000)} s`;
  const open = new Set(); // Status, die noch pending sind
  const report = (context, state, description) => {
    console.log(`#${pr.number} ${sha.slice(0, 7)} ${context}: ${state} (${description})`);
    api('POST', `statuses/${sha}`, { state, context, description: description.slice(0, 140) });
    if (state === 'pending') open.add(context); else open.delete(context);
  };
  const state = { aborted: null, child: null };
  const watcher = setInterval(() => {
    try {
      const now = api('GET', `pulls/${pr.number}`);
      if (now.head.sha !== sha || now.state !== 'open') { state.aborted = now; killTree(state.child); }
    } catch { /* GitHub nicht erreichbar: die Prüfung läuft weiter */ }
  }, ctx.pollMs);
  const newHead = () => state.aborted?.state === 'open' ? state.aborted : null;
  let ok = false;
  try {
    report(AGGREGATE, 'pending', `Prüfung läuft auf ${host}`);
    let config, env, files;
    try {
      config = branchConfig(ctx, pr.base.ref); // bei jedem Durchlauf neu vom Ziel-Branch; fehlt sie dort, wird der PR übersprungen
      const { base, files: changed } = await checkout(ctx, pr);
      files = changed;
      env = { ...process.env, BASE_SHA: base, BASE_REF: pr.base.ref, HEAD_REF: pr.head.ref, EVENT: 'pull_request' };
    } catch (error) {
      if (!state.aborted) report(AGGREGATE, 'failure', error.message); // sonst schließt finally den Status; der neue Head folgt
      return { ok, next: newHead() };
    }
    const selected = select(config.checks, files);
    if (!selected.length) {
      report(AGGREGATE, 'success', `Keine Prüfung betrifft die ${files.length} geänderten Dateien`);
      return { ok: true, next: null };
    }
    for (const check of selected) report(check.context, 'pending', `Läuft auf ${host}`);
    mkdirSync(ctx.logs, { recursive: true });
    const run = async (name, commands, minutes) => {
      const log = join(ctx.logs, `pr${pr.number}-${sha.slice(0, 7)}-${name.replace(/[^\w.-]+/g, '-')}.log`), begun = Date.now(), end = begun + minutes * 60_000;
      writeFileSync(log, '');
      for (const [index, command] of commands.entries()) {
        if (state.aborted) return null; // der Abbruch kam zwischen zwei Befehlen, als kein Prozess lief
        appendFileSync(log, `$ ${command}\n`);
        const { code, timedOut } = await shell(command, { cwd: work, env, log, timeoutMs: end - Date.now(), state, bash: ctx.bash });
        if (state.aborted) return null;
        const step = `Befehl ${index + 1}/${commands.length}`;
        if (timedOut) return ['failure', `Zeitlimit ${minutes} min bei ${step}`];
        if (code) return ['failure', `${step} fehlgeschlagen nach ${Math.round((Date.now() - begun) / 1000)} s: ${firstError(log)}`];
      }
      return ['success', `${Math.round((Date.now() - begun) / 1000)} s auf ${host}`];
    };
    const setup = config.setup.length ? await run('setup', config.setup, 60) : ['success'];
    const failed = [];
    for (const check of selected) {
      if (!setup) break; // abgebrochen
      const result = setup[0] === 'success' ? await run(check.context, check.run, check.timeoutMinutes) : ['failure', `Setup fehlgeschlagen: ${setup[1]}`];
      if (!result || state.aborted) break;
      if (result[0] !== 'success') failed.push(check.context);
      report(check.context, ...result);
    }
    if (!state.aborted) {
      ok = !failed.length;
      report(AGGREGATE, ok ? 'success' : 'failure', ok ? `${selected.length} Prüfungen grün in ${took()} auf ${host}` : `${failed.length} von ${selected.length} rot: ${failed.join(', ')}`);
    }
  } finally {
    clearInterval(watcher);
    for (const context of [...open]) report(context, 'error', state.aborted ? 'Abgebrochen: neuer Head oder PR geschlossen' : 'Abgebrochen: Fehler im Läufer');
  }
  return { ok, next: newHead() };
}

/** Prüft den PR und, wenn währenddessen ein neuer Head kommt, auch diesen. */
export async function follow(ctx, pr) {
  for (let result; ; pr = result.next) {
    result = await checkPullRequest(ctx, pr);
    if (!result.next) return result;
  }
}

const finished = (ctx, sha) => ['success', 'failure'].includes(ctx.api('GET', `commits/${sha}/statuses?per_page=100`).find(status => status.context === AGGREGATE)?.state);

/** `push` der Konfiguration, wenn sich main oder ein Release-Branch bewegt hat; die erste Beobachtung löst nichts aus. */
async function pushed(ctx, heads) {
  const moved = [];
  for (const prefix of ['main', 'release/']) {
    for (const { ref, object } of ctx.api('GET', `git/matching-refs/heads/${prefix}`)) {
      const branch = ref.slice('refs/heads/'.length);
      if (branch !== 'main' && !branch.startsWith('release/')) continue;
      if (heads.has(branch) && heads.get(branch) !== object.sha) moved.push({ branch, before: heads.get(branch), after: object.sha });
      heads.set(branch, object.sha);
    }
  }
  for (const { branch, before, after } of moved) {
    let commands;
    try { commands = branchConfig(ctx, branch).push; } catch (error) { console.error(`push ${branch}: übersprungen, ${error.message}`); continue; }
    const env = { ...process.env, BRANCH: branch, BEFORE_SHA: before, AFTER_SHA: after, EVENT: 'push' };
    mkdirSync(ctx.logs, { recursive: true });
    const log = join(ctx.logs, `push-${branch.replace(/[^\w.-]+/g, '-')}.log`);
    writeFileSync(log, '');
    for (const command of commands) {
      const { code } = await shell(command, { cwd: ctx.root, env, log, timeoutMs: 30 * 60_000, state: {}, bash: ctx.bash });
      if (code) { console.error(`push ${branch}: "${command}" endete mit ${code} (${log})`); break; }
    }
  }
}

/** Jede Minute: bewegte Branches, dann jeden offenen Nicht-Draft-PR mit neuem Head genau einmal, einen nach dem anderen. */
export async function watch(ctx, { rounds = Infinity } = {}) {
  const heads = new Map(), done = new Map();
  for (let round = 0; round < rounds; round++) {
    try {
      await pushed(ctx, heads).catch(error => console.error(`push: ${error.message}`)); // ein Fehler hier hält die PR-Prüfungen nicht auf
      for (const pr of ctx.api('GET', 'pulls?state=open&per_page=100').filter(pr => !pr.draft && pr.head.repo?.full_name === ctx.repository)) {
        if (done.get(pr.number) === pr.head.sha || finished(ctx, pr.head.sha)) continue;
        done.set(pr.number, pr.head.sha); // ponytail: ein Läuferfehler wiederholt den Head nicht; ein neuer Push oder `local-ci.mjs PR` prüft erneut
        await follow(ctx, pr);
      }
    } catch (error) { console.error(error.message); }
    if (round + 1 < rounds) await pause(ctx.pollMs);
  }
}

async function main() {
  enterCwd();
  const [mode] = process.argv.slice(2);
  if (mode !== '--watch' && !/^\d+$/.test(mode ?? '')) {
    console.error('Aufruf: local-ci.mjs [--cwd DIR] PR | --watch');
    process.exit(2);
  }
  const root = projectRoot(), gh = externalTool('gh', root), git = externalTool('git', root);
  const exec = (tool, args, options) => execFileSync(tool.file, args, { encoding: 'utf8', env: tool.env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const { repository } = JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')); // nur die Identität des Projekts; die Prüfliste kommt pro PR vom Ziel-Branch
  // Beside the main checkout, never under .git: Jest finds no tests in a path containing .git (Vaultdex #1819).
  const dir = `${dirname(resolve(root, exec(git, ['rev-parse', '--git-common-dir'], { cwd: root }).trim()))}-local-ci`;
  const bash = gitBash(exec(git, ['--exec-path']).trim()); // vor Sperre und Status
  const ctx = {
    bash, repository, root, work: join(dir, 'work'), logs: join(dir, 'logs'), pollMs: 60_000, mergeWaitMs: 10_000, mergeAttempts: 6,
    git: (cwd, ...args) => exec(git, ['-c', 'core.longpaths=true', ...args], { cwd }).trim(),
    api: (method, path, fields = {}) => JSON.parse(exec(gh, ['api', '-X', method, `repos/${repository}/${path}`, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])]) || 'null'),
  };
  lock(join(dir, 'lock'));
  if (mode === '--watch') await watch(ctx);
  else process.exitCode = (await follow(ctx, ctx.api('GET', `pulls/${mode}`))).ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
