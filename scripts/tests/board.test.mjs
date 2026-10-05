import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const handoffComment = changes => ({ id: 900, user: { login: 'worker', type: 'User' }, body: '## Übergabe\n\nHead: abcdef1\n\n- Retro: keine Befunde',
  html_url: 'h', created_at: '2999-01-01T00:00:00Z', updated_at: '2999-01-01T00:00:00Z', ...changes });

/** Isolated checkout with paginated GitHub responses and a record of every mutation. */
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
  // By default the driver has posted the handoff comment long after any push; tests about it replace this file.
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([handoffComment()]));
  writeFileSync(join(checkout, 'api'), `const fs = require('node:fs');
const path = process.argv[2] ?? '';
if (!path.startsWith('graphql')) {
  if (fs.existsSync('fail') || fs.existsSync('fail-rest')) process.exit(1);
  // REST lists (comments, reviews, reactions) come in pages of 100, like GitHub.
  const parts = path.split('?')[0].split('/');
  const backlink = 'backlink-' + parts[4] + '.json';
  if (parts[3] === 'issues' && parts.length === 5 && process.argv.includes('PATCH')) {
    // A body write; body-overwritten is what another session writes right after it.
    const issue = JSON.parse(fs.readFileSync(backlink));
    // Like gh: body=@- is stdin, body=@<path> a file.
    const source = process.argv.find(arg => arg.startsWith('body=@')).slice(6);
    issue.body = fs.readFileSync(fs.existsSync('body-overwritten') ? 'body-overwritten' : source === '-' ? 0 : source, 'utf8');
    fs.writeFileSync(backlink, JSON.stringify(issue));
    fs.appendFileSync('patches', 'x\\n');
    process.stdout.write(JSON.stringify(issue));
    process.exit(0);
  }
  if (parts[3] === 'issues' && parts.length === 5) {
    process.stdout.write(fs.readFileSync(backlink));
    process.exit(0);
  }
  const comments = 'backlink-comments-' + parts[4] + '.json';
  if (parts[3] === 'issues' && parts[5] === 'comments' && fs.existsSync(comments)) {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
    const items = JSON.parse(fs.readFileSync(comments));
    process.stdout.write(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
    process.exit(0);
  }
  const file = parts.at(-3) + '-' + parts.at(-1) + '.json';
  const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
  const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
  process.stdout.write(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
  process.exit(0);
}
const query = process.argv.find(arg => arg.startsWith('query=')).slice(6);
if (fs.existsSync('fail') || (fs.existsSync('fail-viewer') && query.startsWith('query{viewer'))) process.exit(1);
let data;
if (query.startsWith('mutation')) {
  fs.appendFileSync('mutations', query + '\\n');
  const option = process.argv.find(arg => arg.startsWith('option='));
  if (option) fs.writeFileSync('stored', option.slice(7));
  if (query.includes('addCloseIssueReferences') && !fs.existsSync('link-noop')) {
    // link-delay: the connection shows only after that many reads, like GitHub's delayed consistency.
    const delay = fs.existsSync('link-delay') ? Number(fs.readFileSync('link-delay', 'utf8')) : 0;
    const before = JSON.parse(fs.readFileSync('pr.json'));
    fs.writeFileSync('pr.json', JSON.stringify(delay ? { ...before, linkPending: delay } : { ...before, linkPages: [['I1']] }));
  }
  if (query.includes('markPullRequestReadyForReview') && !fs.existsSync('ready-noop')) {
    fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), isDraft: false }));
  }
  if (query.includes('addProjectV2ItemById')) {
    // add-exists: the Project's own automation was faster, so GitHub refuses like this and the item is readable now
    // (unless add-exists-unreadable); add-fails: any other refusal.
    if (fs.existsSync('add-exists')) {
      if (!fs.existsSync('add-exists-unreadable')) fs.copyFileSync('issue-with-item.json', 'issue.json');
      process.stderr.write('gh: Content already exists in this project\\n');
      process.exit(1);
    }
    if (fs.existsSync('add-fails')) {
      process.stderr.write('gh: Resource not accessible by integration\\n');
      process.exit(1);
    }
    data = { addProjectV2ItemById: { item: { id: 'PI1' } } };
  } else data = {};
} else if (query.startsWith('query{viewer')) data = { viewer: { login: 'worker' } };
else if (query.includes('value:fieldValueByName')) data = { repository: { issue: { issueFieldValues: { nodes: [] },
  projectItems: { nodes: [{ project: { id: 'P1' }, value: { name: fs.readFileSync(fs.existsSync('lost') ? 'lost' : 'stored', 'utf8') } }] } } } };
else if (query.includes('reviewThreads(first:100,after')) {
  const pages = JSON.parse(fs.readFileSync('pr.json')).threadPages ?? [[]];
  const cursor = process.argv.find(arg => arg.startsWith('after='));
  const index = cursor ? Number(cursor.slice(6)) : 0;
  data = { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
    nodes: pages[index].map(isResolved => ({ isResolved, comments: { nodes: [{ url: 'thread-' + index }] } })) } } } };
}
else if (query.includes('closingIssuesReferences')) {
  if (fs.existsSync('fail-links')) process.exit(1);
  let pr = JSON.parse(fs.readFileSync('pr.json'));
  if (pr.linkPending !== undefined) {
    pr = pr.linkPending > 0 ? { ...pr, linkPending: pr.linkPending - 1 } : { ...pr, linkPending: undefined, linkPages: [['I1']] };
    fs.writeFileSync('pr.json', JSON.stringify(pr));
  }
  const pages = pr.linkPages ?? [[]];
  const cursor = process.argv.find(arg => arg.startsWith('after='));
  const index = cursor ? Number(cursor.slice(6)) : 0;
  if (fs.existsSync('changed-issue.json')) fs.copyFileSync('changed-issue.json', 'issue.json');
  if (pr.prAfterLinks) fs.writeFileSync('pr.json', JSON.stringify(pr.prAfterLinks));
  data = { repository: { pullRequest: { state: pr.state, isDraft: pr.isDraft,
    headRefOid: pr.changedHead ?? pr.headRefOid,
    closingIssuesReferences: { totalCount: pr.linkTotal ?? pages.flat().length,
      pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
      nodes: pages[index].map(id => id === null ? null : { id }) } } } };
}
else if (query.includes('pullRequest(number')) {
  if (fs.existsSync('pr-reads.json')) {
    // Each read takes the next prepared overlay and the last one stays: metadata that catches up after a push.
    const reads = JSON.parse(fs.readFileSync('pr-reads.json'));
    const overlay = reads.length > 1 ? reads.shift() : reads[0];
    fs.writeFileSync('pr-reads.json', JSON.stringify(reads));
    fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), ...overlay }));
  }
  data = { repository: { pullRequest: JSON.parse(fs.readFileSync('pr.json')) } };
}
else if (query.includes('fields(first:100)')) data = { node: { fields: { nodes: [{
  id: 'F1', name: 'Status', options: ['Ready', 'In progress', 'Automated review', 'Human review'].map(name => ({ id: name, name }))
}, { id: 'F2', name: 'Priority', options: ['High', 'Low'].map(name => ({ id: name, name })) },
{ id: 'F3', name: 'Size', options: ['XS', 'S'].map(name => ({ id: name, name })) }] } } };
else if (query.includes('search(')) {
  // Like GitHub: is:blocked means an open native predecessor; 'truncate' simulates the 1,000-result cap.
  const blocked = / is:blocked$/.test(process.argv.find(arg => arg.startsWith('q=')));
  const nodes = JSON.parse(fs.readFileSync('search.json'))
    .filter(issue => issue.blockedBy.nodes.some(predecessor => predecessor?.state === 'OPEN') === blocked);
  data = { search: { issueCount: nodes.length + Number(fs.existsSync('truncate')), pageInfo: { hasNextPage: false }, nodes } };
}
else {
  const issue = JSON.parse(fs.readFileSync('issue.json'));
  if (fs.existsSync('handoff-fixture') && fs.existsSync('stored')) {
    issue.projectItems.nodes[0].status.name = fs.readFileSync(fs.existsSync('lost') ? 'lost' : 'stored', 'utf8');
  }
  data = { repository: { issue } };
}
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

const handoffPr = changes => ({
  number: 7, state: 'OPEN', isDraft: false, baseRefName: 'release/0.1.1', headRefOid: 'abcdef1234',
  mergeStateStatus: 'CLEAN', reviewDecision: null,
  latestOpinionatedReviews: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: new Date().toISOString(),
    checkSuites: { totalCount: 1, nodes: [{ createdAt: new Date().toISOString(), status: 'COMPLETED', conclusion: 'SUCCESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 1 } }] },
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [
      { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] } } } }] },
  reviewRequests: { totalCount: 0, nodes: [] }, requestEvents: { totalCount: 0, nodes: [] },
  linkPages: [['I1']], ...changes,
});

test('handoff diagnoses draft and unreadable draft state before waiting for CI', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  const commit = handoffPr().commits.nodes[0].commit;
  for (const checks of [[], [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }]]) {
    for (const isDraft of [true, null, undefined, false]) {
      const pr = handoffPr({ isDraft, commits: { nodes: [{ commit: {
        ...commit, statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks } },
      } }] } });
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
      const result = run('handoff', '1', '7');
      const expected = isDraft === true ? 1 : isDraft === false ? 3 : 2;
      assert.equal(result.status, expected, result.stdout + result.stderr);
      if (isDraft === true) {
        assert.match(result.stdout, /^FAILED$/m);
        assert.match(result.stdout, /^blocker:/m);
        assert.doesNotMatch(result.stdout, /WAITING/);
      } else if (isDraft === false) {
        assert.match(result.stdout, /WAITING/);
      } else {
        assert.match(result.stdout, /^ERROR$/m);
      }
      assert.equal(existsSync(join(checkout, 'mutations')), false, 'Draft or incomplete CI never writes status');
    }
  }
});

test('handoff rejects drafts before unavailable review details', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'fail-rest'), '');
  const commit = handoffPr().commits.nodes[0].commit;
  for (const checks of [[], [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }]]) {
    for (const isDraft of [true, null, undefined, false]) {
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ isDraft, commits: { nodes: [{ commit: {
        ...commit, statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks } },
      } }] } })));
      const result = run('handoff', '1', '7');
      assert.equal(result.status, isDraft === true ? 1 : 2, result.stdout + result.stderr);
      assert.match(result.stdout, isDraft === true ? /^FAILED$/m : /^ERROR$/m);
      assert.doesNotMatch(result.stdout, /^WAITING$/m);
      if (isDraft === true) assert.match(result.stdout, /^blocker:/m);
      assert.equal(existsSync(join(checkout, 'mutations')), false, 'No rejected handoff writes status');
    }
  }
});

test('handoff blocks unlinked, unsafe and unreadable delivery before writing Human review', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  const pending = { ...handoffPr().commits.nodes[0].commit,
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }] } } };
  const failed = { ...pending, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
    { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' },
  ] } } };
  const cases = [
    [handoffPr({ linkPages: [[]] }), ready, 1], // Text/branch refs and partial delivery do not provide the required native link.
    [handoffPr({ linkPages: [['unrelated']] }), ready, 1],
    [handoffPr({ linkPages: [['I1']], linkTotal: 2 }), ready, 2],
    [handoffPr({ linkPages: [[null]], linkTotal: 1 }), ready, 2],
    [handoffPr({ linkPages: [['I1', 'I1']] }), ready, 2],
    [handoffPr({ changedHead: 'new-head' }), ready, 2],
    [handoffPr({ isDraft: true }), ready, 1],
    [handoffPr({ isDraft: null }), ready, 2],
    [handoffPr({ state: 'MERGED' }), ready, 1],
    [handoffPr({ state: 'CLOSED' }), ready, 1],
    [handoffPr({ mergeStateStatus: 'DIRTY' }), ready, 1],
    [handoffPr({ mergeStateStatus: 'UNKNOWN' }), ready, 3],
    [handoffPr({ mergeStateStatus: null }), ready, 3],
    [handoffPr({ threadPages: [[false]] }), ready, 1],
    [handoffPr({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }), ready, 1],
    [handoffPr({ commits: { nodes: [{ commit: pending }] } }), ready, 3],
    [handoffPr({ commits: { nodes: [{ commit: failed }] } }), ready, 1],
    [handoffPr(), { ...ready, assignees: { nodes: [] } }, 1],
    [handoffPr(), { ...ready, assignees: { nodes: [{ login: 'someone-else' }] } }, 1],
    [handoffPr(), { ...ready, state: 'CLOSED' }, 1],
    [handoffPr(), { ...ready, projectItems: issue('In progress').projectItems }, 1],
    [handoffPr(), { ...ready, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } }, 1],
  ];
  for (const [pr, task, status] of cases) {
    writeIssue(task);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
    const result = run('handoff', '1', '7');
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected handoff never mutates status');
  }
  writeIssue(ready);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  for (const failure of ['fail', 'fail-viewer', 'fail-links']) {
    writeFileSync(join(checkout, failure), '');
    assert.equal(run('handoff', '1', '7').status, 2, 'An API read failure is unknown, never a handoff');
    assert.equal(existsSync(mutations), false);
    rmSync(join(checkout, failure));
  }
  assert.equal(run('handoff', '1', '--oops').status, 2, 'Option-like PR arguments are rejected');
  for (const baseRefName of ['main', 'release/0.1.1']) {
    writeFileSync(join(checkout, 'handoff-fixture'), '');
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ baseRefName,
      linkPages: [Array.from({ length: 100 }, (_, index) => 'other-' + index), ['I1']] })));
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /HANDOFF #1 PR #7 head abcdef1234/);
    assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');
  }
});

test('handoff rechecks issue prerequisites after review and link reads, before mutation', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const changes = [
    { ...ready, state: 'CLOSED' },
    { ...ready, assignees: { nodes: [] } },
    { ...ready, assignees: { nodes: [{ login: 'someone-else' }] } },
    { ...ready, projectItems: issue('In progress').projectItems },
    { ...ready, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } },
    { ...ready, blockedBy: { totalCount: 1, nodes: [] } },
  ];
  for (const changed of changes) {
    writeIssue(ready);
    writeFileSync(join(checkout, 'changed-issue.json'), JSON.stringify(changed));
    const result = run('handoff', '1', '7');
    assert.ok([1, 2].includes(result.status), result.stdout + result.stderr);
    assert.equal(existsSync(join(checkout, 'mutations')), false, 'A newer issue state must not be overwritten');
    assert.doesNotMatch(result.stdout, /HANDOFF #1/);
  }
});

test('handoff rechecks PR gates before mutation and rejects changed review proof', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  const commit = handoffPr().commits.nodes[0].commit;
  const changedHead = 'new-head';
  const changes = [
    handoffPr({ headRefOid: changedHead, commits: { nodes: [{ commit: { ...commit, oid: changedHead } }] } }),
    handoffPr({ state: 'CLOSED' }),
    handoffPr({ state: 'MERGED' }),
    handoffPr({ isDraft: true }),
    handoffPr({ mergeStateStatus: 'UNKNOWN' }),
    handoffPr({ mergeStateStatus: 'DIRTY' }),
    handoffPr({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }),
    handoffPr({ threadPages: [[false]] }),
    handoffPr({ linkPages: [[]] }),
    ...['IN_PROGRESS', 'COMPLETED'].map(status => handoffPr({ commits: { nodes: [{ commit: {
      ...commit, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
        { __typename: 'CheckRun', name: 'CI', status, conclusion: 'FAILURE' },
      ] } },
    } }] } })),
  ];
  for (const prAfterLinks of changes) {
    writeIssue(ready);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ prAfterLinks })));
    const result = run('handoff', '1', '7');
    assert.ok([1, 2, 3].includes(result.status), result.stdout + result.stderr);
    assert.equal(existsSync(join(checkout, 'mutations')), false, 'Changed PR proof must never write Human review');
    assert.doesNotMatch(result.stdout, /HANDOFF #1/);
  }
});

test('handoff reports a failed status read-back instead of claiming delivery', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'lost'), 'Ready');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const result = run('handoff', '1', '7');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /HANDOFF #1/);
});

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

test('Automated review requires the declared open PR and every issue backlink before mutating status', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = join(checkout, 'mutations');
  const pr = { number: 7, state: 'OPEN', url: 'https://github.com/test/example/pull/7', body: 'Refs #1. Related: #99.', baseRefName: 'release/0.1.0' };
  const writePR = changes => writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr, ...changes }));
  let commentId = 0;
  const comment = body => ({ id: ++commentId, body, html_url: `https://github.com/test/example/issues/1#issuecomment-${commentId}` });
  const writeBacklink = (number, comments, changes = {}) => {
    writeFileSync(join(checkout, `backlink-${number}.json`), JSON.stringify({ number, state: 'open', comments: comments.length, ...changes }));
    writeFileSync(join(checkout, `backlink-comments-${number}.json`), JSON.stringify(comments));
  };
  const reject = (...args) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected backlink checks must not mutate or add a Project item');
    return result;
  };
  writePR();
  writeBacklink(1, []);
  reject('status', '1', 'Automated review');
  reject('field', '1', 'Status', 'Automated review');
  reject('status', '1', 'Automated review', '--help');
  reject('status', '1', 'Automated review', '0');
  reject('status', '1', 'Automated review', '7', '--help');
  reject('status', '1', 'Automated review', '7');
  for (const body of [
    'PR #7',
    'https://github.com/other/example/pull/7',
    'https://github.com/test/example/pull/70',
    'https://github.com/test/example/pull/7/files',
    'https://github.com/test/example/pull/6',
    'https://github.com.example.com/test/example/pull/7',
  ]) {
    writeBacklink(1, [comment(body)]);
    reject('status', '1', 'Automated review', '7');
  }
  writeBacklink(1, [comment(`[PR #7](${pr.url}).`)]);
  for (const changes of [
    { state: 'CLOSED' }, { state: 'MERGED' }, { number: 8 },
    { body: 'Refs #10' }, { body: 'Refs other/example#1' }, { body: '' },
  ]) {
    writePR(changes);
    reject('status', '1', 'Automated review', '7');
  }
  writePR();
  writeBacklink(1, [comment(pr.url)], { comments: 2 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { comments: 0 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { number: 2 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { pull_request: {} });
  reject('status', '1', 'Automated review', '7');
  const duplicate = comment(pr.url);
  writeBacklink(1, [duplicate, duplicate]);
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)]);
  for (const failure of ['fail', 'fail-rest']) {
    writeFileSync(join(checkout, failure), '');
    reject('status', '1', 'Automated review', '7');
    rmSync(join(checkout, failure));
  }
  writeBacklink(1, Array.from({ length: 100 }, () => comment('Earlier discussion: malformed https://%')).concat(comment(pr.url)));
  writePR({ body: 'Refs #1. Refs test/example#2. Refs test/other#3. Related: #99.' });
  writeBacklink(2, []);
  reject('status', '1', 'Automated review', '7', '2');
  writeBacklink(2, [comment(pr.url)]);
  writeBacklink(3, []);
  reject('status', '1', 'Automated review', '7', '2', 'test/other#3');
  writeBacklink(3, [comment(`${pr.url}/?view=review#discussion`)]);
  for (const args of [
    ['status', '1', 'automated review', '7', '2', 'test/other#3'],
    ['status', '1', 'Automated review', '7', '2'],
    ['field', '1', 'Status', 'Automated review', '7', '2'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /backlink.*#1/);
    assert.match(result.stdout, /backlink.*#2/);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 3);
  assert.equal(JSON.parse(readFileSync(join(checkout, 'backlink-comments-2.json'))).length, 1, 'Repeated verification leaves the existing comment intact');
  writePR({ baseRefName: 'main', body: 'Closes #1' });
  assert.equal(run('status', '1', 'Automated review', '7').status, 0, 'Default-branch delivery works too');
});

test('reviews waits only for traces on the current head and never reads failures as done', t => {
  const { checkout, run } = fixture(t);
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const codexUser = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
  const check = (status, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null) => ({ __typename: 'CheckRun', name: 'CI', status, conclusion });
  const suite = (status = 'COMPLETED', runs = 1, minutes = 1, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null) => ({
    createdAt: minutesAgo(minutes), status, conclusion, app: { slug: 'github-actions' }, checkRuns: { totalCount: runs } });
  const pr = ({ pushed = 1, contexts = [check('COMPLETED')], total = contexts.length, requests = [], requestedAgo, requestEventTotal, threadPages,
    suites = [suite('COMPLETED', 1, pushed)], suiteTotal = suites.length } = {}) => ({
    number: 7, state: 'OPEN', headRefOid: 'abcdef1234', mergeStateStatus: 'CLEAN', reviewDecision: null,
    latestOpinionatedReviews: { totalCount: 0, nodes: [] },
    commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: minutesAgo(pushed + 5),
      checkSuites: { totalCount: suiteTotal, nodes: suites }, statusCheckRollup: { contexts: { totalCount: total, nodes: contexts } } } }] },
    reviewRequests: { totalCount: requests.length, nodes: requests.map(login => ({ requestedReviewer: { login } })) },
    requestEvents: { totalCount: requestEventTotal ?? (requestedAgo === undefined ? 0 : requests.length),
      nodes: requestedAgo === undefined ? [] : requests.map(login => ({ createdAt: minutesAgo(requestedAgo), requestedReviewer: { login } })) },
    threadPages,
  });
  let commentId = 0;
  const codex = (row, minutes) => ({ id: ++commentId, user: codexUser, html_url: 'u', created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes),
    body: `| Review | Status | Commit |\n| Code Review | ${row} <relative-time datetime="${minutesAgo(minutes)}"></relative-time> | \`abcdef1\` |` });
  const reaction = (content, minutes) => ({ content, created_at: minutesAgo(minutes), user: codexUser });
  const look = (data, { comments = [], reactions = [], inline = [], commentReactions = [], reviewList = [] } = {}, ...options) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
    writeFileSync(join(checkout, 'issues-reactions.json'), JSON.stringify(reactions));
    writeFileSync(join(checkout, 'pulls-comments.json'), JSON.stringify(inline));
    writeFileSync(join(checkout, 'comments-reactions.json'), JSON.stringify(commentReactions));
    writeFileSync(join(checkout, 'pulls-reviews.json'), JSON.stringify(reviewList));
    return run('reviews', '7', ...options);
  };
  const reviews = (...args) => look(...args).status;

  assert.equal(reviews(pr()), 0, 'Green CI without other traces is done');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'Red CI ends the wait as FAILED, never DONE');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'SKIPPED')] })), 0);
  assert.equal(reviews(pr({ contexts: [check('IN_PROGRESS')] })), 3);
  assert.equal(reviews(pr({ pushed: 60, contexts: [check('IN_PROGRESS')] })), 3, 'Running CI never stalls');
  assert.equal(reviews(pr({ pushed: 60, contexts: [] })), 3, 'CI that has not started yet never stalls');
  assert.equal(reviews(pr(), { comments: [codex('Running', 1)] }), 3, 'A running summary for the head waits');
  assert.equal(reviews(pr(), { comments: [codex('Completed', 0)] }), 0);
  assert.equal(reviews(pr(), { comments: [codex('Running', 60)] }), 0, 'A review running past the usual duration stalls');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0)] }), 3, 'An announced review waits');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5), reaction('+1', 0)] }), 0, 'A later reaction by the same bot is its result');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 30)] }, '--stall', '120'), 0, 'Traces from before the push do not count');
  assert.equal(reviews(pr({ requests: ['maintainer'] })), 3, 'An outstanding review request waits');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'] })), 0, 'An unanswered request stalls');
  // Older than the Running row, so they fill the first page without answering it.
  const many = Array.from({ length: 100 }, (_, index) => ({ ...codex('Completed', 5), html_url: `old-${index}` }));
  assert.equal(reviews(pr(), { comments: [...many, codex('Running', 1)] }), 3, 'Comments beyond the first page are read');
  assert.equal(reviews(pr({ total: 2 })), 2, 'Unreadable checks are never done');
  const request = { id: 1, user: { login: 'maintainer', type: 'User' }, body: '@codex review', html_url: 'c', created_at: minutesAgo(0.5), updated_at: minutesAgo(0.5) };
  assert.equal(reviews(pr(), { comments: [request], commentReactions: [reaction('eyes', 0)] }), 3, 'A 👀 on the review request comment waits');
  const note = { ...request, body: 'Deploy preview is ready' };
  assert.equal(reviews(pr(), { comments: [note], commentReactions: [reaction('eyes', 0)] }), 0, 'A 👀 on an unrelated comment is no trace');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), suite('QUEUED', 0, 1)] })), 3, 'A workflow that has not reported yet waits');
  assert.equal(reviews(pr({ pushed: 60, suites: [suite('COMPLETED', 1, 60), suite('QUEUED', 0, 60)] })), 0, 'A suite that never runs stalls');
  assert.equal(reviews(pr({ suiteTotal: 101 })), 2, 'Unreadable check suites are never done');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), suite('COMPLETED', 0, 1, 'STARTUP_FAILURE')] })), 1, 'A workflow that fails to start is FAILED');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE'), check('IN_PROGRESS')] })), 1, 'A known failure ends the wait while other checks run');
  // Draft then Ready starts a second run of the same job and cancels the first: only the newest run of a job counts.
  // `run` is the workflow run the job belongs to; by default every job is the only one of its own run.
  const job = (run, status, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null, name = 'Backend', workflow = 'Backend importer', workflowId = `W-${workflow}`) =>
    ({ ...check(status, conclusion), name, checkSuite: { databaseId: run * 10, app: { slug: 'github-actions' }, workflowRun: { databaseId: run, workflow: { id: workflowId, name: workflow } } } });
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED')] })), 1, 'A single cancelled run is a failure');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED')] })), 0, 'A cancelled run followed by a green one is no failure');
  assert.equal(reviews(pr({ contexts: [job(2, 'COMPLETED'), job(1, 'COMPLETED', 'CANCELLED')] })), 0, 'The order of the list does not matter');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED'), job(2, 'COMPLETED', 'CANCELLED')] })), 1, 'A newest cancelled run is a failure');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'IN_PROGRESS')] })), 3, 'A cancelled run followed by a running one waits');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend'), job(2, 'COMPLETED', 'SUCCESS', 'Lint')] })), 1, 'Another job does not replace it');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Frontend')] })), 1, 'The same job name in another workflow does not replace it');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend', 'Build', 'W-1'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Build', 'W-2')] })), 1,
    'Two workflows with the same display name and job name stay two jobs');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend', 'Build', 'W-1'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Build', 'W-1')] })), 0,
    'Runs of one workflow id are one job');
  // Jobs of one workflow run never replace each other, even with the same display name; a later run replaces earlier ones.
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'FAILURE'), job(10, 'COMPLETED', 'SUCCESS')] })), 1,
    'Two jobs with one display name in the same run: a success does not hide the failure');
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'CANCELLED', 'Lint'), job(10, 'COMPLETED', 'SUCCESS', 'Test'),
    job(11, 'COMPLETED', 'SUCCESS', 'Lint'), job(11, 'COMPLETED', 'SUCCESS', 'Test')] })), 0,
    'A complete newer run supersedes the cancelled run of the earlier one');
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'SUCCESS'), job(11, 'COMPLETED', 'FAILURE'), job(11, 'COMPLETED', 'SUCCESS')] })), 1,
    'A failing job of the newest run stays a failure next to a same-named success');
  // A SKIPPED run executed nothing: it neither replaces nor hides an earlier run of the same job.
  const skipped = run => job(run, 'COMPLETED', 'SKIPPED');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2)] })), 1, 'A cancelled run followed by a fully skipped one has no proof');
  assert.equal(reviews(pr({ contexts: [skipped(2), job(1, 'COMPLETED', 'CANCELLED')] })), 1, 'The order of the list does not matter');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'FAILURE'), skipped(2)] })), 1, 'A failure is not hidden by a later skipped run');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED'), skipped(2)] })), 0, 'A real success of the same head stays proof next to a skipped run');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'COMPLETED')] })), 0, 'A successful retry run is the proof');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'COMPLETED', 'FAILURE')] })), 1, 'A failed retry stays failed');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'IN_PROGRESS')] })), 3, 'A running retry waits');
  assert.equal(reviews(pr({ contexts: [job(1, 'IN_PROGRESS'), skipped(2)] })), 3, 'A skipped run does not hide a running one');
  assert.equal(reviews(pr({ contexts: [skipped(1), skipped(2)] })), 0, 'A job that was only ever skipped is optional');
  assert.equal(reviews(pr({ contexts: [skipped(1), job(2, 'COMPLETED', 'SUCCESS', 'Lint')] })), 0, 'A skipped optional job next to a real success passes');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED', 'SKIPPED', 'Backend', 'Frontend')] })), 1,
    'A skipped run of another workflow does not stand in for it');
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'A later read failure keeps the known CI verdict');
  rmSync(join(checkout, 'fail-rest'));
  const headReview = { user: codexUser, commit_id: 'abcdef1234', state: 'COMMENTED', html_url: 'r', submitted_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { comments: [codex('Running', 1)], reviewList: [headReview] }), 0, 'A head review ends a Running summary');
  assert.equal(reviews(pr(), { comments: [{ ...codex('Running', 3), updated_at: minutesAgo(0) }] }), 3, 'A later edit of the summary itself is no result');
  // Codex reviews code and security side by side: one summary, one row per kind, and a separate security result comment.
  const summary = (rows, commit = 'abcdef1') => ({ id: ++commentId, user: codexUser, html_url: 'u', created_at: minutesAgo(10), updated_at: minutesAgo(1),
    body: `| Review | Status | Commit |\n${rows.map(([kind, status, minutes]) =>
      `| ${kind} | ${status} <relative-time datetime="${minutesAgo(minutes)}"></relative-time> | \`${commit}\` |`).join('\n')}` });
  const securityResult = minutes => ({ id: ++commentId, user: codexUser, html_url: 's', created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes),
    body: '### 🛡️ Codex Security Review\n\nSecurity review completed. No security issues were found.' });
  const both = [['📝 **Code Review**', '⏳ **Running**', 3], ['🔒 **Security Review**', '⏳ **Running**', 3]];
  assert.equal(reviews(pr(), { comments: [summary(both)] }), 3, 'Both kinds running wait');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(0)] }), 3, 'A security result leaves the running code review waiting');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(0)], reviewList: [headReview] }), 0, 'Both results end both rows');
  assert.equal(reviews(pr(), { comments: [summary([both[1]]), securityResult(0)] }), 0, 'A security result ends a running security row');
  assert.equal(reviews(pr(), { comments: [summary(both)], reviewList: [headReview] }), 3, 'A code review leaves the running security review waiting');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(5)] }), 3, 'A security result from before the row started answers nothing');
  assert.equal(reviews(pr(), { comments: [summary(both)], reactions: [reaction('+1', 0)] }), 0, 'A final reaction ends every kind');
  assert.equal(reviews(pr(), { comments: [summary(both, 'previous')] }), 0, 'Rows for another commit are not traces on this head');
  const appSuite = { ...suite('QUEUED', 0, 1), app: { slug: 'sonarqubecloud' } };
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), appSuite] })), 0, 'Idle suites of other apps are no trace');
  const blocked = look({ ...pr(), mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'coderabbitai' } }] } });
  assert.equal(blocked.status, 0, 'Blockers are for the handoff; the wait itself is over');
  assert.match(blocked.stdout, /^blocker: changes requested by coderabbitai$/m, 'A standing change request is named as a blocker');
  assert.match(look({ ...pr(), mergeStateStatus: 'DIRTY' }).stdout, /^blocker: merge conflicts$/m);
  assert.equal(reviews({ ...pr(), latestOpinionatedReviews: { totalCount: 101, nodes: [] } }), 2, 'Cut-off review decisions are never read as no blocker');
  const config = join(checkout, '.github/workflow-project.json'), plain = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), awaitApps: ['sonarqubecloud'] }));
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), appSuite] })), 3, 'A listed analyzer waits until it reports');
  writeFileSync(config, plain);
  const oldHeadReview = { user: codexUser, commit_id: 'previous', state: 'COMMENTED', html_url: 'r', submitted_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5)], reviewList: [oldHeadReview] }), 3, 'A review of the previous head answers nothing');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'], requestedAgo: 1 })), 3, 'A late review request starts its own clock');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'], requestEventTotal: 101 })), 2, 'A request whose time is cut off fails closed');
  assert.equal(reviews({ ...pr(), state: 'CLOSED' }), 1, 'A PR closed without merge is FAILED');
  const inlineReply = { user: codexUser, html_url: 'i', created_at: minutesAgo(0), updated_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5)], inline: [inlineReply] }), 0, 'An inline review comment is the result');
  assert.match(look(pr(), { inline: [inlineReply] }).stdout, /^inline chatgpt-codex-connector i$/m, 'Inline findings are listed');
  const bigReview = look(pr({ threadPages: [Array(100).fill(true), [false]] }));
  assert.equal(bigReview.status, 0, 'More than 100 threads still get a verdict');
  assert.match(bigReview.stdout, /^unresolved threads: 1$/m, 'Threads on every page are counted');
  assert.match(bigReview.stdout, /^thread thread-1$/m, 'Every unresolved thread is linked, whatever head it is on');

  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr()));
  for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments']) writeFileSync(join(checkout, `${file}.json`), '[]');
  assert.equal(run('wait', '7').status, 0, 'wait returns once the head is done');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr({ contexts: [check('COMPLETED', 'FAILURE')] })));
  assert.equal(run('wait', '7').status, 1, 'wait ends as FAILED on red CI');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr({ contexts: [check('IN_PROGRESS')] })));
  const waitBriefly = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../board.mjs', import.meta.url)), 'wait', '7', ...args],
    { cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: join(checkout, '..', 'bin') }, timeout: 3000 }).stdout;
  assert.match(waitBriefly(), /^WAITING\nwaiting: check CI/, 'A background wait shows what it waits for');
  assert.match(waitBriefly('--merged'), /^WAITING\nwaiting: human merge/);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr(), state: 'MERGED' }));
  assert.equal(run('wait', '7', '--merged').status, 0, 'wait --merged returns once the PR is merged');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr(), state: 'CLOSED' }));
  assert.equal(run('wait', '7', '--merged').status, 1, 'A PR closed without merge is FAILED, never delivered');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('reviews', '7').status, 2);
  assert.equal(run('wait', '7').status, 2, 'wait reports a read failure instead of waiting silently');
});

test('field accepts Unicode and punctuation in names and options', t => {
  const { run, writeIssue } = fixture(t);
  writeIssue(issue());
  assert.equal(run('field', '1', 'Größe', 'P0: urgent').status, 1, 'Validation lets the name through to the field lookup');
  assert.equal(run('field', '1', 'Size', '-x').status, 2, 'An option-like value is still rejected');
});

test('link connects the issue natively to the PR, repeats safely and trusts only the read-back', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = (changes = {}) => {
    for (const file of ['mutations', 'link-noop', 'fail']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]], ...changes })));
  };

  prepare();
  let result = run('link', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(mutations(), 1, 'A Draft PR is connected with one write');
  assert.match(readFileSync(join(checkout, 'mutations'), 'utf8'), /addCloseIssueReferences\(input:\{issueId:\$issue,pullRequestIds:\[\$pr\]\}\)/);

  result = run('link', '1', '7');
  assert.equal(result.status, 0, 'A second run finds the link already there');
  assert.equal(mutations(), 1, 'No second write');

  prepare();
  writeFileSync(join(checkout, 'link-delay'), '2');
  result = run('link', '1', '7');
  assert.equal(result.status, 0, 'A connection GitHub shows only after a delay is read back repeatedly: ' + result.stdout + result.stderr);
  assert.equal(mutations(), 1, 'The write is not repeated while waiting');
  rmSync(join(checkout, 'link-delay'));

  prepare({ state: 'CLOSED' });
  assert.equal(run('link', '1', '7').status, 2, 'A closed PR is never linked');
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'link-noop'), '');
  result = run('link', '1', '7');
  assert.equal(result.status, 2, 'A write whose read-back lacks the issue is no success');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(mutations(), 1, 'The write is not repeated blindly');

  prepare();
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('link', '1', '7').status, 2, 'An API error is ERROR');
  assert.equal(mutations(), 0);

  assert.equal(run('link', '1', 'seven').status, 2, 'Only a PR number is accepted');
});

test('ready marks a Draft PR ready only for the expected pushed commit and never trusts stale metadata', t => {
  const { checkout, run } = fixture(t);
  const NEW = 'c0ffee'.repeat(6) + 'abcd', OLD = 'decade'.repeat(6) + 'abcd', OTHER = 'facade'.repeat(6) + 'abcd';
  const quick = ['--attempts', '3', '--interval', '0.01'];
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = (changes = {}, reads) => {
    for (const file of ['mutations', 'pr-reads.json', 'ready-noop', 'fail']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ id: 'PR7', number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false,
      headRefOid: NEW, headRepository: { nameWithOwner: 'test/example' }, ...changes }));
    if (reads) writeFileSync(join(checkout, 'pr-reads.json'), JSON.stringify(reads));
  };
  // The verdict and the write count carry the behavior; the diagnostic wording is free to change.
  const refused = (changes, reads, label) => {
    prepare(changes, reads);
    const result = run('ready', '7', NEW, ...quick);
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^FAILED$/m, label);
    assert.equal(mutations(), 0, `${label}: nothing is written`);
  };

  prepare();
  let result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^READY /m);
  assert.equal(mutations(), 1, 'Exactly one Ready mutation');

  prepare({ headRepository: { nameWithOwner: 'Test/Example' } });
  assert.equal(run('ready', '7', NEW, ...quick).status, 0, 'Repository names compare case-insensitively');
  prepare({ headRefOid: OLD }, [{ headRefOid: OLD }]);
  for (const options of [['--interval', 'Infinity'], ['--interval', '1e308'], ['--interval', '-1'], ['--attempts', '0'], ['--attempts', '1.5'],
    ['--attempts', '101'], ['--attempts', '100', '--interval', '100'], ['--attempts', '100', '--interval', '18'],
    ['--attempts', '61', '--interval', '15']]) {
    assert.equal(run('ready', '7', NEW, ...options).status, 2, `${options.join(' ')} could wait without end and is rejected up front`);
  }
  assert.equal(mutations(), 0);

  prepare();
  assert.equal(run('ready', '7', NEW, '--attempts', '60', '--interval', '15').status, 0, 'Both waits together exactly at the half-hour cap are allowed');

  prepare({ headRefOid: OLD }, [{ headRefOid: OLD }, { headRefOid: NEW }]);
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, 'Metadata that catches up after a push is waited for: ' + result.stdout + result.stderr);
  assert.equal(mutations(), 1);

  refused({ headRefOid: OLD }, [{ headRefOid: OLD }], 'A head that stays old');
  refused({ isCrossRepository: true }, undefined, 'A fork branch');
  refused({ headRepository: { nameWithOwner: 'test/other' } }, undefined, 'Another repository');
  refused({ state: 'CLOSED' }, undefined, 'A closed PR');
  refused({ isDraft: false, headRefOid: OTHER }, undefined, 'Ready with another head');
  refused({}, [{ headRefOid: NEW }, { headRefOid: OTHER }], 'A head that changes before the mutation');

  prepare({ isDraft: false });
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, 'Already ready for the expected head is a success without a write');
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'fail'), '');
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 2, 'An API error is ERROR, never a guess');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'ready-noop'), '');
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 2, 'A write without a matching read-back is no success');
  assert.equal(mutations(), 1, 'The mutation is not repeated blindly');

  assert.equal(run('ready', '7', 'not-a-sha').status, 2, 'Only a full commit SHA is accepted');
});

test('a field write succeeds when the Project already added the issue itself, and fails on every other refusal', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const noItem = { ...issue(), projectItems: { nodes: [] } };
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean) : [];
  const count = (name, list = mutations()) => list.filter(line => line.includes(name)).length;
  const prepare = (...flags) => {
    for (const file of ['mutations', 'stored', 'add-exists', 'add-exists-unreadable', 'add-fails']) rmSync(join(checkout, file), { force: true });
    writeIssue(noItem);
    writeFileSync(join(checkout, 'issue-with-item.json'), JSON.stringify(issue()));
    for (const flag of flags) writeFileSync(join(checkout, flag), '');
  };

  prepare();
  let result = run('priority', '1', 'High');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual([count('addProjectV2ItemById'), count('updateProjectV2ItemFieldValue')], [1, 1], 'A missing item is added once, then written');

  prepare('add-exists');
  result = run('priority', '1', 'High');
  assert.equal(result.status, 0, 'Already on the Project is no failure: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'High', 'The value is still written');
  assert.deepEqual([count('addProjectV2ItemById'), count('updateProjectV2ItemFieldValue')], [1, 1]);

  prepare('add-exists', 'add-exists-unreadable');
  assert.notEqual(run('priority', '1', 'High').status, 0, 'Already there but no readable item stays a failure');
  assert.equal(count('updateProjectV2ItemFieldValue'), 0, 'Nothing is written without an item');

  prepare('add-fails');
  assert.notEqual(run('priority', '1', 'High').status, 0, 'Any other refusal stays a failure');
  assert.equal(count('updateProjectV2ItemFieldValue'), 0);
});

test('handoff needs the driver handoff comment that names the current head', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const write = comments => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
  for (const [label, comments] of [
    ['no comment at all', []],
    ['another heading', [handoffComment({ body: 'Review ist durch' })]],
    ['the heading only inside a sentence', [handoffComment({ body: 'siehe ## Übergabe unten' })]],
    ['another author', [handoffComment({ user: { login: 'someone-else', type: 'User' } })]],
    ['no head named (the format before this check)', [handoffComment({ body: '## Übergabe\n\n- Retro: keine Befunde' })]],
    ['another head named, e.g. a comment for the previous push', [handoffComment({ body: '## Übergabe\n\nHead: 1234567\n\n- Retro: keine Befunde' })]],
    ['the head named only inside a sentence', [handoffComment({ body: '## Übergabe\n\nFür Head: abcdef1 siehe oben (Zeile beginnt anders)' })]],
  ]) {
    write(comments);
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^FAILED$/m, label);
    assert.equal(existsSync(mutations), false, `${label}: the status stays untouched`);
  }
  // No timestamp is involved: a head without any check suite (CI reported only as a status) works, and so does a comment
  // that is older than the head's suite, because it names the head.
  const base = handoffPr();
  write([handoffComment({ created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' })]);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ commits: { nodes: [{ commit: { ...base.commits.nodes[0].commit, checkSuites: { totalCount: 0, nodes: [] } } }] } })));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  assert.equal(run('handoff', '1', '7').status, 0, 'Naming the head is enough, with or without a check suite');
  rmSync(join(checkout, 'stored'));
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(base));
  write([handoffComment({ user: { login: 'Worker', type: 'User' }, body: '## Übergabe\n\nhead:   ABCDEF1234\n' })]);
  const result = run('handoff', '1', '7');
  assert.equal(result.status, 0, 'The authenticated user matches regardless of case: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');
});

test('body writes an issue body only on top of the one it is based on and proves the write', t => {
  const { checkout, run } = fixture(t);
  const file = (name, text) => { writeFileSync(join(checkout, name), text); return name; };
  const server = (body, extra = {}) => writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0, body, ...extra }));
  const stored = () => JSON.parse(readFileSync(join(checkout, 'backlink-1.json'), 'utf8')).body;
  const patches = () => existsSync(join(checkout, 'patches')) ? readFileSync(join(checkout, 'patches'), 'utf8').split('\n').filter(Boolean).length : 0;
  const reset = () => { rmSync(join(checkout, 'patches'), { force: true }); rmSync(join(checkout, 'body-overwritten'), { force: true }); };
  const change = file('change.md', 'neu\nzeile\n'), base = file('base.md', 'alt\nzeile\n');

  // Unchanged since it was read (GitHub may return CRLF): written once and read back.
  server('alt\r\nzeile');
  let result = run('body', '1', change, base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|neu\nzeile');

  // Changed by another session before the write: nothing is written, the difference is shown.
  reset();
  server('alt\nvon einer anderen Session ergänzt');
  result = run('body', '1', change, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED$/m);
  assert.match(result.stdout, /von einer anderen Session ergänzt/, 'The current text is part of the diff');
  assert.equal([patches(), stored()].join('|'), '0|alt\nvon einer anderen Session ergänzt');

  // Overwritten right after the write: the read-back reports it, and the write is not repeated.
  reset();
  server('alt\nzeile');
  writeFileSync(join(checkout, 'body-overwritten'), 'Fassung der anderen Session');
  result = run('body', '1', change, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED$/m);
  assert.match(result.stdout, /Fassung der anderen Session/);
  assert.equal(patches(), 1);

  // A file named "-" must not be taken for stdin: the text that was read is written, never an empty body.
  reset();
  server('alt\nzeile');
  file('-', 'neu aus Datei namens minus\n');
  result = run('body', '1', '-', base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|neu aus Datei namens minus');
  rmSync(join(checkout, '-'));

  // Already the wanted text: no write at all.
  reset();
  server('neu\nzeile');
  assert.equal(run('body', '1', change, change).status, 0);
  assert.equal(patches(), 0);

  // A pull request answers under its number as well (with a pull_request key): its description is never replaced.
  reset();
  server('alt\nzeile', { pull_request: { url: 'x' } });
  assert.equal(run('body', '1', change, base).status, 2);
  server('alt\nzeile', { number: 2 });
  assert.equal(run('body', '1', change, base).status, 2, 'A different number is not the requested issue');
  assert.equal(patches(), 0);

  // Unreadable input and API errors are errors, never a written body.
  reset();
  server('alt\nzeile');
  assert.equal(run('body', '1', 'missing.md', base).status, 2);
  assert.equal(run('body', '1', change).status, 2, 'The base the change rests on is required');
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(run('body', '1', change, base).status, 2);
  assert.equal(patches(), 0);
});
