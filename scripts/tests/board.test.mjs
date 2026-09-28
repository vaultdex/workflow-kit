import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('board check exits 0 only for startable issues: 1 blocked, 2 unknown', t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-board-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(join(checkout, '.github'), { recursive: true });
  mkdirSync(bin);
  // Node acts as the fixture gh: `gh api graphql …` runs the checkout's `api` script.
  const gh = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
  copyFileSync(process.execPath, gh);
  chmodSync(gh, 0o755);
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1' }));
  writeFileSync(join(checkout, 'api'), `const fs = require('node:fs');
if (fs.existsSync('fail')) process.exit(1);
process.stdout.write(fs.readFileSync('response.json'));`);
  const check = (status, nodes, totalCount = nodes.length) => {
    writeFileSync(join(checkout, 'response.json'), JSON.stringify({ data: { repository: { issue: {
      id: 'I1', number: 1, title: 'Fixture', state: 'OPEN', assignees: { nodes: [] },
      projectItems: { nodes: [{ id: 'PI1', project: { id: 'P1' }, status: { name: status } }] },
      blockedBy: { totalCount, nodes } } } } }));
    return spawnSync(process.execPath, [fileURLToPath(new URL('../board.mjs', import.meta.url)), 'check', '1'],
      { cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: bin } }).status;
  };
  const predecessor = (state, stateReason) => ({ number: 9, state, stateReason, repository: { nameWithOwner: 'test/other' } });

  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')]), 0);
  assert.equal(check('Ready', [predecessor('OPEN', null)]), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'NOT_PLANNED')]), 1);
  assert.equal(check('Backlog', []), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')], 2), 2, 'Unreadable predecessors are unknown');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(check('Ready', []), 2, 'A failed read is never "no blockers"');
});
