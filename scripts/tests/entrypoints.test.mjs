// Zweck: Echte Generator-Migration ohne Netzwerk testen.
// Nutzen: Wrapper, alte Handler und Metadaten nur entfernen, wenn ihre Herkunft belegt ist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../init-project.mjs', import.meta.url));
const wrappers = ['setup-skills', 'check-skills', 'install-ponytail-hooks', 'install-impeccable-hooks'];
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const own = { command: 'echo managed' }, foreign = { command: 'echo user-owned' };
const manifest = version => ({ version, hooks: { sessionStart: [own] } });

/** Build a consumer with the real installer and harmless, versioned hook fixtures. */
function fixture(t, old = true) {
  const base = mkdtempSync(join(tmpdir(), 'kit migration '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer'), kit = join(root, '.vendor/workflow-kit');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(kit, 'scripts'), { recursive: true });
  mkdirSync(join(kit, 'templates'), { recursive: true });
  copyFileSync(installer, join(kit, 'scripts/init-project.mjs'));
  const files = {};
  if (old) for (const name of wrappers) {
    const path = `scripts/${name}.mjs`, value = `// managed old ${name}\n`;
    write(join(root, path), value); files[path] = hash(value);
  }
  const receipt = join(root, '.github/workflow-kit.json');
  json(receipt, { files, hooks: {} });
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), root, '--existing', ...args], {
    cwd: base, encoding: 'utf8', timeout: 10000,
  });
  const template = (name, value) => json(join(kit, 'templates', name), value);
  return { base, root, kit, receipt, run, template };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('all managed wrappers retire together; repeat setup and check do not drift', t => {
  const f = fixture(t);
  write(join(f.root, 'scripts/custom.mjs'), '// user-owned\n');
  const before = readFileSync(f.receipt);
  assert.notEqual(f.run('--check').status, 0);
  assert.deepEqual(readFileSync(f.receipt), before);
  for (const name of wrappers) assert.ok(existsSync(join(f.root, `scripts/${name}.mjs`)));
  succeeds(f.run());
  for (const name of wrappers) assert.equal(existsSync(join(f.root, `scripts/${name}.mjs`)), false);
  assert.equal(readFileSync(join(f.root, 'scripts/custom.mjs'), 'utf8'), '// user-owned\n');
  assert.deepEqual(read(f.receipt).files, {});
  const after = readFileSync(f.receipt);
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(readFileSync(f.receipt), after);
});
for (const name of wrappers) test(`edited ${name} is preserved before any migration write`, t => {
  const f = fixture(t);
  const path = join(f.root, `scripts/${name}.mjs`);
  write(path, '// local change\n');
  f.template('.cursor/hooks.json', manifest(1));
  const before = readFileSync(f.receipt);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(path, 'utf8'), '// local change\n');
  assert.deepEqual(readFileSync(f.receipt), before);
  assert.equal(existsSync(join(f.root, '.cursor/hooks.json')), false);
});
test('fresh integration creates no scripts and leaves unowned wrappers alone', t => {
  const f = fixture(t, false); succeeds(f.run());
  assert.equal(existsSync(join(f.root, 'scripts')), false);
  for (const name of wrappers) write(join(f.root, `scripts/${name}.mjs`), '// user-owned\n');
  succeeds(f.run()); succeeds(f.run('--check'));
  for (const name of wrappers) assert.equal(readFileSync(join(f.root, `scripts/${name}.mjs`), 'utf8'), '// user-owned\n');
});
test('owned schema version advances; unrelated metadata and handlers survive', t => {
  const f = fixture(t); f.template('.cursor/hooks.json', manifest(1)); succeeds(f.run());
  const path = join(f.root, '.cursor/hooks.json'), value = read(path);
  value.hooks.sessionStart.push(foreign); value.userOption = true; json(path, value);
  f.template('.cursor/hooks.json', manifest(2));
  const before = readFileSync(path), receipt = readFileSync(f.receipt);
  assert.notEqual(f.run('--check').status, 0);
  assert.deepEqual(readFileSync(path), before); assert.deepEqual(readFileSync(f.receipt), receipt);
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.equal(read(path).version, 2); assert.equal(read(path).userOption, true);
  assert.deepEqual(read(path).hooks.sessionStart, [foreign, own]);
  assert.deepEqual(read(f.receipt).hookMetadata['.cursor/hooks.json'], { version: 2 });
});
test('edited schema fails without changing files or claiming its ownership', t => {
  const f = fixture(t); f.template('.cursor/hooks.json', manifest(1)); succeeds(f.run());
  const path = join(f.root, '.cursor/hooks.json'), value = read(path); value.version = 99; json(path, value);
  f.template('.cursor/hooks.json', manifest(2));
  const before = readFileSync(f.receipt);
  assert.notEqual(f.run().status, 0);
  assert.equal(read(path).version, 99); assert.deepEqual(readFileSync(f.receipt), before);
});
test('legacy metadata can be adopted only when identical, never inferred on conflict', t => {
  const f = fixture(t); f.template('.cursor/hooks.json', manifest(1)); succeeds(f.run());
  const receipt = read(f.receipt); delete receipt.hookMetadata; json(f.receipt, receipt);
  f.template('.cursor/hooks.json', manifest(2));
  assert.notEqual(f.run().status, 0); assert.equal(read(join(f.root, '.cursor/hooks.json')).version, 1);
  f.template('.cursor/hooks.json', manifest(1)); succeeds(f.run());
  f.template('.cursor/hooks.json', manifest(2)); succeeds(f.run()); succeeds(f.run('--check'));
});
test('renamed hook template removes old owned fragments but keeps foreign content', t => {
  const f = fixture(t); const old = '.github/hooks/old.json', next = '.github/hooks/new.json';
  f.template(old, manifest(1)); succeeds(f.run());
  const path = join(f.root, old), value = read(path); value.hooks.sessionStart.push(foreign); value.custom = 'keep'; json(path, value);
  rmSync(join(f.kit, 'templates', old)); f.template(next, manifest(2));
  assert.notEqual(f.run('--check').status, 0); assert.equal(existsSync(join(f.root, next)), false);
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(read(path), { version: 1, hooks: { sessionStart: [foreign] }, custom: 'keep' });
  assert.deepEqual(read(join(f.root, next)), manifest(2));
  assert.deepEqual(Object.keys(read(f.receipt).hooks), [next]);
  assert.deepEqual(Object.keys(read(f.receipt).hookMetadata), [next]);
});
test('retiring a fully owned manifest removes only that file', t => {
  const f = fixture(t), name = '.github/hooks/old.json'; f.template(name, manifest(1)); succeeds(f.run());
  write(join(f.root, '.github/hooks/user.txt'), 'keep'); rmSync(join(f.kit, 'templates', name));
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.equal(existsSync(join(f.root, name)), false);
  assert.equal(readFileSync(join(f.root, '.github/hooks/user.txt'), 'utf8'), 'keep');
});
test('edited retired handlers fail before publishing their replacement', t => {
  const f = fixture(t), name = '.github/hooks/old.json'; f.template(name, manifest(1)); succeeds(f.run());
  const path = join(f.root, name), value = read(path); value.hooks.sessionStart[0].command = 'echo edited'; json(path, value);
  rmSync(join(f.kit, 'templates', name)); f.template('.github/hooks/new.json', manifest(2));
  const before = readFileSync(f.receipt); assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(join(f.root, '.github/hooks/new.json')), false);
  assert.deepEqual(readFileSync(f.receipt), before); assert.deepEqual(read(path), value);
});
test('receipt traversal and symlink escapes cannot delete an outside file', t => {
  const f = fixture(t); const outside = join(f.base, 'outside'); mkdirSync(outside);
  write(join(outside, 'keep'), 'keep');
  for (const name of ['../outside/keep', '.github/../.git/config', 'scripts/../../outside/keep']) {
    json(f.receipt, { files: { [name]: hash('keep') }, hooks: {} });
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  }
  json(f.receipt, { files: {}, hooks: {} });
  // An allowed receipt name must still reject a symlinked deletion parent.
  rmSync(join(f.root, 'scripts'), { recursive: true });
  write(join(outside, 'check-skills.mjs'), 'keep');
  symlinkSync(outside, join(f.root, 'scripts'), 'junction');
  json(f.receipt, { files: { 'scripts/check-skills.mjs': hash('keep') }, hooks: {} });
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(outside, 'check-skills.mjs'), 'utf8'), 'keep');
  rmSync(join(f.root, 'scripts'));
  json(f.receipt, { files: {}, hooks: {} });
  symlinkSync(outside, join(f.root, '.cursor'), 'junction');
  f.template('.cursor/hooks.json', manifest(1));
  assert.notEqual(f.run().status, 0); assert.equal(existsSync(join(outside, 'hooks.json')), false);
});

