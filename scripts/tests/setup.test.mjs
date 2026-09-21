import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('../../', import.meta.url));
test('portable setup preserves foreign configuration, rejects edited skills and repeats cleanly', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-kit setup '));
  t.after(() => { assert.equal(dirname(fixture), tmpdir()); rmSync(fixture, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet', fixture]);
  const setup = name => spawnSync(process.execPath, [join(kit, 'scripts', name), fixture], { encoding: 'utf8' });
  const run = name => { const result = setup(name); assert.equal(result.status, 0, result.stderr); };
  run('setup-skills.mjs');
  run('setup-skills.mjs');
  for (const provider of ['.agent', '.agents', '.claude', '.opencode', '.pi']) {
    assert.ok(lstatSync(join(fixture, provider, 'skills/ponytail')).isSymbolicLink());
    assert.equal(readFileSync(join(fixture, provider, 'skills/ponytail/SKILL.md'), 'utf8'), readFileSync(join(fixture, '.github/skills/ponytail/SKILL.md'), 'utf8'));
  }
  const edited = join(fixture, '.github/skills/ponytail/SKILL.md');
  writeFileSync(edited, 'user modification\n');
  const refused = setup('setup-ponytail.mjs');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /left untouched/);
  assert.equal(readFileSync(edited, 'utf8'), 'user modification\n');
  const foreign = join(fixture, '.claude/settings.json');
  const config = { permissions: { deny: ['Read(secret)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo foreign-hook' }] }] } };
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, JSON.stringify(config));
  // init-project requires the real submodule placement for consumer entry points.
  // Exercise the configuration installer in an isolated copy of its reviewed inputs.
  const installer = join(fixture, 'scripts/init-project.mjs');
  mkdirSync(dirname(installer), { recursive: true });
  copyFileSync(join(kit, 'scripts/init-project.mjs'), installer);
  cpSync(join(kit, 'templates'), join(fixture, 'templates'), { recursive: true });
  const init = () => spawnSync(process.execPath, [installer, fixture], { encoding: 'utf8' });
  const first = init();
  assert.equal(first.status, 0, first.stderr);
  const configured = readFileSync(foreign, 'utf8');
  const current = JSON.parse(configured);
  assert.deepEqual(current.permissions, config.permissions);
  assert.deepEqual(current.hooks.SessionStart[0], config.hooks.SessionStart[0]);
  const second = init();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(foreign, 'utf8'), configured);
  writeFileSync(join(fixture, 'AGENTS.md'), 'project-specific rule\n');
  assert.notEqual(init().status, 0);
  assert.equal(readFileSync(join(fixture, 'AGENTS.md'), 'utf8'), 'project-specific rule\n');
  assert.equal(readFileSync(foreign, 'utf8'), configured);
});
