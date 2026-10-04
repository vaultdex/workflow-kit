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
if (process.argv.some(arg => arg.includes('/reactions'))) {
  process.stdout.write(fs.existsSync('reactions.json') ? fs.readFileSync('reactions.json', 'utf8') : '[]');
  process.exit(0);
}
const query = process.argv.find(arg => arg.startsWith('query=')).slice(6);
if (fs.existsSync('fail') || (fs.existsSync('fail-viewer') && query.includes('viewer'))) process.exit(1);
let data;
if (query.startsWith('mutation')) {
  fs.appendFileSync('mutations', query + '\\n');
  fs.writeFileSync('stored', process.argv.find(arg => arg.startsWith('option=')).slice(7));
  data = {};
} else if (query.includes('viewer')) data = { viewer: { login: 'worker' } };
else if (query.includes('value:fieldValueByName')) data = { repository: { issue: { issueFieldValues: { nodes: [] },
  projectItems: { nodes: [{ project: { id: 'P1' }, value: { name: fs.readFileSync(fs.existsSync('lost') ? 'lost' : 'stored', 'utf8') } }] } } } };
else if (query.includes('pullRequest(number')) data = { repository: { pullRequest: JSON.parse(fs.readFileSync('pr.json')) } };
else if (query.includes('fields(first:100)')) data = { node: { fields: { nodes: [{
  id: 'F1', name: 'Status', options: ['Ready', 'In progress'].map(name => ({ id: name, name }))
}, { id: 'F2', name: 'Priority', options: ['High', 'Low'].map(name => ({ id: name, name })) },
{ id: 'F3', name: 'Size', options: ['XS', 'S'].map(name => ({ id: name, name })) }] } } };
else if (query.includes('search(')) {
  // Like GitHub: is:blocked means an open native predecessor; 'truncate' simulates the 1,000-result cap.
  const blocked = / is:blocked$/.test(process.argv.find(arg => arg.startsWith('q=')));
  const nodes = JSON.parse(fs.readFileSync('search.json'))
    .filter(issue => issue.blockedBy.nodes.some(predecessor => predecessor?.state === 'OPEN') === blocked);
  data = { search: { issueCount: nodes.length + Number(fs.existsSync('truncate')), pageInfo: { hasNextPage: false }, nodes } };
}
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
  assert.equal(check('Ready', [predecessor('CLOSED', null)]), 2, 'A closure without a reason is unknown');
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
    const result = run('status', '1', 'In progress');
    assert.notEqual(result.status, 0);
    if (failure === 'fail-viewer') assert.match(result.stdout, /STARTABLE/);
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

test('next lists blocked and unreadable Ready issues apart from startable ones', t => {
  const { checkout, run } = fixture(t);
  const ready = (number, nodes, totalCount) => ({ ...issue('Ready', nodes, totalCount), number, issueFieldValues: { nodes: [] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([
    ready(1, [predecessor('CLOSED', 'COMPLETED')]),
    ready(2, [predecessor('OPEN', null)]),
    ready(3, [predecessor('CLOSED', 'NOT_PLANNED')]),
    ready(4, [], 1),
    { ...ready(5, []), projectItems: issue('Backlog').projectItems },
  ]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, held] = result.stdout.split('\n\n');
  assert.deepEqual(startable.match(/^#\d+/gm), ['#1']);
  assert.deepEqual(held.match(/^#\d+/gm), ['#2', '#3', '#4'], 'Every Ready issue appears; Backlog does not');
  assert.equal(held.match(/^ {2}- /gm).length, 3, 'Each held issue names its reason');
  writeFileSync(join(checkout, 'truncate'), '');
  assert.notEqual(run('next').status, 0, 'A capped search is never reported as the complete Ready set');
});

test('field sets any single-select value and fails when the read-back differs', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const result = run('field', '1', 'Size', 'xs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'XS');
  writeFileSync(join(checkout, 'lost'), 'S');
  assert.notEqual(run('field', '1', 'Size', 'XS').status, 0, 'A write the read-back does not show is a failure');
});

test('reviews waits only for traces on the current head and never reads failures as done', t => {
  const { checkout, run } = fixture(t);
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const bot = login => ({ __typename: 'Bot', login });
  const check = (status, extra = {}) => ({ __typename: 'CheckRun', name: 'CI', status, conclusion: status === 'COMPLETED' ? 'SUCCESS' : null, ...extra });
  const pr = ({ pushed = 1, contexts = [check('COMPLETED')], total = contexts.length, comments = [], reviews = [] } = {}) => ({
    number: 7, state: 'OPEN', headRefOid: 'abcdef1234',
    commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: minutesAgo(pushed + 5),
      checkSuites: { nodes: [{ createdAt: minutesAgo(pushed) }] }, statusCheckRollup: { contexts: { totalCount: total, nodes: contexts } } } }] },
    reviews: { nodes: reviews }, comments: { nodes: comments }, reviewThreads: { totalCount: 0, nodes: [] },
  });
  const codex = (row, minutes) => ({ author: bot('chatgpt-codex-connector'), url: 'u', createdAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes),
    body: `| Review | Status | Commit |\n| Code Review | ${row} <relative-time datetime="${minutesAgo(minutes)}"></relative-time> | \`abcdef1\` |` });
  const reaction = (content, minutes) => ({ content, created_at: minutesAgo(minutes), user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' } });
  const reviews = (data, reactions = [], ...options) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
    writeFileSync(join(checkout, 'reactions.json'), JSON.stringify(reactions));
    return run('reviews', '7', ...options).status;
  };

  assert.equal(reviews(pr()), 0, 'Green CI without other traces is done');
  assert.equal(reviews(pr({ contexts: [check('IN_PROGRESS')] })), 3);
  assert.equal(reviews(pr({ pushed: 60, contexts: [check('IN_PROGRESS')] })), 3, 'Running CI never stalls');
  assert.equal(reviews(pr({ contexts: [] })), 3, 'A fresh push without checks yet waits');
  assert.equal(reviews(pr({ pushed: 60, contexts: [] })), 0, 'Checks that never start stall');
  assert.equal(reviews(pr({ comments: [codex('Running', 1)] })), 3, 'A running summary for the head waits');
  assert.equal(reviews(pr({ comments: [codex('Completed', 0)] })), 0);
  assert.equal(reviews(pr({ comments: [codex('Running', 60)] })), 0, 'A review running past the usual duration stalls');
  assert.equal(reviews(pr(), [reaction('eyes', 0)]), 3, 'An announced review waits');
  assert.equal(reviews(pr(), [reaction('eyes', 0.5), reaction('+1', 0)]), 0, 'A later reaction by the same bot is its result');
  assert.equal(reviews(pr({ pushed: 1 }), [reaction('eyes', 30)], '--stall', '120'), 0, 'Traces from before the push do not count');
  assert.equal(reviews(pr({ total: 2 })), 2, 'Unreadable checks are never done');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr()));
  assert.equal(run('wait', '7').status, 0, 'wait returns once the head is done');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('reviews', '7').status, 2);
  assert.equal(run('wait', '7').status, 2, 'wait reports a read failure instead of waiting silently');
});