test('an unrelated checkout cannot be selected through CLI arguments', t => {
  const f = fixture(t), outside = join(f.base, 'consumer-other');
  mkdirSync(join(outside, '.git'), { recursive: true });
  const result = spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs'), outside], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Target must own this kit/);
  assert.equal(existsSync(join(outside, '.github')), false);
});

test('interrupted hook writes resume; foreign edits remain protected', t => {
  const f = fixture(t), name = '.cursor/hooks.json', target = join(f.root, name);
  f.template(name, manifest(1)); succeeds(f.run());
  const value = read(target); value.hooks.sessionStart.push(foreign); json(target, value);
  const next = { version: 2, hooks: { sessionStart: [{ command: 'echo new' }] } };
  f.template(name, next);
  // Fail the next real write after the hook output, before the final receipt.
  const fault = join(f.base, 'fault.mjs');
  write(fault, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync; let changed = false;
fs.writeFileSync = (path, ...args) => {
  if (changed) throw new Error('injected write failure');
  const result = write(path, ...args);
  if (String(path) === ${JSON.stringify(target)}) changed = true;
  return result;
}; syncBuiltinESMExports();`);
  const failed = spawnSync(process.execPath, ['--import', pathToFileURL(fault).href, join(f.kit, 'scripts/init-project.mjs'), f.root, '--existing'], { encoding: 'utf8' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /injected write failure/);
  const interrupted = readFileSync(f.receipt), updated = readFileSync(target);
  assert.ok(read(f.receipt).planned[name]);
  assert.notEqual(f.run('--check').status, 0);
  assert.deepEqual(readFileSync(f.receipt), interrupted);
  const edited = read(target); edited.hooks.sessionStart.at(-1).command = 'echo user edit'; json(target, edited);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(read(target), edited);
  writeFileSync(target, updated);
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(read(target).hooks.sessionStart, [foreign, ...next.hooks.sessionStart]);
  assert.equal(read(f.receipt).planned, undefined);
});

test('interrupted retirement tolerates an already removed manifest', t => {
  const f = fixture(t), name = '.github/hooks/old.json';
  f.template(name, manifest(1)); succeeds(f.run());
  rmSync(join(f.kit, 'templates', name)); rmSync(join(f.root, name));
  assert.notEqual(f.run('--check').status, 0);
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.equal(read(f.receipt).hooks[name], undefined);
});

test('retired template preserves user-edited metadata after removing owned handlers', t => {
  const f = fixture(t), name = '.github/hooks/old.json';
  f.template(name, manifest(1)); succeeds(f.run());
  const path = join(f.root, name), value = read(path); value.version = 99; json(path, value);
  rmSync(join(f.kit, 'templates', name));
  succeeds(f.run()); succeeds(f.run('--check'));
  assert.deepEqual(read(path), { version: 99 });
});
