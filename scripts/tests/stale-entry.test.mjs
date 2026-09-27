import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyEntry, listing } from '../stale-entry.mjs';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const link = (to, at) => symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');

test('classifying a copy never traverses its nested directory links', t => {
  const base = mkdtempSync(join(tmpdir(), 'linked copy '));
  t.after(() => { assert.equal(dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const copy = join(base, 'copy'), outside = join(base, 'outside');
  mkdirSync(copy); mkdirSync(outside);
  writeFileSync(join(outside, 'private.txt'), 'Untouched\n');
  link(outside, join(copy, 'nested'));
  assert.deepEqual(listing(copy), new Set(['nested']));
  assert.equal(classifyEntry(copy, '', '', [], () => false), 'edited or foreign copy');
  assert.equal(readFileSync(join(outside, 'private.txt'), 'utf8'), 'Untouched\n');
});

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
    // Ponytail, the hooks and Claude's Impeccable arrive as plain copies, other Impeccable entries as links
    // into the original checkout.
    if (entry.includes('impeccable') && !entry.startsWith('.claude/')) link(realpathSync(join(original, entry)), join(worktree, entry));
    else cpSync(join(original, entry), join(worktree, entry), { recursive: true, dereference: true });
  }
  // A copy that an older kit generated matches an output hash an earlier committed receipt recorded.
  // A file that was merely committed, without such a receipt, proves no ownership.
  const git = (...args) => execFileSync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  const commitThenRetire = (file, content) => {
    mkdirSync(dirname(join(worktree, file)), { recursive: true });
    writeFileSync(join(worktree, file), content);
    git('add', file);
    git('commit', '--quiet', '-m', `add ${file}`);
    git('rm', '--quiet', file);
    git('commit', '--quiet', '-m', `retire ${file}`);
  };
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  commitThenRetire('.github/skills/ponytail/.workflow-source.json', JSON.stringify({ revision: 'older',
    files: { '.github/skills/ponytail-help/SKILL.md': sha256('older generated help\n') } }));
  commitThenRetire('.github/skills/ponytail-review/SKILL.md', 'user review text\n');
  writeFileSync(join(worktree, '.claude/skills/ponytail-help/SKILL.md'), 'older generated help\n');
  // An older kit copied this upstream file before applying its maintainability patch.
  const upstream = '.claude/skills/impeccable/scripts/live-browser-ignores.js';
  copyFileSync(join(kit, '.vendor/impeccable', upstream), join(worktree, upstream));
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

  const committedOnly = join(worktree, '.claude/skills/ponytail-review');
  unlinkSync(committedOnly);
  mkdirSync(committedOnly);
  writeFileSync(join(committedOnly, 'SKILL.md'), 'user review text\n');
  const notOwned = setup(worktree);
  assert.notEqual(notOwned.status, 0);
  assert.match(notOwned.stderr, /left untouched \(edited or foreign copy\).*ponytail-review/s);
  assert.equal(readFileSync(join(committedOnly, 'SKILL.md'), 'utf8'), 'user review text\n');
  rmSync(committedOnly, { recursive: true });

  const empty = join(worktree, '.opencode/skills/ponytail');
  unlinkSync(empty);
  mkdirSync(join(empty, 'nested'), { recursive: true });
  const emptyRefused = setup(worktree);
  assert.notEqual(emptyRefused.status, 0);
  assert.match(emptyRefused.stderr, /left untouched \(empty or foreign directory\)/);
  assert.ok(lstatSync(join(empty, 'nested')).isDirectory());
  rmSync(empty, { recursive: true });

  // Each file matches some kit generation (unpatched launcher, patched waiver script), but no single one.
  const mixed = join(worktree, '.claude/skills/impeccable');
  unlinkSync(mixed);
  cpSync(join(original, '.claude/skills/impeccable'), mixed, { recursive: true, dereference: true });
  copyFileSync(join(kit, '.vendor/impeccable/.claude/skills/impeccable/scripts/impeccable'), join(mixed, 'scripts/impeccable'));
  const mixedRefused = setup(worktree);
  assert.notEqual(mixedRefused.status, 0);
  assert.match(mixedRefused.stderr, /left untouched \(edited or foreign copy\).*\.claude.skills.impeccable/s);
  assert.ok(lstatSync(join(mixed, 'scripts/impeccable')).isFile());
  rmSync(mixed, { recursive: true });

  // Every remaining file is generated, but a deleted one makes the copy a user edit.
  const pruned = join(worktree, '.agent/skills/ponytail');
  unlinkSync(pruned);
  cpSync(join(original, '.agent/skills/ponytail'), pruned, { recursive: true, dereference: true });
  rmSync(join(pruned, 'NOTICE.md'));
  const prunedRefused = setup(worktree);
  assert.notEqual(prunedRefused.status, 0);
  assert.match(prunedRefused.stderr, /left untouched \(partial or foreign copy\).*\.agent.skills.ponytail/s);
  assert.ok(lstatSync(join(pruned, 'LICENSE.md')).isFile());
  rmSync(pruned, { recursive: true });

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

for (const [engine, entry, file] of [
  ['ponytail', '.claude/skills/ponytail', 'SKILL.md'],
  ['ponytail', '.agents/hooks', 'ponytail-runtime.js'],
  ['impeccable', '.claude/skills/impeccable', 'SKILL.md'],
]) test(`setup preserves a copy of locally edited ${entry} bundle contents`, t => {
  const root = mkdtempSync(join(tmpdir(), 'edited bundle '));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet', root]);
  const setup = () => spawnSync(process.execPath, [join(kit, `scripts/setup-${engine}.mjs`), root], { encoding: 'utf8' });
  const initial = setup(); assert.equal(initial.status, 0, initial.stderr);
  const target = join(root, entry), bundle = realpathSync(target);
  appendFileSync(join(bundle, file), '\nlocal note\n');
  const edited = readFileSync(join(bundle, file));
  unlinkSync(target);
  cpSync(bundle, target, { recursive: true });
  const result = setup();
  assert.notEqual(result.status, 0, 'An edited live bundle cannot authorize deleting its copy');
  assert.match(result.stderr, /left untouched \(edited or foreign copy\).*rerun setup/s);
  assert.ok(lstatSync(target).isDirectory());
  assert.deepEqual(readFileSync(join(target, file)), edited);
  assert.deepEqual(readFileSync(join(bundle, file)), edited);
});

for (const [engine, bundle, from] of [
  ['ponytail', '.workflow-kit/ponytail', '.agents/skills/ponytail'],
  ['ponytail', '.workflow-kit/ponytail', '.agents/hooks'],
  ['impeccable', '.impeccable/vendor', '.claude/skills/impeccable'],
]) test(`setup preserves unowned ${engine} links with a matching ${from} suffix`, t => {
  const base = mkdtempSync(join(tmpdir(), 'foreign bundle '));
  t.after(() => { assert.equal(dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'consumer'), foreign = join(base, 'foreign', bundle);
  execFileSync('git', ['init', '--quiet', root]);
  const target = join(root, from), elsewhere = join(foreign, from);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'user.txt'), 'User-owned\n');
  link(elsewhere, target);
  for (const marker of [null, 'another-owner\n']) {
    if (marker) writeFileSync(join(foreign, '.owner'), marker);
    const result = spawnSync(process.execPath, [join(kit, `scripts/setup-${engine}.mjs`), root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'A matching path suffix cannot prove kit ownership');
    assert.match(result.stderr, /left untouched \(foreign link\).*rerun setup/s);
    assert.equal(realpathSync(target), realpathSync(elsewhere));
    assert.equal(readFileSync(join(elsewhere, 'user.txt'), 'utf8'), 'User-owned\n');
  }
});
