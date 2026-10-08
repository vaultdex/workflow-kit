// Lokale CI (README, "Lokale CI"): führt die PR-Prüfungen eines Projekts auf diesem Rechner aus und meldet sie als
// Commit-Status. Der Status stammt von diesem Skript, kein Agent behauptet ihn. Nur REST, keine GraphQL-Punkte.
// Aufruf: local-ci.mjs [--cwd DIR] PR | --watch
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const { checks, setup = [], push = [], slots = 1 } = JSON.parse(read(project.localChecks));
  assert.ok(Number.isInteger(slots) && slots >= 1, 'localChecks: "slots" muss eine ganze Zahl ab 1 sein');
  for (const check of checks) {
    assert.ok(check.context && check.paths?.every?.(path => typeof path === 'string') && check.run?.length && check.timeoutMinutes > 0,
      `localChecks: "${check.context}" braucht context, paths, run und timeoutMinutes`);
  }
  return { repository: project.repository, checks, setup, push, slots };
}

/** Die Konfiguration von origin/<branch> nach frischem Fetch: nie aus dem eigenen Checkout und nie aus dem PR, dem man nicht traut. */
export function branchConfig({ git, root }, branch, sha) {
  // Mit `sha` (die Basis, gegen die gemerged wurde) kein neuer Fetch: Prüfliste und Merge-Stand stammen aus demselben Commit.
  if (!sha) try { git(root, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { throw new Error(`origin/${branch} ist nicht abrufbar`); }
  return loadConfig(path => {
    try { return git(root, 'show', `${sha ?? `origin/${branch}`}:${path}`); } catch { throw new Error(`${path} fehlt auf origin/${branch}`); }
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

/** Basis-Stempel im Gesamtstatus `local-ci`: gegen welchen Stand von origin/<base> der Head geprüft wurde. */
const baseMark = sha => `Basis ${sha.slice(0, 12)}`;

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
    git(root, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
    head = git(root, 'rev-parse', 'FETCH_HEAD');
  } catch { throw fail(`origin/${branch} oder refs/pull/${pr.number}/head ist nicht abrufbar`); }
  if (head !== pr.head.sha) throw Object.assign(fail('Der Head des PRs hat sich bewegt'), { moved: true }); // kein Fehler des PRs: der nächste Poll sieht den neuen Head
  if (existsSync(join(work, '.git'))) git(work, 'checkout', '--quiet', '--detach', '--force', base);
  else { mkdirSync(dirname(work), { recursive: true }); git(root, 'worktree', 'prune'); git(root, 'worktree', 'add', '--quiet', '--detach', work, base); }
  git(work, 'clean', '-ffdxq'); // auch Ignoriertes (node_modules) und verschachtelte Repos: der Ordner ist genau der PR-Stand, das Setup stellt Abhängigkeiten wieder her
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
  let ok = false, moved = false;
  try {
    report(AGGREGATE, 'pending', `Prüfung läuft auf ${host}`);
    let config, env, files, base;
    const aggregate = (result, text) => report(AGGREGATE, result, base ? `${baseMark(base)}: ${text}` : text); // die Basis gehört in jeden Endstand, sonst gälte er nach einem Merge in den Ziel-Branch weiter
    try {
      ({ base, files } = await checkout(ctx, pr));
      config = branchConfig(ctx, pr.base.ref, base); // bei jedem Durchlauf neu vom Ziel-Branch, vom Commit des Merge-Stands; fehlt sie dort, wird der PR übersprungen
      env = { ...process.env, BASE_SHA: base, BASE_REF: pr.base.ref, HEAD_REF: pr.head.ref, EVENT: 'pull_request' };
    } catch (error) {
      base ??= error.base;
      if (error.moved) moved = true; // finally schließt den Status ohne rotes Ergebnis
      else if (!state.aborted) aggregate('failure', error.message); // sonst schließt finally den Status; der neue Head folgt
      return { ok, next: newHead() };
    }
    const selected = select(config.checks, files);
    if (!selected.length) {
      aggregate('success', `Keine Prüfung betrifft die ${files.length} geänderten Dateien`);
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
      aggregate(ok ? 'success' : 'failure', ok ? `${selected.length} Prüfungen grün in ${took()} auf ${host}` : `${failed.length} von ${selected.length} rot: ${failed.join(', ')}`);
    }
  } finally {
    clearInterval(watcher);
    for (const context of [...open]) report(context, 'error', state.aborted || moved ? 'Abgebrochen: neuer Head oder PR geschlossen' : 'Abgebrochen: Fehler im Läufer');
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

/** Grün bleibt grün, auch wenn sich die Basis bewegt (wie bei GitHub Actions; sonst liefe der Läufer bei jedem Merge für alle PRs voll). Rot gilt nur für die Basis, gegen die es lief. */
const finished = (ctx, sha, base) => {
  const status = ctx.api('GET', `commits/${sha}/statuses?per_page=100`).find(status => status.context === AGGREGATE);
  return status?.state === 'success' || (status?.state === 'failure' && !!status.description?.startsWith(baseMark(base)));
};

/**
 * `push` der Konfiguration, wenn sich main oder ein Release-Branch bewegt hat; die erste Beobachtung löst nichts aus.
 * `saved` sind die Heads, deren push-Aufgabe erledigt ist (Datei `ctx.headsFile`): nach einem Neustart zählt der Vergleich damit,
 * nicht die erste Beobachtung. Ein Head wird erst nach der Aufgabe gespeichert, eine abgebrochene läuft beim nächsten Start nochmal.
 */
async function pushed(ctx, heads, saved, idle) {
  const moved = [];
  const save = () => { // erst eine Nebendatei, dann umbenennen: ein Abbruch mitten im Schreiben hinterlässt keine halbe Datei
    if (!ctx.headsFile) return;
    writeFileSync(`${ctx.headsFile}.tmp`, JSON.stringify(Object.fromEntries(saved)));
    renameSync(`${ctx.headsFile}.tmp`, ctx.headsFile);
  };
  for (const prefix of ['main', 'release/']) {
    for (const { ref, object } of ctx.api('GET', `git/matching-refs/heads/${prefix}`)) {
      const branch = ref.slice('refs/heads/'.length);
      if (branch !== 'main' && !branch.startsWith('release/')) continue;
      if (heads.has(branch) && heads.get(branch) !== object.sha) moved.push({ branch, before: heads.get(branch), after: object.sha });
      if (!heads.has(branch)) saved.set(branch, object.sha);
      heads.set(branch, object.sha);
    }
  }
  save();
  if (moved.length) await idle(); // die Befehle laufen im Projekt-Checkout: kein Platz holt dort gleichzeitig (Fetch) ab, wie bisher
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
    saved.set(branch, after);
    save();
  }
}

/**
 * Jede Minute: bewegte Branches, dann jeden offenen Nicht-Draft-PR mit neuem Head, oder neuer Basis nach rotem Endstand, genau einmal.
 * Bis zu `ctx.slots` PRs laufen gleichzeitig (Standard 1: einer nach dem anderen im Ordner `work`), jeder auf einem Platz mit eigenem
 * Arbeitsordner `work-1`, `work-2`, …; ein PR belegt nie zwei Plätze. `checkout()` hat kein `await`: die Git-Aufrufe im gemeinsamen
 * Projekt-Checkout (Fetch, FETCH_HEAD, Worktree anlegen) laufen so nie ineinander. Die `push`-Befehle laufen im selben Checkout und
 * warten deshalb, bis alle Plätze frei sind; neue PRs starten erst danach.
 */
export async function watch(ctx, { rounds = Infinity } = {}) {
  let known = {};
  if (ctx.headsFile) try { known = JSON.parse(readFileSync(ctx.headsFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error; // erster Start: die erste Beobachtung ist die Ausgangslage; eine kaputte oder fremde Datei (auch `null`) bricht den Start sichtbar ab
  }
  const heads = new Map(Object.entries(known)), saved = new Map(heads), done = new Map(), slots = ctx.slots ?? 1, busy = new Map(); // busy: Platz -> { number, task }
  const waitUntil = async free => { while (busy.size > slots - free) await Promise.race([...busy.values()].map(({ task }) => task)); };
  const slotFree = () => waitUntil(1), idle = () => waitUntil(slots);
  const start = pr => {
    const slot = [...Array(slots).keys()].find(index => !busy.has(index));
    const task = follow({ ...ctx, work: slots > 1 ? `${ctx.work}-${slot + 1}` : ctx.work }, pr)
      .catch(error => console.error(`#${pr.number}: ${error.message}`)) // ein Läuferfehler hält die anderen Plätze nicht auf
      .finally(() => busy.delete(slot));
    busy.set(slot, { number: pr.number, task });
  };
  for (let round = 0; round < rounds; round++) {
    try {
      await pushed(ctx, heads, saved, idle).catch(error => console.error(`push: ${error.message}`)); // ein Fehler hier hält die PR-Prüfungen nicht auf
      const bases = new Map(); // aktueller SHA je Ziel-Branch, einmal pro Runde
      for (const pr of ctx.api('GET', 'pulls?state=open&per_page=100').filter(pr => !pr.draft && pr.head.repo?.full_name === ctx.repository)) {
        try { if (!bases.has(pr.base.ref)) bases.set(pr.base.ref, ctx.api('GET', `git/ref/heads/${pr.base.ref}`).object.sha); } catch (error) {
          console.error(`#${pr.number}: Basis ${pr.base.ref} nicht lesbar, übersprungen (${error.message.split('\n')[0]})`); // 404 oder Rate-Limit hält die übrigen PRs nicht auf
          continue;
        }
        const base = bases.get(pr.base.ref), key = `${pr.head.sha} ${base}`;
        // läuft der PR noch (`follow` holt einen neuen Head selbst), startet er nicht ein zweites Mal auf einem anderen Platz
        if ([...busy.values()].some(({ number }) => number === pr.number) || done.get(pr.number) === key || finished(ctx, pr.head.sha, base)) continue;
        done.set(pr.number, key); // ponytail: ein Läuferfehler wiederholt Head und Basis nicht; ein neuer Push, eine neue Basis oder `local-ci.mjs PR` prüft erneut
        await slotFree();
        start(pr);
      }
    } catch (error) { console.error(error.message); }
    await slotFree(); // alle Plätze belegt: nicht neu abfragen, bis einer frei ist (bei einem Platz wie bisher: erst nach dem Lauf)
    if (round + 1 < rounds) await pause(ctx.pollMs);
  }
  await Promise.all([...busy.values()].map(({ task }) => task)); // nur bei endlichen `rounds`
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
    bash, repository, root, work: join(dir, 'work'), logs: join(dir, 'logs'), headsFile: join(dir, 'heads.json'), pollMs: 60_000,
    git: (cwd, ...args) => exec(git, ['-c', 'core.longpaths=true', ...args], { cwd }).trim(),
    api: (method, path, fields = {}) => JSON.parse(exec(gh, ['api', '-X', method, `repos/${repository}/${path}`, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])]) || 'null'),
  };
  lock(join(dir, 'lock'));
  if (mode === '--watch') {
    ctx.slots = branchConfig(ctx, 'main').slots; // einmal beim Start von origin/main wie die Prüfliste, nicht aus dem eigenen Checkout; ein neuer Wert gilt nach Neustart
    await watch(ctx);
  } else process.exitCode = (await follow(ctx, ctx.api('GET', `pulls/${mode}`))).ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
