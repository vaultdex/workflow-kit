import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? resolve(scripts, '..'));
for (const name of ['setup-ponytail.mjs', 'setup-impeccable.mjs'])
  execFileSync(process.execPath, [resolve(scripts, name), root], { stdio: 'inherit' });
console.log('Skills ready. Hook installation and personal trust are separate explicit steps.');
