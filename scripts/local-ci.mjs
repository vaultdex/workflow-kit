// Lokale CI (README, "Lokale CI"): führt die PR-Prüfungen eines Projekts auf diesem Rechner aus und meldet sie als
// Commit-Status. Der Status stammt von diesem Skript, kein Agent behauptet ihn. Nur REST, keine GraphQL-Punkte.
// Aufruf: local-ci.mjs [--cwd DIR] PR | --push BRANCH BEFORE AFTER [kit]  (nur auf Abruf: `board.mjs done` und `merge` ohne Status am Head und nach einem Merge)
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';

const AGGREGATE = 'local-ci'; // Status über alle Prüfungen eines Heads; auch "keine Prüfung betroffen" meldet sich hier

const globRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\?]|\*\*\/|\*\*|\*/g,
  token => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*' })[token] ?? `\\${token}`) + '$');

/** Pfad-Filter wie bei GitHub: der Reihe nach, "!" nimmt zurück, "*" bleibt im Ordner, "**" geht darunter. */
export const matches = (paths, file) => paths.reduce((hit, path) => path.startsWith('!')
  ? (globRegExp(path.slice(1)).test(file) ? false : hit)
  : hit || globRegExp(path).test(file), false);

/** Die Prüfungen, deren Filter mindestens eine geänderte Datei treffen. */
export const select = (checks, files) => checks.filter(check => files.some(file => matches(check.paths, file)));

/** `localChecks` aus .github/workflow-project.json: Pfad zu einer JSON-Datei mit checks, optional setup, push und kitPush. `read(pfad)` liefert den Inhalt. */
export function loadConfig(read) {
  const project = JSON.parse(read('.github/workflow-project.json'));
  assert.ok(project.localChecks, '.github/workflow-project.json hat kein "localChecks"');
  const { checks, setup = [], push = [], kitPush = [], riskPaths, baseRecheck } = JSON.parse(read(project.localChecks));
  assert.ok(riskPaths === undefined || riskPaths.every?.(path => typeof path === 'string'), 'localChecks: "riskPaths" muss eine Liste von Pfaden sein');
  assert.ok(baseRecheck === undefined || typeof baseRecheck === 'string', 'localChecks: "baseRecheck" muss ein Befehl (Text) sein');
  for (const check of checks) {
    assert.ok(check.context && check.paths?.every?.(path => typeof path === 'string') && check.run?.length && check.timeoutMinutes > 0,
      `localChecks: "${check.context}" braucht context, paths, run und timeoutMinutes`);
  }
  return { repository: project.repository, checks, setup, push, kitPush, riskPaths, baseRecheck };
}

