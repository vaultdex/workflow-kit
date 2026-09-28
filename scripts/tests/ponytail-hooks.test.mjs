import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = process.env.WORKFLOW_KIT_TARGET || fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const git = (process.env.PATH || '').split(path.delimiter)
  .filter(path.isAbsolute)
  .map(directory => path.join(directory, windows ? 'git.exe' : 'git'))
  .find(existsSync);
// Deadlines only catch hung hooks; they must not measure speed on slow shared runners.
const configuredTimeout = Number(process.env.WORKFLOW_KIT_HOOK_TIMEOUT_MS);
const hookTimeout = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000;
// Nonblocking checks keep a behavioral bound: 10x the hooks' own 1 s stdin deadline.
const nonblockingTimeout = 10_000;
const failure = (result, label) => result.error?.code === 'ETIMEDOUT'
  ? `${label} timed out after ${hookTimeout} ms` : result.stderr || result.error?.message;
const version = '4.10.0-9';

test('shared hooks run from a fresh checkout with spaces and isolated personal state', async t => {
  assert.ok(git, 'Git must be available on an absolute PATH');
  const temp = mkdtempSync(path.join(tmpdir(), 'vaultdex ponytail '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout with spaces');
  mkdirSync(checkout);
  cpSync(path.join(root, '.agents/hooks'), path.join(checkout, '.agents/hooks'), { recursive: true, dereference: true });
  cpSync(path.join(root, '.agents/skills/ponytail'), path.join(checkout, '.agents/skills/ponytail'), { recursive: true, dereference: true });
  mkdirSync(path.join(checkout, 'scripts'));
  cpSync(fileURLToPath(new URL('../install-ponytail-hooks.mjs', import.meta.url)), path.join(checkout, 'scripts/install-ponytail-hooks.mjs'));
  mkdirSync(path.join(checkout, 'frontend'));
  const init = spawnSync(git, ['init', '--quiet', checkout], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const env = {
    ...process.env,
    HOME: path.join(temp, 'home'),
    USERPROFILE: path.join(temp, 'home'),
    XDG_CONFIG_HOME: path.join(temp, 'config'),
    CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
    PLUGIN_DATA: path.join(temp, 'foreign-codex'),
    COPILOT_PLUGIN_DATA: path.join(temp, 'foreign-copilot'),
    CURSOR_VERSION: 'test',
    CURSOR_PROJECT_DIR: checkout,
    PONYTAIL_DEFAULT_MODE: 'ultra',
    PONYTAIL_SUBAGENT_MATCHER: '',
  };
  const checkoutHash = createHash('sha256').update(realpathSync(checkout)).digest('hex');
  const state = host => path.join(env.XDG_CONFIG_HOME, 'ponytail/vaultdex', checkoutHash, host, '.ponytail-active');
  const run = (script, host, prompt = '', extra = {}, args = []) => {
    const result = spawnSync(process.execPath, [path.join(checkout, '.agents/hooks', script), host, ...args], {
      cwd: path.join(checkout, 'frontend'), env: { ...env, ...extra },
      input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: hookTimeout,
    });
    assert.equal(result.status, 0, failure(result, `${script} ${host}`));
    return result.stdout;
  };

  // Installation: identical reruns are reused; snapshots and Node stay outside Git checkouts.
  const installer = path.join(checkout, 'scripts/install-ponytail-hooks.mjs');
  const install = (extra = {}, node = process.execPath) => spawnSync(node, [installer, checkout], { env: { ...env, ...extra }, encoding: 'utf8' });
  const installation = install();
  assert.equal(installation.status, 0, installation.stderr);
  assert.equal(install().status, 0, 'Identical installation must be reusable');
  const snapshot = path.join(env.HOME, '.ponytail/vaultdex', version);
  assert.match(readFileSync(path.join(snapshot, 'launch.sh'), 'utf8'), /^exec '/m, 'Launcher must start a fixed Node');
  const linkedHome = path.join(temp, 'linked-home');
  mkdirSync(linkedHome);
  symlinkSync(checkout, path.join(linkedHome, '.ponytail'), windows ? 'junction' : 'dir');
  for (const unsafeHome of [checkout, path.join(checkout, 'new-home'), linkedHome]) {
    const refused = install({ HOME: unsafeHome, USERPROFILE: unsafeHome });
    assert.notEqual(refused.status, 0, 'Checkout-local snapshots must not be installed');
    assert.match(refused.stderr, /snapshot must be outside Git checkouts/);
  }
  for (const untouched of ['.ponytail', 'new-home', 'vaultdex'])
    assert.equal(existsSync(path.join(checkout, untouched)), false, 'Refusal must precede writes');
  const checkoutNode = path.join(checkout, 'tools', windows ? 'node.exe' : 'node');
  mkdirSync(path.dirname(checkoutNode));
  copyFileSync(process.execPath, checkoutNode);
  const pinnedCheckoutNode = install({}, checkoutNode);
  assert.notEqual(pinnedCheckoutNode.status, 0);
  assert.match(pinnedCheckoutNode.stderr, /Node installed outside Git checkouts/);
  rmSync(path.dirname(checkoutNode), { recursive: true });

  for (const host of ['codex', 'claude', 'copilot', 'cursor']) {
    const output = run('ponytail-activate.js', host);
    const context = host === 'claude' ? output : host === 'codex'
      ? JSON.parse(output).hookSpecificOutput.additionalContext
      : JSON.parse(output)[host === 'cursor' ? 'additional_context' : 'additionalContext'];
    assert.match(context, /PONYTAIL MODE ACTIVE — level: ultra/);
    assert.match(context, /repository's existing/);
    assert.doesNotMatch(context, /STATUSLINE SETUP NEEDED/);
    assert.equal(readFileSync(state(host), 'utf8'), 'ultra');
    const switched = run('ponytail-mode-tracker.js', host, '/ponytail lite');
    if (host === 'codex' || host === 'cursor') {
      assert.match(switched, /Build what.*asked/);
      assert.doesNotMatch(switched, /\| \*\*ultra\*\* \|/);
    }
    assert.equal(readFileSync(state(host), 'utf8'), 'lite');
    run('ponytail-mode-tracker.js', host, '$ponytail simplify this function');
    assert.equal(readFileSync(state(host), 'utf8'), 'lite', `${host}: task invocation must preserve selected mode`);
    if (host === 'codex' || host === 'claude') {
      const resumed = run('ponytail-activate.js', host, '', {}, ['continue']);
      assert.match(resumed, /level: lite/);
      assert.equal(readFileSync(state(host), 'utf8'), 'lite', 'Continuation must retain the selected mode');
    }
    run('ponytail-mode-tracker.js', host, '/ponytail');
    run('ponytail-mode-tracker.js', host, 'add a normal mode toggle');
    assert.equal(readFileSync(state(host), 'utf8'), 'lite');
    if (host === 'codex' || host === 'claude') {
      const subagent = JSON.parse(run('ponytail-subagent.js', host));
      assert.equal(subagent.hookSpecificOutput.hookEventName, 'SubagentStart');
      assert.match(subagent.hookSpecificOutput.additionalContext, /level: lite/);
    } else if (host === 'copilot') {
      assert.match(JSON.parse(run('ponytail-subagent.js', host)).additionalContext, /level: lite/);
      for (const agentName of ['explore', 'code-review']) {
        const result = spawnSync(process.execPath, [path.join(checkout, '.agents/hooks/ponytail-subagent.js'), host], {
          cwd: checkout, env: { ...env, PONYTAIL_SUBAGENT_MATCHER: '^explore$' },
          input: JSON.stringify({ agentName }), encoding: 'utf8', timeout: hookTimeout,
        });
        assert.equal(result.status, 0, failure(result, `ponytail-subagent.js ${host} (${agentName})`));
        if (agentName === 'explore') assert.match(JSON.parse(result.stdout).additionalContext, /level: lite/);
        else assert.equal(result.stdout, '');
      }
    }
    run('ponytail-mode-tracker.js', host, 'normal mode');
    assert.equal(existsSync(state(host)), false);
    const inactive = run('ponytail-mode-tracker.js', host, '/ponytail');
    if (host !== 'copilot') assert.match(inactive, /PONYTAIL MODE OFF/);
    assert.equal(existsSync(state(host)), false, 'Reporting must not reactivate the default');
    if (host === 'codex' || host === 'claude') {
      const resumed = run('ponytail-activate.js', host, '', {}, ['continue']);
      assert.doesNotMatch(resumed, /PONYTAIL MODE ACTIVE/);
      assert.equal(existsSync(state(host)), false, 'Continuation must retain off');
      assert.match(run('ponytail-activate.js', host), /level: ultra/);
      run('ponytail-mode-tracker.js', host, 'normal mode');
    }
    run('ponytail-mode-tracker.js', host, '$ponytail simplify this function');
    assert.equal(readFileSync(state(host), 'utf8'), 'ultra', `${host}: no selected mode uses configured default`);
    run('ponytail-mode-tracker.js', host, 'normal mode');
    run('ponytail-activate.js', host, '', { PONYTAIL_DEFAULT_MODE: 'off' });
    assert.equal(existsSync(state(host)), false);
  }
  assert.equal(existsSync(env.PLUGIN_DATA), false);
  assert.equal(existsSync(env.COPILOT_PLUGIN_DATA), false);
  assert.equal(existsSync(env.CLAUDE_CONFIG_DIR), false);
  const qoderEnv = { PLUGIN_DATA: '', COPILOT_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '', CURSOR_VERSION: '', QODER_SESSION_ID: 'fixture' };
  const qoderOff = JSON.parse(run('ponytail-mode-tracker.js', '', '/ponytail', qoderEnv));
  assert.equal(qoderOff.hookSpecificOutput.additionalContext, 'PONYTAIL MODE OFF');
  assert.equal(existsSync(path.join(env.HOME, '.qoder/.ponytail-active')), false);
  run('ponytail-mode-tracker.js', '', '/ponytail ultra', qoderEnv);
  const qoder = JSON.parse(run('ponytail-mode-tracker.js', '', '/ponytail', qoderEnv));
  assert.match(qoder.hookSpecificOutput.additionalContext, /level: ultra/);
  run('ponytail-mode-tracker.js', '', '/ponytail off', qoderEnv);
  assert.equal(JSON.parse(run('ponytail-mode-tracker.js', '', '/ponytail', qoderEnv))
    .hookSpecificOutput.additionalContext, 'PONYTAIL MODE OFF');
  assert.equal(existsSync(path.join(env.HOME, '.qoder/.ponytail-active')), false);
  run('ponytail-mode-tracker.js', 'codex', '/ponytail default lite');
  assert.equal(JSON.parse(readFileSync(path.join(env.XDG_CONFIG_HOME, 'ponytail/config.json'))).defaultMode, 'lite');
  run('ponytail-activate.js', 'codex', '', { PONYTAIL_DEFAULT_MODE: '' });
  assert.equal(readFileSync(state('codex'), 'utf8'), 'lite');

  // An unchanged trusted hook must not run replacement checkout JavaScript.
  writeFileSync(path.join(checkout, '.agents/hooks/ponytail-activate.js'), "throw new Error('Untrusted checkout code executed');\n");
  assert.notEqual(install().status, 0, 'Changed source must not overwrite an installed version');

  // Execute the committed manifest commands: quoting, launcher and host protocols are the contract.
  const manifests = ['.codex/hooks.json', '.claude/settings.json', '.github/hooks/ponytail.json', '.cursor/hooks.json'];
  const shells = windows
    ? [{ executable: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command'] }]
    : [{ executable: '/bin/sh', args: ['-c'] }];
  const gitBash = windows && path.resolve(path.dirname(git), '../bin/bash.exe');
  if (gitBash && existsSync(gitBash)) shells.push({ executable: gitBash, args: ['--noprofile', '--norc', '-c'] });
  const cursorPayload = path.join(temp, 'cursor input.json');
  writeFileSync(cursorPayload, JSON.stringify({ prompt: '/ponytail full' }));
  // Cursor pipes its payload through $input, rather than invoking the command directly.
  const cursorCommand = (shell, command) => shell.executable.endsWith('powershell.exe')
    ? `Get-Content -LiteralPath $env:PONYTAIL_CURSOR_INPUT -Raw | & { $input | ${command}\n }` : command;
  // Marker programs in the checkout and on PATH (including '.') must never run.
  const marker = path.join(temp, 'hijacked'), bin = path.join(checkout, 'tools');
  mkdirSync(bin);
  if (windows) {
    const shim = path.join(bin, 'node.exe');
    const compiled = spawnSync(shells[0].executable, [...shells[0].args, `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:PONYTAIL_SHIM -TypeDefinition '
public class Shim { public static void Main() { System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("PONYTAIL_MARKER"), "executed"); } }'`],
    { env: { ...env, PONYTAIL_SHIM: shim }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const tool of ['git.exe', 'echo.exe', 'cmd.exe', 'powershell.exe']) cpSync(shim, path.join(bin, tool));
    for (const directory of [checkout, path.join(checkout, 'frontend')])
      for (const tool of ['node.exe', 'git.exe']) cpSync(shim, path.join(directory, tool));
  } else {
    for (const directory of [checkout, bin]) for (const tool of ['node', 'git', 'bash', 'sh', 'readlink', 'echo'])
      writeFileSync(path.join(directory, tool), '#!/bin/sh\nprintf executed > "$PONYTAIL_MARKER"\n', { mode: 0o755 });
  }
  const hostileEnv = { ...env, PONYTAIL_MARKER: marker, PONYTAIL_CURSOR_INPUT: cursorPayload,
    PATH: [checkout, bin, '.', process.env.PATH].join(path.delimiter) };
  if (windows) {
    // Compare bytes with Node directly: PowerShell may supply one BOM, but the launcher may not add another.
    const installedHook = path.join(snapshot, '.agents/hooks/ponytail-mode-tracker.js');
    const originalHook = readFileSync(installedHook);
    writeFileSync(installedHook, "const parts=[]; process.stdin.on('data',p=>parts.push(p)); process.stdin.on('end',()=>process.stdout.write(Buffer.concat(parts).toString('hex')));");
    try {
      for (const pipeline of [false, true]) {
        let expected;
        for (const command of ['& $env:PONYTAIL_TEST_NODE $env:PONYTAIL_TEST_HOOK', `~/.ponytail/vaultdex/${version}/launch.cmd mode-tracker cursor`]) {
          const observed = spawnSync(shells[0].executable, [...shells[0].args, pipeline ? cursorCommand(shells[0], command) : command], {
            cwd: checkout, env: { ...hostileEnv, PONYTAIL_TEST_NODE: process.execPath, PONYTAIL_TEST_HOOK: installedHook },
            input: JSON.stringify({ prompt: '/ponytail full' }), encoding: 'utf8', timeout: hookTimeout,
          });
          assert.equal(observed.status, 0, failure(observed, command));
          assert.ok(observed.stdout, 'Byte probe must receive its synthetic payload');
          expected ??= observed.stdout;
          assert.equal(observed.stdout, expected, `Launcher altered stdin (Cursor pipeline: ${pipeline})`);
          assert.equal(existsSync(marker), false);
        }
      }
    } finally { writeFileSync(installedHook, originalHook); }
  }
  const continuedHost = manifest => manifest === '.codex/hooks.json' ? 'codex' : 'claude';
  for (const manifest of manifests) {
    const hooks = JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks;
    if (manifest === '.codex/hooks.json' || manifest === '.claude/settings.json') {
      assert.deepEqual(hooks.SessionStart.map(group => group.matcher),
        ['startup|clear', manifest === '.codex/hooks.json' ? 'resume|compact' : 'resume|compact|fork']);
    }
    const handlers = Object.values(hooks).flat().flatMap(group => group.hooks || [group]);
    for (const handler of handlers.filter(hook => /ponytail/.test(hook.command || hook.bash || ''))) {
      for (const shell of shells) {
        const powershell = shell.executable.endsWith('powershell.exe');
        if (powershell && !handler.powershell && manifest !== '.cursor/hooks.json') continue;
        const nativeCommand = powershell ? handler.powershell ?? handler.command : handler.command ?? handler.bash;
        const command = manifest === '.cursor/hooks.json' ? cursorCommand(shell, nativeCommand) : nativeCommand;
        if (command.includes(' continue')) writeFileSync(state(continuedHost(manifest)), 'lite');
        const result = spawnSync(shell.executable, [...shell.args, command], {
          cwd: path.join(checkout, 'frontend'), env: hostileEnv,
          input: JSON.stringify({ prompt: '/ponytail full' }), encoding: 'utf8', timeout: hookTimeout,
        });
        assert.equal(result.status, 0, `${manifest}: ${failure(result, command)}`);
        assert.equal(existsSync(marker), false, `${manifest}: checkout program executed`);
        assert.ok(result.stdout.trim(), `${manifest} (${shell.executable}): no hook output from ${nativeCommand}; ${result.stderr}`);
        if (manifest !== '.claude/settings.json') assert.doesNotThrow(() => JSON.parse(result.stdout),
          `${manifest}: launcher must preserve the host JSON protocol`);
        if (command.includes(' continue')) assert.match(result.stdout, /level: lite/);
      }
      if (windows && handler.commandWindows) {
        if (handler.commandWindows.includes(' continue')) writeFileSync(state('codex'), 'lite');
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', handler.commandWindows], {
          cwd: path.join(checkout, 'frontend'), env: hostileEnv, windowsVerbatimArguments: true,
          input: JSON.stringify({ prompt: '/ponytail full' }), encoding: 'utf8', timeout: hookTimeout,
        });
        assert.equal(result.status, 0, failure(result, handler.commandWindows));
        assert.equal(existsSync(marker), false, `${manifest}: checkout program executed in cmd`);
        assert.doesNotThrow(() => JSON.parse(result.stdout), 'cmd must preserve the Codex JSON protocol');
        if (handler.commandWindows.includes(' continue')) assert.match(result.stdout, /level: lite/);
      }
    }
  }

  // Cursor has one command for both shells: install hint when missing, silence when off.
  const cursorStart = JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8')).hooks.sessionStart;
  assert.equal(cursorStart.length, 1, 'One command must choose activation or recovery');
  for (const shell of shells) for (const mode of ['missing', 'active', 'off']) {
    const home = mode === 'missing' ? path.join(temp, 'missing cursor home') : env.HOME;
    const launched = spawnSync(shell.executable, [...shell.args, cursorCommand(shell, cursorStart[0].command)], {
      cwd: path.join(checkout, 'frontend'), env: { ...hostileEnv, HOME: home, USERPROFILE: home,
        PONYTAIL_DEFAULT_MODE: mode === 'off' ? 'off' : 'full' },
      input: '{}', encoding: 'utf8', timeout: hookTimeout,
    });
    assert.equal(launched.status, 0, failure(launched, cursorStart[0].command));
    assert.equal(launched.stderr, '', 'Cursor command must not emit shell errors');
    if (mode === 'active') assert.match(JSON.parse(launched.stdout).additional_context, /PONYTAIL MODE ACTIVE/);
    if (mode === 'off') assert.equal(launched.stdout, '', 'Installed off mode must remain silent');
    if (mode === 'missing') {
      assert.match(JSON.parse(launched.stdout).additional_context, /node \.vendor\/workflow-kit\/scripts\/install-ponytail-hooks\.mjs \./);
      assert.equal(existsSync(path.join(home, '.ponytail')), false, 'Recovery must not install hooks');
    }
    assert.equal(existsSync(marker), false, 'Recovery must not execute PATH-owned programs');
  }
  // Installed hook failures stay failures in every launcher; they never become install hints.
  const activate = path.join(snapshot, '.agents/hooks/ponytail-activate.js');
  const activateSource = readFileSync(activate);
  try {
    writeFileSync(activate, 'process.exit(7);');
    for (const shell of shells) {
      const result = spawnSync(shell.executable, [...shell.args, cursorCommand(shell, cursorStart[0].command)], {
        cwd: path.join(checkout, 'frontend'), env: hostileEnv, input: '{}', encoding: 'utf8', timeout: hookTimeout,
      });
      assert.equal(result.status, 7, failure(result, `failing hook through ${shell.executable}`));
      assert.equal(result.stdout, '', 'Installed failures must not emit recovery JSON');
    }
  } finally { writeFileSync(activate, activateSource); }

  const cursorPrompt = JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8')).hooks.beforeSubmitPrompt[0].command;
  for (const shell of shells) for (const mode of ['full', 'ordinary', 'lite', 'off']) {
    const payload = JSON.stringify({ prompt: mode === 'ordinary' ? 'explain this function' : `/ponytail ${mode}` });
    writeFileSync(cursorPayload, payload);
    const result = spawnSync(shell.executable, [...shell.args, cursorCommand(shell, cursorPrompt)], {
      cwd: path.join(checkout, 'frontend'), env: hostileEnv,
      input: payload, encoding: 'utf8', timeout: hookTimeout,
    });
    assert.equal(result.status, 0, failure(result, cursorPrompt));
    assert.equal(result.stderr, '');
    if (mode === 'ordinary') {
      assert.equal(result.stdout, '', 'Ordinary Cursor prompts must remain silent');
      assert.equal(readFileSync(state('cursor'), 'utf8'), 'full');
    } else {
      const output = JSON.parse(result.stdout);
      assert.equal(output.continue, true);
      if (mode === 'off') {
        assert.equal(output.additional_context, 'PONYTAIL MODE OFF');
        assert.equal(existsSync(state('cursor')), false);
      } else {
        assert.match(output.additional_context, new RegExp(`PONYTAIL MODE CHANGED — level: ${mode}`));
        assert.equal(readFileSync(state('cursor'), 'utf8'), mode);
      }
    }
    assert.equal(existsSync(marker), false);
  }

  // Without a snapshot, SessionStart owns the install hint; every other hook stays silent.
  const missingShell = windows ? shells.at(-1) : shells[0];
  const missingEnv = { ...env, HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') };
  const codexStart = JSON.parse(readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'))
    .hooks.SessionStart.flatMap(group => group.hooks).find(hook => hook.command.includes(' activate codex'));
  const missing = spawnSync(missingShell.executable, [...missingShell.args, codexStart.command], {
    cwd: checkout, env: missingEnv, input: '{}', encoding: 'utf8', timeout: hookTimeout,
  });
  assert.equal(missing.status, 0, failure(missing, codexStart.command));
  assert.match(missing.stdout, /install-ponytail-hooks\.mjs/);
  assert.equal(existsSync(path.join(temp, 'missing/.ponytail')), false, 'Hook must not install itself');
  for (const manifest of manifests) {
    const hooks = JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks;
    for (const [event, groups] of Object.entries(hooks)) {
      if (event.toLowerCase() === 'sessionstart') continue;
      for (const handler of groups.flatMap(group => group.hooks || [group])) {
        const command = handler.command ?? handler.bash;
        if (!command?.includes('.ponytail')) continue;
        const result = spawnSync(missingShell.executable, [...missingShell.args, command], {
          cwd: checkout, env: missingEnv, input: '{}', encoding: 'utf8', timeout: hookTimeout,
        });
        if (manifest === '.cursor/hooks.json') {
          assert.notEqual(result.error?.code, 'ETIMEDOUT', failure(result, command));
          assert.notEqual(result.status, 0, 'Missing Cursor launcher must fail closed');
          continue;
        }
        assert.equal(result.status, 0, failure(result, command));
        assert.equal(result.stdout, '', `${manifest}/${event}: repeated activation warning`);
      }
    }
  }

  // Large rulesets must drain fully on immediate exit and on an unclosed stdin.
  appendFileSync(path.join(checkout, '.agents/skills/ponytail/SKILL.md'), '\n' + 'x'.repeat(256 * 1024) + '\nTAIL_TOKEN\n');
  run('ponytail-mode-tracker.js', 'codex', '/ponytail lite');
  assert.match(JSON.parse(run('ponytail-subagent.js', 'codex')).hookSpecificOutput.additionalContext, /TAIL_TOKEN/);
  for (const script of ['ponytail-mode-tracker.js', 'ponytail-subagent.js']) {
    const child = spawn(process.execPath, [path.join(checkout, '.agents/hooks', script), 'codex'], {
      cwd: checkout, env: { ...env, PONYTAIL_SUBAGENT_MATCHER: 'explore' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    child.stdin.write(JSON.stringify({ prompt: '/ponytail lite', agent_type: 'explore' }));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    await new Promise((resolve, reject) => {
      const guard = setTimeout(() => { child.kill(); reject(new Error('Hook blocked while draining stdout')); }, nonblockingTimeout);
      child.once('error', error => { clearTimeout(guard); reject(error); });
      child.once('close', code => { clearTimeout(guard); code === 0 ? resolve() : reject(new Error(`Hook exited ${code}`)); });
    });
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /TAIL_TOKEN/);
  }

  // A pipe that never closes must not freeze the user's session.
  const child = spawn(process.execPath, [path.join(checkout, '.agents/hooks/ponytail-mode-tracker.js'), 'codex'], {
    cwd: checkout, env, stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => child.kill());
  const exitCode = await new Promise((resolve, reject) => {
    const guard = setTimeout(() => { child.kill(); reject(new Error('Hook blocked on stdin')); }, nonblockingTimeout);
    child.once('error', error => { clearTimeout(guard); reject(error); });
    child.once('exit', code => { clearTimeout(guard); resolve(code); });
  });
  assert.equal(exitCode, 0);
});
