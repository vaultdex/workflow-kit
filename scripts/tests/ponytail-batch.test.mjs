import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skills = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'];
const hooks = ['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'];
const providers = ['.agent', '.agents', '.claude', '.github', '.opencode', '.pi'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

/** The real setup against a committed local upstream: no download or model call. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ponytail batch '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const upstream = join(base, 'upstream'), kit = join(base, 'kit'), root = join(base, 'consumer');
  for (const dir of [upstream, kit, root]) {
    mkdirSync(dir);
    git(dir, 'init', '--quiet');
    git(dir, 'config', 'user.name', 'Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
  }
  const expected = new Map(skills.map(name => [`skills/${name}/SKILL.md`, `# ${name}\r\nGrüße 🎴\r\n\n`])
    .concat(hooks.map(name => [`hooks/ponytail-${name}.js`, name === 'runtime' ? '' : `// ${name}\r\n`])));
  expected.set('skills/ponytail/SKILL.md', '# ponytail\nbase\nGrüße 🎴\n');
  expected.set('LICENSE', 'License\r\n© Example 🎴\r\n');
  for (const [path, content] of expected) write(join(upstream, path), content);
  git(upstream, 'add', '.'); git(upstream, 'commit', '--quiet', '-m', 'Fixture sources');
  git(kit, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, '.vendor/ponytail');
  git(kit, 'commit', '--quiet', '-am', 'Pin local fixture');
  write(join(kit, 'scripts/ponytail/NOTICE.md'), 'Fixture attribution\n');
  write(join(kit, 'scripts/ponytail/adaptations.patch'),
    'diff --git a/skills/ponytail/SKILL.md b/skills/ponytail/SKILL.md\n'
    + '--- a/skills/ponytail/SKILL.md\n+++ b/skills/ponytail/SKILL.md\n'
    + '@@ -1,3 +1,3 @@\n # ponytail\n-base\n+patched\n Grüße 🎴\n');
  for (const script of ['setup-ponytail.mjs', 'checkout-root.mjs', 'provider-links.mjs'])
    copyFileSync(new URL(`../${script}`, import.meta.url), join(kit, 'scripts', script));
  const run = () => spawnSync(process.execPath, [join(kit, 'scripts/setup-ponytail.mjs')], { cwd: root, encoding: 'utf8' });
  return { root, source: join(kit, '.vendor/ponytail'), expected, run };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('setup writes byte-correct ordinary files for every provider and reruns without changes', t => {
  const f = fixture(t); succeeds(f.run());
  for (const [path, original] of f.expected) {
    const output = path === 'LICENSE' ? '.agents/hooks/LICENSE.md' : `.agents/${path}`;
    assert.equal(readFileSync(join(f.root, output), 'utf8'), original.replaceAll('\r\n', '\n').replace('\nbase\n', '\npatched\n'), path);
  }
  for (const provider of providers) assert.ok(lstatSync(join(f.root, provider, 'skills/ponytail')).isDirectory(), provider);
  const copilot = join(f.root, '.github/skills/ponytail/SKILL.md');
  const before = readFileSync(copilot);
  succeeds(f.run());
  assert.deepEqual(readFileSync(copilot), before);
});

test('a dirty source is refused; generated Copilot skills are regenerated, stale ones removed', t => {
  const f = fixture(t); succeeds(f.run());
  const hook = join(f.root, '.agents/hooks/ponytail-activate.js'), installed = readFileSync(hook);
  writeFileSync(join(f.source, 'hooks/ponytail-runtime.js'), '// local change\n');
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(readFileSync(hook), installed, 'The installation stays');
  writeFileSync(join(f.source, 'hooks/ponytail-runtime.js'), '');
  const output = join(f.root, '.github/skills/ponytail/SKILL.md'), generated = readFileSync(output);
  writeFileSync(output, 'Manual change\n');
  write(join(f.root, '.github/skills/ponytail-retired/SKILL.md'), 'Dropped upstream\n');
  write(join(f.root, '.github/skills/custom/SKILL.md'), 'User skill\n');
  succeeds(f.run());
  assert.deepEqual(readFileSync(output), generated);
  assert.deepEqual(readdirSync(join(f.root, '.github/skills')).sort(), ['custom', ...skills].sort());
});

test('copies, files and old provider junctions become ordinary files; originals move aside once', t => {
  const f = fixture(t); succeeds(f.run());
  const copy = join(f.root, '.claude/skills/ponytail'), file = join(f.root, '.agents/hooks'), link = join(f.root, '.pi/skills/ponytail');
  write(join(copy, 'SKILL.md'), 'Copied from another worktree\n');
  rmSync(file, { recursive: true }); write(file, 'User file\n');
  const legacy = join(f.root, '.workflow-kit/old-ponytail');
  const oldTarget = join(legacy, 'skills/ponytail');
  write(join(oldTarget, 'SKILL.md'), 'Personal legacy customization\n');
  const alias = join(f.root, 'legacy-alias');
  if (process.platform !== 'win32') symlinkSync(join(legacy, 'skills'), alias, 'dir');
  rmSync(link, { recursive: true });
  // `..` following a symlink must keep filesystem semantics, not lexical normalization.
  symlinkSync(process.platform === 'win32' ? oldTarget : `${relative(dirname(link), alias)}/../skills/ponytail`, link,
    process.platform === 'win32' ? 'junction' : 'dir');
  succeeds(f.run());
  for (const path of [copy, file, link]) assert.ok(lstatSync(path).isDirectory(), path);
  assert.equal(readFileSync(join(f.source, 'skills/ponytail/SKILL.md'), 'utf8').replaceAll('\r\n', '\n'),
    '# ponytail\nbase\nGrüße 🎴\n', 'Old link target was not changed');
  const [moved] = readdirSync(join(f.root, '.workflow-kit/replaced'));
  const replaced = join(f.root, '.workflow-kit/replaced', moved);
  assert.equal(readFileSync(join(replaced, '.claude/skills/ponytail/SKILL.md'), 'utf8'), 'Copied from another worktree\n');
  assert.equal(readFileSync(join(replaced, '.agents/hooks'), 'utf8'), 'User file\n');
  assert.ok(lstatSync(join(replaced, '.pi/skills/ponytail')).isSymbolicLink());
  assert.equal(readFileSync(join(replaced, '.pi/skills/ponytail/SKILL.md'), 'utf8'), 'Personal legacy customization\n',
    'The preserved link still exposes personal contents');
  assert.equal(readFileSync(join(oldTarget, 'SKILL.md'), 'utf8'), 'Personal legacy customization\n');
  succeeds(f.run());
  assert.deepEqual(readdirSync(join(f.root, '.workflow-kit/replaced')), [moved], 'Equal generated files are kept');
});
