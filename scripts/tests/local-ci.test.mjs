// Lokale CI mit echtem Git (Merge-Stand wird aus origin/<base> und refs/pull/N/head gebaut) und nachgebautem gh: Filter, Auswahl, Ablauf der Status, Abbruch, Basis-Wechsel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPullRequest, gitBash, gitOptions, loadConfig, loadSlots, lock, mainSlots, matches, select, supervise, watch } from '../local-ci.mjs';
import { isolatedGit, temporary } from './fixtures.mjs';

test('Pfad-Filter wie bei GitHub: der Reihe nach, "!" nimmt zurück, "*" bleibt im Ordner, "**" geht darunter', () => {
  assert.ok(matches(['backend/**'], 'backend/a/b.kt'));
  assert.ok(!matches(['backend/*'], 'backend/a/b.kt'));
  assert.ok(matches(['**/*.md'], 'README.md'));
  assert.ok(!matches(['backend/**', '!backend/docs/**'], 'backend/docs/x.md'));
  assert.ok(matches(['!backend/docs/**', 'backend/**'], 'backend/docs/x.md'), 'ein späterer Treffer gewinnt');
  assert.ok(!matches(['!backend/**'], 'backend/a.kt'), 'nur Ausschlüsse wählen nie etwas');
  assert.ok(!matches(['a.b'], 'axb'), 'Punkte sind keine Platzhalter');
  const checks = [{ context: 'Backend', paths: ['backend/**'] }, { context: 'Frontend', paths: ['frontend/**'] }];
  assert.deepEqual(select(checks, ['docs/x.md', 'frontend/a.ts']).map(check => check.context), ['Frontend']);
  assert.deepEqual(select(checks, ['docs/x.md']), []);
});

test('Git Bash: unter Windows nur das bash.exe der Git-Installation, fehlt es, bricht der Start ab; sonst bleibt es bei bash', () => {
  assert.equal(gitBash('/x/libexec/git-core', 'linux'), 'bash');
  assert.throws(() => gitBash('C:/gibt-es-nicht/mingw64/libexec/git-core', 'win32'), /Git Bash fehlt/);
});

test('die Sperrdatei lässt nur einen Läufer zu und übernimmt die eines toten Prozesses', t => {
  const file = join(temporary(t, 'local-ci lock '), 'lock');
  const release = lock(file);
  assert.throws(() => lock(file));
  release();
  writeFileSync(file, '99999999');
  lock(file)();
});

/** Ein Kind, das mit der nächsten Antwort aus `exits` endet; `kill` beendet es sofort mit Signal. */
function fakeStarts(exits) {
  const starts = [];
  return { starts, start() {
    const child = new EventEmitter();
    child.kill = signal => { starts.push(`kill ${signal}`); child.emit('exit', null, signal); };
    starts.push('start');
    if (exits.length) setImmediate(() => child.emit('exit', exits.shift(), null));
    return child;
  } };
}

test('--watch startet den Runner nach jedem Ende neu, außer bei Aufruffehler (2) und belegter Sperre (3)', async () => {
  const crashes = fakeStarts([1, 1, 0]);
  await supervise(crashes.start, { delayMs: 1, restarts: 2 });
  assert.deepEqual(crashes.starts, ['start', 'start', 'start']); // endliche Zahl von Neustarts
  for (const code of [2, 3]) {
    const once = fakeStarts([code, 1]);
    assert.equal(await supervise(once.start, { delayMs: 1 }), code);
    assert.deepEqual(once.starts, ['start']);
  }
});

