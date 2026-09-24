// Zweck: Echte Hook-Kommandos auf einmaligen Setup-Hinweis und Fehlerweitergabe pruefen.
// Nutzen: Fehlende Installation verursacht keine Edit-/Stop-Schleifen; die Engine bleibt unveraendert.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const manifests = ['.codex/hooks.json', '.claude/settings.json', '.github/hooks/impeccable.json'];
const groups = name => JSON.parse(readFileSync(join(kit, 'templates', name), 'utf8')).hooks;
const commands = (name, start) => Object.entries(groups(name))
  .filter(([event]) => (event.toLowerCase() === 'sessionstart') === start)
  .flatMap(([, values]) => values.flatMap(group => group.hooks ?? [group]))
  .filter(hook => (hook.command ?? hook.bash ?? '').includes('engine-0.1.5'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'impeccable hook '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, HOME: root, USERPROFILE: root } };
}
function run(hook, f, input = '{}') {
  const command = windows ? hook.commandWindows ?? hook.powershell : hook.command ?? hook.bash;
  assert.ok(command, 'No verified native command for this shell');
  const shell = !windows ? '/bin/sh' : hook.commandWindows
    ? join(process.env.SystemRoot, 'System32/cmd.exe')
    : join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = !windows ? ['-c', command] : hook.commandWindows ? ['/d', '/s', '/c', command]
    : ['-NoProfile', '-NonInteractive', '-Command', command];
  return spawnSync(shell, args, { cwd: f.root, env: f.env, input, encoding: 'utf8', timeout: 10_000 });
}
for (const name of manifests) test(`${name}: missing engine warns only at SessionStart, not on edits or Stop`, {
  skip: windows && name === '.claude/settings.json' ? 'Claude command is the existing POSIX/Git-Bash form' : false,
}, t => {
  const f = fixture(t), starts = commands(name, true), repeated = commands(name, false);
  assert.equal(starts.length, 1);
  assert.ok(repeated.length);
  const warning = run(starts[0], f);
  assert.equal(warning.status, 0, warning.stderr);
  assert.match(warning.stdout, /Impeccable fehlt/);
  assert.match(warning.stdout, /\.vendor\/workflow-kit\/scripts\/install-impeccable-hooks\.mjs \./);
  assert.equal(warning.stderr, '');
  for (let turn = 0; turn < 3; turn++) for (const hook of repeated) {
    const result = run(hook, f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('installed engine receives stdin and its failure is not suppressed', { skip: windows }, t => {
  const f = fixture(t), engine = join(f.root, '.impeccable/vaultdex/engine-0.1.5/impeccable');
  mkdirSync(join(engine, '..'), { recursive: true });
  writeFileSync(engine, '#!/bin/sh\n[ "$1" = hook ] || exit 9\nIFS= read -r event\nprintf "%s\\n" "$event"\nexit 7\n', { mode: 0o755 });
  for (const name of manifests) {
    assert.equal(run(commands(name, true)[0], f).stdout, '');
    for (const hook of commands(name, false)) {
      const result = run(hook, f, '{"hook_event_name":"Stop"}\n');
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.stdout.trim(), '{"hook_event_name":"Stop"}');
    }
  }
});

test('pinned engine: measure Stop without touched UI and after a CSS edit', {
  skip: process.env.GITHUB_ACTIONS !== 'true' && !process.env.WORKFLOW_KIT_ENGINE_PROOF ? 'Run with WORKFLOW_KIT_ENGINE_PROOF=1 for the isolated real-engine download; CI runs it' : false,
  timeout: 180_000,
}, t => {
  const f = fixture(t);
  const installed = spawnSync(process.execPath, [join(kit, 'scripts/install-impeccable-hooks.mjs')], {
    cwd: kit, env: { ...f.env, IMPECCABLE_DOWNLOAD_BASE: 'https://github.com/pbakaus/impeccable/releases/download' },
    encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(installed.status, 0, installed.stderr);
  const engine = join(f.root, '.impeccable/vaultdex/engine-0.1.5', windows ? 'impeccable.exe' : 'impeccable');
  const project = join(f.root, 'project'); mkdirSync(join(project, '.impeccable'), { recursive: true });
  writeFileSync(join(project, 'PRODUCT.md'), '# Fixture\n\n<!-- impeccable:product-schema 1 -->\n\n## Platform\n\nweb\n');
  writeFileSync(join(project, '.impeccable/config.json'), '{"hook":{"enabled":true}}');
  const engineEnv = { ...f.env };
  for (const key of ['IMPECCABLE_HOOK_DISABLED', 'IMPECCABLE_HOOK_QUIET', 'IMPECCABLE_HOOK_DEPTH', 'CLAUDE_HOOK_DEPTH']) delete engineEnv[key];
  const call = event => {
    const start = performance.now();
    const result = spawnSync(engine, ['hook'], {
      cwd: project, env: engineEnv,
      input: JSON.stringify({ cwd: project, session_id: 'fixture', ...event }), encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    if (result.stdout.trim()) JSON.parse(result.stdout);
    return { ms: Math.round((performance.now() - start) * 100) / 100, stdout: result.stdout };
  };
  const stop = { hook_event_name: 'Stop', stop_hook_active: false };
  const untouched = call(stop); assert.equal(untouched.stdout, '');
  const css = join(project, 'Card.css');
  const content = '.card { border-left: 4px solid #6366f1; border-radius: 8px; }\n';
  writeFileSync(css, content);
  call({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: css },
    tool_response: { type: 'create', filePath: css, originalFile: null, content } });
  const cache = JSON.parse(readFileSync(join(project, '.impeccable/hook.cache.json'), 'utf8'));
  assert.ok(Object.keys(cache.sessions?.fixture?.files ?? {}).some(path => path.replaceAll('\\', '/') === css.replaceAll('\\', '/')), 'Real engine must register the CSS edit before measuring Stop');
  const edited = call(stop);
  assert.equal(call({ ...stop, stop_hook_active: true }).stdout, '');
  t.diagnostic(`Measured engine process time: Stop without touched UI ${untouched.ms}ms; after CSS edit ${edited.ms}ms. Not an agent/token benchmark.`);
});
