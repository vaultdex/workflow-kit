import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = process.env.WORKFLOW_KIT_TARGET || fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const git = (process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)
  .map(directory => path.join(directory, windows ? 'git.exe' : 'git')).find(existsSync);
// Deadlines only catch hung hooks; they must not measure speed on slow shared runners.
const hookTimeout = Number(process.env.WORKFLOW_KIT_HOOK_TIMEOUT_MS) || 30_000;
const version = '4.10.0-9';

test('installed hooks run every manifest command without executing checkout programs', t => {
  assert.ok(git, 'Git must be available on an absolute PATH');
  const temp = mkdtempSync(path.join(tmpdir(), 'vaultdex ponytail '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout with spaces');
  for (const from of ['.agents/hooks', '.agents/skills/ponytail'])
    cpSync(path.join(root, from), path.join(checkout, from), { recursive: true, dereference: true });
  mkdirSync(path.join(checkout, 'frontend'));
  assert.equal(spawnSync(git, ['init', '--quiet', checkout]).status, 0);
  const env = { ...process.env, HOME: path.join(temp, 'home'), USERPROFILE: path.join(temp, 'home'),
    XDG_CONFIG_HOME: path.join(temp, 'config'), PONYTAIL_DEFAULT_MODE: 'full' };
  const installer = fileURLToPath(new URL('../install-ponytail-hooks.mjs', import.meta.url));
  const install = (extra = {}, node = process.execPath) => spawnSync(node, [installer, checkout], { env: { ...env, ...extra }, encoding: 'utf8' });

  // The snapshot and the Node it pins stay outside Git checkouts; identical reruns are fine.
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(install().status, 0, 'Identical reinstall');
  const linkedHome = path.join(temp, 'linked-home');
  mkdirSync(linkedHome);
  symlinkSync(checkout, path.join(linkedHome, '.ponytail'), windows ? 'junction' : 'dir');
  for (const home of [checkout, linkedHome]) assert.notEqual(install({ HOME: home, USERPROFILE: home }).status, 0, home);
  assert.equal(existsSync(path.join(checkout, '.ponytail')), false, 'Refusal precedes writes');
  const checkoutNode = path.join(checkout, 'tools', windows ? 'node.exe' : 'node');
  mkdirSync(path.dirname(checkoutNode));
  copyFileSync(process.execPath, checkoutNode);
  assert.notEqual(install({}, checkoutNode).status, 0, 'A Node inside a checkout is never pinned');
  writeFileSync(path.join(checkout, '.agents/hooks/ponytail-activate.js'), 'throw new Error("changed");\n');
  assert.notEqual(install().status, 0, 'Changed hook code needs a new snapshot version');

  // Marker programs in the checkout and on PATH (including '.') must never run.
  const marker = path.join(temp, 'hijacked'), bin = path.dirname(checkoutNode);
  const shells = windows
    ? [{ executable: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command'] }]
    : [{ executable: '/bin/sh', args: ['-c'] }];
  const gitBash = windows && path.resolve(path.dirname(git), '../bin/bash.exe');
  if (gitBash && existsSync(gitBash)) shells.push({ executable: gitBash, args: ['--noprofile', '--norc', '-c'] });
  if (windows) {
    const compiled = spawnSync(shells[0].executable, [...shells[0].args, `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:PONYTAIL_SHIM -TypeDefinition '
public class Shim { public static void Main() { System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("PONYTAIL_MARKER"), "executed"); } }'`],
    { env: { ...env, PONYTAIL_SHIM: path.join(bin, 'shim.exe') }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const directory of [bin, checkout, path.join(checkout, 'frontend')])
      for (const tool of ['node.exe', 'git.exe', 'cmd.exe', 'powershell.exe']) copyFileSync(path.join(bin, 'shim.exe'), path.join(directory, tool));
  } else {
    for (const directory of [bin, checkout, path.join(checkout, 'frontend')]) for (const tool of ['node', 'git', 'sh', 'echo'])
      writeFileSync(path.join(directory, tool), '#!/bin/sh\nprintf executed > "$PONYTAIL_MARKER"\n', { mode: 0o755 });
  }
  const hostile = { ...env, PONYTAIL_MARKER: marker, PATH: [checkout, bin, '.', process.env.PATH].join(path.delimiter) };
  const input = JSON.stringify({ prompt: '/ponytail lite' });
  // Cursor on Windows pipes its payload through PowerShell's $input.
  const cursor = (shell, command) => shell.executable.endsWith('powershell.exe') ? `$input | & { $input | ${command}\n }` : command;
  const execute = (shell, command, extra = {}) => spawnSync(shell.executable, [...shell.args, command],
    { cwd: path.join(checkout, 'frontend'), env: { ...hostile, ...extra }, input, encoding: 'utf8', timeout: hookTimeout });
  const manifests = ['.codex/hooks.json', '.claude/settings.json', '.github/hooks/ponytail.json', '.cursor/hooks.json'];
  const handlers = manifest => Object.entries(JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks)
    .flatMap(([event, groups]) => groups.flatMap(group => group.hooks || [group]).map(handler => ({ event, handler })))
    .filter(({ handler }) => /ponytail/.test(handler.command || handler.bash || ''));
  const missing = { HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') };
  for (const manifest of manifests) for (const { event, handler } of handlers(manifest)) {
    const start = event.toLowerCase() === 'sessionstart';
    for (const shell of shells) {
      const powershell = shell.executable.endsWith('powershell.exe');
      if (powershell && !handler.powershell && manifest !== '.cursor/hooks.json') continue;
      const native = powershell ? handler.powershell ?? handler.command : handler.command ?? handler.bash;
      const command = manifest === '.cursor/hooks.json' ? cursor(shell, native) : native;
      const result = execute(shell, command);
      assert.equal(result.status, 0, `${manifest} ${event}: ${result.stderr}`);
      if (manifest !== '.claude/settings.json' && result.stdout) assert.doesNotThrow(() => JSON.parse(result.stdout), `${manifest} ${event}: host JSON`);
      // Without a snapshot only SessionStart speaks (the install hint). Cursor's prompt hook just errors.
      if (manifest === '.cursor/hooks.json' && !start) continue;
      const absent = execute(shell, command, missing);
      assert.equal(absent.status, 0, `${manifest} ${event} without snapshot: ${absent.stderr}`);
      assert.equal(Boolean(absent.stdout.trim()), start, `${manifest} ${event} without snapshot`);
    }
    if (windows && handler.commandWindows) {
      const result = spawnSync(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', handler.commandWindows],
        { cwd: path.join(checkout, 'frontend'), env: hostile, windowsVerbatimArguments: true, input, encoding: 'utf8', timeout: hookTimeout });
      assert.equal(result.status, 0, `${manifest} ${event} (cmd): ${result.stderr}`);
      if (result.stdout) assert.doesNotThrow(() => JSON.parse(result.stdout), `${manifest} ${event} (cmd): host JSON`);
    }
    assert.equal(existsSync(marker), false, `${manifest} ${event}: a checkout program ran`);
  }

  // A failing installed hook stays a failure through every launcher.
  const activate = path.join(env.HOME, '.ponytail/vaultdex', version, '.agents/hooks/ponytail-activate.js');
  const [{ handler: cursorStart }] = handlers('.cursor/hooks.json');
  writeFileSync(activate, 'process.exit(7);');
  for (const shell of shells) assert.equal(execute(shell, cursor(shell, cursorStart.command)).status, 7, shell.executable);
});
