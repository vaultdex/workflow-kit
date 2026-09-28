import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(file, 'utf8');
const documents = ['.', 'docs', 'templates'].flatMap(directory => readdirSync(join(kit, directory))
  .filter(name => name.endsWith('.md')).map(name => join(kit, directory, name)));
// GitHub heading anchors: lower case, punctuation removed, spaces become hyphens.
const anchors = file => new Set([...read(file).matchAll(/^#{1,6} +(.+)$/gm)]
  .map(([, heading]) => heading.replace(/[`*]/g, '').trim().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replaceAll(' ', '-')));

test('relative links and anchors in the kit documentation resolve', () => {
  for (const file of documents) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [path, anchor] = target.split('#');
      // Consumer templates link to the kit through its submodule path.
      const base = relative(kit, file).startsWith('templates') && path.startsWith('.vendor/workflow-kit/')
        ? join(kit, path.slice('.vendor/workflow-kit/'.length)) : resolve(dirname(file), path || file);
      const where = `${relative(kit, file)} → ${target}`;
      assert.ok(existsSync(base), `Missing link target: ${where}`);
      if (anchor) assert.ok(anchors(base).has(anchor), `Missing anchor: ${where}`);
    }
  }
});

test('mandatory agent reading stays within its budget', () => {
  // Every agent reads the entry on every task; replace or delete rules instead of appending.
  const size = file => read(join(kit, file)).length;
  assert.ok(size('AGENT_RULES.md') + size('templates/AGENTS.md') <= 5000, 'AGENT_RULES.md and templates/AGENTS.md exceed 5000 characters');
  assert.ok(size('docs/CONTRIBUTING.md') <= 12000, 'docs/CONTRIBUTING.md exceeds 12000 characters');
});
