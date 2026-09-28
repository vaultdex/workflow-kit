// Zweck: Lokale Provider-Pfade (.claude/skills/ponytail usw.) auf das generierte Bundle verlinken.
// Nutzen: Kopien aus Harness-Worktrees, fremde Links oder Dateien an Kit-Pfaden blockieren das Setup
// nicht mehr und gehen nie verloren: Sie werden nach .workflow-kit/replaced/<Zeitpunkt>/ verschoben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const present = path => lstatSync(path, { throwIfNoEntry: false });
const stamp = new Date().toISOString().replaceAll(':', '-');

/** Create `path` as a directory below `root`; no existing component may be a link or a file (no redirected state). */
export function localDirectory(root, path) {
  const inside = relative(root, path);
  assert.ok(!isAbsolute(inside) && inside.split(sep)[0] !== '..', `Directory leaves checkout: ${path}`);
  let current = root;
  for (const part of inside.split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = present(current);
    if (!entry) break;
    assert.ok(entry.isDirectory(), `Refusing linked or non-directory path: ${relative(root, current)}`);
  }
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

/** Move whatever is at `path` to .workflow-kit/replaced/<stamp>/, keeping it for the user. */
export function moveAside(root, path) {
  if (!present(path)) return;
  const destination = join(root, '.workflow-kit/replaced', stamp, relative(root, path));
  localDirectory(root, dirname(destination));
  rename(path, destination);
  console.log(`Moved ${relative(root, path)} to ${relative(root, destination)}`);
}

/** Make `path` a link to `target`. A matching link stays; anything else moves to .workflow-kit/replaced/. */
export function link(root, path, target) {
  if (present(path)?.isSymbolicLink() && existsSync(path) && realpathSync(path) === realpathSync(target)) return;
  localDirectory(root, dirname(path));
  moveAside(root, path);
  const windows = process.platform === 'win32';
  symlinkSync(windows ? target : relative(dirname(path), target), path, windows ? 'junction' : 'dir');
}
