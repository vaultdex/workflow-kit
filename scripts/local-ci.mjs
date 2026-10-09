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

const SLOTS_MESSAGE = 'localChecks: "slots" muss eine ganze Zahl ab 1 sein';

/** `localChecks` aus .github/workflow-project.json: Pfad zu einer JSON-Datei mit checks, optional setup, push und kitPush. `read(pfad)` liefert den Inhalt. */
export function loadConfig(read) {
  const project = JSON.parse(read('.github/workflow-project.json'));
  assert.ok(project.localChecks, '.github/workflow-project.json hat kein "localChecks"');
  const { checks, setup = [], push = [], kitPush = [], slots = 1, riskPaths } = JSON.parse(read(project.localChecks));
  assert.ok(Number.isInteger(slots) && slots >= 1, SLOTS_MESSAGE);
  assert.ok(riskPaths === undefined || riskPaths.every?.(path => typeof path === 'string'), 'localChecks: "riskPaths" muss eine Liste von Pfaden sein');
  for (const check of checks) {
    assert.ok(check.context && check.paths?.every?.(path => typeof path === 'string') && check.run?.length && check.timeoutMinutes > 0,
      `localChecks: "${check.context}" braucht context, paths, run und timeoutMinutes`);
  }
  return { repository: project.repository, checks, setup, push, kitPush, slots, riskPaths };
}

/** Die Einstellung `localCiAfterApps` vom Ziel-Branch: ohne sie (oder ohne die belegt fehlende Datei dort, das meldet dann der Lauf selbst) null, der PR startet wie bisher. Ein Fetch- oder anderer Lesefehler wirft: Er gilt nicht als ausgeschaltete Einstellung. */
const waitSettings = (ctx, branch) => branchConfig(ctx, branch, undefined, read => {
  let text;
  try { text = read('.github/workflow-project.json'); } catch (error) { if (error.missing) return null; throw error; }
  const { localCiAfterApps, awaitApps = [] } = JSON.parse(text);
  return localCiAfterApps ? { apps: awaitApps } : null;
});

/** Warum der Head noch nicht dran ist (Text für den Status), oder null: die `apps` sind für ihn fertig und SonarCloud meldet 0 offene Befunde. */
export async function waitReason(ctx, pr, { apps }) {
  const runs = ctx.api('GET', `commits/${pr.head.sha}/check-runs?per_page=100`).check_runs;
  const waiting = apps.filter(app => !runs.some(run => run.app?.slug === app && run.status === 'completed'));
  if (waiting.length) return `wartet auf ${waiting.join(', ')}`;
  const sonar = runs.find(run => run.app?.slug === 'sonarqubecloud' && run.status === 'completed' && run.conclusion !== 'skipped');
  if (!sonar) return 'wartet auf die Sonar-Analyse'; // fehlt oder übersprungen: kein Nachweis
  const { origin, searchParams } = new URL(sonar.details_url ?? 'invalid:');
  if (!['https://sonarcloud.io', 'https://sonarqube.us'].includes(origin) || !searchParams.get('id') || searchParams.get('pullRequest') !== String(pr.number)) throw new Error('der Sonar-Check verlinkt nicht die Analyse dieses PRs');
  let open;
  if (ctx.sonarToken) { // Ein grünes Gate heißt nicht 0 Befunde; die anonyme API meldet bei privaten Projekten 0, darum nur mit Token
    const search = new URLSearchParams({ componentKeys: searchParams.get('id'), pullRequest: pr.number, resolved: 'false', ps: 1 });
    const response = await fetch(`${origin}/api/issues/search?${search}`, { headers: { Authorization: `Bearer ${ctx.sonarToken}` } });
    if (!response.ok) throw new Error(`Sonar-API antwortet ${response.status}`);
    open = (await response.json()).total;
  } else open = Number(/\[(\d+) New issues?\]/.exec(sonar.output?.summary)?.[1] ?? NaN); // die Zusammenfassung des Checks nennt die Zahl
  if (!Number.isSafeInteger(open)) throw new Error('SONAR_TOKEN fehlt und die Sonar-Zusammenfassung nennt keine Zahl');
  return open ? `${open} Sonar-Befunde offen` : null;
}