const fetchBranch = ({ git, root }, branch) => {
  try { git(root, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { throw new Error(`origin/${branch} ist nicht abrufbar`); }
};

/** Die Konfiguration von origin/<branch> nach frischem Fetch: nie aus dem eigenen Checkout und nie aus dem PR, dem man nicht traut. */
export function branchConfig(ctx, branch, sha, load = loadConfig) {
  const { git, root } = ctx;
  // Mit `sha` (die Basis, gegen die gemerged wurde; bei `push` der bearbeitete Commit) kein neuer Fetch: Prüfliste und Worktree stammen aus demselben Commit.
  if (!sha) fetchBranch(ctx, branch);
  const ref = sha ?? `origin/${branch}`;
  return load(path => {
    try { return git(root, 'show', `${ref}:${path}`); } catch (error) {
      // Nur ein leerer Baum-Eintrag belegt Fehlen (`missing`); jeder andere Lesefehler wirft weiter, auch wenn der Beleg selbst scheitert.
      let listed = true;
      try { listed = Boolean(git(root, 'ls-tree', '--name-only', ref, '--', path).trim()); } catch { /* Beleg nicht möglich: kein Fehlen */ }
      throw Object.assign(new Error(listed ? `${path} nicht lesbar auf origin/${branch}: ${String(error.message).split('\n')[0]}` : `${path} fehlt auf origin/${branch}`), { missing: !listed });
    }
  });
}

/**
 * Der erste freie Platz `work-N` unter `dir`: gleichzeitige Läufe (mehrere Driver) teilen sich nie einen Ordner, und die Ordner bleiben für den
 * nächsten Lauf (warme Caches). Besetzt ist ein Platz durch die Sperrdatei `lock-N` eines lebenden Prozesses; die eines toten wird übernommen.
 */
export function claimSlot(dir) {
  mkdirSync(dir, { recursive: true });
  for (let slot = 1; ; slot++) {
    const file = join(dir, `lock-${slot}`);
    try { writeFileSync(file, String(process.pid), { flag: 'wx' }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = !Number.isInteger(pid); // eine Datei, die gerade geschrieben wird
      try { process.kill(pid, 0); alive = true; } catch (kill) { alive ||= kill.code === 'EPERM'; }
      if (alive) continue;
      rmSync(file, { force: true });
      slot--; // der Platz des toten Prozesses wird gleich noch einmal versucht
      continue;
    }
    process.once('exit', () => rmSync(file, { force: true }));
    return join(dir, `work-${slot}`);
  }
}

const killTree = child => {
  try {
    if (child?.pid) process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : process.kill(-child.pid, 'SIGKILL');
  } catch { /* der Prozess ist schon weg */ }
};

/** Vor jedem Git-Aufruf des Läufers. Ohne `submodule.recurse=false` (im Clone oft `true`) checkt `checkout` in den Arbeitsordnern
 * auch das Kit-Submodul aus und scheitert nach einem Pin-Bump mit "failed to unpack tree object"; das Kit holt `submodule update --init`. */
export const gitOptions = ['-c', 'core.longpaths=true', '-c', 'submodule.recurse=false', '-c', 'core.filesRefLockTimeout=10000']; // zuletzt: gleichzeitige Fetches derselben Refs warten aufeinander

/** Windows: das bash.exe von Git for Windows (`<git-root>/bin/bash.exe`, aus `git --exec-path` abgeleitet), nie das erste `bash` im PATH:
 * aus PowerShell ist das WSL ohne node. Fehlt es, bricht der Start ab, bevor ein Status gemeldet wird. */
export function gitBash(execPath, platform = process.platform) {
  if (platform !== 'win32') return 'bash';
  const bash = win32.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  assert.ok(existsSync(bash), `Git Bash fehlt (${bash}); installiere Git for Windows`);
  return bash;
}

/** Ein Befehl über `bash -c`; Ausgabe an das Protokoll.
 * Nennt `.node-version` des Arbeitsordners eine Version und gibt es `fnm`, läuft der Befehl mit ihr (fnm 1.39 hat kein `--install-if-missing` für exec: `fnm install` ist erneut aufgerufen folgenlos); ohne fnm bleibt es bei der Version des Läufers, mit Hinweis im Protokoll. */
function shell(command, { cwd, env, log, timeoutMs, bash = 'bash', fnm }) {
  return new Promise(done => {
    const file = join(cwd, '.node-version'), version = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (version && !fnm) appendFileSync(log, `Hinweis: .node-version nennt ${version}, aber fnm fehlt; es gilt die Node-Version des Läufers\n`);
    const args = version && fnm
      ? ['-c', 'fnm=$1 v=$2; "$fnm" install "$v" && "$fnm" exec --using="$v" -- "$BASH" -c "$3"', 'bash', fnm, version, command]
      : ['-c', command];
    const child = spawn(bash, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => appendFileSync(log, chunk)); // ein gemeinsamer Dateihandle für beide Ströme bricht unter Windows ab
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(timeoutMs, 0));
    const finish = code => { clearTimeout(timer); done({ code, timedOut }); };
    child.once('error', error => { appendFileSync(log, `${error.message}\n`); finish(127); });
    child.once('close', code => finish(code ?? 1));
  });
}

const firstError = log => {
  const lines = readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('$ '));
  return (lines.find(line => /error|fail|exception/i.test(line)) ?? lines.at(-1) ?? 'ohne Ausgabe').trim().slice(0, 90);
};

/** Basis-Stempel im Gesamtstatus `local-ci`: gegen welchen Stand von origin/<base> der Head geprüft wurde. */
const baseMark = sha => `Basis ${sha.slice(0, 12)}`;

/** Setzt den Worktree `work` des Projekt-Checkouts auf `sha` (neu angelegt, falls nötig) und räumt ihn leer, auch Ignoriertes (node_modules) und verschachtelte Repos: der Ordner ist genau dieser Stand, das Setup stellt Abhängigkeiten wieder her. */
function worktreeAt({ git, root }, work, sha) {
  if (existsSync(join(work, '.git'))) git(work, 'checkout', '--quiet', '--detach', '--force', sha);
  else { mkdirSync(dirname(work), { recursive: true }); git(root, 'worktree', 'prune'); git(root, 'worktree', 'add', '--quiet', '--detach', work, sha); }
  git(work, 'clean', '-ffdxq');
}

/**
 * Baut den Merge-Stand selbst (GitHubs refs/pull/N/merge bleibt nach einem Merge in den Ziel-Branch auf der alten Basis stehen):
 * frischer Fetch von origin/<base> und dem PR-Head, dann Head in die Basis im eigenen Worktree. `HEAD^1` ist die Basis wie in der Actions-CI.
 */
async function checkout(ctx, pr) {
  const { git, root, work } = ctx, branch = pr.base.ref;
  let base, head;
  const fail = message => Object.assign(new Error(message), { base }); // die Basis hängt am Fehler, damit der Status sie nennt
  try {
    git(root, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    base = git(root, 'rev-parse', `refs/remotes/origin/${branch}`);
    git(root, 'fetch', '--quiet', 'origin', `+refs/pull/${pr.number}/head:refs/local-ci/pr-${pr.number}`); // eigener Ref statt FETCH_HEAD: gleichzeitige Läufe teilen den Checkout
    head = git(root, 'rev-parse', `refs/local-ci/pr-${pr.number}`);
  } catch { throw fail(`origin/${branch} oder refs/pull/${pr.number}/head ist nicht abrufbar`); }
  if (head !== pr.head.sha) throw fail('Der Head des PRs hat sich bewegt');
  worktreeAt(ctx, work, base);
  try {
    // ohne Hooks und Signatur, feste Identität unabhängig von der Git-Konfiguration des Rechners
    git(work, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=local-ci', '-c', 'user.email=local-ci@localhost', 'merge', '--no-ff', '--quiet', '-m', `Merge PR ${pr.number} in ${branch}`, head);
  } catch (error) {
    const conflicted = git(work, 'diff', '--name-only', '--diff-filter=U');
    try { git(work, 'merge', '--abort'); } catch { /* kein Merge im Gang */ }
    // nur ein echter Konflikt (nicht zusammengeführte Pfade) heißt so; jeder andere Fehler nennt seine erste Zeile
    throw fail(conflicted ? `Konflikt mit ${branch}` : `Merge fehlgeschlagen: ${String(error.stderr || error.stdout || error.message).split(/\r?\n/).find(line => line.trim())?.trim()}`);
  }
  return { base, files: git(work, 'diff', '--name-only', '-z', base, 'HEAD').split('\0').filter(Boolean) };
}

/**
 * Prüft den Head eines PRs einmal und gibt zurück, ob alles Gewählte grün war. Ein Push währenddessen ändert nichts am Lauf:
 * Der Status gehört zum geprüften Head, für den neuen prüft der Aufrufer erneut.
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
  let ok = false;
  try {
    report(AGGREGATE, 'pending', `Prüfung läuft auf ${host}`);
    let config, env, files, base;
    const redFile = join(ctx.logs, `pr${pr.number}-${sha.slice(0, 7)}-red-tests.txt`), baseRedFile = redFile.replace('-red-', '-base-red-');
    const aggregate = (result, text) => report(AGGREGATE, result, base ? `${baseMark(base)}: ${text}` : text); // die Basis gehört in jeden Endstand, sonst gälte er nach einem Merge in den Ziel-Branch weiter
    try {
      ({ base, files } = await checkout(ctx, pr));
      config = branchConfig(ctx, pr.base.ref, base); // bei jedem Durchlauf neu vom Ziel-Branch, vom Commit des Merge-Stands; fehlt sie dort, wird der PR übersprungen
      env = { ...process.env, BASE_SHA: base, BASE_REF: pr.base.ref, HEAD_REF: pr.head.ref, EVENT: 'pull_request' };
      if (config.baseRecheck) env.LOCAL_CI_RED_TESTS = redFile; // die Prüfungen tragen hier ihre roten Tests ein (je Zeile einer)
    } catch (error) {
      base ??= error.base;
      aggregate('failure', error.message);
      return false;
    }
    const matched = select(config.checks, files);
    // `slow`-Prüfungen laufen nur, wenn der Diff `riskPaths` trifft; ohne `riskPaths` laufen sie immer.
    const risky = !config.riskPaths || files.some(file => matches(config.riskPaths, file));
    const selected = matched.filter(check => !check.slow || risky);
    for (const check of matched) if (!selected.includes(check)) report(check.context, 'success', 'übersprungen: risikoarm');
    if (!selected.length) {
      aggregate('success', matched.length ? `${matched.length} langsame Prüfungen übersprungen: risikoarm` : `Keine Prüfung betrifft die ${files.length} geänderten Dateien`);
      return true;
    }
    for (const check of selected) report(check.context, 'pending', `Läuft auf ${host}`);
    mkdirSync(ctx.logs, { recursive: true });
    if (config.baseRecheck) writeFileSync(redFile, '');
    const run = async (name, commands, minutes) => {
      const log = join(ctx.logs, `pr${pr.number}-${sha.slice(0, 7)}-${name.replace(/[^\w.-]+/g, '-')}.log`), begun = Date.now(), end = begun + minutes * 60_000;
      writeFileSync(log, '');
      for (const [index, command] of commands.entries()) {
        appendFileSync(log, `$ ${command}\n`);
        const { code, timedOut } = await shell(command, { cwd: work, env, log, timeoutMs: end - Date.now(), bash: ctx.bash, fnm: ctx.fnm });
        const step = `Befehl ${index + 1}/${commands.length}`;
        if (timedOut) return ['failure', `Zeitlimit ${minutes} min bei ${step}`];
        if (code) return ['failure', `${step} fehlgeschlagen nach ${Math.round((Date.now() - begun) / 1000)} s: ${firstError(log)}`];
      }
      return ['success', `${Math.round((Date.now() - begun) / 1000)} s auf ${host}`];
    };
    const setup = config.setup.length ? await run('setup', config.setup, 60) : ['success'];
    const failed = [];
    for (const check of selected) {
      const result = setup[0] === 'success' ? await run(check.context, check.run, check.timeoutMinutes) : ['failure', `Setup fehlgeschlagen: ${setup[1]}`];
      if (result[0] !== 'success') failed.push(check.context);
      report(check.context, ...result);
    }
    let baseRed = []; // rote Tests des PRs, die auch am Kopf der Basis rot sind
    if (failed.length && config.baseRecheck) {
      const red = [...new Set(readFileSync(redFile, 'utf8').split(/\r?\n/).filter(Boolean))];
      if (red.length) { // nur die roten Tests, einmal; der Befehl schreibt die dort weiter roten nach LOCAL_CI_BASE_RED_TESTS. Ein Fehler hier ändert das Ergebnis nicht.
        worktreeAt(ctx, work, base);
        writeFileSync(baseRedFile, '');
        env.LOCAL_CI_BASE_RED_TESTS = baseRedFile;
        const minutes = Math.max(...selected.map(check => check.timeoutMinutes));
        const ready = config.setup.length ? await run('setup-base', config.setup, 60) : ['success'];
        if (ready?.[0] === 'success') await run('base-recheck', [config.baseRecheck], minutes);
        const still = readFileSync(baseRedFile, 'utf8').split(/\r?\n/);
        baseRed = red.filter(test => still.includes(test));
      }
    }
    ok = !failed.length;
    const summary = ok ? `${selected.length} Prüfungen grün in ${took()} auf ${host}` : `${failed.length} von ${selected.length} rot: ${failed.join(', ')}`;
    aggregate(ok ? 'success' : 'failure', baseRed.length ? `Basis rot: ${baseRed.join(', ')}; ${summary}` : summary);
    if (baseRed.length) try { api('POST', `issues/${pr.number}/comments`, { body: `Basis rot: ${baseRed.join(', ')}\n\nDiese Tests sind schon am Kopf von ${pr.base.ref} (${base.slice(0, 12)}) rot, sie stammen nicht von diesem PR. Weitere rote Prüfungen stehen im Status.` }); } catch { /* nur ein Hinweis */ }
  } finally {
    for (const context of [...open]) report(context, 'error', 'Abgebrochen: Fehler im Läufer');
  }
  return ok;
}

