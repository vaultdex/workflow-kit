// Zweck: init-project an echten Dateien pruefen, ohne Netzwerk.
// Nutzen: Kit-Handler werden ersetzt; fremde Hooks, Einstellungen und Projektdateien gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const kitHook = version => ({ command: `sh "$HOME/.ponytail/vaultdex/${version}/launch.sh" activate` });
const foreign = { command: 'sonar hook codex-prompt-submit' };

/** A consumer with the real installer at .vendor/workflow-kit and an empty template set. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kit migration '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer'), kit = join(root, '.vendor/workflow-kit');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(kit, 'templates'), { recursive: true });
  mkdirSync(join(kit, 'scripts'));
  for (const script of ['init-project.mjs', 'checkout-root.mjs', 'provider-links.mjs']) copyFileSync(new URL(`../${script}`, import.meta.url), join(kit, 'scripts', script));
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const template = (name, value) => (typeof value === 'string' ? write : json)(join(kit, 'templates', name), value);
  return { base, root, kit, run, template };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('kit handlers are replaced; foreign handlers, groups and settings stay; reruns change nothing', t => {
  const f = fixture(t), path = join(f.root, '.claude/settings.json');
  json(path, { permissions: { allow: ['x'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign, kitHook('old')] }] } });
  f.template('.claude/settings.json', { description: 'kit', hooks: { SessionStart: [{ matcher: 'startup', hooks: [kitHook('new')] }] } });
  succeeds(f.run('--existing'));
  assert.deepEqual(read(path), { description: 'kit', permissions: { allow: ['x'] }, hooks: { SessionStart: [
    { matcher: 'startup', hooks: [foreign] }, { matcher: 'startup', hooks: [kitHook('new')] }] } });
  const once = readFileSync(path);
  succeeds(f.run('--existing'));
  assert.deepEqual(readFileSync(path), once);
});

test('retired hook files lose only kit handlers', t => {
  const f = fixture(t), mixed = join(f.root, '.github/hooks/old.json'), owned = join(f.root, '.github/hooks/gone.json');
  json(mixed, { version: 1, hooks: { sessionStart: [kitHook('old'), foreign] } });
  json(owned, { version: 1, hooks: { sessionStart: [kitHook('old')] } });
  json(join(f.root, '.github/workflow-kit.json'), { files: {}, hooks: {} });
  succeeds(f.run('--existing'));
  assert.deepEqual(read(mixed), { version: 1, hooks: { sessionStart: [foreign] } });
  assert.equal(existsSync(owned), false);
  assert.equal(existsSync(join(f.root, '.github/workflow-kit.json')), false, 'The old ownership receipt is retired');
});

test('templates start new projects and are never overwritten', t => {
  const f = fixture(t), rules = join(f.root, 'AGENTS.md');
  f.template('AGENTS.md', 'kit rules\n');
  succeeds(f.run('--existing'));
  assert.equal(existsSync(rules), false, 'Existing projects keep their own files');
  succeeds(f.run());
  assert.equal(readFileSync(rules, 'utf8'), 'kit rules\n');
  write(rules, 'project rules\n');
  f.template('AGENTS.md', 'kit rules v2\n');
  succeeds(f.run());
  assert.equal(readFileSync(rules, 'utf8'), 'project rules\n');
});

test('writes stay inside the owning checkout', t => {
  const f = fixture(t), outside = join(f.base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.root, '.cursor'), 'junction');
  f.template('.cursor/hooks.json', { version: 1, hooks: { sessionStart: [kitHook('new')] } });
  assert.notEqual(f.run('--existing').status, 0);
  assert.equal(existsSync(join(outside, 'hooks.json')), false);
  const other = join(f.base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  assert.notEqual(spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs')], { cwd: other }).status, 0, 'Only the owning checkout');
});
