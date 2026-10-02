// Provider discovery files are ordinary, committable files. Replaced local content stays recoverable.
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const present = path => lstatSync(path, { throwIfNoEntry: false });
const stamp = new Date().toISOString().replaceAll(':', '-');

/** Assert `path` lies below `root` and no existing component on the way is a link or a file (no redirected state). */
export function checkDirectory(root, path) {
  const inside = relative(root, path);
  assert.ok(!isAbsolute(inside) && inside.split(sep)[0] !== '..', `Directory leaves checkout: ${path}`);
  let current = root;
  for (const part of inside.split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = present(current);
    if (!entry) break;
    assert.ok(entry.isDirectory(), `Refusing linked or non-directory path: ${relative(root, current)}`);
  }
}

/** Create `path` as a directory below `root` after `checkDirectory`. */
export function localDirectory(root, path) {
  checkDirectory(root, path);
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
  // Through a linked ancestor, `path` would name an entry somewhere else.
  checkDirectory(root, dirname(path));
  const entry = present(path);
  if (!entry) return;
  const destination = join(root, '.workflow-kit/replaced', stamp, relative(root, path));
  localDirectory(root, dirname(destination));
  const target = entry.isSymbolicLink() ? readlinkSync(path) : null;
  if (process.platform !== 'win32' && target && !isAbsolute(target)) {
    // Moving a relative link verbatim would break recovery. Keep its original target
    // without reading through it; remove the old link only after the backup exists.
    // Preserve `..` after symlink components rather than normalizing it lexically.
    symlinkSync(dirname(path) + sep + target, destination);
    unlinkSync(path);
  } else rename(path, destination);
  console.log(`Moved ${relative(root, path)} to ${relative(root, destination)}`);
}

/** Compare ordinary files/directories without following a previous provider link. */
function same(path, source) {
  const current = present(path), expected = lstatSync(source);
  if (!current || current.isSymbolicLink()) return false;
  if (expected.isFile()) return current.isFile()
    && (process.platform === 'win32' || (current.mode & 0o111) === (expected.mode & 0o111))
    && readFileSync(path).equals(readFileSync(source));
  assert.ok(expected.isDirectory(), `Unexpected generated link or special file: ${source}`);
  if (!current.isDirectory()) return false;
  const names = readdirSync(source).sort();
  return JSON.stringify(readdirSync(path).sort()) === JSON.stringify(names)
    && names.every(name => same(join(path, name), join(source, name)));
}

/** Publish generated files; keep equal output and preserve changed files or old junctions aside. */
export function materialize(root, path, source) {
  localDirectory(root, dirname(path));
  if (same(path, source)) return;
  moveAside(root, path);
  cpSync(source, path, { recursive: true });
}
