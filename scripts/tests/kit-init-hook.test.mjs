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
    git(kit, 'add', '.'); git(kit, 'commit', '--quiet', '-m', 'kit');
    const origin = fixture('origin', 'README.md');
    git(origin, 'submodule', '--quiet', 'add', kit.replaceAll('\\', '/'), '.vendor/workflow-kit');
    git(origin, 'add', '.'); git(origin, 'commit', '--quiet', '-m', 'consumer');
    const plain = fixture('plain', 'README.md');
    git(plain, 'add', '.'); git(plain, 'commit', '--quiet', '-m', 'plain');
    let count = 0;
    const clone = () => { const dir = join(temp, 'clone' + count++); git(temp, 'clone', '--quiet', origin, dir); return dir; };

    for (const [file, key] of variants) for (const command of new Set(handlers(file, key))) {
      const trial = (cwd) => run(kind, [...args, command], cwd, local);
      const [first, second] = [clone(), clone()];
      assert.ok(!existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), 'fresh clone starts without the kit');

      let result = trial(first);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '', 'a successful init prints nothing');
      assert.ok(existsSync(join(first, '.vendor/workflow-kit/AGENT_RULES.md')), `${file} initializes the kit`);

      const rules = join(first, '.vendor/workflow-kit/AGENT_RULES.md');
      rmSync(rules);
      result = trial(first);
      assert.match(result.stdout, /AGENT_RULES.md/, 'a kit whose rules file is missing despite the update is reported');
      git(join(first, '.vendor/workflow-kit'), 'checkout', '--', 'AGENT_RULES.md');

      renameSync(kit, `${kit}-gone`);
      result = trial(first);
      assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], 'an initialized kit is not touched, not even to reach the source');

      result = trial(second);
      assert.equal(result.status, 0, 'a failed init must not abort the session');
      assert.match(result.stdout, /git submodule update --init \.vendor\/workflow-kit/, 'a failed init prints the manual command');
      assert.ok(!existsSync(join(second, '.vendor/workflow-kit/AGENT_RULES.md')));
      renameSync(`${kit}-gone`, kit);

      result = trial(plain);
      assert.deepEqual([result.status, result.stdout], [0, ''], 'a project without a kit gitlink is left alone');
      assert.ok(!existsSync(join(plain, '.vendor')));
    }
  });
}
