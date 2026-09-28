import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('board check and next turn GitHub data into verdicts and a ranked list', t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-board-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(join(checkout, '.github'), { recursive: true });
  mkdirSync(bin);
  // Node acts as the fixture gh: `gh api graphql …` runs the checkout's `api` script.
  const gh = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
  copyFileSync(process.execPath, gh);
  chmodSync(gh, 0o755);
  writeFileSync(join(checkout, '.github/workflow-project.json'),
    JSON.stringify({ repository: 'test/example', id: 'P1', url: 'https://example.invalid/p/1' }));
  writeFileSync(join(checkout, 'api'), `const fs = require('node:fs');
if (fs.existsSync('fail')) { console.error('HTTP 502'); process.exit(1); }
process.stdout.write(fs.readFileSync('response.json'));`);
  const board = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../board.mjs', import.meta.url)), ...args],
    { cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: bin } });
  const respond = data => writeFileSync(join(checkout, 'response.json'), JSON.stringify({ data }));
  const check = (status, nodes, totalCount = nodes.length) => {
    respond({ repository: { issue: { id: 'I1', number: 1, title: 'Fixture', state: 'OPEN', assignees: { nodes: [] },
      projectItems: { nodes: [{ id: 'PI1', project: { id: 'P1' }, status: { name: status } }] },
      blockedBy: { totalCount, nodes } } } });
    return board('check', '1');
  };
  const expect = (result, code, pattern) => {
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, pattern);
  };
  const predecessor = (state, stateReason) => ({ number: 9, state, stateReason, repository: { nameWithOwner: 'test/other' } });

  expect(check('Ready', [predecessor('CLOSED', 'COMPLETED')]), 0, /STARTABLE/);
  expect(check('Ready', [predecessor('OPEN', null)]), 1, /BLOCKED\n- blocked by test\/other#9 \(open\)/);
  expect(check('Ready', [predecessor('CLOSED', 'NOT_PLANNED')]), 1, /closed as not planned; record a decision/);
  expect(check('Backlog', []), 1, /BLOCKED\n- status is Backlog/);
  expect(check('Ready', [predecessor('CLOSED', 'COMPLETED')], 2), 2, /UNKNOWN\n- only 1 of 2 predecessors are readable/);

  const item = (status, priority) => ({ nodes: [{ project: { id: 'P1' }, status: { name: status }, priority }] });
  respond({ search: { issueCount: 3, nodes: [
    { number: 7, title: 'Unprioritized', issueFieldValues: { nodes: [] }, projectItems: item('Ready', null) },
    { number: 8, title: 'Linked field', issueFieldValues: { nodes: [{ name: 'High', field: { name: 'Priority' } }] },
      projectItems: item('Ready', null) },
    { number: 5, title: 'Taken', issueFieldValues: { nodes: [] }, projectItems: item('In progress', { name: 'Urgent' }) },
  ] } });
  expect(board('next'), 0, /^#8 \[High\] Linked field\n#7 \[no priority\] Unprioritized\n/);

  writeFileSync(join(checkout, 'fail'), '');
  expect(check('Ready', []), 2, /UNKNOWN\n- HTTP 502/);
});
