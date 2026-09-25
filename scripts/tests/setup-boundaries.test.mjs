import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const [script, state] of [
  ['setup-ponytail.mjs', '.workflow-kit/ponytail'],
  ['setup-impeccable.mjs', '.impeccable/vendor'],
]) {
  for (const linked of [false, true]) {
    test(`${script} rejects ${linked ? 'linked' : 'unknown'} owner markers without disclosing their contents`, t => {
      const fixture = mkdtempSync(join(tmpdir(), 'workflow-owner-'));
      t.after(() => { assert.equal(dirname(fixture), tmpdir()); rmSync(fixture, { recursive: true, force: true }); });
      const root = join(fixture, 'target checkout'), bin = join(fixture, 'bin');
      mkdirSync(join(root, state), { recursive: true }); mkdirSync(bin);
      // Git must not be invoked before the marker is rejected. Node as Git
      // would reject the first Git option if this preflight were bypassed.
      const git = join(bin, process.platform === 'win32' ? 'git.exe' : 'git');
      copyFileSync(process.execPath, git); chmodSync(git, 0o755);
      const owner = join(root, state, '.owner'), outside = join(fixture, 'private-fixture.txt');
      const sentinel = 'synthetic value must not appear in an assertion';
      writeFileSync(outside, sentinel);
      if (linked) {
        try { symlinkSync(outside, owner, 'file'); }
        catch (error) {
          if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
          t.skip('Windows account cannot create file symlinks; Linux runs this case'); return;
        }
      } else writeFileSync(owner, sentinel);
      const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('../' + script, import.meta.url)), root],
        { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to replace an unknown/);
      assert.ok(!(result.stdout + result.stderr).includes(sentinel), 'Marker contents must not reach diagnostic output');
      assert.equal(readFileSync(outside, 'utf8'), sentinel);
      assert.equal(existsSync(join(root, '.github')), false, 'No publication on failed owner validation');
    });
  }
  for (const linked of [false, true]) {
    test(`${script} rejects Git ${linked ? 'file links into the target' : 'inside the invoking checkout'}`, t => {
      const fixture = mkdtempSync(join(tmpdir(), 'workflow-git-boundary-'));
      t.after(() => { assert.equal(dirname(fixture), tmpdir()); rmSync(fixture, { recursive: true, force: true }); });
      const root = join(fixture, 'target'), caller = join(fixture, 'caller');
      const bin = join(fixture, linked ? 'external-bin' : 'caller/tools');
      mkdirSync(root); mkdirSync(caller); mkdirSync(bin, { recursive: true });
      const name = process.platform === 'win32' ? 'git.exe' : 'git';
      const executable = join(linked ? root : bin, name);
      copyFileSync(process.execPath, executable); chmodSync(executable, 0o755);
      if (linked) {
        try { symlinkSync(executable, join(bin, name), 'file'); }
        catch (error) {
          if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
          t.skip('Windows account cannot create file symlinks; Linux runs this case'); return;
        }
      }
      const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('../' + script, import.meta.url)), root],
        { cwd: caller, encoding: 'utf8', env: { ...process.env, PATH: bin } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Install Git.*outside/);
      assert.equal(existsSync(join(root, state)), false, 'Reject the interpreter before setup writes');
    });
  }
}

for (const [script, marker, command] of [
  ['setup-impeccable.mjs', '.github/skills/impeccable/.vaultdex-source.json', 'git'],
  ['setup-github.mjs', '.github/workflow-project.json', 'gh'],
]) {
  for (const parent of [false, true]) {
    test(`${script} refuses a linked ${parent ? 'metadata directory' : 'metadata file'} before invoking its CLI`, t => {
      const fixture = mkdtempSync(join(tmpdir(), 'workflow-metadata-'));
      t.after(() => { assert.equal(dirname(fixture), tmpdir()); rmSync(fixture, { recursive: true, force: true }); });
      const root = join(fixture, 'checkout'), bin = join(fixture, 'bin'), outside = join(fixture, 'outside');
      mkdirSync(root); mkdirSync(bin); mkdirSync(outside);
      const executable = join(bin, process.platform === 'win32' ? `${command}.exe` : command);
      copyFileSync(process.execPath, executable); chmodSync(executable, 0o755);
      writeFileSync(join(root, 'repo'), "require('node:fs').writeFileSync('executed', 'unexpected GitHub call');");
      const sentinel = 'synthetic invalid JSON must not reach diagnostics';
      const externalFile = join(outside, 'metadata.json');
      writeFileSync(externalFile, sentinel);
      const target = join(root, marker);
      mkdirSync(dirname(parent ? dirname(target) : target), { recursive: true });
      try {
        symlinkSync(parent ? outside : externalFile, parent ? dirname(target) : target,
          parent ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        t.skip('Windows account cannot create file symlinks; Linux runs this case'); return;
      }
      const args = script === 'setup-github.mjs' ? ['test/example', '2'] : [root];
      const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('../' + script, import.meta.url)), ...args],
        { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, parent ? /[Dd]irectory leaves checkout/ : /must be a regular file/);
      assert.ok(!(result.stdout + result.stderr).includes(sentinel));
      assert.equal(existsSync(join(root, 'executed')), false);
      assert.equal(readFileSync(externalFile, 'utf8'), sentinel);
    });
  }
}
