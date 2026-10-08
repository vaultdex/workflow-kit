// Lokale CI mit echtem Git (Merge-Stand wird aus origin/<base> und refs/pull/N/head gebaut) und nachgebautem gh: Filter, Auswahl, Ablauf der Status, Abbruch, Basis-Wechsel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPullRequest, gitBash, loadConfig, lock, matches, select, watch } from '../local-ci.mjs';
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
  const posts = [];
  const pr = { number: 1, state: 'open', draft: false, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } }, base: { ref: 'main' } };
  const server = { pulls: [pr], current: pr, refs: [] };
  const api = (method, path, fields) => {
    if (method === 'POST') { posts.push({ ...fields, sha: path.split('/')[1] }); return {}; }
    if (path.startsWith('pulls?')) return server.pulls;
    if (path.startsWith('pulls/')) return path === `pulls/${server.current.number}` ? server.current : server.pulls.find(({ number }) => path === `pulls/${number}`) ?? server.current;
    if (path.startsWith('git/matching-refs/')) return server.refs.filter(({ ref }) => ref.startsWith(`refs/heads/${path.split('heads/')[1]}`));
    if (path.startsWith('git/ref/heads/')) { // Ziel-Branch auf origin; ein Branch, den es dort nicht gibt, bekommt einen Platzhalter
      try { return { object: { sha: git(origin, 'rev-parse', `refs/heads/${path.slice('git/ref/heads/'.length)}`) } }; } catch { return { object: { sha: '0'.repeat(40) } }; }
    }
    if (path.startsWith('commits/')) return posts.filter(post => post.context === 'local-ci' && post.sha === path.split('/')[1]).reverse(); // neuester zuerst wie bei GitHub
    return [];
  };
  const ctx = { repository: 'o/r', root, work: join(dir, 'work'), logs: join(dir, 'logs'), pollMs: 100, git, api };
  /** Ändert die Prüfliste auf main von origin (wie ein Merge dort); der Läufer liest sie beim nächsten Durchlauf. */
  const publish = next => {
    writeFileSync(join(root, '.github/local-checks.json'), JSON.stringify(next));
    git(root, 'commit', '-qam', 'checks');
    git(root, 'push', '-q', 'origin', 'main');
  };
  return { ctx, pr, posts, server, base, root, dir, publish, summary: () => posts.map(({ context, state }) => `${context}: ${state}`) };
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

test('fehlt die Konfiguration auf dem Ziel-Branch, meldet local-ci das klar und die Schleife prüft den nächsten PR', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
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

test('watch prüft einen neuen Head genau einmal, überspringt Drafts und Forks und führt push aus, wenn sich main bewegt', async t => {
  const f = fixture(t, { push: ['echo "$BRANCH $BEFORE_SHA $AFTER_SHA $EVENT" > pushed.txt'], checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.server.pulls = [{ ...f.pr, number: 2, draft: true }, { ...f.pr, number: 3, head: { ...f.pr.head, repo: { full_name: 'x/r' } } }, f.pr];
  f.server.refs = [{ ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } }];
  const ctx = { ...f.ctx, pollMs: 1 };
  const moving = () => { f.server.refs = [{ ref: 'refs/heads/main', object: { sha: 'b'.repeat(40) } }, { ref: 'refs/heads/mainly', object: { sha: 'c'.repeat(40) } }]; };
  const api = ctx.api;
  ctx.api = (method, path, fields) => { if (path.startsWith('pulls?') && f.posts.length) moving(); return api(method, path, fields); };
  await watch(ctx, { rounds: 3 });
  assert.equal(f.posts.filter(post => post.context === 'local-ci' && post.state === 'pending').length, 1);
  assert.equal(f.posts.at(-1).state, 'success', JSON.stringify(f.posts));
  assert.equal(readFileSync(join(f.root, 'pushed.txt'), 'utf8').trim(), `main ${'a'.repeat(40)} ${'b'.repeat(40)} push`);
});

test('watch holt nach einem Neustart die push-Aufgabe nach, wenn sich main dazwischen bewegt hat; ohne Datei löst der erste Start nichts aus', async t => {
  const f = fixture(t, { push: ['echo "$BEFORE_SHA $AFTER_SHA" >> pushed.txt'], checks: [] });
  const ctx = { ...f.ctx, pollMs: 1, headsFile: join(f.root, '..', 'heads.json') };
  const main = sha => { f.server.refs = [{ ref: 'refs/heads/main', object: { sha: sha.repeat(40) } }]; };
  f.server.pulls = [];
  main('a');
  await watch(ctx, { rounds: 1 });
  assert.ok(!existsSync(join(f.root, 'pushed.txt')), 'erster Start ohne Datei: nur Ausgangslage');
  main('b'); // der Läufer ist aus
  await watch(ctx, { rounds: 1 });
  main('c');
  await watch(ctx, { rounds: 1 });
  assert.equal(readFileSync(join(f.root, 'pushed.txt'), 'utf8'), `${'a'.repeat(40)} ${'b'.repeat(40)}\n${'b'.repeat(40)} ${'c'.repeat(40)}\n`);
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

test('mit slots 2 wartet ein fälliger push, bis die laufenden Prüfungen fertig sind: kein Fetch der Plätze im Projekt-Checkout währenddessen', async t => {
  const f = fixture(t, { push: ['test -e ../work-1.fertig && echo ok > pushed.txt'], checks: [{ context: 'Backend', paths: ['backend/**'], run: ['sleep 1', 'touch "$PWD.fertig"'], timeoutMinutes: 1 }] });
  f.server.refs = [{ ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } }];
  const ctx = { ...f.ctx, slots: 2, pollMs: 1 }, api = ctx.api;
  ctx.api = (method, path, fields) => { if (path.startsWith('pulls?') && f.posts.length) f.server.refs = [{ ref: 'refs/heads/main', object: { sha: 'b'.repeat(40) } }]; return api(method, path, fields); };
  await watch(ctx, { rounds: 3 });
  assert.equal(readFileSync(join(f.root, 'pushed.txt'), 'utf8').trim(), 'ok');
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
  for (const bad of [0, 1.5, '2']) assert.throws(() => loadConfig(read(bad)), /slots/);
});