test('SIGTERM im Elternprozess geht ans Kind und beendet die Schleife ohne Neustart', async () => {
  const running = fakeStarts([]);
  const done = supervise(running.start, { delayMs: 1 });
  process.emit('SIGTERM', 'SIGTERM');
  await done;
  assert.deepEqual(running.starts, ['start', 'kill SIGTERM']);
  const waiting = fakeStarts([1]); // das Signal in der Wartezeit vor dem Neustart weckt die Schleife
  const stopped = supervise(waiting.start, { delayMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(await stopped, 0);
  assert.equal(waiting.starts.filter(entry => entry === 'start').length, 1);
});

/** Im Arbeitsordner: BASE_SHA und HEAD^1 sind beide genau der aktuelle Stand von origin/main (der Fetch des Läufers hat ihn nachgezogen). */
const onBase = 'test "$BASE_SHA" = "$(git rev-parse refs/remotes/origin/main)" && test "$(git rev-parse HEAD^1)" = "$BASE_SHA"';

/** Ein Projekt mit Origin, PR 1 (Branch feature ändert backend/x.txt, bei `prConfig` auch die Prüfliste) und dem Head unter refs/pull/1/head. */
function fixture(t, config, prConfig) {
  const dir = temporary(t, 'local ci ');
  const env = { ...isolatedGit(dir), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const origin = join(dir, 'origin.git'), root = join(dir, 'root');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main', root);
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.gitignore'), 'ignoriert\n');
  writeFileSync(join(root, '.github/workflow-project.json'), JSON.stringify({ repository: 'o/r', localChecks: '.github/local-checks.json' }));
  writeFileSync(join(root, '.github/local-checks.json'), JSON.stringify(config));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', origin);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'feature');
  mkdirSync(join(root, 'backend'));
  writeFileSync(join(root, 'backend/x.txt'), 'x');
  if (prConfig) writeFileSync(join(root, '.github/local-checks.json'), JSON.stringify(prConfig));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'feature');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', '-q', 'origin', 'feature:refs/pull/1/head', 'feature', 'main');
  git(root, 'checkout', 'main');
  const posts = [], comments = [];
  const pr = { number: 1, state: 'open', draft: false, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } }, base: { ref: 'main' } };
  const server = { pulls: [pr], current: pr, refs: [] };
  const api = (method, path, fields, repo) => {
    if (repo === 'o/kit') return { object: { sha: server.kit } }; // main des Kits
    if (path.endsWith('/comments')) { comments.push(fields.body); return {}; }
    if (method === 'POST') { posts.push({ ...fields, sha: path.split('/')[1] }); return {}; }
    if (path.startsWith('pulls?')) return server.pulls;
    if (path.startsWith('pulls/')) return path === `pulls/${server.current.number}` ? server.current : server.pulls.find(({ number }) => path === `pulls/${number}`) ?? server.current;
    if (path.startsWith('git/matching-refs/')) return server.refs.filter(({ ref }) => ref.startsWith(`refs/heads/${path.split('heads/')[1]}`));
    if (path.startsWith('git/ref/heads/')) { // Ziel-Branch auf origin; ein Branch, den es dort nicht gibt, bekommt einen Platzhalter
      try { return { object: { sha: git(origin, 'rev-parse', `refs/heads/${path.slice('git/ref/heads/'.length)}`) } }; } catch { return { object: { sha: '0'.repeat(40) } }; }
    }
    if (path.includes('/check-runs?')) return { check_runs: server.checkRuns ?? [] };
    if (path.startsWith('commits/')) return posts.filter(post => post.context === 'local-ci' && post.sha === path.split('/')[1]).reverse(); // neuester zuerst wie bei GitHub
    return [];
  };
  const bash = gitBash(git(dir, '--exec-path')); // wie der Läufer: unter Windows das Git Bash, nie ein WSL-bash im PATH
  const ctx = { repository: 'o/r', root, work: join(dir, 'work'), logs: join(dir, 'logs'), pollMs: 100, git: (cwd, ...args) => git(cwd, ...gitOptions, ...args), api, bash };
  /** Ändert die Prüfliste auf main von origin (wie ein Merge dort); der Läufer liest sie beim nächsten Durchlauf. */
  const publish = next => {
    writeFileSync(join(root, '.github/local-checks.json'), JSON.stringify(next));
    git(root, 'commit', '-qam', 'checks');
    git(root, 'push', '-q', 'origin', 'main');
  };
  /** Ein neuer Commit auf main von origin mit der Datei `file` (wie ein Merge dort); liefert seinen SHA. */
  const advance = file => {
    writeFileSync(join(root, file), 'neu');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', file);
    git(root, 'push', '-q', 'origin', 'main');
    return git(root, 'rev-parse', 'HEAD');
  };
  return { ctx, git, pr, posts, comments, server, base, root, dir, publish, advance, summary: () => posts.map(({ context, state }) => `${context}: ${state}`) };
}

test('wählt nach den geänderten Dateien, meldet pending vor dem Ergebnis und gibt die Umgebung der Actions-CI weiter', async t => {
  const f = fixture(t, { setup: [], checks: [] });
  const env = `test "$EVENT" = pull_request && ${onBase} && test "$HEAD_REF" = feature && test "$BASE_REF" = main`;
  f.publish({ checks: [
    { context: 'Backend', paths: ['backend/**'], run: [env, 'echo fein'], timeoutMinutes: 1 },
    { context: 'Broken', paths: ['**', '!frontend/**'], run: ['echo "kaputt: Fehler 7" >&2; exit 3', 'echo nie'], timeoutMinutes: 1 },
    { context: 'Slow', paths: ['backend/*.txt'], run: ['sleep 30'], timeoutMinutes: 0.001 },
    { context: 'Frontend', paths: ['frontend/**'], run: ['exit 1'], timeoutMinutes: 1 },
    { context: 'Lint', paths: ['**', '!backend/**'], run: ['exit 1'], timeoutMinutes: 1 }] });
  const result = await checkPullRequest(f.ctx, f.pr);
  assert.deepEqual([result.ok, result.next], [false, null]);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Broken: pending', 'Slow: pending',
    'Backend: success', 'Broken: failure', 'Slow: failure', 'local-ci: failure']);
  assert.match(f.posts.find(post => post.context === 'Broken' && post.state === 'failure').description, /Fehler 7/, 'die erste Fehlerzeile des Befehls steht im Status');
});

test('ohne betroffene Prüfung bleibt es bei einem grünen local-ci; ein fehlgeschlagenes Setup lässt die Prüfungen rot, ohne sie zu starten', async t => {
  const f = fixture(t, { checks: [{ context: 'Frontend', paths: ['frontend/**'], run: ['exit 1'], timeoutMinutes: 1 }] });
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: success']);
  f.publish({ setup: ['exit 1'], checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }] });
  f.posts.length = 0;
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, false);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Backend: failure', 'local-ci: failure']);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
});

test('baseRecheck: bei rotem PR läuft er einmal an der Basis, "Basis rot" nennt nur die dort weiter roten Tests, in Status und Kommentar; ohne Wert oder ohne rote Tests läuft er nicht', async t => {
  const f = fixture(t, { checks: [] });
  const check = run => ({ context: 'Backend', paths: ['backend/**'], run: [run], timeoutMinutes: 1 });
  const red = check('printf "A\\nB\\n" >> "$LOCAL_CI_RED_TESTS"; exit 1');
  const recheck = 'test ! -e backend/x.txt && echo A > "$LOCAL_CI_BASE_RED_TESTS"; touch gelaufen'; // an der Basis fehlt die Datei des PRs; A bleibt rot, B nicht
  const last = () => f.posts.findLast(post => post.context === 'local-ci').description;
  f.publish({ checks: [red], baseRecheck: recheck });
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, false);
  assert.match(last(), /^Basis \w{12}: Basis rot: A; 1 von 1 rot: Backend$/);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0], /^Basis rot: A\n/);
  assert.ok(existsSync(join(f.ctx.work, 'gelaufen')));
  f.publish({ checks: [check('exit 1')], baseRecheck: recheck }); // rot ohne gemeldete Tests: kein Lauf an der Basis
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, false);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
  f.publish({ checks: [red] }); // ohne baseRecheck ändert sich nichts
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, false);
  assert.match(last(), /^Basis \w{12}: 1 von 1 rot: Backend$/);
  assert.equal(f.comments.length, 1);
});

