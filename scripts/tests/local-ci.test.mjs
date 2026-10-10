// Lokale CI mit echtem Git (Merge-Stand wird aus origin/<base> und refs/pull/N/head gebaut) und nachgebautem gh: Filter, Auswahl, Ablauf der Status, push.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkPullRequest, claimSlot, gitBash, gitOptions, matches, runPush, select } from '../local-ci.mjs';
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

test('gleichzeitige Läufe bekommen verschiedene Plätze; die Sperre eines toten Prozesses wird übernommen', t => {
  const dir = temporary(t, 'local-ci slot ');
  assert.equal(claimSlot(dir), join(dir, 'work-1'));
  assert.equal(claimSlot(dir), join(dir, 'work-2'), 'der erste Platz gehört einem lebenden Prozess');
  writeFileSync(join(dir, 'lock-1'), '99999999');
  assert.equal(claimSlot(dir), join(dir, 'work-1'));
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
  const api = (method, path, fields) => {
    if (path.endsWith('/comments')) comments.push(fields.body);
    else posts.push({ ...fields, sha: path.split('/')[1] });
  };
  const bash = gitBash(git(dir, '--exec-path')); // wie der Läufer: unter Windows das Git Bash, nie ein WSL-bash im PATH
  const ctx = { repository: 'o/r', root, work: join(dir, 'work'), logs: join(dir, 'logs'), git: (cwd, ...args) => git(cwd, ...gitOptions, ...args), api, bash };
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
  return { ctx, git, pr, posts, comments, base, root, dir, publish, advance, summary: () => posts.map(({ context, state }) => `${context}: ${state}`) };
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
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Backend: pending', 'Broken: pending', 'Slow: pending',
    'Backend: success', 'Broken: failure', 'Slow: failure', 'local-ci: failure']);
  assert.match(f.posts.find(post => post.context === 'Broken' && post.state === 'failure').description, /Fehler 7/, 'die erste Fehlerzeile des Befehls steht im Status');
});

test('ohne betroffene Prüfung bleibt es bei einem grünen local-ci; ein fehlgeschlagenes Setup lässt die Prüfungen rot, ohne sie zu starten', async t => {
  const f = fixture(t, { checks: [{ context: 'Frontend', paths: ['frontend/**'], run: ['exit 1'], timeoutMinutes: 1 }] });
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: success']);
  f.publish({ setup: ['exit 1'], checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }] });
  f.posts.length = 0;
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
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
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
  assert.match(last(), /^Basis \w{12}: Basis rot: A; 1 von 1 rot: Backend$/);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0], /^Basis rot: A\n/);
  assert.ok(existsSync(join(f.ctx.work, 'gelaufen')));
  f.publish({ checks: [check('exit 1')], baseRecheck: recheck }); // rot ohne gemeldete Tests: kein Lauf an der Basis
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
  f.publish({ checks: [red] }); // ohne baseRecheck ändert sich nichts
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
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
  assert.equal(await checkPullRequest({ ...withVersion.ctx, fnm }, withVersion.pr), true);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['install 26.1.2', 'exec 26.1.2']);
  assert.equal(await checkPullRequest({ ...without.ctx, fnm }, without.pr), true);
  assert.ok(!existsSync(`${without.dir.replace(/\\/g, '/')}/fnm.log`), 'ohne .node-version wird fnm nicht gerufen');
  assert.equal(await checkPullRequest(withVersion.ctx, withVersion.pr), true); // ohne fnm
  const log = readFileSync(join(withVersion.ctx.logs, readdirSync(withVersion.ctx.logs).find(name => name.includes('Backend'))), 'utf8');
  assert.match(log, /\.node-version nennt 26\.1\.2, aber fnm fehlt/);
});

test('die Prüfliste kommt vom Ziel-Branch auf origin, weder aus dem PR noch aus dem eigenen Checkout; ein neuer Stand dort gilt beim nächsten Durchlauf', async t => {
  const check = (context, run) => ({ context, paths: ['backend/**'], run: [run], timeoutMinutes: 1 });
  const f = fixture(t, { checks: [check('Ziel', 'touch ziel')] }, { checks: [check('PR', 'touch pr')] });
  writeFileSync(join(f.root, '.github/local-checks.json'), JSON.stringify({ checks: [check('Lokal', 'touch lokal')] })); // ungepushte Änderung im Läufer-Checkout
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Ziel: pending', 'Ziel: success', 'local-ci: success']);
  assert.deepEqual(['ziel', 'pr', 'lokal'].map(name => existsSync(join(f.ctx.work, name))), [true, false, false]);
});

test('ein Konflikt mit dem Ziel-Branch ergibt ein rotes local-ci mit der Basis, ohne eine Prüfung zu starten', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }] });
  mkdirSync(join(f.root, 'backend'));
  writeFileSync(join(f.root, 'backend/x.txt'), 'anders');
  f.ctx.git(f.root, 'add', '-A');
  f.ctx.git(f.root, 'commit', '-qm', 'konflikt');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  assert.equal(await checkPullRequest(f.ctx, f.pr), false);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: failure']);
  assert.match(f.posts.at(-1).description, /^Basis [0-9a-f]{12}: Konflikt mit main$/);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
});

