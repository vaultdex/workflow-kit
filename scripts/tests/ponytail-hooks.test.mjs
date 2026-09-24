import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  cpSync(fileURLToPath(new URL('../ponytail', import.meta.url)), path.join(checkout, 'scripts/ponytail'), { recursive: true });
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
  const checkoutHash = createHash('sha256').update(checkout).digest('hex');
  const state = host => path.join(env.XDG_CONFIG_HOME, 'ponytail/vaultdex', checkoutHash, host, '.ponytail-active');
  const run = (script, host, prompt = '', extra = {}, args = []) => {
    const result = spawnSync(process.execPath, [path.join(checkout, '.agents/hooks', script), host, ...args], {
      cwd: path.join(checkout, 'frontend'), env: { ...env, ...extra },
      input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: 4000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };

  const install = () => spawnSync(process.execPath, [path.join(checkout, 'scripts/install-ponytail-hooks.mjs')], { env, encoding: 'utf8' });
  const installation = install();
  assert.equal(installation.status, 0, installation.stderr);
  assert.equal(install().status, 0, 'Identical installation must be reusable');

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
      const resumed = run('ponytail-activate.js', host, '', {}, [checkout, 'continue']);
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
          env: { ...env, PONYTAIL_SUBAGENT_MATCHER: '^explore$' },
          input: JSON.stringify({ agentName }), encoding: 'utf8', timeout: 4000,
        });
        assert.equal(result.status, 0, result.stderr);
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
      const resumed = run('ponytail-activate.js', host, '', {}, [checkout, 'continue']);
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

  // Execute committed shell commands too: quoting and Git-root lookup are part
  // of the installation contract, not proved by invoking scripts directly.
  const manifests = ['.codex/hooks.json', '.claude/settings.json', '.github/hooks/ponytail.json', '.cursor/hooks.json'];
  const shells = windows
    ? [{ executable: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command'] }]
    : [{ executable: '/bin/sh', args: ['-c'] }];
  const gitBash = windows && path.resolve(path.dirname(git), '../bin/bash.exe');
  if (gitBash && existsSync(gitBash)) shells.push({ executable: gitBash, args: ['--noprofile', '--norc', '-c'] });
  // Executable markers, including a PATH directory outside the checkout whose
  // real junction/symlink target is inside it. No malicious program is executed.
  const marker = path.join(temp, 'hijacked'), bin = path.join(checkout, 'tools');
  mkdirSync(bin);
  if (windows) {
    const shim = path.join(bin, 'node.exe');
    const compiled = spawnSync(shells[0].executable, [...shells[0].args, `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:PONYTAIL_SHIM -TypeDefinition '
public class Shim { public static void Main() { System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("PONYTAIL_MARKER"), "executed"); } }'`],
    { env: { ...env, PONYTAIL_SHIM: shim }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    cpSync(shim, path.join(bin, 'git.exe'));
    for (const directory of [checkout, path.join(checkout, 'frontend')])
      for (const tool of ['node.exe', 'git.exe']) cpSync(path.join(bin, tool), path.join(directory, tool));
  } else {
    for (const directory of [checkout, bin]) for (const tool of ['node', 'git', 'bash'])
      writeFileSync(path.join(directory, tool), '#!/bin/sh\nprintf executed > "$PONYTAIL_MARKER"\n', { mode: 0o755 });
  }
  const linked = path.join(temp, 'external-link');
  symlinkSync(bin, linked, windows ? 'junction' : 'dir');
  const fileLinked = path.join(temp, 'external-file-link');
  if (!windows) {
    mkdirSync(fileLinked);
    symlinkSync(path.join(bin, 'node'), path.join(fileLinked, 'node'));
  }
  const externalNode = path.join(temp, 'external-node');
  if (!windows) {
    mkdirSync(externalNode);
    // The trusted external shim must not inherit a checkout-controlled Bash.
    writeFileSync(path.join(externalNode, 'node'), '#!/usr/bin/env bash\nexec '
      + "'" + process.execPath.replaceAll("'", "'\\''") + "' \"$@\"\n", { mode: 0o755 });
  }
  const hostileEnv = { ...env, PONYTAIL_MARKER: marker,
    PATH: [checkout, bin, '.', linked, ...(!windows ? [fileLinked, externalNode] : []), process.env.PATH].join(path.delimiter) };
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
        const command = powershell ? handler.powershell ?? handler.command : handler.command ?? handler.bash;
        const continuedHost = manifest === '.codex/hooks.json' ? 'codex' : 'claude';
        if (command.includes(' continue')) writeFileSync(state(continuedHost), 'lite');
        const result = spawnSync(shell.executable, [...shell.args, command], {
          cwd: path.join(checkout, 'frontend'), env: hostileEnv,
          input: JSON.stringify({ prompt: '/ponytail full' }), encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 0, `${manifest}: ${result.stderr || result.error?.message}`);
        assert.equal(existsSync(marker), false, `${manifest}: checkout Node/Git executed`);
        assert.ok(result.stdout.trim(), `${manifest}: no hook output`);
        if (manifest !== '.claude/settings.json') assert.doesNotThrow(() => JSON.parse(result.stdout),
          `${manifest}: native launcher must preserve the host JSON protocol`);
        if (command.includes(' continue')) {
          assert.match(result.stdout, /level: lite/);
          assert.equal(readFileSync(state(continuedHost), 'utf8'), 'lite');
        }
      }
      if (windows && handler.commandWindows) {
        if (handler.commandWindows.includes(' continue')) writeFileSync(state('codex'), 'lite');
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', handler.commandWindows], {
          cwd: path.join(checkout, 'frontend'), env: hostileEnv, windowsVerbatimArguments: true,
          input: JSON.stringify({ prompt: '/ponytail full' }), encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.equal(existsSync(marker), false, `${manifest}: checkout Node/Git executed in cmd`);
        assert.ok(result.stdout.trim(), `${manifest}: no Windows override output`);
        assert.doesNotThrow(() => JSON.parse(result.stdout), 'cmd must preserve the Codex JSON protocol');
        if (handler.commandWindows.includes(' continue')) assert.match(result.stdout, /level: lite/);
      }
    }
  }

  const codexStart = JSON.parse(readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'))
    .hooks.SessionStart.flatMap(group => group.hooks).find(hook => hook.command.includes(' activate codex'));
  const missingShell = windows ? shells.at(-1) : shells[0];
  const noExternalNode = spawnSync(missingShell.executable, [...missingShell.args, codexStart.command], {
    cwd: checkout, env: { ...hostileEnv, PATH: [checkout, bin, '.', linked].join(path.delimiter) },
    input: '{}', encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(noExternalNode.status, 0, 'Untrusted-only PATH must not start Node');
  assert.match(noExternalNode.stderr, /install Node outside the checkout/);
  assert.equal(existsSync(marker), false);
  if (windows) {
    const restricted = spawnSync(shells[0].executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted',
      '-File', path.join(env.USERPROFILE, '.ponytail/vaultdex/4.10.0-6/launch.ps1'), 'activate', 'codex'],
    { cwd: checkout, env: hostileEnv, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(restricted.status, 0, 'Native script policy must not be bypassed');
    assert.equal(existsSync(marker), false);
  }
  // A nested/fake .git marker must not shrink the executable trust boundary.
  writeFileSync(path.join(checkout, 'frontend/.git'), 'not a Git repository');
  for (const shell of shells) {
    const command = shell.executable.endsWith('powershell.exe')
      ? JSON.parse(readFileSync(path.join(root, '.github/hooks/ponytail.json'))).hooks.sessionStart[0].powershell
      : codexStart.command;
    const nested = spawnSync(shell.executable, [...shell.args, command], {
      cwd: path.join(checkout, 'frontend'), env: hostileEnv, input: '{}', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(nested.status, 0, nested.stderr);
    assert.match(nested.stdout, /PONYTAIL MODE ACTIVE/);
    assert.equal(existsSync(marker), false, 'Nested marker admitted an outer-checkout executable');
  }
  rmSync(path.join(checkout, 'frontend/.git'));
  const missing = spawnSync(missingShell.executable, [...missingShell.args, codexStart.command], {
    cwd: checkout, env: { ...env, HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') },
    input: '{}', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /node scripts\/install-ponytail-hooks.mjs/);
  assert.equal(existsSync(path.join(temp, 'missing/.ponytail')), false, 'Hook must not install itself');

  // SessionStart owns missing-install guidance; subsequent hooks stay silent.
  for (const manifest of manifests) {
    const hooks = JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks;
    for (const [event, groups] of Object.entries(hooks)) {
      if (event.toLowerCase() === 'sessionstart') continue;
      for (const handler of groups.flatMap(group => group.hooks || [group])) {
        const command = handler.command ?? handler.bash;
        if (!command?.includes('.ponytail')) continue;
        const result = spawnSync(missingShell.executable, [...missingShell.args, command], {
          cwd: checkout, env: { ...env, HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') },
          input: '{}', encoding: 'utf8', timeout: 5000,
        });
        if (manifest === '.cursor/hooks.json') {
          assert.notEqual(result.status, 0, 'Missing native Cursor launcher must fail closed');
          continue;
        }
        assert.equal(result.status, 0, result.stderr);
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
      env: { ...env, PONYTAIL_SUBAGENT_MATCHER: 'explore' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    child.stdin.write(JSON.stringify({ prompt: '/ponytail lite', agent_type: 'explore' }));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    await new Promise((resolve, reject) => {
      const guard = setTimeout(() => { child.kill(); reject(new Error('Hook blocked while draining stdout')); }, 4000);
      child.once('error', error => { clearTimeout(guard); reject(error); });
      child.once('close', code => { clearTimeout(guard); code === 0 ? resolve() : reject(new Error(`Hook exited ${code}`)); });
    });
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /TAIL_TOKEN/);
  }

  // A pipe that never closes must not freeze the user's session.
  const child = spawn(process.execPath, [path.join(checkout, '.agents/hooks/ponytail-mode-tracker.js'), 'codex'], {
    env, stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => child.kill());
  const exitCode = await new Promise((resolve, reject) => {
    const guard = setTimeout(() => { child.kill(); reject(new Error('Hook blocked on stdin')); }, 3000);
    child.once('error', error => { clearTimeout(guard); reject(error); });
    child.once('exit', code => { clearTimeout(guard); resolve(code); });
  });
  assert.equal(exitCode, 0);
});
