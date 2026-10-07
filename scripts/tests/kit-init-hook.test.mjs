import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { rename } from '../provider-links.mjs';
import { isolatedGit, run as spawn, temporary } from './fixtures.mjs';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const handlers = (file, key, marker = 'ls-files -s -- .vendor/workflow-kit') => {
  const hooks = Object.values(JSON.parse(readFileSync(join(templates, file), 'utf8')).hooks).flat().flatMap(group => group.hooks ?? [group]);
  return hooks.filter(hook => hook[key]?.includes(marker)).map(hook => hook[key]);
};
// The init handlers of every agent: Claude, Codex, Cursor (shell part of its polyglot) and Copilot.
const posix = [['.claude/settings.json', 'command'], ['.codex/hooks.json', 'command'], ['.cursor/hooks.json', 'command'], ['.github/hooks/workflow-kit.json', 'bash']];
const windows = [['.codex/hooks.json', 'commandWindows'], ['.github/hooks/workflow-kit.json', 'powershell']];
const shell = process.platform === 'win32' ? { posix: 'sh', windows: 'powershell.exe' } : { posix: '/bin/sh', windows: 'pwsh' };

// Every handler runs in its own temporary directory with its own repositories, so the variants run side by side.
describe('kit init handlers', { concurrency: true }, () => {
for (const [kind, variants, args] of [['posix', posix, ['-c']], ['windows', windows, ['-NoProfile', '-NonInteractive', '-Command']]]) {
  const available = spawnSync(shell[kind], kind === 'posix' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0']).status === 0;
  describe(`${kind} hooks initialize a missing kit once and leave an initialized one alone`, { skip: !available && `${shell[kind]} unavailable`, concurrency: true }, () => {
    for (const [file, key] of variants) test(file, async t => {
      const temp = temporary(t, 'kit-init ');
      // The test submodule is a local path; Git blocks that transport for submodules unless allowed.
      const local = { ...isolatedGit(temp), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
      const git = async (cwd, ...a) => {
        const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env: local });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const fixture = async (name, ...files) => { const dir = join(temp, name); mkdirSync(dir); await git(dir, 'init', '--quiet'); for (const file of files) writeFileSync(join(dir, file), 'x'); return dir; };

      const kit = await fixture('kit', 'AGENT_RULES.md');
      // Checkout code the handler must not run: a team-wide relative core.hooksPath reaches the kit's own .githooks.
      mkdirSync(join(kit, '.githooks'));
      writeFileSync(join(kit, '.githooks/post-checkout'), '#!/bin/sh\necho ran > "$HOOK_MARKER"\n');
      await git(kit, 'add', '.'); await git(kit, 'update-index', '--chmod=+x', '.githooks/post-checkout'); await git(kit, 'commit', '--quiet', '-m', 'kit');
      const origin = await fixture('origin', 'README.md');
      await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
      await git(origin, 'add', '.'); await git(origin, 'commit', '--quiet', '-m', 'consumer');
      const plain = await fixture('plain', 'README.md');
      await git(plain, 'add', '.'); await git(plain, 'commit', '--quiet', '-m', 'plain');
      let count = 0;
      const clone = async () => { const dir = join(temp, 'clone' + count++); await git(temp, 'clone', '--quiet', origin, dir); return dir; };
      const marker = join(temp, 'hook-ran').replaceAll('\\', '/');
      const nested = { ...local, HOOK_MARKER: marker, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '.githooks' };
      // Precondition: without the handler's protection that hook does run during the init.
      const bare = await clone();
      const initialized = await spawn('git', ['submodule', '--quiet', 'update', '--init', '--checkout', '.vendor/workflow-kit'], { cwd: bare, env: nested });
      assert.equal(initialized.status, 0, initialized.stderr);
      assert.ok(existsSync(marker), 'the fixture hook runs when nothing disables hooks');
      rmSync(marker);

      const commands = new Set(handlers(file, key));
      assert.ok(commands.size, `${file} carries the kit init handler`);
      for (const command of commands) {
        const trial = (cwd, env) => spawn(shell[kind], [...args, command], { cwd, env: { ...nested, ...env } });
        const [first, second] = [await clone(), await clone()];
        assert.ok(!existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), 'fresh clone starts without the kit');

        let result = await trial(first);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '', 'a successful init prints nothing');
        assert.ok(existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), `${file} initializes the kit`);
        assert.ok(!existsSync(marker), `${file} runs no hook from the checkout`);

        const rules = join(first, '.vendor/workflow-kit/AGENT_RULES.md');
        rmSync(rules);
        result = await trial(first);
        assert.notEqual(result.stdout.trim(), '', 'a kit whose rules file is missing despite the update is reported');
        await git(join(first, '.vendor/workflow-kit'), 'checkout', '--', 'AGENT_RULES.md');

        rename(kit, `${kit}-gone`);
        result = await trial(first);
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], 'an initialized kit is not touched, not even to reach the source');

        result = await trial(second);
        assert.equal(result.status, 0, 'a failed init must not abort the session');
        assert.notEqual(result.stdout.trim(), '', 'a failed init prints the manual command');
        assert.ok(!existsSync(join(second, '.vendor/workflow-kit/AGENT_RULES.md')));
        rename(`${kit}-gone`, kit);

        // An initialized kit whose gitlink moved on (a base merge) lags behind the pin; the pin commit is not fetched yet.
        const head = async inner => (await git(inner, 'rev-parse', 'HEAD')).trim();
        // Initializing a submodule is the slowest Git call here, so it happens once; every case starts from a copy.
        let initialized;
        const stale = async () => {
          initialized ??= (async () => {
            const template = await clone();
            await git(template, 'submodule', '--quiet', 'update', '--init', '.vendor/workflow-kit');
            return template;
          })();
          const dir = join(temp, 'clone' + count++), inner = join(dir, '.vendor/workflow-kit');
          cpSync(await initialized, dir, { recursive: true });
          const old = await head(inner);
          await git(kit, 'commit', '--quiet', '--allow-empty', '-m', 'newer');
          const pin = await head(kit);
          await git(dir, 'update-index', '--cacheinfo', `160000,${pin},.vendor/workflow-kit`);
          assert.notEqual(old, pin, 'the kit lags behind its pin');
          return { dir, inner, old, pin };
        };
        let lag = await stale();
        result = await trial(lag.dir);
        assert.deepEqual([result.status, result.stdout, await head(lag.inner)], [0, '', lag.pin], `${file} moves a lagging kit to the pin`);
        assert.ok(!existsSync(marker), 'the update runs no hook from the checkout');

        // Work that a checkout would lose stays: local changes, unpublished commits. Both are reported.
        lag = await stale();
        writeFileSync(join(lag.inner, 'notes.txt'), 'mine');
        result = await trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit with local changes is reported');
        assert.deepEqual([await head(lag.inner), existsSync(join(lag.inner, 'notes.txt'))], [lag.old, true]);
        lag = await stale();
        await git(lag.inner, 'commit', '--quiet', '--allow-empty', '-m', 'mine');
        const mine = await head(lag.inner);
        result = await trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit with unpublished commits is reported');
        assert.equal(await head(lag.inner), mine);

        lag = await stale();
        rename(kit, `${kit}-gone`);
        result = await trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a lagging kit that cannot be updated is reported');
        assert.equal(await head(lag.inner), lag.old);
        rename(`${kit}-gone`, kit);

        // The agent's project directory wins over the hook's working directory.
        const away = await clone();
        result = await trial(temp, { CLAUDE_PROJECT_DIR: away });
        assert.ok(existsSync(join(away, '.vendor/workflow-kit/AGENT_RULES.md')), `${file} initializes the project directory, not the working directory`);

        if (kind === 'posix') {
          const noGit = mkdtempSync(join(temp, 'no-git '));
          const sh = process.platform === 'win32' ? (await spawn('where', ['sh'])).stdout.split(/\r?\n/)[0] : '/bin/sh';
          result = await spawn(sh, [...args, command], { cwd: await clone(), env: { ...process.env, PATH: noGit } });
          assert.deepEqual([result.status, result.stdout.trim() !== ''], [0, true], 'a missing git is reported, not skipped silently');
        }

        result = await trial(plain);
        assert.deepEqual([result.status, result.stdout], [0, ''], 'a project without a kit gitlink is left alone');
        assert.ok(!existsSync(join(plain, '.vendor')));
      }
    });
  });

  describe(`${kind} hooks report a checkout behind its fetched base, change nothing and never need the network`, { skip: !available && `${shell[kind]} unavailable`, concurrency: true }, () => {
    for (const [file, key] of variants) test(file, async t => {
      const temp = temporary(t, 'kit-behind ');
      const env = isolatedGit(temp);
      const git = async (cwd, ...a) => {
        const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      // The message names the repository: equal commits made in the same second would have equal ids.
      const commit = dir => git(dir, 'commit', '--quiet', '--allow-empty', '-m', `c ${count} ${dir}`);
      let count = 0;
      /** A clone of an upstream that moved on `behind` commits since the last fetch, plus `own` commits made in the clone. */
      const scenario = async (behind, own) => {
        const up = join(temp, `up${count}`), dir = join(temp, `work${count++}`);
        mkdirSync(up); await git(up, 'init', '--quiet'); await commit(up);
        await git(temp, 'clone', '--quiet', up, dir);
        for (let i = 0; i < behind; i++) await commit(up);
        if (behind) await git(dir, 'fetch', '--quiet');
        for (let i = 0; i < own; i++) await commit(dir);
        return { up, dir };
      };
      const state = async dir => [await git(dir, 'rev-parse', 'HEAD'), await git(dir, 'rev-parse', 'origin/HEAD'), await git(dir, 'status', '--porcelain')];

      const commands = new Set(handlers(file, key, 'merge-base --is-ancestor'));
      assert.ok(commands.size, `${file} carries the stale branch handler`);
      for (const command of commands) {
        const trial = cwd => spawn(shell[kind], [...args, command], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: '' } });
        const silent = async (cwd, why) => { const r = await trial(cwd); assert.deepEqual([r.status, r.stdout], [0, ''], why); };

        await silent((await scenario(0, 0)).dir, 'an up-to-date checkout is not reported');
        await silent((await scenario(0, 1)).dir, 'a checkout ahead of its base is not reported');
        await silent((await scenario(2, 1)).dir, 'a checkout with commits of its own is not reported');

        const { up, dir } = await scenario(2, 0);
        const before = await state(dir);
        let result = await trial(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\b2\b/, `${file} reports how many commits the checkout is behind`);
        if (file !== '.claude/settings.json') assert.doesNotThrow(() => JSON.parse(result.stdout), `${file}: host JSON`);
        assert.deepEqual(await state(dir), before, 'the hook changes nothing');

        // A branch without upstream is still compared with the remote's default branch; no remote is contacted.
        await git(dir, 'switch', '--quiet', '-c', 'solo', '--no-track');
        rename(up, `${up}-gone`);
        result = await trial(dir);
        assert.match(result.stdout, /\b2\b/, 'the check uses the last fetched state, not the network');

        const plain = join(temp, `plain${count++}`);
        mkdirSync(plain); await git(plain, 'init', '--quiet'); await commit(plain);
        await silent(plain, 'a checkout without remote is left alone');
        await silent(temp, 'a directory outside any repository is left alone');
      }
    });
  });
}
});
