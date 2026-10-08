// Lokale CI mit echtem Git (Merge-Stand wie refs/pull/N/merge) und nachgebautem gh: Filter, Auswahl, Ablauf der Status, Abbruch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPullRequest, lock, matches, select, watch } from '../local-ci.mjs';
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

test('die Sperrdatei lässt nur einen Läufer zu und übernimmt die eines toten Prozesses', t => {
  const file = join(temporary(t, 'local-ci lock '), 'lock');
  const release = lock(file);
  assert.throws(() => lock(file));
  release();
  writeFileSync(file, '99999999');
  lock(file)();
});

/** Ein Projekt mit Origin, PR 1 (Branch feature ändert backend/x.txt, bei `prConfig` auch die Prüfliste) und dem Merge-Stand unter refs/pull/1/merge. */
function fixture(t, config, prConfig) {
  const dir = temporary(t, 'local ci ');
  const env = { ...isolatedGit(dir), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const origin = join(dir, 'origin.git'), root = join(dir, 'root');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main', root);
  mkdirSync(join(root, '.github'));
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
  git(root, 'checkout', '-b', 'merge', 'main');
  git(root, 'merge', '--no-ff', '-m', 'merge', 'feature');
  git(root, 'push', '-q', 'origin', 'merge:refs/pull/1/merge', 'feature', 'main');
  git(root, 'checkout', 'main');
  const posts = [];
  const pr = { number: 1, state: 'open', draft: false, head: { sha: head, ref: 'feature', repo: { full_name: 'o/r' } }, base: { ref: 'main' } };
  const server = { pulls: [pr], current: pr, refs: [] };
  const api = (method, path, fields) => {
    if (method === 'POST') { posts.push(fields); return {}; }
    if (path.startsWith('pulls?')) return server.pulls;
    if (path.startsWith('pulls/')) return server.current;
    if (path.startsWith('git/matching-refs/')) return server.refs.filter(({ ref }) => ref.startsWith(`refs/heads/${path.split('heads/')[1]}`));
    return [];
  };
  const ctx = { repository: 'o/r', root, work: join(dir, 'work'), logs: join(dir, 'logs'), pollMs: 100, mergeWaitMs: 1, mergeAttempts: 2, git, api };
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
  const env = base => `test "$EVENT" = pull_request && test "$BASE_SHA" = ${base} && test "$HEAD_REF" = feature && test "$BASE_REF" = main`;
  f.publish({ checks: [
    { context: 'Backend', paths: ['backend/**'], run: [env(f.base), 'echo fein'], timeoutMinutes: 1 },
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
  f.publish({ checks: [check('Neu', 'touch neu')] });
  f.posts.length = 0;
  assert.equal((await checkPullRequest(f.ctx, f.pr)).ok, true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Neu: pending', 'Neu: success', 'local-ci: success']);
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
