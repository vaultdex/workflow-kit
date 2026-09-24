import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? kit);
const source = join(kit, '.vendor/ponytail');
const state = join(root, '.workflow-kit');
const bundle = join(state, 'ponytail');
const present = p => lstatSync(p, { throwIfNoEntry: false });
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const searchPath = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  .filter(p => existsSync(p) && realpathSync(p) !== realpathSync(root)
    && !realpathSync(p).startsWith(realpathSync(root) + sep));
const binary = searchPath.map(p => join(p, process.platform === 'win32' ? 'git.exe' : 'git')).find(existsSync);
assert.ok(binary, 'Install Git outside the checkout on an absolute PATH');
const gitOptions = { cwd: root,
  env: { ...process.env, PATH: searchPath.join(delimiter), NoDefaultCurrentDirectoryInExePath: '1' } };
const git = (...args) => execFileSync(binary, args, { ...gitOptions, encoding: 'utf8' });

function directory(p) {
  let parent = p;
  while (!present(parent)) parent = dirname(parent);
  const actual = realpathSync(parent);
  assert.ok(actual === realpathSync(root) || actual.startsWith(realpathSync(root) + sep), `Directory leaves checkout: ${p}`);
  mkdirSync(p, { recursive: true });
}

directory(state);
assert.ok(!present(bundle)?.isSymbolicLink(), 'Generated Ponytail bundle must not be a link');
if (existsSync(bundle)) assert.equal(text(join(bundle, '.owner')), 'vaultdex-workflow-kit\n');
if (existsSync(join(source, '.git'))) assert.equal(git('-C', source, 'status', '--porcelain', '--untracked-files=all').trim(), '', 'Ponytail source has local changes');
git('-C', kit, 'submodule', 'update', '--init', '--', '.vendor/ponytail');
const revision = git('-C', source, 'rev-parse', 'HEAD').trim();
const skills = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'];
const files = [...skills.map(s => `skills/${s}/SKILL.md`),
  ...['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'].map(n => `hooks/ponytail-${n}.js`)];
// Read committed blobs in one Git process. Parse byte lengths before decoding:
// UTF-8 characters and embedded newlines are not batch-record boundaries.
const requested = [...files, 'LICENSE'];
const batch = execFileSync(binary, ['-C', source, 'cat-file', '--batch'], {
  ...gitOptions, input: requested.map(file => `${revision}:${file}\n`).join(''),
  maxBuffer: 16 * 1024 * 1024,
});
let offset = 0;
const contents = new Map();
for (const file of requested) {
  const end = batch.indexOf(10, offset);
  assert.ok(end >= offset, `Missing pinned blob header: ${file}`);
  const header = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(batch.toString('ascii', offset, end));
  assert.ok(header, `Missing or non-blob pinned source: ${file}`);
  const size = Number(header[2]);
  offset = end + 1;
  assert.ok(Number.isSafeInteger(size) && size >= 0 && size < batch.length - offset
    && batch[offset + size] === 10, `Incomplete pinned blob: ${file}`);
  contents.set(file, batch.toString('utf8', offset, offset + size).replaceAll('\r\n', '\n'));
  offset += size + 1;
}
assert.equal(offset, batch.length, 'Unexpected trailing pinned-source output');
const stage = mkdtempSync(join(state, 'setup-'));
const next = join(stage, 'next');
const previous = join(stage, 'previous');
let published = false;
try {
  for (const file of files) {
    const p = join(next, '.agents', file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents.get(file));
  }
  git('apply', '--whitespace=error-all', `--directory=${relative(root, join(next, '.agents')).split(sep).join('/')}`,
    join(kit, 'scripts/ponytail/adaptations.patch'));
  for (const file of files) writeFileSync(join(next, '.agents', file), text(join(next, '.agents', file)));
  const license = contents.get('LICENSE');
  writeFileSync(join(next, '.agents/hooks/LICENSE.md'), license);
  writeFileSync(join(next, '.agents/skills/ponytail/LICENSE.md'), license);
  writeFileSync(join(next, '.agents/skills/ponytail/NOTICE.md'), text(join(kit, 'scripts/ponytail/NOTICE.md')));
  writeFileSync(join(next, '.owner'), 'vaultdex-workflow-kit\n');
  const links = ['.agent', '.agents', '.claude', '.opencode', '.pi'].flatMap(p => skills.map(s => [`${p}/skills/${s}`, `.agents/skills/${s}`]));
  links.push(['.agents/hooks', '.agents/hooks']);
  for (const [dest, from] of links) {
    const target = join(root, dest);
    directory(dirname(target));
    if (present(target)) assert.ok(present(target).isSymbolicLink()
      && resolve(dirname(target), readlinkSync(target)) === join(bundle, from), `Existing skill/hook left untouched: ${target}`);
  }
  const outputs = Object.fromEntries([...skills.map(s => [`skills/${s}/SKILL.md`, `.github/skills/${s}/SKILL.md`]),
    ...['LICENSE.md', 'NOTICE.md'].map(n => [`skills/ponytail/${n}`, `.github/skills/ponytail/${n}`])]
    .map(([from, dest]) => [dest, text(join(next, '.agents', from))]));
  const receiptPath = join(root, '.github/skills/ponytail/.workflow-source.json');
  directory(dirname(receiptPath));
  assert.ok(!present(receiptPath) || present(receiptPath).isFile(), 'Receipt must be a regular file');
  const old = existsSync(receiptPath) ? JSON.parse(text(receiptPath)).files : {};
  for (const [file, bytes] of Object.entries(outputs)) {
    const target = join(root, file);
    directory(dirname(target));
    if (present(target)) assert.ok(present(target).isFile() && (text(target) === bytes || old[file] === hash(text(target))),
      `Existing or edited Copilot skill left untouched: ${target}`);
  }
  assert.ok(!present(receiptPath) || present(receiptPath).isFile(), 'Receipt must be a regular file');
  if (existsSync(bundle)) renameSync(bundle, previous);
  try { renameSync(next, bundle); }
  catch (error) { if (existsSync(previous)) renameSync(previous, bundle); throw error; }
  for (const [dest, from] of links) {
    const target = join(root, dest);
    if (!present(target)) symlinkSync(process.platform === 'win32' ? join(bundle, from) : relative(dirname(target), join(bundle, from)),
      target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const [file, bytes] of Object.entries(outputs)) writeFileSync(join(root, file), bytes);
  writeFileSync(receiptPath, JSON.stringify({ revision, files: Object.fromEntries(Object.entries(outputs).map(([p, bytes]) => [p, hash(bytes)])) }, null, 2) + '\n');
  published = true;
  console.log(`Ponytail ${revision.slice(0, 7)}: shared source, five local providers linked, Copilot refreshed.`);
} finally {
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  if (published || !existsSync(previous)) rmSync(stage, { recursive: true, force: true });
  else console.error(`Setup incomplete; previous installation preserved at ${previous}`);
}
