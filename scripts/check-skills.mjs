import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? kit);
const git = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  .map(p => join(p, process.platform === 'win32' ? 'git.exe' : 'git')).find(existsSync);
assert.ok(git, 'Git is required');
// Compare regenerated files with real pinned blobs, not a self-asserted receipt.
for (const name of ['ponytail', 'impeccable']) {
  const pin = execFileSync(git, ['-C', kit, 'rev-parse', `HEAD:.vendor/${name}`], { encoding: 'utf8' }).trim();
  const actual = execFileSync(git, ['-C', join(kit, '.vendor', name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(actual, pin, `Initialize the committed ${name} submodule`);
}
const fixture = mkdtempSync(join(tmpdir(), 'workflow-kit discovery '));
try {
  execFileSync(git, ['init', '--quiet', fixture]);
  execFileSync(process.execPath, [join(kit, 'scripts/setup-skills.mjs'), fixture], { stdio: 'pipe' });
  const normalize = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  const expected = readdirSync(join(fixture, '.github'), { recursive: true }).filter(p => lstatSync(join(fixture, '.github', p)).isFile());
  for (const file of expected) assert.equal(normalize(join(root, '.github', file)), normalize(join(fixture, '.github', file)), `Regenerate .github/${file} with setup-skills`);
  const actual = readdirSync(join(root, '.github'), { recursive: true }).filter(p => lstatSync(join(root, '.github', p)).isFile()
    && /^(skills[\\/](ponytail[^\\/]*|impeccable)[\\/]|agents[\\/]impeccable-)/.test(p));
  assert.deepEqual(actual.sort(), expected.sort(), 'Stale generated discovery files must be removed');
  console.log('All Copilot skills, support files and agents match the pinned sources and reviewed patches.');
} finally {
  assert.equal(dirname(fixture), tmpdir());
  assert.ok(!lstatSync(fixture).isSymbolicLink());
  rmSync(fixture, { recursive: true, force: true });
}