/**
 * `push` der Konfiguration von `branch` (mit `kit`: `kitPush`, wenn sich main des Kits bewegt hat; dann ist `after` der SHA im Kit),
 * von `board.mjs merge` nach einem eigenen Merge gerufen. Die Befehle laufen ohne `setup` (kein `npm ci`; nur das Kit-Submodul wird geholt)
 * in einem Worktree auf dem neuen Stand, nie im alten Stand des Checkouts: bei `push` ist das `after`, bei `kitPush` origin/main des Projekts.
 * Konfiguration und Worktree stammen aus diesem einen Commit. Gibt zurück, ob alle Befehle grün waren.
 */
export async function runPush(ctx, { branch, before, after, kit }) {
  fetchBranch(ctx, branch);
  const sha = kit ? ctx.git(ctx.root, 'rev-parse', `refs/remotes/origin/${branch}`) : after;
  const config = branchConfig(ctx, branch, sha), commands = kit ? config.kitPush : config.push;
  if (!commands.length) return true;
  worktreeAt(ctx, ctx.work, sha);
  if (ctx.git(ctx.work, 'ls-files', '--stage', '--', '.vendor/workflow-kit').startsWith('160000')) ctx.git(ctx.work, 'submodule', 'update', '--init', '.vendor/workflow-kit'); // nur, wenn dieser Stand das Kit enthält (Modus 160000 = Gitlink); die Skripte brauchen es, kein `setup`
  const env = { ...process.env, BRANCH: branch, BEFORE_SHA: before, AFTER_SHA: after, EVENT: kit ? 'kit' : 'push' };
  mkdirSync(ctx.logs, { recursive: true });
  const log = join(ctx.logs, `push-${kit ? 'kit-' : ''}${branch.replace(/[^\w.-]+/g, '-')}.log`);
  writeFileSync(log, '');
  for (const command of commands) {
    const { code } = await shell(command, { cwd: ctx.work, env, log, timeoutMs: 30 * 60_000, bash: ctx.bash, fnm: ctx.fnm });
    if (code) { console.error(`push ${branch}: "${command}" endete mit ${code} (${log})`); return false; }
  }
  return true;
}

