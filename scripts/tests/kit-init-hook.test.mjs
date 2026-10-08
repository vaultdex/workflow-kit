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

        // A .git file that points nowhere (aborted first clone): with other files in the folder the hook only reports,
        // with nothing but the .git file it clears it, and an empty modules remnant, and loads the pin again.
        lag = await stale();
        rmSync(join(lag.dir, '.git/modules'), { recursive: true });
        result = await trial(lag.dir);
        assert.notEqual(result.stdout.trim(), '', 'a kit with a dangling .git and other files is reported');
        assert.ok(existsSync(join(lag.inner, 'AGENT_RULES.md')));
        for (const name of ['AGENT_RULES.md', '.githooks']) rmSync(join(lag.inner, name), { recursive: true });
        mkdirSync(join(lag.dir, '.git/modules'));
        result = await trial(lag.dir);
        assert.deepEqual([result.status, result.stdout, await head(lag.inner)], [0, '', lag.pin], `${file} repairs a dangling .git`);

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

  describe(`${kind} hooks fast-forward a clean checkout behind its fetched base, warn when changes stop that, and never need the network`, { skip: !available && `${shell[kind]} unavailable`, concurrency: true }, () => {
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
      const dirty = dir => writeFileSync(join(dir, 'notes.txt'), 'mine');

      const init = new Set(handlers(file, key));
      const warn = new Set(handlers(file, key, 'merge-base --is-ancestor').filter(command => !init.has(command)));
      assert.ok(warn.size && init.size, `${file} carries the stale branch handler and the kit init handler`);
      for (const command of warn) {
        const trial = cwd => spawn(shell[kind], [...args, command], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: '' } });
        const silent = async (cwd, why) => { const r = await trial(cwd); assert.deepEqual([r.status, r.stdout], [0, ''], why); };

        await silent((await scenario(0, 0)).dir, 'an up-to-date checkout is not reported');
        await silent((await scenario(0, 1)).dir, 'a checkout ahead of its base is not reported');
        await silent((await scenario(2, 1)).dir, 'a checkout with commits of its own is not reported');
        await silent((await scenario(2, 0)).dir, 'a clean checkout is not reported: the init handler fast-forwards it');

        const { up, dir } = await scenario(2, 0);
        await dirty(dir);
        const before = await state(dir);
        let result = await trial(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /\b2\b/, `${file} reports how many commits the checkout is behind`);
        if (file !== '.claude/settings.json') assert.doesNotThrow(() => JSON.parse(result.stdout), `${file}: host JSON`);
        assert.deepEqual(await state(dir), before, 'the warning changes nothing');

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
      for (const command of init) {
        const trial = cwd => spawn(shell[kind], [...args, command], { cwd, env: { ...env, CLAUDE_PROJECT_DIR: '' } });
        const kept = async ({ dir }, why) => {
          const before = await state(dir);
          const result = await trial(dir);
          assert.deepEqual([result.status, await state(dir)], [0, before], why);
        };
        await kept(await scenario(2, 1), 'a checkout with commits of its own is not moved');
        const changed = await scenario(2, 0);
        await dirty(changed.dir);
        await kept(changed, 'a checkout with local changes is not moved');

        // No network and no upstream branch: the last fetched origin/HEAD is enough.
        const { up, dir } = await scenario(2, 0);
        await git(dir, 'switch', '--quiet', '-c', 'solo', '--no-track');
        rename(up, `${up}-gone`);
        const result = await trial(dir);
        assert.equal(result.status, 0, result.stderr);
        const [head, base, status] = await state(dir);
        assert.deepEqual([head, status], [base, ''], `${file} fast-forwards a clean checkout to the last fetched base`);

        // No hook of the checkout runs: a team-wide relative core.hooksPath reaches a post-merge hook that arrives with the merge.
        const marker = join(temp, 'hook-ran').replaceAll('\\', '/');
        const nested = { ...env, HOOK_MARKER: marker, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.githooks', CLAUDE_PROJECT_DIR: '' };
        const hooked = async () => {
          const { up, dir } = await scenario(0, 0);
          mkdirSync(join(up, '.githooks'));
          writeFileSync(join(up, '.githooks/post-merge'), '#!/bin/sh\necho ran > "$HOOK_MARKER"\n');
          await git(up, 'add', '.'); await git(up, 'update-index', '--chmod=+x', '.githooks/post-merge'); await commit(up);
          await git(dir, 'fetch', '--quiet');
          return dir;
        };
        const plain = await spawn('git', ['merge', '--quiet', '--ff-only', 'origin/HEAD'], { cwd: await hooked(), env: nested });
        assert.equal(plain.status, 0, plain.stderr);
        assert.ok(existsSync(marker), 'the fixture hook runs when nothing disables hooks');
        rmSync(marker);
        const guarded = await hooked();
        await spawn(shell[kind], [...args, command], { cwd: guarded, env: nested });
        assert.equal((await state(guarded))[0], await git(guarded, 'rev-parse', 'origin/HEAD'), 'the checkout was fast-forwarded');
        assert.ok(!existsSync(marker), `${file} runs no hook from the checkout`);
      }
    });
  });

  describe(`${kind} hooks move the kit to the pin of the fast-forwarded checkout`, { skip: !available && `${shell[kind]} unavailable`, concurrency: true }, () => {
    for (const [file, key] of variants) test(file, async t => {
      const temp = temporary(t, 'kit-follow ');
      const env = { ...isolatedGit(temp), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
      const git = async (cwd, ...a) => {
        const result = await spawn('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, env });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      const fixture = async (name, file) => { const dir = join(temp, name); mkdirSync(dir); await git(dir, 'init', '--quiet'); writeFileSync(join(dir, file), 'x'); await git(dir, 'add', '.'); await git(dir, 'commit', '--quiet', '-m', name); return dir; };
      const kit = await fixture('kit', 'AGENT_RULES.md'), origin = await fixture('origin', 'README.md');
      await git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
      await git(origin, 'commit', '--quiet', '-m', 'consumer');
      const work = join(temp, 'work');
      await git(temp, 'clone', '--quiet', '--recurse-submodules', origin, work);
      // The consumer moves its pin to a newer kit commit; the clone only fetches that.
      await git(kit, 'commit', '--quiet', '--allow-empty', '-m', 'newer');
      const pin = await git(kit, 'rev-parse', 'HEAD'), inner = join(work, '.vendor/workflow-kit');
      await git(join(origin, '.vendor/workflow-kit'), 'pull', '--quiet');
      await git(origin, 'commit', '--quiet', '-am', 'bump the kit');
      await git(work, 'fetch', '--quiet');
      assert.notEqual(await git(inner, 'rev-parse', 'HEAD'), pin, 'the kit lags behind the fetched pin');

      for (const command of new Set(handlers(file, key))) {
        const result = await spawn(shell[kind], [...args, command], { cwd: work, env: { ...env, CLAUDE_PROJECT_DIR: '' } });
        assert.deepEqual([result.status, result.stdout], [0, ''], result.stderr);
        assert.deepEqual([await git(work, 'rev-parse', 'HEAD'), await git(inner, 'rev-parse', 'HEAD')], [await git(origin, 'rev-parse', 'HEAD'), pin]);
      }
    });
  });

  describe(`${kind} hooks report a missing node_modules, name the project setup and never install`, { skip: !available && `${shell[kind]} unavailable`, concurrency: true }, () => {
    for (const [file, key] of variants) test(file, async t => {
      const temp = temporary(t, 'kit-modules ');
      const env = { ...isolatedGit(temp), CLAUDE_PROJECT_DIR: '' };
      const commands = new Set(handlers(file, key, 'node_modules'));
      assert.equal(commands.size, 1, `${file} carries the node_modules handler`);
      const [command] = commands;
      let count = 0;
      const project = async (manifest, setup) => {
        const dir = join(temp, `p${count++}`);
        mkdirSync(join(dir, '.github'), { recursive: true });
        assert.equal((await spawn('git', ['init', '--quiet'], { cwd: dir, env })).status, 0);
        if (manifest) writeFileSync(join(dir, 'package.json'), manifest);
        if (setup) writeFileSync(join(dir, '.github/workflow-project.json'), JSON.stringify({ setup }, null, 2));
        return dir;
      };
      const trial = async dir => {
        const result = await spawn(shell[kind], [...args, command], { cwd: dir, env });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const reported = async (dir, why) => {
        const out = await trial(dir);
        assert.match(out, /node_modules is missing/, why);
        if (file !== '.claude/settings.json') assert.doesNotThrow(() => JSON.parse(out), `${file}: host JSON`);
        assert.ok(!existsSync(join(dir, 'node_modules')), 'nothing is installed');
        return out;
      };
      const silent = async (dir, why) => assert.equal(await trial(dir), '', why);

      const manifest = JSON.stringify({ name: 'x', devDependencies: { a: '1' } }, null, 2);
      await reported(await project(manifest), 'a worktree without node_modules is reported');
      assert.match(await reported(await project(manifest, 'pnpm run setup:all'), 'the setup field is honored'), /pnpm run setup:all/);

      const installed = await project(manifest);
      mkdirSync(join(installed, 'node_modules'));
      await silent(installed, 'a worktree with node_modules is left alone');
      await silent(await project(JSON.stringify({ name: 'x', dependencies: {} })), 'a manifest without dependencies is left alone');
      await silent(await project(JSON.stringify({ peerDependencies: { a: '1' } })), 'only the dependencies npm installs by default count, the same in every shell');
      await silent(await project('{ not json'), 'a broken package.json is not reported');
      await silent(await project(), 'a project without package.json is left alone');
      await silent(temp, 'a directory outside any repository is left alone');
    });
  });
}
});
