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
const path = process.argv[2] ?? '';
if (!path.startsWith('graphql')) {
  if (fs.existsSync('fail') || fs.existsSync('fail-rest')) process.exit(1);
  // REST lists (comments, reviews, reactions) come in pages of 100, like GitHub.
  const parts = path.split('?')[0].split('/');
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
  fs.writeFileSync('stored', process.argv.find(arg => arg.startsWith('option=')).slice(7));
  data = {};
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
  const pr = JSON.parse(fs.readFileSync('pr.json'));
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
else if (query.includes('pullRequest(number')) data = { repository: { pullRequest: JSON.parse(fs.readFileSync('pr.json')) } };
else if (query.includes('fields(first:100)')) data = { node: { fields: { nodes: [{
  id: 'F1', name: 'Status', options: ['Ready', 'In progress', 'Human review'].map(name => ({ id: name, name }))
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
    checkSuites: { totalCount: 0, nodes: [] }, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
      { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] } } } }] },
  reviewRequests: { totalCount: 0, nodes: [] }, requestEvents: { totalCount: 0, nodes: [] },
  linkPages: [['I1']], ...changes,
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
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'A later read failure keeps the known CI verdict');
  rmSync(join(checkout, 'fail-rest'));
  const headReview = { user: codexUser, commit_id: 'abcdef1234', state: 'COMMENTED', html_url: 'r', submitted_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { comments: [codex('Running', 1)], reviewList: [headReview] }), 0, 'A head review ends a Running summary');
  assert.equal(reviews(pr(), { comments: [{ ...codex('Running', 3), updated_at: minutesAgo(0) }] }), 3, 'A later edit of the summary itself is no result');
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