test('.node-version des geprüften Stands wählt die Node-Version über fnm; ohne Datei ändert sich nichts, ohne fnm bleibt es bei der des Läufers mit Hinweis', async t => {
  const config = { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo gelaufen'], timeoutMinutes: 1 }] };
  const withVersion = fixture(t, config), without = fixture(t, config);
  const { root } = withVersion, git = withVersion.ctx.git;
  git(root, 'checkout', 'feature');
  writeFileSync(join(root, '.node-version'), '26.1.2\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'node');
  git(root, 'push', '-q', 'origin', 'feature:refs/pull/1/head');
  withVersion.pr.head.sha = git(root, 'rev-parse', 'HEAD');
  const fnm = join(withVersion.dir, 'fnm').replace(/\\/g, '/'), calls = `${fnm}.log`; // eingeschleust statt echtem fnm: merkt sich "install V" und "exec V" und führt den Befehl aus
  writeFileSync(fnm, '#!/bin/sh\necho "$1 ${2#--using=}" >> "$0.log"\n[ "$1" = exec ] && { shift 3; exec "$@"; }\nexit 0\n', { mode: 0o755 }); // ausführbar, sonst scheitert der Aufruf unter Linux
  assert.equal((await checkPullRequest({ ...withVersion.ctx, fnm }, withVersion.pr)).ok, true);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['install 26.1.2', 'exec 26.1.2']);
  assert.equal((await checkPullRequest({ ...without.ctx, fnm }, without.pr)).ok, true);
  assert.ok(!existsSync(`${without.dir.replace(/\\/g, '/')}/fnm.log`), 'ohne .node-version wird fnm nicht gerufen');
  assert.equal((await checkPullRequest(withVersion.ctx, withVersion.pr)).ok, true); // ohne fnm
  const log = readFileSync(join(withVersion.ctx.logs, readdirSync(withVersion.ctx.logs).find(name => name.includes('Backend'))), 'utf8');
  assert.match(log, /\.node-version nennt 26\.1\.2, aber fnm fehlt/);
});

test('die Prüfliste kommt vom Ziel-Branch auf origin, weder aus dem PR noch aus dem eigenen Checkout; ein neuer Stand dort gilt beim nächsten Durchlauf', async t => {
  const check = (context, run) => ({ context, paths: ['backend/**'], run: [run], timeoutMinutes: 1 });
  const f = fixture(t, { checks: [check('Ziel', 'touch ziel')] }, { checks: [check('PR', 'touch pr')] });
  writeFileSync(join(f.root, '.github/local-checks.json'), JSON.stringify({ checks: [check('Lokal', 'touch lokal')] })); // ungepushte Änderung im Läufer-Checkout
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Ziel: pending', 'Ziel: success', 'local-ci: success']);
  assert.deepEqual(['ziel', 'pr', 'lokal'].map(name => existsSync(join(f.ctx.work, name))), [true, false, false]);
});

/** Ein Lauf des PRs, dann bewegt sich main (neue Prüfliste "Neu"); `watch` läuft drei Runden. */
async function afterBaseMoves(t, firstRun) {
  const check = (context, run) => ({ context, paths: ['backend/**'], run: [run], timeoutMinutes: 1 });
  const f = fixture(t, { checks: [check('Alt', firstRun)] });
  const ctx = { ...f.ctx, pollMs: 1 }, api = ctx.api;
  let moved = false;
  ctx.api = (method, path, fields) => {
    if (path.startsWith('pulls?') && f.posts.length && !moved) { moved = true; f.publish({ checks: [check('Neu', `${onBase} && touch neu`)] }); }
    return api(method, path, fields);
  };
  await watch(ctx, { rounds: 3 });
  return { f, aggregates: f.posts.filter(post => post.context === 'local-ci') };
}

test('ein grünes local-ci bleibt grün, wenn sich der Ziel-Branch bewegt: kein neuer Lauf', async t => {
  const { f, aggregates } = await afterBaseMoves(t, 'touch alt');
  assert.deepEqual(aggregates.map(post => post.state), ['pending', 'success']);
  assert.deepEqual(['alt', 'neu'].map(name => existsSync(join(f.ctx.work, name))), [true, false]);
});

test('ein rotes local-ci wird bei neuer Basis ohne neuen Push gegen die neue Basis (und deren Prüfliste) neu geprüft; danach ist es fertig', async t => {
  const { f, aggregates } = await afterBaseMoves(t, 'exit 1');
  assert.deepEqual(aggregates.map(post => post.state), ['pending', 'failure', 'pending', 'success'], 'zwei Läufe, in Runde 3 nichts mehr');
  const [before, after] = aggregates.filter(post => post.state !== 'pending').map(post => post.description);
  assert.ok(before.startsWith(`Basis ${f.base.slice(0, 12)}:`) && after.startsWith(`Basis ${f.ctx.git(f.root, 'rev-parse', 'main').slice(0, 12)}:`), `${before} | ${after}`);
  assert.ok(existsSync(join(f.ctx.work, 'neu')), 'der Arbeitsordner ist der Stand gegen die neue Basis');
});

test('ein Konflikt mit dem Ziel-Branch ergibt ein rotes local-ci mit der Basis, ohne eine Prüfung zu starten', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }] });
  mkdirSync(join(f.root, 'backend'));
  writeFileSync(join(f.root, 'backend/x.txt'), 'anders');
  f.ctx.git(f.root, 'add', '-A');
  f.ctx.git(f.root, 'commit', '-qm', 'konflikt');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, false);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: failure']);
  assert.match(f.posts.at(-1).description, /^Basis [0-9a-f]{12}: Konflikt mit main$/);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
});

