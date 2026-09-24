import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const setup = fileURLToPath(new URL('../setup-ponytail.mjs', import.meta.url));
const skills = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'];
const hooks = ['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ponytail batch '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const upstream = join(base, 'upstream'), kit = join(base, 'kit'), root = join(base, 'consumer');
  for (const dir of [upstream, kit, root]) {
    mkdirSync(dir);
    git(dir, 'init', '--quiet');
    git(dir, 'config', 'user.name', 'Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'core.autocrlf', 'false');
  }
  const expected = new Map(skills.map(name => [`skills/${name}/SKILL.md`, `# ${name}\r\nGrüße 🎴\r\n\n`])
    .concat(hooks.map(name => [`hooks/ponytail-${name}.js`, name === 'runtime' ? '' : `// ${name}\r\n`])));
  expected.set('skills/ponytail/SKILL.md', '# ponytail\nbase\nGrüße 🎴\n');
  expected.set('LICENSE', 'License\r\n© Example 🎴\r\n');
  for (const [path, content] of expected) write(join(upstream, path), content);
  git(upstream, 'add', '.'); git(upstream, 'commit', '--quiet', '-m', 'Fixture sources');
  git(kit, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', upstream, '.vendor/ponytail');
  git(kit, 'commit', '--quiet', '-am', 'Pin local fixture');
  const source = join(kit, '.vendor/ponytail');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  write(join(kit, 'scripts/ponytail/NOTICE.md'), 'Fixture attribution\n');
  write(join(kit, 'scripts/ponytail/adaptations.patch'),
    'diff --git a/skills/ponytail/SKILL.md b/skills/ponytail/SKILL.md\n'
    + '--- a/skills/ponytail/SKILL.md\n+++ b/skills/ponytail/SKILL.md\n'
    + '@@ -1,3 +1,3 @@\n # ponytail\n-base\n+patched\n Grüße 🎴\n');
  copyFileSync(setup, join(kit, 'scripts/setup-ponytail.mjs'));
  const trace = join(base, 'git-events.jsonl');
  const run = () => {
    writeFileSync(trace, '');
    return spawnSync(process.execPath, [join(kit, 'scripts/setup-ponytail.mjs'), root], {
      encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
    });
  };
  const starts = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => event.event === 'start').map(event => event.argv);
  const pin = () => { git(source, 'add', '-A'); git(source, 'commit', '--quiet', '-m', 'Change fixture');
    git(kit, 'add', '.vendor/ponytail'); git(kit, 'commit', '--quiet', '-m', 'Update pin'); };
  return { root, source, expected, run, starts, pin };
}

function succeeds(result) { assert.equal(result.status, 0, result.stderr); }

test('one batch reads all pinned blobs with byte-correct UTF-8, CRLF and empty files', t => {
  const f = fixture(t); succeeds(f.run());
  const calls = f.starts();
  assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('--batch')).length, 1);
  assert.equal(calls.filter(args => args.includes('show')).length, 0);
  for (const [path, original] of f.expected) {
    const value = original.replaceAll('\r\n', '\n').replace('\nbase\n', '\npatched\n');
    const output = path === 'LICENSE' ? '.agents/hooks/LICENSE.md' : `.agents/${path}`;
    assert.equal(readFileSync(join(f.root, output), 'utf8'), value, path);
  }
  for (const provider of ['.agent', '.agents', '.claude', '.opencode', '.pi'])
    assert.match(readFileSync(join(f.root, provider, 'skills/ponytail/SKILL.md'), 'utf8'), /patched/);
});

test('repeat setup keeps the same receipt and unrelated files', t => {
  const f = fixture(t); succeeds(f.run());
  const receipt = join(f.root, '.github/skills/ponytail/.workflow-source.json');
  const before = readFileSync(receipt);
  write(join(f.root, '.github/skills/custom/SKILL.md'), 'User-owned\n');
  succeeds(f.run());
  assert.deepEqual(readFileSync(receipt), before);
  assert.equal(readFileSync(join(f.root, '.github/skills/custom/SKILL.md'), 'utf8'), 'User-owned\n');
});

for (const problem of ['missing', 'tree']) test(`${problem} pinned source fails before replacing the previous installation`, t => {
  const f = fixture(t); succeeds(f.run());
  const receipt = join(f.root, '.github/skills/ponytail/.workflow-source.json');
  const before = readFileSync(receipt);
  const path = join(f.source, 'hooks/ponytail-runtime.js');
  rmSync(path);
  if (problem === 'tree') write(join(path, 'nested'), 'Not a blob\n');
  f.pin();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing or non-blob pinned source/);
  assert.deepEqual(readFileSync(receipt), before);
  assert.equal(readFileSync(join(f.root, '.agents/hooks/ponytail-runtime.js'), 'utf8'), '');
  assert.deepEqual(readdirSync(join(f.root, '.workflow-kit')), ['ponytail']);
});

test('dirty upstream and edited consumer files are still refused', t => {
  const f = fixture(t); succeeds(f.run());
  const source = join(f.source, 'hooks/ponytail-runtime.js');
  writeFileSync(source, '// local change\n');
  assert.match(f.run().stderr, /Ponytail source has local changes/);
  writeFileSync(source, '');
  const output = join(f.root, '.github/skills/ponytail/SKILL.md');
  writeFileSync(output, 'Manual change\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing or edited Copilot skill left untouched/);
  assert.equal(readFileSync(output, 'utf8'), 'Manual change\n');
});

test('missing license fails without publishing a partial installation', t => {
  const f = fixture(t); rmSync(join(f.source, 'LICENSE')); f.pin();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing or non-blob pinned source: LICENSE/);
  assert.equal(existsSync(join(f.root, '.workflow-kit/ponytail')), false);
});
