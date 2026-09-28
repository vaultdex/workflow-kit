// Zweck: Gepinnte Ponytail-Skills erzeugen und in die lokalen Provider verlinken.
// Nutzen: Ein Bundle fuer alle lokalen Provider; keine kopierte Laufzeitlogik im Produkt.
// Aufruf: setup-skills bei Einrichtung oder bewusstem Kit-Update, nicht pro Agenten-Turn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalTool, projectRoot } from './checkout-root.mjs';
import { link, localDirectory, moveAside, rename } from './provider-links.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = projectRoot();
const source = join(kit, '.vendor/ponytail');
const state = join(root, '.workflow-kit');
const bundle = join(state, 'ponytail');
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const present = p => lstatSync(p, { throwIfNoEntry: false });
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const gitTool = externalTool('git', root, kit, process.cwd());
const git = (...args) => execFileSync(gitTool.file, args, { cwd: root, env: gitTool.env, encoding: 'utf8' });
const skillName = /^ponytail(?:-[a-z0-9]+)*$/;

localDirectory(root, state);
assert.ok(!present(bundle)?.isSymbolicLink(), 'Generated Ponytail bundle must not be a link');
if (existsSync(join(source, '.git'))) assert.equal(git('-C', source, 'status', '--porcelain', '--untracked-files=all').trim(), '', 'Ponytail source has local changes');
git('-C', kit, 'submodule', 'update', '--init', '--', '.vendor/ponytail');
// assume-unchanged (lowercase tag) or skip-worktree (S) would hide edits from the status check above.
assert.ok(!/^(?:[a-z]|S) /m.test(git('-C', source, 'ls-files', '-v')), 'Ponytail source hides local changes from git status');
const revision = git('-C', source, 'rev-parse', 'HEAD').trim();
const skills = git('-C', source, 'ls-tree', '-d', '--name-only', `${revision}:skills`).trim().split('\n');
assert.ok(skills.includes('ponytail') && skills.every(s => skillName.test(s)), 'Invalid pinned skill names');
const files = [...skills.map(s => `skills/${s}/SKILL.md`),
  ...['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'].map(n => `hooks/ponytail-${n}.js`)];
// The source is clean and at the pin, so its working tree holds the pinned files.
const contents = new Map([...files, 'LICENSE'].map(file => [file, text(join(source, file))]));
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
  const links = providers.flatMap(p => skills.map(s => [`${p}/skills/${s}`, `.agents/skills/${s}`]));
  links.push(['.agents/hooks', '.agents/hooks']);
  const outputs = Object.fromEntries([...skills.map(s => [`skills/${s}/SKILL.md`, `.github/skills/${s}/SKILL.md`]),
    ...['LICENSE.md', 'NOTICE.md'].map(n => [`skills/ponytail/${n}`, `.github/skills/ponytail/${n}`])]
    .map(([from, dest]) => [dest, text(join(next, '.agents', from))]));
  // Check every output directory before the swap, so a linked one stops setup with nothing replaced.
  const cloud = join(root, '.github/skills');
  for (const directory of [cloud, ...links.map(([dest]) => dirname(join(root, dest))),
    ...Object.keys(outputs).map(file => dirname(join(root, file)))]) localDirectory(root, directory);
  if (existsSync(bundle)) rename(bundle, previous);
  try { rename(next, bundle); }
  catch (error) {
    if (existsSync(previous)) rename(previous, bundle);
    throw error;
  }
  for (const [dest, from] of links) link(root, join(root, dest), join(bundle, from));
  // Other ponytail-* entries in .github/skills and the providers (skills upstream dropped, or the project's
  // own) move to .workflow-kit/replaced/; current Copilot skills are generated and rewritten whole.
  for (const directory of [cloud, ...providers.map(p => join(root, p, 'skills'))])
    for (const entry of readdirSync(directory).filter(name => skillName.test(name)))
      if (!skills.includes(entry)) moveAside(root, join(directory, entry));
      else if (directory === cloud) rmSync(join(cloud, entry), { recursive: true, force: true });
  for (const [file, bytes] of Object.entries(outputs)) {
    localDirectory(root, dirname(join(root, file)));
    writeFileSync(join(root, file), bytes);
  }
  published = true;
  console.log(`Ponytail ${revision.slice(0, 7)}: shared source, five local providers linked, Copilot refreshed.`);
} finally {
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  if (published || !existsSync(previous)) rmSync(stage, { recursive: true, force: true });
  else console.error(`Setup incomplete; previous installation preserved at ${previous}`);
}
