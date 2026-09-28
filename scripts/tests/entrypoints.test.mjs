// Zweck: init-project an echten Dateien pruefen, ohne Netzwerk.
// Nutzen: Eigene Hook-Handler und Vorlagen werden aktualisiert; fremde Inhalte gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../init-project.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const own = { command: 'echo managed' }, foreign = { command: 'echo user-owned' };
const manifest = version => ({ version, hooks: { sessionStart: [own] } });

/** A consumer with the real installer at .vendor/workflow-kit and an empty template set. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kit migration '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer'), kit = join(root, '.vendor/workflow-kit');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(kit, 'templates'), { recursive: true });
  mkdirSync(join(kit, 'scripts'));
  copyFileSync(installer, join(kit, 'scripts/init-project.mjs'));
  const receipt = join(root, '.github/workflow-kit.json');
  json(receipt, { files: {}, hooks: {} });
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), root, '--existing', ...args],
    { cwd: base, encoding: 'utf8', timeout: 10000 });
  const template = (name, value) => json(join(kit, 'templates', name), value);
  return { base, root, kit, receipt, run, template };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('owned hooks update in place; foreign handlers, groups and metadata survive; reruns are stable', t => {
  const f = fixture(t), path = join(f.root, '.claude/settings.json');
  json(path, { permissions: { allow: ['x'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign] }] } });
  f.template('.claude/settings.json', { hooks: { SessionStart: [{ matcher: 'startup', hooks: [own] }] } });
  succeeds(f.run());
  assert.deepEqual(read(path).hooks.SessionStart, [{ matcher: 'startup', hooks: [foreign, own] }]);
  f.template('.claude/settings.json', { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'echo v2' }] }] } });
  assert.notEqual(f.run('--check').status, 0, 'Stale owned output fails the check');
  succeeds(f.run());
  const updated = readFileSync(path);
  assert.deepEqual(read(path), { permissions: { allow: ['x'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign, { command: 'echo v2' }] }] } });
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(readFileSync(path), updated);
});

test('edited owned handlers and templates are refused before any write', t => {
  const f = fixture(t), path = join(f.root, '.cursor/hooks.json');
  f.template('.cursor/hooks.json', manifest(1)); f.template('AGENTS.md', 'kit rules\n');
  const first = spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs'), f.root], { encoding: 'utf8' });
  succeeds(first);
  const value = read(path); value.hooks.sessionStart[0].command = 'echo edited'; json(path, value);
  f.template('.cursor/hooks.json', manifest(2));
  const receipt = readFileSync(f.receipt);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(read(path), value); assert.deepEqual(readFileSync(f.receipt), receipt);
  json(path, manifest(1));
  write(join(f.root, 'AGENTS.md'), 'project rules\n');
  f.template('AGENTS.md', 'kit rules v2\n');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'project rules\n');
});

test('retired templates remove only unedited owned content', t => {
  const f = fixture(t), hooks = join(f.root, '.github/hooks/old.json'), rules = join(f.root, 'CONTRIBUTING.md');
  f.template('.github/hooks/old.json', manifest(1)); succeeds(f.run());
  const value = read(hooks); value.hooks.sessionStart.push(foreign); json(hooks, value);
  write(rules, 'kit text\n'); json(f.receipt, { ...read(f.receipt), files: { 'CONTRIBUTING.md': hash('kit text\n') } });
  rmSync(join(f.kit, 'templates/.github'), { recursive: true });
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(read(hooks), { version: 1, hooks: { sessionStart: [foreign] } }, 'Foreign handler and its schema stay');
  assert.equal(existsSync(rules), false);
  assert.deepEqual(read(f.receipt), { files: {}, hooks: {}, hookMetadata: {} });
});

test('receipt paths and links cannot reach outside the checkout', t => {
  const f = fixture(t), outside = join(f.base, 'outside');
  write(join(outside, 'keep'), 'keep');
  for (const name of ['../outside/keep', '.github/../.git/config']) {
    json(f.receipt, { files: { [name]: hash('keep') }, hooks: {} });
    assert.notEqual(f.run().status, 0);
  }
  json(f.receipt, { files: {}, hooks: {} });
  symlinkSync(outside, join(f.root, '.cursor'), 'junction');
  f.template('.cursor/hooks.json', manifest(1));
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(join(outside, 'hooks.json')), false);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  const other = join(f.base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  assert.notEqual(spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs'), other]).status, 0, 'Only the owning checkout');
});
