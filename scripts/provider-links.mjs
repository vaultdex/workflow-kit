// Zweck: Lokale Provider-Pfade (.claude/skills/ponytail usw.) auf das generierte Bundle verlinken.
// Nutzen: Kopien aus Harness-Worktrees, fremde Links oder Dateien an Kit-Pfaden blockieren das Setup
// nicht mehr und gehen nie verloren: Sie werden nach .workflow-kit/replaced/<Zeitpunkt>/ verschoben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const present = path => lstatSync(path, { throwIfNoEntry: false });
const stamp = new Date().toISOString().replaceAll(':', '-');

/** Refuse a path whose nearest existing ancestor resolves outside `root` (redirected state). */
export function assertInside(root, path) {
  let ancestor = path;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor), base = realpathSync(root);
  assert.ok(actual === base || actual.startsWith(base + sep), `Directory leaves checkout: ${path}`);
}

/** Create `path` as a directory inside `root`. */
export function localDirectory(root, path) {
  assertInside(root, path);
  mkdirSync(path, { recursive: true });
}

/** Move whatever occupies `path` (copy, foreign link or file) into .workflow-kit/replaced/; delete nothing. */
function moveAside(root, path) {
  const destination = join(root, '.workflow-kit/replaced', stamp, relative(root, path));
  localDirectory(root, dirname(destination));
  renameSync(path, destination);
  console.log(`Moved ${relative(root, path)} to ${relative(root, destination)}`);
}

/** Make `path` a link to `target`, keeping a link that already resolves there. */
export function link(root, path, target) {
  if (present(path)?.isSymbolicLink() && existsSync(path) && realpathSync(path) === realpathSync(target)) return;
  localDirectory(root, dirname(path));
  if (present(path)) moveAside(root, path);
  const windows = process.platform === 'win32';
  symlinkSync(windows ? target : relative(dirname(path), target), path, windows ? 'junction' : 'dir');
}

/** Remove a retired provider entry: a link into `bundle` goes, anything else is moved aside. */
export function retire(root, path, bundle) {
  if (!present(path)) return;
  if (present(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)).startsWith(bundle + sep)) unlinkSync(path);
  else moveAside(root, path);
}