test('vor jedem Lauf ist der Arbeitsordner genau der PR-Stand: eine ignorierte Datei des vorigen Laufs ist weg', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch ignoriert'], timeoutMinutes: 1 }] });
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.ok(existsSync(join(f.ctx.work, 'ignoriert')));
  f.publish({ checks: [] });
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.ok(!existsSync(join(f.ctx.work, 'ignoriert')));
});

test('submodule.recurse=true im Clone: ein Pin-Bump auf einen Commit, den das Submodul im Arbeitsordner nicht hat, lässt den Checkout nicht scheitern', async t => {
  const f = fixture(t, { checks: [] });
  const { git, root } = f, file = ['-c', 'protocol.file.allow=always'], sub = join(f.dir, 'kit');
  git(f.dir, 'init', '-q', '-b', 'main', sub);
  writeFileSync(join(sub, 'a'), '1');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-qm', 'c1');
  git(root, ...file, 'submodule', 'add', '-q', sub, '.vendor/kit');
  git(root, 'commit', '-qm', 'pin c1');
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'config', 'submodule.recurse', 'true');
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  git(f.ctx.work, ...file, 'submodule', 'update', '--init'); // wie `setup`: das Kit im Arbeitsordner steht auf c1
  writeFileSync(join(sub, 'a'), '2');
  git(sub, 'commit', '-qam', 'c2');
  git(join(root, '.vendor/kit'), 'pull', '-q');
  git(root, 'commit', '-qam', 'pin c2');
  git(root, 'push', '-q', 'origin', 'main');
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
});

test('fehlt die Konfiguration auf dem Ziel-Branch, meldet local-ci das klar und die Schleife prüft den nächsten PR', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.ctx.git(f.root, 'checkout', '-q', '--orphan', 'leer'); // release/9 gibt es, aber ohne .github (ein fehlender Branch gälte als nicht abrufbar und wartet)
  f.ctx.git(f.root, 'rm', '-rfq', '.');
  f.ctx.git(f.root, 'commit', '-q', '--allow-empty', '-m', 'leer');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'leer:refs/heads/release/9');
  f.ctx.git(f.root, 'checkout', '-q', '-f', 'main');
  f.server.pulls = [{ ...f.pr, number: 2, base: { ref: 'release/9' } }, f.pr];
  await watch({ ...f.ctx, pollMs: 1 }, { rounds: 1 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: failure', 'local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);
});

test('ein neuer Head bricht die laufende Prüfung ab, schließt ihre Status und liefert den neuen PR', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['sleep 60'], timeoutMinutes: 5 }] });
  const pushed = { ...f.pr, head: { ...f.pr.head, sha: 'f'.repeat(40) } };
  f.server.current = pushed;
  const started = Date.now();
  const result = await checkPullRequest(f.ctx, f.pr);
  assert.ok(Date.now() - started < 30_000, 'der Befehl wurde beendet, nicht abgewartet');
  assert.equal(result.next, pushed);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'local-ci: error', 'Backend: error'], 'nichts wird grün gemeldet, nichts bleibt pending');
});

