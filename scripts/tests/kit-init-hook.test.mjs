import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const handlers = (file, key) => {
  const hooks = Object.values(JSON.parse(readFileSync(join(templates, file), 'utf8')).hooks).flat().flatMap(group => group.hooks ?? [group]);
  return hooks.filter(hook => hook[key]?.includes('ls-files -s -- .vendor/workflow-kit')).map(hook => hook[key]);
};
// The init handlers of every agent: Claude, Codex, Cursor (shell part of its polyglot) and Copilot.
const posix = [['.claude/settings.json', 'command'], ['.codex/hooks.json', 'command'], ['.cursor/hooks.json', 'command'], ['.github/hooks/workflow-kit.json', 'bash']];
const windows = [['.codex/hooks.json', 'commandWindows'], ['.github/hooks/workflow-kit.json', 'powershell']];
const shell = process.platform === 'win32' ? { posix: 'sh', windows: 'powershell.exe' } : { posix: '/bin/sh', windows: 'pwsh' };
const run = (command, args, cwd, env) => spawnSync(shell[command], [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

for (const [kind, variants, args] of [['posix', posix, ['-c']], ['windows', windows, ['-NoProfile', '-NonInteractive', '-Command']]]) {
  const available = spawnSync(shell[kind], kind === 'posix' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0']).status === 0;
  test(`${kind} hooks initialize a missing kit once and leave an initialized one alone`, { skip: !available && `${shell[kind]} unavailable` }, t => {
    const temp = mkdtempSync(join(tmpdir(), 'kit-init '));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, encoding: 'utf8', env: { ...process.env, ...local } });
    // The test submodule is a local path; Git blocks that transport for submodules unless allowed.
    const local = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
    const fixture = (name, ...files) => { const dir = join(temp, name); mkdirSync(dir); git(dir, 'init', '--quiet'); for (const file of files) writeFileSync(join(dir, file), 'x'); return dir; };

    const kit = fixture('kit', 'AGENT_RULES.md');
    // Checkout code the handler must not run: a team-wide relative core.hooksPath reaches the kit's own .githooks.
    mkdirSync(join(kit, '.githooks'));
    writeFileSync(join(kit, '.githooks/post-checkout'), '#!/bin/sh\necho ran > "$HOOK_MARKER"\n');
    git(kit, 'add', '.'); git(kit, 'update-index', '--chmod=+x', '.githooks/post-checkout'); git(kit, 'commit', '--quiet', '-m', 'kit');
    const origin = fixture('origin', 'README.md');
    git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
    git(origin, 'add', '.'); git(origin, 'commit', '--quiet', '-m', 'consumer');
    const plain = fixture('plain', 'README.md');
    git(plain, 'add', '.'); git(plain, 'commit', '--quiet', '-m', 'plain');
    let count = 0;
    const clone = () => { const dir = join(temp, 'clone' + count++); git(temp, 'clone', '--quiet', origin, dir); return dir; };
    const marker = join(temp, 'hook-ran').replaceAll('\\', '/');
    const nested = { ...local, HOOK_MARKER: marker, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '.githooks' };
    // Precondition: without the handler's protection that hook does run during the init.
    const bare = clone();
    execFileSync('git', ['submodule', '--quiet', 'update', '--init', '--checkout', '.vendor/workflow-kit'], { cwd: bare, env: { ...process.env, ...nested } });
    assert.ok(existsSync(marker), 'the fixture hook runs when nothing disables hooks');
    rmSync(marker);

    for (const [file, key] of variants) {
      const commands = new Set(handlers(file, key));
      assert.ok(commands.size, `${file} carries the kit init handler`);
      for (const command of commands) {
        const trial = (cwd, env) => run(kind, [...args, command], cwd, { ...nested, ...env });
        const [first, second] = [clone(), clone()];
        assert.ok(!existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), 'fresh clone starts without the kit');

        let result = trial(first);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '', 'a successful init prints nothing');
        assert.ok(existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), `${file} initializes the kit`);
        assert.ok(!existsSync(marker), `${file} runs no hook from the checkout`);

        const rules = join(first, '.vendor/workflow-kit/AGENT_RULES.md');
        rmSync(rules);
        result = trial(first);
        assert.notEqual(result.stdout.trim(), '', 'a kit whose rules file is missing despite the update is reported');
        git(join(first, '.vendor/workflow-kit'), 'checkout', '--', 'AGENT_RULES.md');

        renameSync(kit, `${kit}-gone`);
        result = trial(first);
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], 'an initialized kit is not touched, not even to reach the source');

        result = trial(second);
        assert.equal(result.status, 0, 'a failed init must not abort the session');
        assert.notEqual(result.stdout.trim(), '', 'a failed init prints the manual command');
        assert.ok(!existsSync(join(second, '.vendor/workflow-kit/AGENT_RULES.md')));
        renameSync(`${kit}-gone`, kit);

        // An initialized kit whose gitlink moved on (a base merge) lags behind the pin; the pin commit is not fetched yet.
        const head = inner => git(inner, 'rev-parse', 'HEAD').trim();
        const stale = () => {
          const dir = clone(), inner = join(dir, '.vendor/workflow-kit');
          git(dir, 'submodule', '--quiet', 'update', '--init', '.vendor/workflow-kit');
          const old = head(inner);
          git(kit, 'commit', '--quiet', '--allow-empty', '-m', 'newer');
          const pin = head(kit);
          git(dir, 'update-index', '--cacheinfo', `160000,${pin},.vendor/workflow-kit`);
          assert.notEqual(old, pin, 'the kit lags behind its pin');
          return { dir, inner, old, pin };
        };
        let lag = stale();
        result = trial(lag.dir);
        assert.deepEqual([result.status, result.stdout, head(lag.inner)], [0, '', lag.pin], `${file} moves a lagging kit to the pin`);
        assert.ok(!existsSync(marker), 'the update runs no hook from the checkout');

        // Work that a checkout would lose stays: local changes, unpublished commits. Both are reported.
        lag = stale();
        writeFileSync(join(lag.inner, 'notes.txt'), 'mine');
        result = trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit with local changes is reported');
        assert.deepEqual([head(lag.inner), existsSync(join(lag.inner, 'notes.txt'))], [lag.old, true]);
        lag = stale();
        git(lag.inner, 'commit', '--quiet', '--allow-empty', '-m', 'mine');
        const mine = head(lag.inner);
        result = trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit with unpublished commits is reported');
        assert.equal(head(lag.inner), mine);

        lag = stale();
        renameSync(kit, `${kit}-gone`);
        result = trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit that cannot be updated is reported');
        assert.equal(head(lag.inner), lag.old);
        renameSync(`${kit}-gone`, kit);

        // The agent's project directory wins over the hook's working directory.
        const away = clone();
        result = trial(temp, { CLAUDE_PROJECT_DIR: away });
        assert.ok(existsSync(join(away, '.vendor/workflow-kit/AGENT_RULES.md')), `${file} initializes the project directory, not the working directory`);

        if (kind === 'posix') {
          const noGit = mkdtempSync(join(temp, 'no-git '));
          const sh = process.platform === 'win32' ? execFileSync('where', ['sh'], { encoding: 'utf8' }).split(/\r?\n/)[0] : '/bin/sh';
          result = spawnSync(sh, [...args, command], { cwd: clone(), encoding: 'utf8', env: { ...process.env, PATH: noGit } });
          assert.deepEqual([result.status, result.stdout.trim() !== ''], [0, true], 'a missing git is reported, not skipped silently');
        }

        result = trial(plain);
        assert.deepEqual([result.status, result.stdout], [0, ''], 'a project without a kit gitlink is left alone');
        assert.ok(!existsSync(join(plain, '.vendor')));
      }
    }
  });
}
