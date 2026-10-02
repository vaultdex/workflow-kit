import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both setups act on the checkout they run in (see projectRoot in checkout-root.mjs).
const scripts = dirname(fileURLToPath(import.meta.url));
for (const name of ['setup-ponytail.mjs', 'setup-impeccable.mjs', 'setup-matt-pocock.mjs'])
  execFileSync(process.execPath, [join(scripts, name)], { stdio: 'inherit' });
console.log('Skills generated for commit. Hook installation and personal trust are separate explicit steps.');