test('vor jedem Lauf ist der Arbeitsordner genau der PR-Stand: eine ignorierte Datei des vorigen Laufs ist weg', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['touch ignoriert'], timeoutMinutes: 1 }] });
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
  assert.ok(existsSync(join(f.ctx.work, 'ignoriert')));
  f.publish({ checks: [] });
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
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
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
  git(f.ctx.work, ...file, 'submodule', 'update', '--init'); // wie `setup`: das Kit im Arbeitsordner steht auf c1
  writeFileSync(join(sub, 'a'), '2');
  git(sub, 'commit', '-qam', 'c2');
  git(join(root, '.vendor/kit'), 'pull', '-q');
  git(root, 'commit', '-qam', 'pin c2');
  git(root, 'push', '-q', 'origin', 'main');
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
});

test('fehlt die Konfiguration auf dem Ziel-Branch, meldet local-ci das klar', async t => {
  const f = fixture(t, { checks: [{ context: 'Backend', paths: ['backend/**'], run: ['echo ok'], timeoutMinutes: 1 }] });
  f.ctx.git(f.root, 'rm', '-rfq', '.github'); // release/9 gibt es, aber ohne .github
  f.ctx.git(f.root, 'commit', '-qm', 'ohne');
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main:refs/heads/release/9');
  assert.equal(await checkPullRequest(f.ctx, { ...f.pr, base: { ref: 'release/9' } }), false);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'local-ci: failure']);
  assert.match(f.posts.at(-1).description, /fehlt auf origin\/release\/9/);
});

test('push läuft auf dem Stand des Merges, nicht im Checkout, mit Branch und beiden SHAs', async t => {
  // neu.txt gibt es nur auf dem neuen Stand von main; der Checkout (root) steht auf dem alten und hat sie nicht
  const f = fixture(t, { push: ['echo "$BRANCH $BEFORE_SHA $AFTER_SHA $EVENT $(cat neu.txt)" > ../pushed.txt'], checks: [] });
  const after = f.advance('neu.txt');
  f.ctx.git(f.root, 'reset', '-q', '--hard', f.base);
  assert.equal(await runPush(f.ctx, { branch: 'main', before: f.base, after }), true);
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

for (const kitOn of ['main', 'release']) {
  test(`push richtet das Kit im Worktree nach dessen eigenem Stand ein: Kit nur auf ${kitOn}`, async t => {
    const f = fixture(t, { push: ['cat .vendor/workflow-kit/kitfile >> ../pushed.txt || echo ohne >> ../pushed.txt'], checks: [] });
    f.ctx.git(f.root, 'checkout', '-q', '-b', 'release/1');
    if (kitOn === 'release') addKit(f); else f.ctx.git(f.root, 'commit', '--allow-empty', '-qm', 'release');
    f.ctx.git(f.root, 'push', '-q', 'origin', 'release/1');
    const release = f.ctx.git(f.root, 'rev-parse', 'HEAD');
    f.ctx.git(f.root, 'checkout', '-q', 'main');
    if (kitOn === 'main') { addKit(f); f.ctx.git(f.root, 'push', '-q', 'origin', 'main'); }
    await runPush(f.ctx, { branch: 'release/1', before: f.base, after: release });
    assert.equal(readFileSync(join(f.dir, 'pushed.txt'), 'utf8').trim(), kitOn === 'main' ? 'ohne' : 'kit');
  });
}

test('kitPush läuft auf main des Projekts, wenn sich main des Kits bewegt', async t => {
  // setup (npm ci im Projekt) läuft hier nicht, das Kit-Submodul ist aber da
  const f = fixture(t, { setup: ['exit 1'], kitPush: ['echo "$BRANCH $EVENT $BEFORE_SHA $AFTER_SHA $(git rev-parse HEAD) $(cat .vendor/workflow-kit/kitfile)" >> ../kit.txt'], checks: [] });
  addKit(f);
  f.ctx.git(f.root, 'push', '-q', 'origin', 'main');
  const main = f.ctx.git(f.root, 'rev-parse', 'HEAD'), [before, after] = ['a'.repeat(40), 'b'.repeat(40)];
  assert.equal(await runPush(f.ctx, { branch: 'main', before, after, kit: true }), true);
  assert.equal(readFileSync(join(f.dir, 'kit.txt'), 'utf8').trim(), `main kit ${before} ${after} ${main} kit`);
});

test('slow: eine langsame Prüfung läuft nur, wenn der Diff riskPaths trifft, sonst zählt sie als grün; ohne riskPaths läuft sie immer', async t => {
  const checks = [{ context: 'Slow', slow: true, paths: ['backend/**'], run: ['touch gelaufen'], timeoutMinutes: 1 }];
  const f = fixture(t, { checks });
  f.publish({ riskPaths: ['db/**'], checks });
  assert.equal(await checkPullRequest(f.ctx, f.pr), true);
  assert.deepEqual(f.summary(), ['local-ci: pending', 'Slow: success', 'local-ci: success']);
  assert.ok(!existsSync(join(f.ctx.work, 'gelaufen')));
  for (const config of [{ riskPaths: ['backend/**'], checks }, { checks }]) { // Risiko-Pfad getroffen, und ganz ohne riskPaths
    f.publish(config);
    f.posts.length = 0;
    assert.equal(await checkPullRequest(f.ctx, f.pr), true);
    assert.deepEqual(f.summary(), ['local-ci: pending', 'Slow: pending', 'Slow: success', 'local-ci: success']);
    assert.ok(existsSync(join(f.ctx.work, 'gelaufen')));
  }
});
