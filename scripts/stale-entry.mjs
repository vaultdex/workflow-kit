// Zweck: Kit-eigene Altstände an Skill-/Hook-Zielen erkennen, fremde Inhalte schützen.
// Nutzen: Kopierte Worktrees und ältere Checkouts werden ohne Handarbeit eingerichtet (#38).
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** All files and directories below `path` as POSIX paths, or null when it is no directory. */
export function listing(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return null;
  return new Set(readdirSync(path, { recursive: true }).map(name => name.split(sep).join('/')));
}

/** True when `bytes` equal a generated file, also across a CRLF checkout of the same text. */
export function sameFile(path, bytes) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
  const expected = readFileSync(path);
  return expected.equals(bytes) || expected.toString('utf8').replaceAll('\r\n', '\n') === bytes.toString('utf8').replaceAll('\r\n', '\n');
}

/** A known generated directory as a state: its complete listing and its files' contents. */
export const directoryState = path => ({ names: listing(path), matches: (name, bytes) => sameFile(join(path, name), bytes) });

const equal = (a, b) => a.size === b.size && [...a].every(name => b.has(name));

/**
 * Classifies an existing provider entry. `current` links to `expected`; `stale` is kit-owned and may be
 * replaced: a link to the same owned bundle path in another checkout (a copied junction/symlink) or a copy equal to
 * one single known generated state, i.e. the same complete listing and every file matching that state. A copy
 * assembled from several states, pruned or extended, stays untouched with the returned reason.
 */
export function classifyEntry(target, expected, bundlePath, states, ownsTarget) {
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) {
    const to = resolve(dirname(target), readlinkSync(target));
    if (to === expected) return 'current';
    return to.endsWith(sep + bundlePath) && ownsTarget(to) ? 'stale' : 'foreign link';
  }
  if (!entry.isDirectory()) return 'foreign file';
  const names = listing(target);
  const files = [...names].filter(name => !lstatSync(join(target, name)).isDirectory());
  // An empty directory proves no kit ownership; it may be a user's own skill namespace.
  if (!files.length) return 'empty or foreign directory';
  if (files.some(name => !lstatSync(join(target, name)).isFile())) return 'edited or foreign copy';
  const candidates = states.filter(state => state.names && equal(state.names, names));
  if (!candidates.length) return 'partial or foreign copy';
  const contents = new Map(files.map(name => [name, readFileSync(join(target, name))]));
  return candidates.some(state => files.every(name => state.matches(name, contents.get(name)))) ? 'stale' : 'edited or foreign copy';
}

/** Removes an entry that classifyEntry reported as stale: only the link itself, or the verified copy. */
export function removeStale(target) {
  if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  else rmSync(target, { recursive: true });
}