test('watch prüft einen neuen Head genau einmal, überspringt Drafts und Forks und führt push aus, wenn sich main bewegt: auf dem neuen Stand, nicht im Läufer-Checkout', async t => {
  // neu.txt gibt es nur auf dem neuen Stand von main; der Läufer-Checkout (root) steht auf dem alten und hat sie nicht
  const f = fixture(t, { push: ['echo "$BRANCH $BEFORE_SHA $AFTER_SHA $EVENT $(cat neu.txt)" > ../pushed.txt'], checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.server.pulls = [{ ...f.pr, number: 2, draft: true }, { ...f.pr, number: 3, head: { ...f.pr.head, repo: { full_name: 'x/r' } } }, f.pr];
  f.server.refs = [{ ref: 'refs/heads/main', object: { sha: f.base } }];
  const after = f.advance('neu.txt');
  f.ctx.git(f.root, 'reset', '-q', '--hard', f.base);
  const ctx = { ...f.ctx, pollMs: 1 };
  const moving = () => { f.server.refs = [{ ref: 'refs/heads/main', object: { sha: after } }, { ref: 'refs/heads/mainly', object: { sha: 'c'.repeat(40) } }]; };
  const api = ctx.api;
  ctx.api = (method, path, fields) => { if (path.startsWith('pulls?') && f.posts.length) moving(); return api(method, path, fields); };
  await watch(ctx, { rounds: 3 });
  assert.equal(f.posts.filter(post => post.context === 'local-ci' && post.state === 'pending').length, 1);
  assert.equal(f.posts.at(-1).state, 'success', JSON.stringify(f.posts));
  assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8').trim(), `main ${f.base} ${after} push neu`);
});

/** Legt ein lokales Kit an und committet es als Submodul auf den ausgecheckten Branch von f.root (ohne Push). */
function addKit(f) {
  const kit = join(f.dir, 'kit');
  mkdirSync(kit);
  f.ctx.git(kit, 'init', '-q', '-b', 'main');
  writeFileSync(join(kit, 'kitfile'), 'kit');
  f.ctx.git(kit, 'add', '-A');
  f.ctx.git(kit, 'commit', '-qm', 'kit');
  f.ctx.git(f.root, 'config', '--global', 'url.' + kit.replaceAll('\\', '/') + '.insteadOf', 'https://github.com/o/kit.git'); // das Submodul kommt vom lokalen Ordner
  f.ctx.git(f.root, 'config', '--global', 'protocol.file.allow', 'always');
  writeFileSync(join(f.root, '.gitmodules'), '[submodule ".vendor/workflow-kit"]\n\tpath = .vendor/workflow-kit\n\turl = https://github.com/o/kit.git\n');
  f.ctx.git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${f.ctx.git(kit, 'rev-parse', 'HEAD')},.vendor/workflow-kit`);
  f.ctx.git(f.root, 'add', '.gitmodules');
  f.ctx.git(f.root, 'commit', '-qm', 'kit');
}

test('watch führt push mit Konfiguration und Dateien des beobachteten Commits aus, auch wenn der Branch vor dem Fetch weiterzieht; die weitere Bewegung folgt danach', async t => {
  const f = fixture(t, { push: [], checks: [] });
  f.publish({ push: ['echo "a $AFTER_SHA $(git rev-parse HEAD)" >> ../pushed.txt'], checks: [] });
  const a = f.ctx.git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'new.sh'), 'echo b >> ../pushed.txt'); // das Skript gibt es erst in b
  f.ctx.git(f.root, 'add', 'new.sh');
  f.publish({ push: ['bash new.sh'], checks: [] });
  const b = f.ctx.git(f.root, 'rev-parse', 'HEAD'), ctx = { ...f.ctx, pollMs: 1, headsFile: join(f.dir, 'heads.json') };
  const main = sha => { f.server.refs = [{ ref: 'refs/heads/main', object: { sha } }]; };
  f.server.pulls = [];
  main(f.base);
  await watch(ctx, { rounds: 1 });
  main(a); // origin steht schon auf b, die API meldet noch a
  await watch(ctx, { rounds: 1 });
  assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8'), `a ${a} ${a}\n`);
  main(b);
  await watch(ctx, { rounds: 1 });
  assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8'), `a ${a} ${a}\nb\n`);
});

for (const kitOn of ['main', 'release']) {
  test(`watch richtet das Kit im push-Worktree nach dessen eigenem Stand ein: Kit nur auf ${kitOn}`, async t => {
    const f = fixture(t, { push: ['cat .vendor/workflow-kit/kitfile >> ../pushed.txt || echo ohne >> ../pushed.txt'], checks: [] });
    f.ctx.git(f.root, 'checkout', '-q', '-b', 'release/1');
    if (kitOn === 'release') addKit(f); else f.ctx.git(f.root, 'commit', '--allow-empty', '-qm', 'release');
    f.ctx.git(f.root, 'push', '-q', 'origin', 'release/1');
    const release = f.ctx.git(f.root, 'rev-parse', 'HEAD');
    f.ctx.git(f.root, 'checkout', '-q', 'main');
    if (kitOn === 'main') { addKit(f); f.ctx.git(f.root, 'push', '-q', 'origin', 'main'); }
    const ctx = { ...f.ctx, pollMs: 1, headsFile: join(f.dir, 'heads.json') };
    f.server.pulls = [];
    f.server.kit = 'a'.repeat(40);
    const refs = sha => { f.server.refs = [{ ref: 'refs/heads/release/1', object: { sha } }]; };
    refs(f.base);
    await watch(ctx, { rounds: 1 });
    refs(release);
    await watch(ctx, { rounds: 1 });
    assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8').trim(), kitOn === 'main' ? 'ohne' : 'kit');
  });
}

test('watch führt kitPush auf main des Projekts aus, wenn sich main des Kits bewegt; die erste Beobachtung löst nichts aus', async t => {
  // setup (npm ci im Projekt) läuft hier nicht, das Kit-Submodul ist aber da
  const f = fixture(t, { setup: ['exit 1'], kitPush: ['echo "$BRANCH $EVENT $BEFORE_SHA $AFTER_SHA $(git rev-parse HEAD) $(cat .vendor/workflow-kit/kitfile)" >> ../kit.txt'], checks: [] });
  addKit(f);
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  const main = f.ctx.git(f.root, 'rev-parse', 'HEAD'), ctx = { ...f.ctx, pollMs: 1, headsFile: join(f.dir, 'heads.json') };
  f.server.pulls = [];
  f.server.kit = 'a'.repeat(40);
  await watch(ctx, { rounds: 1 });
  assert.ok(!existsSync(join(f.dir, 'kit.txt')), 'erste Beobachtung: nur Ausgangslage');
  f.server.kit = 'b'.repeat(40);
  await watch(ctx, { rounds: 1 });
  assert.equal(readFileSync(join(f.dir, 'kit.txt'), 'utf8').trim(), `main kit ${'a'.repeat(40)} ${'b'.repeat(40)} ${main} kit`);
});

test('watch holt nach einem Neustart die push-Aufgabe nach, wenn sich main dazwischen bewegt hat; ohne Datei löst der erste Start nichts aus', async t => {
  const f = fixture(t, { push: ['echo "$BEFORE_SHA $AFTER_SHA" >> ../pushed.txt'], checks: [] });
  const ctx = { ...f.ctx, pollMs: 1, headsFile: join(f.root, '..', 'heads.json') };
  const [a, b, c] = [f.base, f.advance('b.txt'), f.advance('c.txt')];
  const main = sha => { f.server.refs = [{ ref: 'refs/heads/main', object: { sha } }]; };
  f.server.pulls = [];
  main(a);
  await watch(ctx, { rounds: 1 });
  assert.ok(!existsSync(join(f.dir, 'pushed.txt')), 'erster Start ohne Datei: nur Ausgangslage');
  main(b); // der Läufer ist aus
  await watch(ctx, { rounds: 1 });
  main(c);
  await watch(ctx, { rounds: 1 });
  assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8'), `${a} ${b}\n${b} ${c}\n`);
});

/** Drei offene PRs mit demselben Head; jede Prüfung legt eine Datei neben ihrem Arbeitsordner an und wartet bei `barrier` auf die der anderen. */
function threePullRequests(t, barrier) {
  const run = ['touch "$PWD.gestartet"', ...barrier ? ['for i in $(seq 100); do test -e ../work-1.gestartet && test -e ../work-2.gestartet && exit 0; sleep 0.1; done; exit 1'] : []];
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run, timeoutMinutes: 1 }] });
  const others = [2, 3].map(number => { // eigener Head je PR, sonst gälte der grüne Status des ersten für alle
    f.ctx.git(f.root, 'checkout', '-q', '-b', `feature${number}`, 'feature');
    writeFileSync(join(f.root, `backend/y${number}.txt`), 'y');
    f.ctx.git(f.root, 'add', '-A');
    f.ctx.git(f.root, 'commit', '-qm', `PR ${number}`);
    f.ctx.git(f.root, 'push', '-q', 'origin', `feature${number}:refs/pull/${number}/head`);
    return { ...f.pr, number, head: { ...f.pr.head, ref: `feature${number}`, sha: f.ctx.git(f.root, 'rev-parse', 'HEAD') } };
  });
  f.ctx.git(f.root, 'checkout', '-q', 'main');
  f.server.pulls = [f.pr, ...others];
  return { ...f, aggregates: () => f.posts.filter(post => post.context === 'local-ci').map(post => post.state) };
}

test('mit slots 2 belegen zwei PRs zwei Plätze mit eigenem Ordner, der dritte wartet auf einen freien', async t => {
  const f = threePullRequests(t, true);
  await watch({ ...f.ctx, slots: 2, pollMs: 1 }, { rounds: 1 });
  // Beide Prüfungen warten auf die Startdatei der anderen: das gelingt nur, wenn sie zugleich laufen. Der dritte startet erst, wenn einer fertig ist.
  assert.deepEqual(f.aggregates(), ['pending', 'pending', 'success', 'pending', 'success', 'success']);
  assert.deepEqual(['work-1', 'work-2', 'work-3', 'work'].map(name => existsSync(join(f.dir, `${name}.gestartet`))), [true, true, false, false]);
});

test('ohne slots läuft ein PR nach dem anderen im Ordner work, wie bisher', async t => {
  const f = threePullRequests(t, false);
  await watch({ ...f.ctx, pollMs: 1 }, { rounds: 1 });
  assert.deepEqual(f.aggregates(), ['pending', 'success', 'pending', 'success', 'pending', 'success']);
  assert.deepEqual(['work', 'work-1'].map(name => existsSync(join(f.dir, `${name}.gestartet`))), [true, false]);
});

test('ein PR-Lauf, der alle Plätze belegt, hält push (main, Release-Branch) und kitPush nicht auf: sie laufen währenddessen, die Prüfung wartet auf sie (#520)', async t => {
  const wait = 'for i in $(seq 100); do grep -qx main ../pushed.txt && grep -qx release/1 ../pushed.txt && test -e ../kit.txt && exit 0; sleep 0.1; done; exit 1';
  const f = fixture(t, { push: ['echo "$BRANCH" >> ../pushed.txt'], kitPush: ['touch ../kit.txt'], checks: [{ context: 'Backend', paths: ['backend/**'], run: [wait], timeoutMinutes: 1 }] });
  addKit(f);
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main', 'main:refs/heads/release/1');
  const before = f.ctx.git(f.root, 'rev-parse', 'HEAD');
  f.server.refs = ['main', 'release/1'].map(branch => ({ ref: `refs/heads/${branch}`, object: { sha: before } }));
  f.server.kit = 'a'.repeat(40);
  const after = f.advance('b.txt');
  const ctx = { ...f.ctx, pollMs: 1 }, api = ctx.api;
  ctx.api = (method, path, fields, repo) => { // main, Release-Branch und Kit-main bewegen sich, sobald der PR läuft und den einzigen Platz belegt
    if (path.startsWith('git/matching-refs/') && f.posts.length) { f.server.refs = f.server.refs.map(ref => ({ ...ref, object: { sha: after } })); f.server.kit = 'b'.repeat(40); }
    return api(method, path, fields, repo);
  };
  await watch(ctx, { rounds: 1 });
  assert.equal(f.posts.at(-1).state, 'success', JSON.stringify(f.posts));
});

test('ein PR belegt nie zwei Plätze: ein neuer Head während des Laufs wird von follow geprüft, nicht zusätzlich gestartet', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['sleep 1'], timeoutMinutes: 1 }] });
  f.ctx.git(f.root, 'checkout', '-q', 'feature');
  writeFileSync(join(f.root, 'backend/z.txt'), 'z');
  f.ctx.git(f.root, 'add', '-A');
  f.ctx.git(f.root, 'commit', '-qm', 'neuer Head');
  const pushed = { ...f.pr, head: { ...f.pr.head, sha: f.ctx.git(f.root, 'rev-parse', 'HEAD') } };
  f.ctx.git(f.root, 'checkout', '-q', 'main');
  const ctx = { ...f.ctx, slots: 2, pollMs: 1 }, api = ctx.api;
  let pushing = false; // der Push kommt, wenn der erste Lauf schon läuft
  ctx.api = (method, path, fields) => {
    if (path.startsWith('pulls?') && f.posts.length && !pushing) {
      pushing = true;
      f.ctx.git(f.root, 'push', '-q', 'origin', 'feature:refs/pull/1/head');
      f.server.pulls = [f.server.current = pushed];
    }
    return api(method, path, fields);
  };
  await watch(ctx, { rounds: 3 });
  assert.deepEqual(f.summary().filter(line => line.startsWith('local-ci')), ['local-ci: pending', 'local-ci: error', 'local-ci: pending', 'local-ci: success']);
});

test('slots muss eine ganze Zahl ab 1 sein, fehlt es, gilt 1', () => {
  const read = slots => path => path.endsWith('workflow-project.json') ? '{"localChecks":"c.json"}' : JSON.stringify({ checks: [], ...slots === undefined ? {} : { slots } });
  assert.equal(loadConfig(read()).slots, 1);
  assert.equal(loadConfig(read(2)).slots, 2);
  assert.equal(loadSlots(read(2)), 2);
  for (const bad of [0, 1.5, '2']) assert.throws(() => loadSlots(read(bad)), /slots/);
});

test('main ohne lokale CI: der Start gibt 1 Platz, und der Release-PR wird mit der Prüfliste seines Ziel-Branchs geprüft', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main:refs/heads/release/9');
  writeFileSync(join(f.root, '.github/workflow-project.json'), JSON.stringify({ repository: 'o/r' }));
  f.ctx.git(f.root, 'commit', '-qam', 'main ohne lokale CI');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  f.server.pulls = [{ ...f.pr, base: { ref: 'release/9' } }];
  const ctx = { ...f.ctx, pollMs: 1 };
  ctx.slots = mainSlots(ctx);
  assert.equal(ctx.slots, 1);
  await watch(ctx, { rounds: 1 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);
});

test('main mit reiner Platzkonfiguration: der Start liest nur slots, der Release-PR nutzt die Prüfliste seines Ziel-Branchs, ein Ziel-Branch ohne Prüfliste bleibt rot', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main:refs/heads/release/9');
  writeFileSync(join(f.root, '.github/local-checks.json'), '{"slots":2}');
  f.ctx.git(f.root, 'commit', '-qam', 'main nur mit slots');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main', 'main:refs/heads/release/10');
  f.server.pulls = [{ ...f.pr, number: 2, base: { ref: 'release/10' } }, { ...f.pr, base: { ref: 'release/9' } }];
  const ctx = { ...f.ctx, pollMs: 1 };
  assert.equal(mainSlots(ctx), 2);
  await watch(ctx, { rounds: 1 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: failure', 'local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);
});

test('slow: eine langsame Prüfung läuft nur, wenn der Diff riskPaths trifft, sonst zählt sie als grün; ohne riskPaths läuft sie immer', async t => {
  const checks = [{ context: 'Slow', slow: true, paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }];
  const f = fixture(t, { checks });
  f.publish({ riskPaths: ['db/**'], checks });
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Slow: success', 'local-ci: success']);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
  for (const config of [{ riskPaths: ['backend/**'], checks }, { checks }]) { // Risiko-Pfad getroffen, und ganz ohne riskPaths
    f.publish(config);
    f.posts.length = 0;
    assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
    assert.deepEqual(f.summary(), ['local-ci: pending', 'Slow: pending', 'Slow: success', 'local-ci: success']);
    assert.ok(existsSync(join(f.ctx.work, 'gelaufen')));
  }
});

test('localCiAfterApps: der Läufer nimmt den PR erst, wenn Sonar für den Head fertig ist und 0 Befunde offen sind; ohne die Einstellung startet er sofort', async t => {
  const checks = [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }];
  const sonar = summary => [{ app: { slug: 'sonarqubecloud' }, status: 'completed', conclusion: 'success', details_url: 'https://sonarcloud.io/dashboard?id=o_r&pullRequest=1', output: { summary } }];
  const round = async (f, rounds = 1) => { f.posts.length = 0; await watch({ ...f.ctx, pollMs: 1 }, { rounds }); return f.summary(); };
  const plain = fixture(t, { checks });
  assert.deepEqual(await round(plain),['local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);

  const f = fixture(t, { checks });
  writeFileSync(join(f.root, '.github/workflow-project.json'), JSON.stringify({ repository: 'o/r', localChecks: '.github/local-checks.json', awaitApps: ['sonarqubecloud'], localCiAfterApps: true }));
  f.ctx.git(f.root, 'commit', '-qam', 'warten');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await round(f, 2), ['local-ci: pending'], 'Sonar noch nicht fertig: zwei Runden, ein Status, kein Lauf');
  f.server.checkRuns = sonar('[3 New issues](x)');
  assert.deepEqual(await round(f), ['local-ci: pending'], 'Befunde offen: kein Lauf');
  f.server.checkRuns = sonar('[0 New issues](x)');
  assert.deepEqual(await round(f),['local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);
});

/** Ein Projekt, dessen main `localCiAfterApps` mit Sonar als awaitApp einschaltet; `sonarRuns(Zusammenfassung, Ergebnis)` ist die Antwort der Check-Runs. */
function afterAppsFixture(t, checks) {
  const f = fixture(t, { checks });
  writeFileSync(join(f.root, '.github/workflow-project.json'), JSON.stringify({ repository: 'o/r', localChecks: '.github/local-checks.json', awaitApps: ['sonarqubecloud'], localCiAfterApps: true }));
  f.ctx.git(f.root, 'commit', '-qam', 'warten');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  return f;
}
const sonarRuns = (summary, conclusion = 'success') => [{ app: { slug: 'sonarqubecloud' }, status: 'completed', conclusion, details_url: 'https://sonarcloud.io/dashboard?id=o_r&pullRequest=1', output: { summary } }];

test('localCiAfterApps: eine übersprungene Sonar-Analyse und ein einmaliger Fetchfehler beim Lesen der Einstellung geben die CI nicht frei', async t => {
  const f = afterAppsFixture(t, [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }]);
  f.server.checkRuns = sonarRuns('[0 New issues](x)', 'skipped');
  await watch({ ...f.ctx, pollMs: 1 }, { rounds: 2 });
  assert.deepEqual(f.summary(), ['local-ci: pending'], 'übersprungen: zwei Runden, ein Status, kein Lauf');

  f.server.checkRuns = sonarRuns('[0 New issues](x)');
  f.posts.length = 0;
  let failed = false; // der Fetch der Einstellung scheitert in der ersten Runde, danach klappt er
  const git = (cwd, ...args) => { if (args[0] === 'fetch' && !failed) { failed = true; throw new Error('Netz weg'); } return f.ctx.git(cwd, ...args); };
  await watch({ ...f.ctx, git, pollMs: 1 }, { rounds: 2 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success'], 'Fetchfehler: erst gemeldet und gewartet, dann geprüft');
});

test('localCiAfterApps: ein einmaliger Lesefehler der vorhandenen Einstellung gilt nicht als ausgeschaltet, die Sonar-Prüfung folgt in der nächsten Runde', async t => {
  const f = afterAppsFixture(t, [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }]);
  f.server.checkRuns = [];
  let failed = false; // der erste `git show` der Projektdatei scheitert, der Beleg `ls-tree` und alle späteren Lesungen klappen
  const git = (cwd, ...args) => { if (args[0] === 'show' && !failed) { failed = true; throw new Error('Lesefehler'); } return f.ctx.git(cwd, ...args); };
  await watch({ ...f.ctx, git, pollMs: 1 }, { rounds: 2 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: pending'], 'erst nicht lesbar, dann wartet auf Sonar: nie ein Prüfbefehl');
  assert.match(f.posts[0].description, /nicht lesbar/);

  f.server.checkRuns = sonarRuns('[0 New issues](x)');
  f.posts.length = 0;
  await watch({ ...f.ctx, pollMs: 1 }, { rounds: 2 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success'], 'Sonar 0: genau ein Lauf');

  const gone = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  gone.ctx.git(gone.root, 'rm', '-q', '.github/workflow-project.json');
  gone.ctx.git(gone.root, 'commit', '-qm', 'ohne Projektdatei');
  gone.ctx.git(gone.root, 'push', '-q', 'origin', 'main');
  await watch({ ...gone.ctx, pollMs: 1 }, { rounds: 1 });
  assert.match(gone.posts.at(-1).description, /fehlt auf origin\/main/, 'belegt fehlende Datei: bisherige Meldung im Lauf');
});

test('localCiAfterApps: ein Folgehead nach einem Push-Abbruch wartet wie der erste und läuft nach Sonar 0 genau einmal', async t => {
  const f = afterAppsFixture(t, [{ context: 'Backend', paths: ['backend/**'], run: ['sleep 1'], timeoutMinutes: 1 }]);
  f.ctx.git(f.root, 'checkout', '-q', 'feature');
  writeFileSync(join(f.root, 'backend/z.txt'), 'z');
  f.ctx.git(f.root, 'add', '-A');
  f.ctx.git(f.root, 'commit', '-qm', 'neuer Head');
  const pushed = { ...f.pr, head: { ...f.pr.head, sha: f.ctx.git(f.root, 'rev-parse', 'HEAD') } };
  f.ctx.git(f.root, 'checkout', '-q', 'main');
  const ctx = { ...f.ctx, slots: 2, pollMs: 1 }, api = ctx.api;
  let pushing = false; // der Push kommt, wenn der erste Lauf schon läuft; der neue Head hat nur eine übersprungene Analyse
  ctx.api = (method, path, fields) => {
    if (path.startsWith('pulls?') && f.posts.length && !pushing) {
      pushing = true;
      f.ctx.git(f.root, 'push', '-q', 'origin', 'feature:refs/pull/1/head');
      f.server.pulls = [f.server.current = pushed];
    }
    if (path.includes('/check-runs?')) return { check_runs: sonarRuns('[0 New issues](x)', path.includes(pushed.head.sha) ? 'skipped' : 'success') };
    return api(method, path, fields);
  };
  await watch(ctx, { rounds: 3 });
  assert.deepEqual(f.summary().filter(line => line.startsWith('local-ci')), ['local-ci: pending', 'local-ci: error', 'local-ci: pending'], 'alter Lauf beendet, neuer Head wartet');
  assert.equal(f.posts.filter(post => post.sha === pushed.head.sha && post.context === 'Backend').length, 0, 'der Prüfbefehl des neuen Heads lief nicht');

  f.posts.length = 0;
  ctx.api = (method, path, fields) => path.includes('/check-runs?') ? { check_runs: sonarRuns('[0 New issues](x)') } : api(method, path, fields);
  await watch(ctx, { rounds: 1 });
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Backend: success', 'local-ci: success']);
});