/** Die Platzzahl von main: nur sie wird gelesen, eine Prüfliste braucht main nicht (die der PRs kommt vom jeweiligen Ziel-Branch). Ohne Angabe gilt 1, ein ungültiger Wert bleibt ein Fehler. */
export function loadSlots(read) {
  const { localChecks } = JSON.parse(read('.github/workflow-project.json'));
  const { slots = 1 } = localChecks ? JSON.parse(read(localChecks)) : {};
  assert.ok(Number.isInteger(slots) && slots >= 1, SLOTS_MESSAGE);
  return slots;
}
export const mainSlots = ctx => branchConfig(ctx, 'main', undefined, loadSlots);

/** Die Konfiguration von origin/<branch> nach frischem Fetch: nie aus dem eigenen Checkout und nie aus dem PR, dem man nicht traut. */
export function branchConfig({ git, root }, branch, sha, load = loadConfig) {
  // Mit `sha` (die Basis, gegen die gemerged wurde) kein neuer Fetch: Prüfliste und Merge-Stand stammen aus demselben Commit.
  if (!sha) try { git(root, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { throw new Error(`origin/${branch} ist nicht abrufbar`); }
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
    git(root, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
    head = git(root, 'rev-parse', 'FETCH_HEAD');
  } catch { throw fail(`origin/${branch} oder refs/pull/${pr.number}/head ist nicht abrufbar`); }
  if (head !== pr.head.sha) throw Object.assign(fail('Der Head des PRs hat sich bewegt'), { moved: true }); // kein Fehler des PRs: der nächste Poll sieht den neuen Head
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
    const matched = select(config.checks, files);
    // `slow`-Prüfungen laufen nur, wenn der Diff `riskPaths` trifft; ohne `riskPaths` laufen sie immer.
    const risky = !config.riskPaths || files.some(file => matches(config.riskPaths, file));
    const selected = matched.filter(check => !check.slow || risky);
    for (const check of matched) if (!selected.includes(check)) report(check.context, 'success', 'übersprungen: risikoarm');
    if (!selected.length) {
      aggregate('success', matched.length ? `${matched.length} langsame Prüfungen übersprungen: risikoarm` : `Keine Prüfung betrifft die ${files.length} geänderten Dateien`);
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

/** Prüft den PR und, wenn währenddessen ein neuer Head kommt, auch diesen, sofern `hold(head)` keinen Grund zum Warten meldet (dann holt `watch` ihn in einer späteren Runde). */
export async function follow(ctx, pr, hold) {
  for (let result; ; pr = result.next) {
    result = await checkPullRequest(ctx, pr);
    if (!result.next || await hold?.(result.next)) return result;
  }
}

/** Grün bleibt grün, auch wenn sich die Basis bewegt (wie bei GitHub Actions; sonst liefe der Läufer bei jedem Merge für alle PRs voll). Rot gilt nur für die Basis, gegen die es lief. */
const finished = (ctx, sha, base) => {
  const status = ctx.api('GET', `commits/${sha}/statuses?per_page=100`).find(status => status.context === AGGREGATE);
  return status?.state === 'success' || (status?.state === 'failure' && !!status.description?.startsWith(baseMark(base)));
};

/** Das Kit-Repository aus .gitmodules von origin/main (lokale Referenz ohne Fetch, wie in kit-pin.mjs); ohne Kit-Submodul undefined. */
const kitRepository = ({ git, root }) => {
  try { return /github\.com[/:](.+?)(?:\.git)?$/.exec(git(root, 'config', '--blob', 'refs/remotes/origin/main:.gitmodules', '--get', 'submodule..vendor/workflow-kit.url'))?.[1]; } catch { return undefined; }
};

/**
 * `push` der Konfiguration, wenn sich main oder ein Release-Branch bewegt hat, und `kitPush`, wenn sich main des Kits bewegt hat
 * (dann auf main des Projekts); die erste Beobachtung löst nichts aus. Die Befehle laufen ohne `setup` (kein `npm ci`; nur das Kit-Submodul wird geholt) in einem eigenen Worktree auf
 * dem neuen Stand, nie im alten Stand des Läufer-Checkouts: bei `push` ist das `AFTER_SHA`, bei `kitPush` origin/main des Projekts
 * (dort ist `AFTER_SHA` der SHA im Kit, kein Commit des Projekts).
 * `saved` sind die Heads, deren Aufgabe erledigt ist (Datei `ctx.headsFile`): nach einem Neustart zählt der Vergleich damit,
 * nicht die erste Beobachtung. Ein Head wird erst nach der Aufgabe gespeichert, eine abgebrochene läuft beim nächsten Start nochmal.
 */
async function pushed(ctx, heads, saved, idle) {
  const moved = [];
  const save = () => { // erst eine Nebendatei, dann umbenennen: ein Abbruch mitten im Schreiben hinterlässt keine halbe Datei
    if (!ctx.headsFile) return;
    writeFileSync(`${ctx.headsFile}.tmp`, JSON.stringify(Object.fromEntries(saved)));
    renameSync(`${ctx.headsFile}.tmp`, ctx.headsFile);
  };
  const seen = (key, sha, event) => {
    if (heads.has(key) && heads.get(key) !== sha) moved.push({ ...event, key, before: heads.get(key), after: sha });
    if (!heads.has(key)) saved.set(key, sha);
    heads.set(key, sha);
  };
  for (const prefix of ['main', 'release/']) {
    for (const { ref, object } of ctx.api('GET', `git/matching-refs/heads/${prefix}`)) {
      const branch = ref.slice('refs/heads/'.length);
      if (branch === 'main' || branch.startsWith('release/')) seen(branch, object.sha, { branch });
    }
  }
  const kit = kitRepository(ctx);
  if (kit) try { seen('kit:main', ctx.api('GET', 'git/ref/heads/main', {}, kit).object.sha, { branch: 'main', kit: true }); } catch (error) { console.error(`push kit: ${error.message.split('\n')[0]}`); } // ein Fehler beim Kit hält die Projekt-Branches nicht auf
  save();
  if (moved.length) await idle(); // Fetch und Worktree entstehen im Projekt-Checkout: kein Platz holt dort gleichzeitig ab, wie bisher
  for (const { key, branch, before, after, kit } of moved) {
    const work = `${ctx.work}-push`;
    let config, commands;
    try {
      config = branchConfig(ctx, branch); // frischer Fetch von origin/<branch>
      commands = kit ? config.kitPush : config.push;
      if (commands.length) {
        worktreeAt(ctx, work, kit ? ctx.git(ctx.root, 'rev-parse', `refs/remotes/origin/${branch}`) : after);
        if (kitRepository(ctx)) ctx.git(work, 'submodule', 'update', '--init', '.vendor/workflow-kit'); // die Skripte brauchen das Kit, kein `setup` (npm ci blockierte alle Plätze)
      }
    } catch (error) { console.error(`push ${key}: übersprungen, ${error.message}`); continue; }
    if (commands.length) {
      const env = { ...process.env, BRANCH: branch, BEFORE_SHA: before, AFTER_SHA: after, EVENT: kit ? 'kit' : 'push' };
      mkdirSync(ctx.logs, { recursive: true });
      const log = join(ctx.logs, `push-${key.replace(/[^\w.-]+/g, '-')}.log`);
      writeFileSync(log, '');
      for (const command of commands) {
        const { code } = await shell(command, { cwd: work, env, log, timeoutMs: 30 * 60_000, state: {}, bash: ctx.bash });
        if (code) { console.error(`push ${key}: "${command}" endete mit ${code} (${log})`); break; }
      }
    }
    saved.set(key, after);
    save();
  }
}

/**
 * Jede Minute: bewegte Branches, dann jeden offenen Nicht-Draft-PR mit neuem Head, oder neuer Basis nach rotem Endstand, genau einmal.
 * Bis zu `ctx.slots` PRs laufen gleichzeitig (Standard 1: einer nach dem anderen im Ordner `work`), jeder auf einem Platz mit eigenem
 * Arbeitsordner `work-1`, `work-2`, …; ein PR belegt nie zwei Plätze. `checkout()` hat kein `await`: die Git-Aufrufe im gemeinsamen
 * Projekt-Checkout (Fetch, FETCH_HEAD, Worktree anlegen) laufen so nie ineinander. Die `push`-Befehle legen ihren Worktree im selben
 * Checkout an und warten deshalb, bis alle Plätze frei sind; neue PRs starten erst danach.
 */
export async function watch(ctx, { rounds = Infinity } = {}) {
  let known = {};
  if (ctx.headsFile) try { known = JSON.parse(readFileSync(ctx.headsFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error; // erster Start: die erste Beobachtung ist die Ausgangslage; eine kaputte oder fremde Datei (auch `null`) bricht den Start sichtbar ab
  }
  const heads = new Map(Object.entries(known)), saved = new Map(heads), done = new Map(), waiting = new Map(), slots = ctx.slots ?? 1, busy = new Map(); // busy: Platz -> { number, task }
  const waitUntil = async free => { while (busy.size > slots - free) await Promise.race([...busy.values()].map(({ task }) => task)); };
  const slotFree = () => waitUntil(1), idle = () => waitUntil(slots);
  // Einstellung `localCiAfterApps`: bis Sonar für den Head fertig ist und 0 Befunde offen sind, nimmt der Läufer den PR nicht, auch nicht als Folgehead in `follow`
  const hold = async (pr, settings = new Map()) => {
    let reason = null;
    try {
      if (!settings.has(pr.base.ref)) settings.set(pr.base.ref, waitSettings(ctx, pr.base.ref));
      reason = settings.get(pr.base.ref) && await waitReason(ctx, pr, settings.get(pr.base.ref));
    } catch (error) { reason = `Wartebedingung nicht lesbar: ${error.message.split('\n')[0]}`; }
    if (reason) { // ein Status je Head und Grund, kein Aufruf je Runde
      if (waiting.get(pr.number) !== `${pr.head.sha} ${reason}`) ctx.api('POST', `statuses/${pr.head.sha}`, { state: 'pending', context: AGGREGATE, description: reason.slice(0, 140) });
      waiting.set(pr.number, `${pr.head.sha} ${reason}`);
    }
    return reason;
  };
  const start = pr => {
    const slot = [...Array(slots).keys()].find(index => !busy.has(index));
    const task = follow({ ...ctx, work: slots > 1 ? `${ctx.work}-${slot + 1}` : ctx.work }, pr, hold)
      .catch(error => console.error(`#${pr.number}: ${error.message}`)) // ein Läuferfehler hält die anderen Plätze nicht auf
      .finally(() => busy.delete(slot));
    busy.set(slot, { number: pr.number, task });
  };
  for (let round = 0; round < rounds; round++) {
    try {
      await pushed(ctx, heads, saved, idle).catch(error => console.error(`push: ${error.message}`)); // ein Fehler hier hält die PR-Prüfungen nicht auf
      const bases = new Map(), settings = new Map(); // aktueller SHA und Einstellung `localCiAfterApps` je Ziel-Branch, einmal pro Runde
      for (const pr of ctx.api('GET', 'pulls?state=open&per_page=100').filter(pr => !pr.draft && pr.head.repo?.full_name === ctx.repository)) {
        try { if (!bases.has(pr.base.ref)) bases.set(pr.base.ref, ctx.api('GET', `git/ref/heads/${pr.base.ref}`).object.sha); } catch (error) {
          console.error(`#${pr.number}: Basis ${pr.base.ref} nicht lesbar, übersprungen (${error.message.split('\n')[0]})`); // 404 oder Rate-Limit hält die übrigen PRs nicht auf
          continue;
        }
        const base = bases.get(pr.base.ref), key = `${pr.head.sha} ${base}`;
        // läuft der PR noch (`follow` holt einen neuen Head selbst), startet er nicht ein zweites Mal auf einem anderen Platz
        if ([...busy.values()].some(({ number }) => number === pr.number) || done.get(pr.number) === key || finished(ctx, pr.head.sha, base)) continue;
        if (await hold(pr, settings)) continue;
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
    bash, repository, root, work: join(dir, 'work'), logs: join(dir, 'logs'), headsFile: join(dir, 'heads.json'), pollMs: 60_000, sonarToken: process.env.SONAR_TOKEN,
    git: (cwd, ...args) => exec(git, ['-c', 'core.longpaths=true', ...args], { cwd }).trim(),
    api: (method, path, fields = {}, repo = repository) => JSON.parse(exec(gh, ['api', '-X', method, `repos/${repo}/${path}`, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])]) || 'null'),
  };
  lock(join(dir, 'lock'));
  if (mode === '--watch') {
    ctx.slots = mainSlots(ctx); // einmal beim Start von origin/main wie die Prüfliste, nicht aus dem eigenen Checkout; ein neuer Wert gilt nach Neustart
    await watch(ctx);
  } else process.exitCode = (await follow(ctx, ctx.api('GET', `pulls/${mode}`))).ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
