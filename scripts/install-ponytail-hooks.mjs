import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run explicitly from a reviewed checkout. Automatic hooks execute this installed
// snapshot, never the installer or mutable JavaScript in the working tree.
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(homedir(), '.ponytail', 'vaultdex');
const destination = path.join(parent, '4.10.0-5');
const files = [
  '.agents/hooks/LICENSE.md',
  ...['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent']
    .map(name => `.agents/hooks/ponytail-${name}.js`),
  '.agents/skills/ponytail/SKILL.md',
  '.agents/skills/ponytail/LICENSE.md',
  '.agents/skills/ponytail/NOTICE.md',
];

function matches(directory) {
  return files.every(file => existsSync(path.join(directory, file)) &&
    readFileSync(path.join(directory, file)).equals(readFileSync(path.join(root, file))));
}

const missing = files.filter(file => !existsSync(path.join(root, file)));
if (missing.length) throw new Error(`Ponytail sources missing in ${root} (${missing[0]}); run node scripts/setup-skills.mjs first.`);

if (existsSync(destination)) {
  if (!matches(destination)) throw new Error('Ponytail 4.10.0-5 differs from this checkout. Review the change and publish a new runtime version; existing installation was not replaced.');
} else {
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, '.install-'));
  try {
    for (const file of files) {
      const target = path.join(staging, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(root, file)));
    }
    try {
      renameSync(staging, destination);
    } catch (error) {
      // A concurrent identical installation is already the desired result.
      if (!existsSync(destination) || !matches(destination)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
console.log(`Ponytail hooks installed: ${destination}`);
console.log('Review and enable the project hooks in your agent; start a fresh session. No hook trust or personal agent settings were changed.');
