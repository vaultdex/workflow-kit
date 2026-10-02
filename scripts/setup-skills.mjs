import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './checkout-root.mjs';
import { checkDirectory, materialize } from './provider-links.mjs';

// Check Matt's ownership manifests before another generator changes discovery files.
// All setups act on the checkout they run in (see projectRoot in checkout-root.mjs).
const scripts = dirname(fileURLToPath(import.meta.url));
for (const name of ['setup-matt-pocock.mjs', 'setup-ponytail.mjs', 'setup-impeccable.mjs'])
  execFileSync(process.execPath, [join(scripts, name)], { stdio: 'inherit' });
const kit = dirname(scripts), root = projectRoot();
const findSkills = join(kit, '.agents/skills/find-skills');
checkDirectory(kit, findSkills);
for (const provider of ['.agent', '.agents', '.claude', '.github', '.opencode', '.pi'])
  materialize(root, join(root, provider, 'skills/find-skills'), findSkills);
console.log('Skills generated for commit. Hook installation and personal trust are separate explicit steps.');
