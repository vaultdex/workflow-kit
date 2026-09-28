import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';

// Reuse the installer's ancestor check without executing an untrusted Git first.
// An enclosing checkout also owns sibling tools outside a nested submodule.
export function checkoutRoot(path) {
  let checkout = realpathSync.native(path);
  for (let ancestor = dirname(checkout);; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, '.git'))) checkout = ancestor;
    if (dirname(ancestor) === ancestor) return checkout;
  }
}

/** The Git checkout containing the working directory: kit commands act on the project they run in,
 * never on a path taken from their arguments. */
export function projectRoot() {
  for (let directory = realpathSync.native(process.cwd());; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return directory;
    assert.notEqual(dirname(directory), directory, 'Run this command inside a Git checkout');
  }
}

/** Resolve an installed CLI (git, gh) outside every checkout containing `paths`, so a checkout
 * cannot substitute it. The returned environment keeps only such PATH entries and stops Windows
 * from searching the working directory first. */
export function externalTool(name, ...paths) {
  const checkouts = paths.map(checkoutRoot);
  const outside = path => checkouts.every(base => path !== base && !path.startsWith(base + sep));
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
    .filter(path => existsSync(path) && outside(realpathSync.native(path)));
  const file = directories.map(path => join(path, process.platform === 'win32' ? `${name}.exe` : name))
    .filter(existsSync).map(path => realpathSync.native(path)).find(outside);
  assert.ok(file, `Install ${name} outside the checkout on an absolute PATH`);
  return { file, env: { ...process.env, PATH: directories.join(delimiter), NoDefaultCurrentDirectoryInExePath: '1' } };
}
