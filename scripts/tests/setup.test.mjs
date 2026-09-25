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
  copyFileSync(join(kit, '.gitattributes'), join(fixture, '.gitattributes'));
  const setup = name => spawnSync(process.execPath, [join(kit, 'scripts', name), fixture], { encoding: 'utf8' });
  const run = name => { const result = setup(name); assert.equal(result.status, 0, result.stderr); };
  const collision = join(fixture, '.github/agents/impeccable-documenter.agent.md');
  mkdirSync(dirname(collision), { recursive: true });
  writeFileSync(collision, 'foreign tracked agent\n');
  execFileSync('git', ['-C', fixture, 'add', '.github/agents/impeccable-documenter.agent.md']);
  assert.notEqual(setup('setup-impeccable.mjs').status, 0);
  assert.equal(readFileSync(collision, 'utf8'), 'foreign tracked agent\n');
  execFileSync('git', ['-C', fixture, 'rm', '--cached', '--quiet', '.github/agents/impeccable-documenter.agent.md']);
  rmSync(collision);
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
  const shared = JSON.parse(readFileSync(join(kit, 'templates/.claude/settings.json'), 'utf8')).hooks.SessionStart[0];
  const config = { permissions: { deny: ['Read(secret)'] }, hooks: { SessionStart: [{ ...shared, hooks: [{ type: 'command', command: 'echo foreign-hook' }, ...shared.hooks] }] } };
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, JSON.stringify(config));
  // init-project requires the real submodule placement for consumer entry points.
  // Exercise the configuration installer in an isolated copy of its reviewed inputs.
  const installer = join(fixture, 'scripts/init-project.mjs');
  mkdirSync(dirname(installer), { recursive: true });
  copyFileSync(join(kit, 'scripts/init-project.mjs'), installer);
  cpSync(join(kit, 'templates'), join(fixture, 'templates'), { recursive: true });
  const init = (...args) => spawnSync(process.execPath, [installer, fixture, ...args], { encoding: 'utf8' });
  const first = init();
  assert.equal(first.status, 0, first.stderr);
  for (const link of ['.agents/hooks', ...['.agent', '.agents', '.claude', '.opencode', '.pi'].map(p => `${p}/skills/ponytail`)]) {
    assert.ok(lstatSync(join(fixture, link)).isSymbolicLink(), link);
    assert.equal(spawnSync('git', ['-C', fixture, 'check-ignore', '-q', link]).status, 0, `${link} must be ignored`);
  }
  const configured = readFileSync(foreign, 'utf8');
  const current = JSON.parse(configured);
  assert.deepEqual(current.permissions, config.permissions);
  assert.deepEqual(current.hooks.SessionStart[0], config.hooks.SessionStart[0]);
  const sharedCommand = shared.hooks[0].command;
  assert.equal(current.hooks.SessionStart.flatMap(g => g.hooks).filter(h => h.command === sharedCommand).length, 1);
  const second = init();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(foreign, 'utf8'), configured);
  const retired = join(fixture, 'templates/CONTRIBUTING.md');
  rmSync(retired);
  assert.notEqual(init('--check').status, 0);
  const retirement = init('--existing');
  assert.equal(retirement.status, 0, retirement.stderr);
  assert.equal(lstatSync(join(fixture, 'CONTRIBUTING.md'), { throwIfNoEntry: false }), undefined);
  assert.ok(!JSON.parse(readFileSync(join(fixture, '.github/workflow-kit.json'), 'utf8')).files['CONTRIBUTING.md']);
  const checked = init('--check');
  assert.equal(checked.status, 0, checked.stderr);
  const previousRules = readFileSync(join(fixture, 'AGENTS.md'), 'utf8');
  const nextRules = readFileSync(join(fixture, 'templates/AGENTS.md'), 'utf8').replaceAll('\r\n', '\n') + '\nUpdated shared rule.\n';
  writeFileSync(join(fixture, 'templates/AGENTS.md'), nextRules);
  assert.notEqual(init('--check').status, 0);
  assert.equal(readFileSync(join(fixture, 'AGENTS.md'), 'utf8'), previousRules);
  const updated = init('--existing');
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(readFileSync(join(fixture, 'AGENTS.md'), 'utf8'), nextRules);
  writeFileSync(join(fixture, 'AGENTS.md'), 'project-specific rule\n');
  assert.notEqual(init('--check').status, 0);
  assert.notEqual(init().status, 0);
  assert.notEqual(init('--existing').status, 0);
  assert.equal(readFileSync(join(fixture, 'AGENTS.md'), 'utf8'), 'project-specific rule\n');
  assert.equal(readFileSync(foreign, 'utf8'), configured);
});
