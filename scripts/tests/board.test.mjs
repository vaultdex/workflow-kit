import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function fixture(t) {
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
const query = process.argv.find(arg => arg.startsWith('query=')).slice(6);
if (fs.existsSync('fail') || (fs.existsSync('fail-viewer') && query.includes('viewer'))) process.exit(1);
let data;
if (query.startsWith('mutation')) {
  fs.appendFileSync('mutations', query + '\\n');
  data = {};
} else if (query.includes('viewer')) data = { viewer: { login: 'worker' } };
else if (query.includes('fields(first:100)')) data = { node: { fields: { nodes: [{
  id: 'F1', name: 'Status', options: ['Ready', 'In progress'].map(name => ({ id: name, name }))
}] } } };
else data = { repository: { issue: JSON.parse(fs.readFileSync('issue.json')) } };
process.stdout.write(JSON.stringify({ data }));`);
  return {
    checkout,
    run: (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../board.mjs', import.meta.url)), ...args],
      { cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: bin } }),
    writeIssue: issue => writeFileSync(join(checkout, 'issue.json'), JSON.stringify(issue)),
  };
}

const issue = (status = 'Ready', nodes = [], totalCount = nodes.length) => ({
  id: 'I1', number: 1, title: 'Fixture', state: 'OPEN', assignees: { nodes: [] },
  projectItems: { nodes: [{ id: 'PI1', project: { id: 'P1' }, status: { name: status } }] },
  blockedBy: { totalCount, nodes },
});
const predecessor = (state, stateReason) => ({ number: 9, state, stateReason, repository: { nameWithOwner: 'test/other' } });

test('board check exits 0 only for startable issues: 1 blocked, 2 unknown', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const check = (...args) => { writeIssue(issue(...args)); return run('check', '1').status; };

  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')]), 0);
  assert.equal(check('Ready', [predecessor('OPEN', null)]), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'NOT_PLANNED')]), 1);
  assert.equal(check('Backlog', []), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')], 2), 2, 'Unreadable predecessors are unknown');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(check('Ready', []), 2, 'A failed read is never "no blockers"');
});

test('In progress requires a startable issue assigned to the authenticated user before any mutation', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  const assigned = changes => ({ ...issue(), assignees: { nodes: [{ login: 'worker' }] }, ...changes });
  const cases = [
    issue(),
    { ...issue(), assignees: { nodes: [{ login: 'someone-else' }] } },
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('CLOSED', 'NOT_PLANNED')] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [] } }),
    assigned({ projectItems: { nodes: [] } }),
    assigned({ projectItems: issue('Backlog').projectItems }),
    assigned({ state: 'CLOSED' }),
  ];
  for (const candidate of cases) {
    writeIssue(candidate);
    const result = run('status', '1', 'in progress');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected starts must not mutate or add a Project item');
  }
  writeIssue(assigned());
  for (const failure of ['fail', 'fail-viewer']) {
    writeFileSync(join(checkout, failure), '');
    assert.notEqual(run('status', '1', 'In progress').status, 0);
    assert.equal(existsSync(mutations), false, 'API failure must not mutate status');
    rmSync(join(checkout, failure));
  }
  for (const status of ['Ready', 'In progress', 'Automated review', 'Human review']) {
    writeIssue(assigned({ projectItems: issue(status).projectItems }));
    const result = run('status', '1', 'In progress');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 4);
  writeIssue(issue());
  assert.equal(run('status', '1', 'Ready').status, 0, 'Returning blocked work to Ready does not require assignment');
});