async function main() {
  enterCwd();
  const [mode, ...args] = process.argv.slice(2);
  if (mode !== '--push' && !/^\d+$/.test(mode ?? '')) {
    console.error('Aufruf: local-ci.mjs [--cwd DIR] PR | --push BRANCH BEFORE AFTER [kit]');
    process.exit(2);
  }
  const root = projectRoot(), gh = externalTool('gh', root), git = externalTool('git', root);
  const exec = (tool, args, options) => execFileSync(tool.file, args, { encoding: 'utf8', env: tool.env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const { repository } = JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')); // nur die Identität des Projekts; die Prüfliste kommt pro PR vom Ziel-Branch
  // Beside the main checkout, never under .git: Jest finds no tests in a path containing .git (Vaultdex #1819).
  const dir = `${dirname(resolve(root, exec(git, ['rev-parse', '--git-common-dir'], { cwd: root }).trim()))}-local-ci`;
  const ctx = {
    bash: gitBash(exec(git, ['--exec-path']).trim()), // vor Sperre und Status
    fnm: spawnSync('fnm', ['--version'], { stdio: 'ignore' }).status === 0 ? 'fnm' : undefined, // ohne fnm bleibt es bei der Node-Version des Läufers
    repository, root, logs: join(dir, 'logs'),
    git: (cwd, ...args) => exec(git, [...gitOptions, ...args], { cwd }).trim(),
    api: (method, path, fields = {}) => JSON.parse(exec(gh, ['api', '-X', method, `repos/${repository}/${path}`, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])]) || 'null'),
  };
  ctx.work = claimSlot(dir);
  if (mode === '--push') {
    const [branch, before, after, kit] = args;
    process.exitCode = (await runPush(ctx, { branch, before, after, kit: kit === 'kit' })) ? 0 : 1;
  } else process.exitCode = (await checkPullRequest(ctx, ctx.api('GET', `pulls/${mode}`))) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
