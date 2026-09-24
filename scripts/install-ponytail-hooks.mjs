// Zweck: Einen geprueften Ponytail-Snapshot im Benutzerverzeichnis installieren.
// Nutzen: Automatische Hooks muessen keine veraenderlichen Checkout-Skripte ausfuehren.
// Aufruf: Explizit aus dem Kit mit dem Projektpfad; persoenliche Hook-Freigabe bleibt getrennt.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run explicitly from a reviewed checkout. Automatic hooks execute this installed
// snapshot, never the installer or mutable JavaScript in the working tree.
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(homedir(), '.ponytail', 'vaultdex');
const destination = path.join(parent, '4.10.0-6');
// The bootstrap itself must remain personal trusted code, outside every checkout.
// Resolve the existing prefix before checking ancestors, including junctions.
let existing = destination;
const missingParts = [];
while (!existsSync(existing) && existing !== path.dirname(existing)) {
  missingParts.unshift(path.basename(existing));
  existing = path.dirname(existing);
}
for (let directory = path.join(realpathSync(existing), ...missingParts);; directory = path.dirname(directory)) {
  if (existsSync(path.join(directory, '.git'))) {
    throw new Error('Ponytail snapshot must be outside Git checkouts. Use a personal home/snapshot location outside the checkout before installing or enabling hooks.');
  }
  if (directory === path.dirname(directory)) break;
}
const files = [
  '.agents/hooks/LICENSE.md',
  ...['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent']
    .map(name => `.agents/hooks/ponytail-${name}.js`),
  '.agents/skills/ponytail/SKILL.md',
  '.agents/skills/ponytail/LICENSE.md',
  '.agents/skills/ponytail/NOTICE.md',
];
const source = fileURLToPath(new URL('./ponytail/', import.meta.url));
const inputs = Object.fromEntries(files.map(file => [file, path.join(root, file)]));
for (const name of ['launch.sh', 'launch.ps1', 'launch.cmd']) inputs[name] = path.join(source, name);

function matches(directory) {
  return Object.entries(inputs).every(([file, input]) => existsSync(path.join(directory, file)) &&
    readFileSync(path.join(directory, file)).equals(readFileSync(input)));
}

const missing = files.filter(file => !existsSync(path.join(root, file)));
if (missing.length) throw new Error(`Ponytail sources missing in ${root} (${missing[0]}); run the kit's scripts/setup-skills.mjs with this project path first.`);

if (existsSync(destination)) {
  if (!matches(destination)) throw new Error('Ponytail 4.10.0-6 differs from this checkout. Review the change and publish a new runtime version; existing installation was not replaced.');
} else {
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, '.install-'));
  try {
    for (const [file, input] of Object.entries(inputs)) {
      const target = path.join(staging, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(input), { mode: file === 'launch.cmd' ? 0o755 : 0o644 });
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
