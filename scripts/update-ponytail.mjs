// Port scripts/ponytail/adaptations.patch to the Ponytail revision the submodule now points at,
// then regenerate the committed skills. Run after a submodule bump (Renovate or manual).
// The old patch is replayed onto the previous upstream files and 3-way merged with the new upstream files,
// like `quilt refresh`; a real conflict stops with the file name instead of guessing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDirectory } from './provider-links.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(kit, '.vendor/ponytail');
const patchPath = join(kit, 'scripts/ponytail/adaptations.patch');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lf = text => text.replaceAll('\r\n', '\n');

/** Files and contents of the patched upstream paths at one revision; a CI checkout may only hold the new pin. */
const upstream = (revision, files) => {
  try { git(source, 'cat-file', '-e', `${revision}^{commit}`); }
  catch { git(source, 'fetch', '--no-tags', 'origin', revision); }
  return Object.fromEntries(files.map(file => {
    try { return [file, lf(git(source, 'show', `${revision}:${file}`))]; }
    catch { throw new Error(`${file} does not exist in Ponytail ${revision.slice(0, 7)}; adapt scripts/ponytail/adaptations.patch by hand.`); }
  }));
};

/** Whether `patch` applies cleanly to the upstream files in `contents`. */
export function patchApplies(patch, contents) {
  const stage = mkdtempSync(join(tmpdir(), 'ponytail-check-'));
  try {
    for (const [file, text] of Object.entries(contents)) {
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      writeFileSync(join(stage, file), text);
    }
    writeFileSync(join(stage, '.check.patch'), patch);
    return spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=error-all', '.check.patch'], { cwd: stage }).status === 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** `resolved` holds hand-edited results for files that conflicted in an earlier run. */
export function refreshPatch({ patch, from, to, files, resolved = {} }) {
  const stage = mkdtempSync(join(tmpdir(), 'ponytail-refresh-'));
  try {
    const dirs = Object.fromEntries(['old', 'ours', 'a', 'b'].map(name => [name, join(stage, name)]));
    const put = (dir, contents) => Object.entries(contents).forEach(([file, text]) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    });
    put(dirs.old, from);
    put(dirs.ours, from);
    put(dirs.a, to);
    const patchFile = join(stage, 'old.patch');
    writeFileSync(patchFile, patch);
    git(dirs.ours, 'apply', '--whitespace=error-all', patchFile);
    const conflicts = {};
    for (const file of files) {
      if (file in resolved) {
        // Any marker form counts. A bare "=======" is legitimate only where the new upstream has it too (a Markdown
        // heading underline), judged by the line above it; any other one is an orphaned conflict separator.
        const lines = resolved[file].split('\n');
        const orphan = lines.some((line, i) => line === '=======' && !(i > 0 && to[file].includes(`${lines[i - 1]}\n=======`)));
        const leftover = /^(?:<{7} adapted|>{7} new upstream)$/m.test(resolved[file]) || orphan;
        assert.ok(!leftover, `${file} still contains conflict markers`);
        put(dirs.b, { [file]: resolved[file] });
        continue;
      }
      const result = spawnSync('git', ['merge-file', '-p', '-L', 'adapted', '-L', 'previous upstream', '-L', 'new upstream',
        join(dirs.ours, file), join(dirs.old, file), join(dirs.a, file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      assert.ok(result.status !== null && result.status < 128, `git merge-file failed for ${file}: ${result.stderr}`);
      if (result.status > 0) conflicts[file] = result.stdout;
      put(dirs.b, { [file]: result.stdout });
    }
    if (Object.keys(conflicts).length)
      throw Object.assign(new Error(`Adaptation conflicts with the new upstream in: ${Object.keys(conflicts).join(', ')}`), { conflicts });
    // Exit status 1 only means "differences found".
    const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-prefix', '--no-color', 'a', 'b'], { cwd: stage, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(diff.status === 0 || diff.status === 1, `git diff failed: ${diff.stderr}`);
    return diff.stdout;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Conflicting files are written to this directory (ignored by Git) with markers; edit them and run the command again.
// Every access first checks the whole path chain inside the checkout, so a link (symlink or junction) in the ignored
// state directory can neither redirect a recursive delete nor an overwrite to somewhere else.
const stateDirectory = root => join(root, '.workflow-kit/ponytail-resolve');
const regularFile = (root, path) => {
  checkDirectory(root, dirname(path));
  assert.ok(lstatSync(path).isFile(), `Refusing linked or non-file path: ${relative(root, path)}`);
  return path;
};

/** Hand-resolved files of an earlier conflict. Files that do not carry this target revision are discarded. */
export function loadResolved(root, files, to) {
  const dir = stateDirectory(root);
  checkDirectory(root, dir);
  if (!existsSync(dir)) return {};
  const targetFile = join(dir, 'TARGET');
  if (!existsSync(targetFile) || readFileSync(regularFile(root, targetFile), 'utf8').trim() !== to) {
    rmSync(dir, { recursive: true, force: true });
    return {};
  }
  return Object.fromEntries(files.filter(file => existsSync(join(dir, file)))
    .map(file => [file, lf(readFileSync(regularFile(root, join(dir, file)), 'utf8'))]));
}

export function saveConflicts(root, conflicts, to) {
  const dir = stateDirectory(root);
  for (const [file, text] of Object.entries(conflicts)) {
    checkDirectory(root, dirname(join(dir, file)));
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  writeFileSync(join(dir, 'TARGET'), `${to}\n`);
  return dir;
}

export function clearResolved(root) {
  const dir = stateDirectory(root);
  checkDirectory(root, dir);
  rmSync(dir, { recursive: true, force: true });
}

export function patchedFiles(patch) {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const to = git(source, 'rev-parse', 'HEAD').trim();
  // The generators read the index pin and reset the submodule to it, so stage a bump that is only checked out.
  if (git(kit, 'rev-parse', ':.vendor/ponytail').trim() !== to) git(kit, 'add', '--', '.vendor/ponytail');
  const patch = lf(readFileSync(patchPath, 'utf8'));
  const files = patchedFiles(patch);
  const target = upstream(to, files);
  // A patch that already fits the new upstream (earlier run, or unrelated pin bump) needs no port.
  if (patchApplies(patch, target)) {
    console.log(`Ponytail adaptations already fit ${to.slice(0, 7)}.`);
  } else {
    // The patch targets the pin recorded in the last commit that changed it; pass a revision when the history is shallow.
    const lastPatchCommit = git(kit, 'log', '-1', '--format=%H', '--', 'scripts/ponytail/adaptations.patch').trim();
    const from = process.argv[2] ?? (lastPatchCommit && git(kit, 'ls-tree', lastPatchCommit, '.vendor/ponytail').split(/\s+/)[2]);
    assert.ok(from, 'No previous upstream revision: pass it as the first argument');
    const resolved = loadResolved(kit, files, to);
    try {
      writeFileSync(patchPath, refreshPatch({ patch, from: upstream(from, files), to: target, files, resolved }));
    } catch (error) {
      if (!error.conflicts) throw error;
      const dir = saveConflicts(kit, error.conflicts, to);
      throw new Error(`${error.message}. Resolve the conflict markers in ${dir}, then run node scripts/update-ponytail.mjs again.`);
    }
    clearResolved(kit);
    console.log(`Ponytail adaptations ported from ${from.slice(0, 7)} to ${to.slice(0, 7)}.`);
  }
  execFileSync(process.execPath, [join(kit, 'scripts/setup-ponytail.mjs')], { stdio: 'inherit' });
}
