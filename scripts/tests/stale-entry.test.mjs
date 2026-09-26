import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const link = (to, at) => symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');

// #38: a harness worktree copies ignored provider entries as plain folders or keeps links to the
// original checkout. Setup replaces such kit-owned leftovers and still protects edited or foreign content.
test('setup replaces copied or relocated kit entries and protects edited or foreign ones', t => {
  const base = mkdtempSync(join(tmpdir(), 'workflow-kit stale '));
  t.after(() => { assert.equal(dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const fixture = name => {
    const root = join(base, name);
    execFileSync('git', ['init', '--quiet', root]);
    copyFileSync(join(kit, '.gitattributes'), join(root, '.gitattributes'));
    return root;
  };
  const setup = root => spawnSync(process.execPath, [join(kit, 'scripts/setup-skills.mjs'), root], { encoding: 'utf8' });
  const ok = root => { const result = setup(root); assert.equal(result.status, 0, result.stderr); };
  const original = fixture('original');
  ok(original);

  const worktree = fixture('worktree');
  const entries = ['.agents/hooks', '.claude/skills/ponytail-help', ...providers.flatMap(p => [`${p}/skills/ponytail`, `${p}/skills/impeccable`])];
  for (const entry of entries) {
    mkdirSync(dirname(join(worktree, entry)), { recursive: true });
    // Ponytail and the hooks arrive as plain copies, Impeccable as links into the original checkout.
    if (entry.includes('impeccable')) link(realpathSync(join(original, entry)), join(worktree, entry));
    else cpSync(join(original, entry), join(worktree, entry), { recursive: true, dereference: true });
  }
  // A copy that an older kit generated equals an earlier committed Copilot output of that skill.
  const help = '.github/skills/ponytail-help/SKILL.md';
  const git = (...args) => execFileSync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  mkdirSync(dirname(join(worktree, help)), { recursive: true });
  writeFileSync(join(worktree, help), 'older generated help\n');
  git('add', help);
  git('commit', '--quiet', '-m', 'older generated output');
  git('rm', '--quiet', help);
  git('commit', '--quiet', '-m', 'retire output');
  writeFileSync(join(worktree, '.claude/skills/ponytail-help/SKILL.md'), 'older generated help\n');
  ok(worktree);
  for (const entry of entries) {
    assert.ok(lstatSync(join(worktree, entry)).isSymbolicLink(), entry);
    assert.ok(realpathSync(join(worktree, entry)).startsWith(realpathSync(worktree)), `${entry} must use this checkout's bundle`);
  }

  const edited = join(worktree, '.claude/skills/ponytail-audit');
  unlinkSync(edited);
  cpSync(join(original, '.claude/skills/ponytail-audit'), edited, { recursive: true, dereference: true });
  appendFileSync(join(edited, 'SKILL.md'), 'local note\n');
  const refused = setup(worktree);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /left untouched \(edited or foreign copy\).*ponytail-audit.*rerun setup/s);
  assert.match(readFileSync(join(edited, 'SKILL.md'), 'utf8'), /local note\n$/);
  rmSync(edited, { recursive: true });

  const foreign = join(worktree, '.pi/skills/impeccable');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  unlinkSync(foreign);
  link(elsewhere, foreign);
  const protectedLink = setup(worktree);
  assert.notEqual(protectedLink.status, 0);
  assert.match(protectedLink.stderr, /left untouched \(foreign link\)/);
  assert.equal(realpathSync(foreign), realpathSync(elsewhere));
  unlinkSync(foreign);

  ok(worktree);
  ok(worktree);
  for (const entry of entries) assert.ok(lstatSync(join(worktree, entry)).isSymbolicLink(), entry);
});
