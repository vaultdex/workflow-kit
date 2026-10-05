import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { patchApplies, patchedFiles, refreshPatch } from '../update-ponytail.mjs';

const lines = (...overrides) => Array.from({ length: 12 }, (_, i) => overrides.find(([n]) => n === i + 1)?.[1] ?? `line ${i + 1}`).join('\n') + '\n';
const FILE = 'hooks/ponytail-example.js';

/** What `git diff` writes for one changed file, as the kit stores its adaptation patch. */
function diff(t, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'ponytail refresh test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [side, text] of [['a', before], ['b', after]]) {
    mkdirSync(join(dir, side, dirname(FILE)), { recursive: true });
    writeFileSync(join(dir, side, FILE), text);
  }
  return spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-prefix', '--no-color', 'a', 'b'], { cwd: dir, encoding: 'utf8' }).stdout;
}

function apply(t, patch, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ponytail apply test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, dirname(FILE)), { recursive: true });
  writeFileSync(join(dir, FILE), text);
  writeFileSync(join(dir, 'p.patch'), patch);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error-all', 'p.patch'], { cwd: dir, stdio: 'pipe' });
  return readFileSync(join(dir, FILE), 'utf8');
}

test('an adaptation is ported onto changed upstream and the new patch applies to the new upstream', t => {
  const previous = lines();
  const patch = diff(t, previous, lines([3, 'adapted 3']));
  assert.deepEqual(patchedFiles(patch), [FILE]);
  // Upstream edits inside the patch's context (so the old patch no longer applies) and far from it.
  const next = lines([6, 'upstream 6'], [11, 'upstream 11']);
  const refreshed = refreshPatch({ patch, from: { [FILE]: previous }, to: { [FILE]: next }, files: [FILE] });
  assert.equal(apply(t, refreshed, next), lines([3, 'adapted 3'], [6, 'upstream 6'], [11, 'upstream 11']));
  assert.equal(patchApplies(patch, { [FILE]: next }), false);
  assert.equal(patchApplies(refreshed, { [FILE]: next }), true);
});

test('an adaptation that overlaps an upstream change stops with the file name', t => {
  const previous = lines();
  const patch = diff(t, previous, lines([3, 'adapted 3']));
  const next = lines([3, 'upstream 3']);
  const run = resolved => refreshPatch({ patch, from: { [FILE]: previous }, to: { [FILE]: next }, files: [FILE], resolved });
  assert.throws(() => run({}), error => error.message.includes(FILE) && error.conflicts[FILE].includes('<<<<<<< adapted'));
  // The hand-edited result of that conflict becomes the new patch; leftover markers are rejected.
  const merged = lines([3, 'adapted upstream 3']);
  assert.equal(apply(t, run({ [FILE]: merged }), next), merged);
  assert.throws(() => run({ [FILE]: '<<<<<<< adapted\nx\n' }), /still contains conflict markers/);
});
