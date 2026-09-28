// Zweck: Lokale Provider-Pfade (.claude/skills/ponytail usw.) auf das generierte Bundle verlinken.
// Nutzen: Kopien aus Harness-Worktrees, fremde Links oder Dateien an Kit-Pfaden blockieren das Setup
// nicht mehr und gehen nie verloren: Sie werden nach .workflow-kit/replaced/<Zeitpunkt>/ verschoben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const present = path => lstatSync(path, { throwIfNoEntry: false });
const stamp = new Date().toISOString().replaceAll(':', '-');

/** Create `path` as a directory; every existing ancestor must stay inside `root` (no redirected state). */
export function localDirectory(root, path) {
  let ancestor = path;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor), base = realpathSync(root);
  assert.ok(actual === base || actual.startsWith(base + sep), `Directory leaves checkout: ${path}`);
  mkdirSync(path, { recursive: true });
}

/** renameSync that waits out the short locks Windows antivirus and indexers put on fresh files. */
export function rename(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      if (attempt === 30 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Make `path` a link to `target`. A matching link stays; anything else moves to .workflow-kit/replaced/. */
export function link(root, path, target) {
  if (present(path)?.isSymbolicLink() && existsSync(path) && realpathSync(path) === realpathSync(target)) return;
  localDirectory(root, dirname(path));
  if (present(path)) {
    const destination = join(root, '.workflow-kit/replaced', stamp, relative(root, path));
    localDirectory(root, dirname(destination));
    renameSync(path, destination);
    console.log(`Moved ${relative(root, path)} to ${relative(root, destination)}`);
  }
  const windows = process.platform === 'win32';
  symlinkSync(windows ? target : relative(dirname(path), target), path, windows ? 'junction' : 'dir');
}
