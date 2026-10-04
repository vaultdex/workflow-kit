import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('kit scripts and docs contain no control characters besides tab and line breaks', () => {
  // A script edit once turned a regex \b into a literal backspace; such bytes are invisible in review.
  const files = execFileSync('git', ['ls-files', '--', 'scripts', 'docs', ':(glob)*.md'], { cwd: root, encoding: 'utf8' })
    // Patches feed generated skills, so a stray byte there would spread.
    .split('\n').filter(file => /\.(mjs|js|md|json|ya?ml|patch)$/.test(file));
  assert.ok(files.length > 10, 'Expected to scan the kit sources');
  const broken = files.filter(file => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readFileSync(`${root}/${file}`, 'utf8')));
  assert.deepEqual(broken, []);
});
