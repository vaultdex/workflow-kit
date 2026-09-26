// Zweck: Kit-eigene Altstände an Skill-/Hook-Zielen erkennen, fremde Inhalte schützen.
// Nutzen: Kopierte Worktrees und ältere Checkouts werden ohne Handarbeit eingerichtet (#38).
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Classifies an existing provider entry. `current` links to `expected`; `stale` is kit-owned and may be
 * replaced: a link to the same bundle path in another checkout (a copied junction/symlink) or a copy whose
 * every file `known(name, bytes)` accepts as unedited generated output. Anything else returns the reason
 * it stays untouched.
 */
export function classifyEntry(target, expected, bundlePath, known) {
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) {
    const to = resolve(dirname(target), readlinkSync(target));
    if (to === expected) return 'current';
    return to.endsWith(sep + bundlePath) ? 'stale' : 'foreign link';
  }
  if (!entry.isDirectory()) return 'foreign file';
  for (const name of readdirSync(target, { recursive: true })) {
    const kind = lstatSync(join(target, name));
    if (kind.isDirectory()) continue;
    if (!kind.isFile() || !known(name.split(sep).join('/'), readFileSync(join(target, name)))) return 'edited or foreign copy';
  }
  return 'stale';
}

/** True when `bytes` equal a generated file, also across a CRLF checkout of the same text. */
export function sameFile(path, bytes) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
  const expected = readFileSync(path);
  return expected.equals(bytes) || expected.toString('utf8').replaceAll('\r\n', '\n') === bytes.toString('utf8').replaceAll('\r\n', '\n');
}

/** Removes an entry that classifyEntry reported as stale: only the link itself, or the verified copy. */
export function removeStale(target) {
  if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  else rmSync(target, { recursive: true });
}
