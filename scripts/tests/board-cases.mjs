import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';

// Every case starts Node processes (board.mjs, and Node again as the fake gh for each call), and node:test runs the
// tests of one file one after the other. So board-1.test.mjs … board-6.test.mjs each import this file with ?shard=N and
// run every 6th test, side by side. A new test needs nothing: it lands in the next shard by its position.
const SHARDS = 6, shard = Number(new URL(import.meta.url).searchParams.get('shard'));
for (let index = 1; index <= SHARDS; index++) assert.ok(existsSync(new URL(`board-${index}.test.mjs`, import.meta.url)), `board-${index}.test.mjs is missing: its tests would silently not run`);
assert.ok(shard >= 1 && shard <= SHARDS, 'import this file as board-cases.mjs?shard=N');
const CALL_TIMEOUT_MS = 60_000;
let position = 0;
// The start line names the running test: a hung file shows its last "start" instead of staying silent (node:test prints a test only when it ends).
const test = (name, body) => position++ % SHARDS + 1 === shard
  ? nodeTest(name, t => { console.error(`start: ${name}`); return body(t); }) : undefined;

// body_html is what GitHub renders for the body (the handoff check reads that, like the open acceptance of the issue).
const handoffComment = changes => ({ id: 900, user: { login: 'worker', type: 'User' }, body: '## Übergabe\n\nHead: abcdef1\n\n### Retro\n\n- Keine Funde',
  body_html: '<h2 dir="auto">Übergabe</h2>\n<p dir="auto">Head: abcdef1</p>\n<h3 dir="auto">Retro</h3>\n<ul dir="auto">\n<li>Keine Funde</li>\n</ul>',
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
  // A hard link, not a copy: on Windows the first start of every fresh executable is scanned for ~0.7 s; a link to Node is not.
  try { linkSync(process.execPath, gh); } catch {
    copyFileSync(process.execPath, gh);
    chmodSync(gh, 0o755);
  }
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
  if (parts[3] === 'issues' && parts[4] === 'comments' && parts.length === 6) {
    // One comment by id, as rendered by GitHub.
    const found = JSON.parse(fs.readFileSync('issues-comments.json')).find(comment => String(comment.id) === parts[5]);
    process.stdout.write(JSON.stringify({ body_html: found?.body_html }));
    process.exit(0);
  }
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
  if (parts[3] === 'issues' && parts[5] === 'comments' && process.argv.includes('POST')) {
    // A comment write; comment-noop is GitHub accepting it without showing it.
    fs.appendFileSync('comment-writes', 'x\\n');
    if (!fs.existsSync('comment-noop')) {
      const items = JSON.parse(fs.readFileSync(comments));
      items.push({ id: items.length + 1, body: fs.readFileSync(0, 'utf8'), html_url: 'https://github.com/test/example/issues/1#issuecomment-' + (items.length + 1) });
      fs.writeFileSync(comments, JSON.stringify(items));
      fs.writeFileSync(backlink, JSON.stringify({ ...JSON.parse(fs.readFileSync(backlink)), comments: items.length }));
    }
    process.stdout.write('{}');
    process.exit(0);
  }
  if (parts[3] === 'issues' && parts[5] === 'comments' && fs.existsSync(comments)) {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1);
    const items = JSON.parse(fs.readFileSync(comments));
    process.stdout.write(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
    process.exit(0);
  }
  if (parts[3] === 'compare') {
    // compare.json: { behind: commits the base gained, own: files of the PR, base: files of the base }; by default the base has not moved.
    const moved = fs.existsSync('compare.json') ? JSON.parse(fs.readFileSync('compare.json')) : { behind: 0, own: [], base: [] };
    // gh cuts a request at an unencoded "#", so a ref that is not encoded never reaches GitHub whole.
    if (path.includes('#')) process.exit(1);
    // BASE...HEAD lists the PR's files, HEAD...BASE those of the base. GitHub lists up to 300 files, all on page 1.
    const base = decodeURIComponent(parts.slice(4).join('/')).split('...')[0];
    const forward = base === JSON.parse(fs.readFileSync('pr.json')).baseRefName;
    const files = (forward ? moved.own : moved.base).slice(0, 300).map(filename => ({ filename }));
    process.stdout.write(JSON.stringify({ behind_by: forward ? moved.behind : 0, files }));
    process.exit(0);
  }
  if (parts[3] === 'activity') {
    // The branch's push log; by default the head was set long ago.
    const head = JSON.parse(fs.readFileSync('pr.json')).headRefOid;
    process.stdout.write(fs.existsSync('activity.json') ? fs.readFileSync('activity.json') : JSON.stringify([{ after: head, timestamp: '2000-01-01T00:00:00Z' }]));
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
  // mutation-fails: GitHub refuses every write.
  if (fs.existsSync('mutation-fails')) process.exit(1);
  fs.appendFileSync('mutations', query + '\\n');
  const option = process.argv.find(arg => arg.startsWith('option='));
  if (option) fs.writeFileSync('stored', option.slice(7));
  // Per field, so a call that sets several fields can be read back field by field.
  const fieldId = process.argv.find(arg => arg.startsWith('field='));
  if (option && fieldId) {
    const values = fs.existsSync('stored-values.json') ? JSON.parse(fs.readFileSync('stored-values.json')) : {};
    fs.writeFileSync('stored-values.json', JSON.stringify({ ...values, [fieldId.slice(6)]: option.slice(7) }));
  }
  if (query.includes('addCloseIssueReferences') && !fs.existsSync('link-noop')) {
    // link-delay: the connection shows only after that many reads, like GitHub's delayed consistency.
    const delay = fs.existsSync('link-delay') ? Number(fs.readFileSync('link-delay', 'utf8')) : 0;
    const before = JSON.parse(fs.readFileSync('pr.json'));
    fs.writeFileSync('pr.json', JSON.stringify(delay ? { ...before, linkPending: delay } : { ...before, linkPages: [['I1']] }));
  }
  // sub-noop: GitHub accepted the call but the link is not readable afterwards.
  if (query.includes('addSubIssue') && !fs.existsSync('sub-noop')) {
    fs.writeFileSync('child.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('child.json')), parent: { number: 1, repository: { nameWithOwner: 'Test/Example' } } }));
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
else if (query.includes('fieldValues(first:100)')) {
  const names = { F1: 'Status', F2: 'Priority', F3: 'Size' };
  const values = JSON.parse(fs.readFileSync('stored-values.json'));
  // lost: the API accepted the writes but every field reads back as this value.
  const lost = fs.existsSync('lost') && fs.readFileSync('lost', 'utf8');
  data = { repository: { issue: { issueFieldValues: { nodes: [] },
    projectItems: { nodes: [{ project: { id: 'P1' }, fieldValues: { nodes: Object.entries(values).map(([id, name]) => ({ name: lost || name, field: { name: names[id] } })) } }] } } } };
}
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
else if (query.includes('issue(number:$number){id parent{')) data = { repository: { issue: JSON.parse(fs.readFileSync('child.json')) } };
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
  // `gh pr merge …` runs this script: it records the call; merge-fails is gh refusing, merge-noop a merge that never shows.
  writeFileSync(join(checkout, 'pr'), `const fs = require('node:fs');
fs.appendFileSync('merges', process.argv.slice(2).join(' ') + '\\n');
if (fs.existsSync('merge-fails')) { process.stderr.write('gh: Head branch was modified\\n'); process.exit(1); }
if (!fs.existsSync('merge-noop')) fs.writeFileSync('pr.json', JSON.stringify({ ...JSON.parse(fs.readFileSync('pr.json')), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }));`);
  const env = {};
  return {
    checkout, env,
    // A call that hangs (a `wait` that never ends, a dead gh) would block the whole file silently: kill it and name test and command.
    run: (...args) => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../board.mjs', import.meta.url)), ...args],
        { cwd: checkout, encoding: 'utf8', env: { ...process.env, PATH: bin, ...env }, timeout: CALL_TIMEOUT_MS });
      assert.ifError(result.error && new Error(`"${t.name}": board.mjs ${args.join(' ')} did not finish in ${CALL_TIMEOUT_MS / 1000} s (${result.error.code})`));
      return result;
    },
    writeIssue: issue => writeFileSync(join(checkout, 'issue.json'), JSON.stringify(issue)),
  };
}

const issue = (status = 'Ready', nodes = [], totalCount = nodes.length) => ({
  id: 'I1', number: 1, title: 'Fixture', state: 'OPEN', bodyHTML: '', assignees: { nodes: [] },
  projectItems: { nodes: [{ id: 'PI1', project: { id: 'P1' }, status: { name: status } }] },
  blockedBy: { totalCount, nodes },
});
const predecessor = (state, stateReason) => ({ number: 9, state, stateReason, repository: { nameWithOwner: 'test/other' } });

// Pushed long enough ago that the reviewer grace has passed.
const pushedAt = () => new Date(Date.now() - 10 * 60_000).toISOString();
const handoffPr = changes => ({
  number: 7, state: 'OPEN', isDraft: false, baseRefName: 'release/0.1.1', headRefOid: 'abcdef1234',
  mergeStateStatus: 'CLEAN', reviewDecision: null,
  latestOpinionatedReviews: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: pushedAt(),
    checkSuites: { totalCount: 1, nodes: [{ createdAt: pushedAt(), status: 'COMPLETED', conclusion: 'SUCCESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 1 } }] },
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
    { ...ready, bodyHTML: task('added while waiting') },
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

// GitHub's rendering of a task item, an issue reference and a code block (shape of its Markdown API output).
const task = (text, checked) => `<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="${checked ? 'Completed' : 'Incomplete'} task"${checked ? ' checked=""' : ''}> ${text}</li>`;
const reference = '<a class="issue-link js-issue-link" href="https://github.com/test/example/issues/12">#12</a>';
const list = items => `<ul class="contains-task-list">\n${items.join('\n')}\n</ul>`;
const codeBlock = '<pre class="notranslate"><code class="notranslate">- [ ] sample in code\n</code></pre>';

test('handoff rejects open acceptance without an issue reference and names each line', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const open = [
    [list([task('first'), task('second ' + reference), task('third')]), ['first', 'third']],
    [list([task('color #123abc and revisit #12later')]), ['color #123abc and revisit #12later']],
    [list([task('url <a href="https://example.com/page#12">https://example.com/page#12</a>')]), ['url https://example.com/page#12']],
    [list([task('a &lt; b')]), ['a < b']],
    [`<ul>\n<li>Phase<br>\nCriteria:\n${list([task('nested')])}\n</li>\n</ul>`, ['nested']],
    [codeBlock + list([task('after code')]), ['after code']],
  ];
  for (const [bodyHTML, lines] of open) {
    writeIssue({ ...ready, bodyHTML });
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 1, bodyHTML + result.stdout + result.stderr);
    for (const line of lines) assert.ok(result.stdout.includes(': ' + line), result.stdout);
    assert.doesNotMatch(result.stdout, /sample in code|second/);
    assert.equal(existsSync(join(checkout, 'mutations')), false, 'Rejected handoff never mutates status');
  }
  // No list, only code, checked off, or moved to a follow-up: the issue may go to Human review.
  for (const bodyHTML of ['', '<p>no list</p>', codeBlock, list([task('done', true)]), list([task('moved to ' + reference), task('b', true)])]) {
    writeIssue({ ...ready, bodyHTML });
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 0, bodyHTML + result.stdout + result.stderr);
  }
  writeIssue({ ...ready, bodyHTML: undefined });
  assert.equal(run('handoff', '1', '7').status, 2, 'An unreadable rendered body is unknown, never a handoff');
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

test('"Wartet bis" holds an issue until its tag exists or its UTC time has passed; unreadable values are unknown', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const waiting = line => ({ ...issue(), body: `## Was\n\nKein Blocker hier, Wartet bis: kommt später.\n\n## Abhängigkeiten und Wiederaufnahme\n\n${line}\n` });
  const check = line => { writeIssue(waiting(line)); return run('check', '1'); };
  const tag = (name, ...refs) => writeFileSync(join(checkout, `matching-refs-${name}.json`), JSON.stringify(refs.map(ref => ({ ref: `refs/tags/${ref}` }))));

  const missing = check('Wartet bis: v1.2.3');
  assert.equal(missing.status, 1, missing.stdout);
  assert.ok(missing.stdout.includes('v1.2.3'), 'The unmet condition is named');
  tag('v1.2.3', 'v1.2.30'); // A prefix match is no match.
  assert.equal(check('Wartet bis: v1.2.3').status, 1);
  tag('v1.2.3', 'v1.2.3');
  assert.equal(check('Wartet bis: v1.2.3').status, 0);
  const future = check('Wartet bis: 2999-01-01T00:00Z');
  assert.equal(future.status, 1, future.stdout);
  assert.ok(future.stdout.includes('2999-01-01T00:00Z'), 'The unmet condition is named');
  assert.equal(check('Wartet bis: 2000-01-01T00:00Z').status, 0);
  writeFileSync(join(checkout, 'tags-2026.json'), JSON.stringify([{ ref: 'refs/tags/release/2026' }])); // Der Mock benennt die Datei nach den Pfadteilen -3 und -1.
  assert.equal(check('Wartet bis: release/2026').status, 0, 'Tags need not look like versions');
  assert.equal(check('Wartet bis: release/2027').status, 1);
  writeFileSync(join(checkout, 'matching-refs-release%402026.json'), JSON.stringify([{ ref: 'refs/tags/release@2026' }]));
  assert.equal(check('Wartet bis: release@2026').status, 0, 'Any tag Git accepts is looked up, URL-encoded');
  writeFileSync(join(checkout, 'matching-refs-%C2%A0release.json'), JSON.stringify([{ ref: 'refs/tags/ release' }]));
  assert.equal(check('Wartet bis:  release').status, 0, 'Only ASCII separators are stripped from the value');
  // No Markdown section logic: a condition is never silently overlooked, wherever the line sits.
  for (const body of ['### Abhängigkeiten und Wiederaufnahme ###\n\n#### Release\n\nWartet bis: 2999-01-01T00:00Z\n',
    '## Weiteres\n\n- Wartet bis: 2999-01-01T00:00Z\n', 'Wartet bis: 2999-01-01T00:00Z\r\n\r\n```sh\n## x\n```\n']) {
    writeIssue({ ...issue(), body });
    assert.equal(run('check', '1').status, 1, body);
  }
  for (const variant of ['**Wartet bis:** v1.2.3', '> Wartet bis: v1.2.3', '1. Wartet bis: v1.2.3', '- [ ] Wartet bis: v1.2.3', '## Wartet bis: v1.2.3', '| Wartet bis: v1.2.3 |', '`Wartet bis: v1.2.3`','Wartet bis v1.2.3']) {
    assert.equal(check(variant).status, 2, `${variant} is unknown, never overlooked`);
  }
  for (const invalid of ['Wartet bis: bald nach dem Release', 'Wartet bis: release.', 'Wartet bis: foo.lock', 'Wartet bis: 2026-02-30T10:00Z', 'Wartet bis: 2999-01-01T00:00+02:00', 'Wartet bis:']) {
    assert.equal(check(invalid).status, 2, `${invalid} is unknown, never "no blocker"`);
  }
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(check('Wartet bis: v1.2.3').status, 2, 'A failed tag lookup is unknown');
  rmSync(join(checkout, 'fail-rest'));
  assert.equal(check('Keine Wartebedingung.').status, 0);
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
  // Not assigned: one ERROR line, not the check's verdict block in front of it.
  writeIssue(issue());
  assert.match(run('status', '1', 'In progress').stdout, /^ERROR - [^\n]*\n$/);
  writeIssue(assigned());
  for (const failure of ['fail', 'fail-viewer']) {
    writeFileSync(join(checkout, failure), '');
    const result = run('status', '1', 'In progress');
    assert.notEqual(result.status, 0);
    if (failure === 'fail-viewer') assert.match(result.stdout, /^ERROR - /);
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
    { ...ready(6, []), body: '## Abhängigkeiten und Wiederaufnahme\n\nWartet bis: 2999-01-01T00:00Z' },
  ]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, held] = result.stdout.split('\n\n');
  assert.deepEqual(startable.match(/^#\d+/gm), ['#1']);
  assert.deepEqual(held.match(/^#\d+/gm), ['#2', '#3', '#4', '#6'], 'Every Ready issue appears; Backlog does not');
  assert.equal(held.match(/^ {2}- /gm).length, 4, 'Each held issue names its reason');
  assert.ok(held.includes('2999-01-01T00:00Z'), 'The unmet condition is named');
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

/** What the reviews tests share: a checkout, PR snapshots, Codex traces and `look` (write the snapshot, run `reviews`). */
function reviewsFixture(t) {
  const { checkout, run } = fixture(t);
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const codexUser = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
  const check = (status, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null) => ({ __typename: 'CheckRun', name: 'CI', status, conclusion });
  const suite = (status = 'COMPLETED', runs = 1, minutes = 1, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null, run, workflowId = 'W-Frontend', slug = 'github-actions') => ({
    createdAt: minutesAgo(minutes), status, conclusion, app: { slug }, checkRuns: { totalCount: runs },
    workflowRun: run === undefined ? null : { databaseId: run, workflow: { id: workflowId } } });
  const pr = ({ pushed = 1, contexts = [check('COMPLETED')], total = contexts.length, requests = [], requestedAgo, requestEventTotal, threadPages,
    suites = [suite('COMPLETED', 1, pushed)], suiteTotal = suites.length } = {}) => ({
    number: 7, state: 'OPEN', isDraft: true, baseRefName: 'release/0.1.1', headRefOid: 'abcdef1234', mergeStateStatus: 'CLEAN', reviewDecision: null,
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

  return { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews };
}

test('reviews waits only for traces on the current head and never reads failures as done', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);

  assert.equal(reviews(pr()), 0, 'Green CI without other traces is done');
  // Codex starts on "ready for review" and shows its first trace a minute or two later, often after CI is green.
  const readied = (minutes, changes, pushed = 1) => ({ ...pr({ pushed }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(minutes) }] }, ...changes });
  assert.equal(reviews(readied(0.5)), 3, 'Green CI right after Ready still waits for reviewers to start');
  assert.equal(reviews(readied(5, {}, 5)), 0, 'After the grace a missing trace means no reviewer is coming');
  // Codex also reviews new commits: a push to a long-ready PR starts the grace again.
  assert.equal(reviews(readied(30, {}, 1)), 3, 'Green CI right after a push to a ready PR still waits for reviewers');
  assert.equal(reviews(readied(30, {}, 5)), 0, 'After the grace since the push a missing trace means no reviewer is coming');
  // A head set to an older commit keeps its old suites and commit date; only the branch's push log dates the new push.
  const pushedToBranch = minutes => writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(minutes) }]));
  pushedToBranch(0.5);
  assert.equal(reviews(readied(30, {}, 5)), 3, 'Green CI on a reused commit just pushed to a ready PR still waits for reviewers');
  pushedToBranch(5);
  assert.equal(reviews(readied(30, {}, 5)), 0, 'Precondition: a reused commit pushed before the grace is done');
  // The same commit pushed twice: the latest push counts, in either order.
  const older = { after: 'abcdef1234', timestamp: minutesAgo(10) }, newer = { after: 'abcdef1234', timestamp: minutesAgo(0.5) };
  for (const log of [[older, newer], [newer, older]]) {
    writeFileSync(join(checkout, 'activity.json'), JSON.stringify(log));
    assert.equal(reviews(readied(30, {}, 5)), 3, 'The latest push of a repeated commit starts the grace');
  }
  writeFileSync(join(checkout, 'activity.json'), '[]');
  assert.equal(reviews(readied(30, {}, 5)), 2, 'An unreadable push time never reads as done');
  rmSync(join(checkout, 'activity.json'));
  assert.equal(reviews(readied(0.5), {}, '--grace', '0'), 0, 'The grace can be turned off');
  assert.equal(reviews(readied(-0.5)), 3, 'Precondition: a Ready after now still waits with the default grace');
  assert.equal(reviews(readied(-0.5), {}, '--grace', '0'), 0, 'Ready during the query (after now) does not revive a disabled grace');
  // Commit dates come from client clocks: one ahead of GitHub must not cut the grace short.
  const committed = minutes => ({ commits: { nodes: [{ commit: { ...pr().commits.nodes[0].commit, committedDate: minutesAgo(minutes) } }] } });
  assert.equal(reviews(readied(0.5, committed(-10))), 3, 'A commit date in the future does not cut the grace short');
  assert.equal(reviews(readied(0.5, { isDraft: true })), 0, 'A Draft starts no grace');
  // A PR opened ready gets its first CI suite from the "opened" event, after its creation.
  assert.equal(reviews({ ...pr({ pushed: 0.2 }), isDraft: false, createdAt: minutesAgo(0.5) }), 3, 'A PR opened ready counts from its creation');
  // Correction pushes: heads pushed after the first Ready; the head that set Ready does not count, a repeated head counts once.
  const corrections = (pushes, changes) => {
    writeFileSync(join(checkout, 'activity.json'), JSON.stringify(pushes.map(([after, minutes]) => ({ after, timestamp: minutesAgo(minutes) }))));
    return look({ ...readied(30, {}, 5), firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] }, ...changes }).stdout;
  };
  // Only the number and the presence of the cap notice are checked, not the wording around them.
  const count = output => output.match(/correction pushes after ready: (\d+)/)?.[1];
  const cap = /cap reached/;
  const twoPushes = corrections([['abcdef1234', 5], ['bbbbbbb', 15], ['aaaaaaa', 25]]);
  assert.equal(count(twoPushes), '2');
  assert.match(twoPushes, cap);
  const onePush = corrections([['abcdef1234', 15], ['aaaaaaa', 25]]);
  assert.equal(count(onePush), '1');
  assert.doesNotMatch(onePush, cap);
  assert.doesNotMatch(corrections([['abcdef1234', 5], ['abcdef1234', 10], ['aaaaaaa', 25]]), cap, 'A repeated head is one push');
  assert.equal(count(corrections([['abcdef1234', 25]])), '0');
  assert.equal(count(corrections([['abcdef1234', 5], ['bbbbbbb', 15], ['abcdef1234', 25]])), '1', 'Pushing back to the head that set Ready is no new head');
  assert.equal(count(look({ ...pr(), firstReadyEvents: { nodes: [] } }).stdout), undefined, 'A PR that never was ready has no count');
  // A red head still reports the count, and an unreadable push log never turns the red verdict into ERROR.
  const red = { commits: pr({ pushed: 5, contexts: [check('COMPLETED', 'FAILURE')] }).commits };
  const redPushes = [['abcdef1234', 5], ['bbbbbbb', 15], ['aaaaaaa', 25]];
  assert.equal(count(corrections(redPushes, red)), '2', 'A red head reports the count too');
  assert.equal(look({ ...readied(30, {}, 5), ...red, firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }).status, 1);
  writeFileSync(join(checkout, 'activity.json'), 'unreadable');
  assert.equal(look({ ...readied(30, {}, 5), ...red, firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }).status, 1, 'An unreadable push log keeps the red verdict');
  // Without the grace nothing else reads the log, so an unreadable one must not turn green into ERROR either.
  assert.equal(look({ ...readied(30, {}, 5), firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }, undefined, '--grace', '0').status, 0, 'An unreadable push log keeps the green verdict');
  rmSync(join(checkout, 'activity.json'));
});

test('reviews reads CI checks, check suites and the traces of reviewers on the head', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
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
  // Draft then Ready: the first run's suite is cancelled before it reports a check run, the second run's suite carries them.
  const cancelled = suite('COMPLETED', 0, 1, 'CANCELLED', 10);
  assert.equal(reviews(pr({ suites: [cancelled] })), 1, 'A single empty cancelled suite is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11)] })), 0, 'A newer successful suite of the same workflow replaces it');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1, 'SUCCESS', 11), cancelled] })), 0, 'The order of the suites does not matter');
  assert.equal(reviews(pr({ suites: [cancelled, suite('QUEUED', 0, 1, null, 11)] })), 3, 'A newer suite that has not reported yet waits');
  // The replacing suite answers for the workflow even with runs: the green rollup shows only the jobs reported so far.
  assert.equal(reviews(pr({ suites: [cancelled, suite('IN_PROGRESS', 1, 1, null, 11)] })), 3, 'A replacing suite with runs that is still running waits');
  assert.equal(reviews(pr({ pushed: 60, suites: [suite('COMPLETED', 0, 60, 'CANCELLED', 10), suite('IN_PROGRESS', 1, 60, null, 11)] })), 3, 'A running suite with runs never stalls');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'CANCELLED', 11)] })), 1, 'A replacing suite with runs that ends cancelled is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 0, 1, 'CANCELLED', 11)] })), 1, 'A newest cancelled suite is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 0, 1, 'STARTUP_FAILURE', 11)] })), 1, 'A newer suite that fails to start is a failure');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'STARTUP_FAILURE', 10)] })), 1, 'A startup failure without a replacement is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11, 'W-Other')] })), 1, 'Another workflow does not replace it');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11, 'W-Frontend', 'other-app')] })), 1, 'Another app does not replace it');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'CANCELLED', 12), suite('COMPLETED', 1, 1, 'SUCCESS', 11)] })), 1, 'An older successful suite does not replace a newer cancelled one');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'CANCELLED'), suite('COMPLETED', 1, 1, 'SUCCESS', 11)] })), 1, 'A suite without a workflow run cannot be ordered and stays a failure');
});

test('reviews tells the newest run of a job from cancelled, skipped and Draft runs', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
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
  // Ready since 5 minutes: a pull_request run created before that was a Draft run, and its skipped job guard proves nothing.
  const draftRun = (run, conclusion = 'SKIPPED', { minutes = 10, event = 'pull_request', time, ...names } = {}) => {
    const base = job(run, conclusion === 'IN_PROGRESS' ? conclusion : 'COMPLETED', conclusion === 'IN_PROGRESS' ? null : conclusion, names.name, names.workflow);
    return { ...base, checkSuite: { ...base.checkSuite, createdAt: time ?? minutesAgo(minutes), workflowRun: { ...base.checkSuite.workflowRun, event } } };
  };
  const readyHead = (contexts, extra) => ({ ...pr({ contexts, pushed: 10 }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(5) }] }, ...extra });
  const oldTraces = { comments: [codex('Completed', 0)] };
  assert.equal(reviews(readyHead([draftRun(1)]), oldTraces), 3, 'A Ready head whose only runs were skipped while Draft is not proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SKIPPED', { name: 'Lint', workflow: 'Lint' }), job(3, 'COMPLETED', 'SUCCESS', 'Backend', 'Frontend')]), oldTraces), 3,
    'A green other workflow does not cover the missing path');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'IN_PROGRESS', { minutes: 2 })]), oldTraces), 3, 'A running Ready run waits');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'FAILURE', { minutes: 2 })]), oldTraces), 1, 'A failed Ready run is FAILED');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { minutes: 2 })]), oldTraces), 0, 'An executed Ready run is the proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SKIPPED', { minutes: 2 })]), oldTraces), 0, 'A skip after Ready is a real optional skip');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint', minutes: 2 })]), oldTraces), 0, 'A skipped job of a workflow that executed since Ready stays optional');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint' })]), oldTraces), 3, 'An unguarded job that ran while Draft does not cover the guarded one');
  // Converting to Draft right before Ready starts a Draft run that can land just after the Ready event.
  const toggled = contexts => readyHead(contexts, { convertEvents: { nodes: [{ createdAt: minutesAgo(5.02) }] } });
  const lateSkip = () => draftRun(1, 'SKIPPED', { minutes: 4.95 });
  assert.equal(reviews(toggled([lateSkip()]), oldTraces), 3, 'A Draft-conversion run just after Ready is no Ready proof');
  assert.equal(reviews(toggled([draftRun(1, 'SKIPPED', { minutes: 20 })]), oldTraces), 0, 'A skip from before the latest Draft conversion belongs to an earlier period');
  assert.equal(reviews(readyHead([lateSkip()]), oldTraces), 0, 'Precondition: without the conversion that skip is after Ready');
  assert.equal(reviews(toggled([lateSkip(), draftRun(2, 'SUCCESS', { minutes: 3 })]), oldTraces), 0, 'A later executed run of the workflow is the proof');
  // Opened as Draft (Ready event, no conversion) and marked Ready within seconds: the delayed `opened` run is a Draft run too.
  const openedDraft = contexts => readyHead(contexts, { createdAt: minutesAgo(5.05) });
  assert.equal(reviews(openedDraft([lateSkip()]), oldTraces), 3, 'An opened-as-Draft run just after Ready is no Ready proof');
  assert.equal(reviews(openedDraft([lateSkip(), draftRun(2, 'SUCCESS', { minutes: 3 })]), oldTraces), 0, 'A later executed run of the workflow is the proof');
  assert.equal(reviews(readyHead([lateSkip()], { createdAt: 'unreadable' }), oldTraces), 2, 'An unreadable creation time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1, 'SUCCESS', { event: 'push' }), draftRun(2)]), oldTraces), 3, 'An executed push run of the same job from before Ready does not hide the Draft skip');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: null, minutes: 2 })]), oldTraces), 0, 'A skip after Ready needs no readable event');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: 'push' })]), oldTraces), 0, 'Only pull_request runs carry a Draft guard');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), isDraft: true }, oldTraces), 0, 'A Draft head has nothing to wait for yet');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), readyEvents: { nodes: [] } }, oldTraces), 0, 'A PR that was never Draft has no Draft runs');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { time: 'unreadable' })]), oldTraces), 2, 'An unreadable run time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: null })]), oldTraces), 2, 'An unreadable run event is an error, never proof');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), readyEvents: { nodes: [{ createdAt: 'unreadable' }] } }, oldTraces), 2, 'An unreadable Ready time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1)], { convertEvents: { nodes: [{ createdAt: 'unreadable' }] } }), oldTraces), 2, 'An unreadable Draft conversion time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint', time: 'unreadable' })]), oldTraces), 2, 'An unreadable start time of a sibling run is an error, never a silent wait');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { time: 'unreadable' }), job(2, 'COMPLETED', 'FAILURE', 'Lint', 'Lint')]), oldTraces), 1, 'A known failure stays the verdict over unreadable Draft data');
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'A later read failure keeps the known CI verdict');
  rmSync(join(checkout, 'fail-rest'));
});

test('reviews reads Codex rows, blockers and threads, and wait ends with the verdict', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
  let commentId = 1000; // after the ids of `codex`, so no two comments share one
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
  const result = run('field', '1', 'Größe', 'P0: urgent');
  assert.match(result.stdout, /^ERROR - .*Größe/, 'Validation lets the name through to the field lookup: ' + result.stderr);
  assert.equal(run('field', '1', 'Size', '-x').stdout, '', 'An option-like value is still rejected as usage');
  assert.equal(run('field', '1', 'Size', '-x').status, 2);
});

test('field sets several fields in one call: every pair is validated first, then all are written and read back', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const mutations = join(checkout, 'mutations');
  let result = run('field', '1', 'Size', 'xs', 'Priority', 'low');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(checkout, 'stored-values.json'), 'utf8')), { F3: 'XS', F2: 'Low' });

  rmSync(mutations);
  for (const args of [['Size', 'XS', 'Priority', 'Urgent'], ['Size', 'XS', 'Colour', 'Red'], ['Size', 'XS', 'Priority'], ['Size', 'XS', 'size', 'S']]) {
    result = run('field', '1', ...args);
    assert.match(result.stdout, /^ERROR - /m, result.stdout + result.stderr);
    assert.equal(result.stderr, '', 'No stack trace');
    assert.equal(result.status, 2);
    assert.equal(existsSync(mutations), false, 'One invalid pair writes nothing: ' + args.join(' '));
  }
  // The valid choices are named, for an unknown option and for an unknown field alike.
  assert.match(run('field', '1', 'Size', 'XS', 'Priority', 'Urgent').stdout, /High.*Low/);
  assert.match(run('field', '1', 'Size', 'XS', 'Colour', 'Red').stdout, /Priority.*Size/);

  writeFileSync(join(checkout, 'lost'), 'S');
  const lost = run('field', '1', 'Size', 'XS', 'Priority', 'Low');
  assert.notEqual(lost.status, 0, 'A read-back that differs for any field is a failure');
  assert.match(lost.stdout, /^ERROR - [^\n]*\n$/, 'A failed call shows no write as confirmed and stays one line');
});

test('field, status and priority report failures as one ERROR line, and issue failures name the repository', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  for (const args of [['field', '1', 'Colour', 'Red'], ['priority', '1', 'Urgent'], ['status', '1', 'Done']]) {
    const result = run(...args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^ERROR - /);
    assert.equal(result.stderr, '', 'No stack trace');
  }
  // A passing guard (the readiness check prints) waits until every pair is valid, so the failure stays one line.
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] } });
  const late = run('field', '1', 'Status', 'In progress', 'Colour', 'Red');
  assert.equal(late.status, 2);
  assert.match(late.stdout, /^ERROR - [^\n]*\n$/);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  // Assigned but blocked: the refusal is the one ERROR line too, and nothing is written.
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] }, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } });
  const held = run('status', '1', 'In progress');
  assert.equal(held.status, 2);
  assert.match(held.stdout, /^ERROR - [^\n]*\n$/);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] } });
  // A write that fails after the guards passed leaves the check's output unprinted too.
  writeFileSync(join(checkout, 'mutation-fails'), '');
  const refused = run('status', '1', 'In progress');
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /^ERROR - [^\n]*\n$/);
  assert.doesNotMatch(refused.stdout, /Assign yourself/, "The start guards passed; the write failed");
  rmSync(join(checkout, 'mutation-fails'));
  writeIssue(issue());
  // GitHub refuses an unknown issue number: the message says which repository was meant.
  writeFileSync(join(checkout, 'fail'), '');
  for (const args of [['check', '1'], ['priority', '1', 'High']]) {
    assert.match(run(...args).stdout, /test\/example#1/, args[0]);
  }
});

test('link connects the issue natively to the PR, repeats safely and trusts only the read-back', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const commentWrites = () => existsSync(join(checkout, 'comment-writes')) ? readFileSync(join(checkout, 'comment-writes'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = (changes = {}) => {
    for (const file of ['mutations', 'link-noop', 'fail', 'comment-writes', 'comment-noop']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]],
      url: 'https://github.com/test/example/pull/7', body: 'Refs #1', ...changes })));
    writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
    writeFileSync(join(checkout, 'backlink-comments-1.json'), '[]');
  };

  prepare();
  assert.notEqual(run('status', '1', 'Automated review', '7').status, 0, 'Without the comment the guard refuses');
  assert.equal(mutations(), 0, 'and writes nothing');
  let result = run('link', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(mutations(), 1, 'A Draft PR is connected with one write');
  assert.match(readFileSync(join(checkout, 'mutations'), 'utf8'), /addCloseIssueReferences\(input:\{issueId:\$issue,pullRequestIds:\[\$pr\]\}\)/);
  assert.equal(commentWrites(), 1, 'The missing backlink comment is written once');
  result = run('status', '1', 'Automated review', '7');
  assert.equal(result.status, 0, 'The guard accepts what link wrote: ' + result.stdout + result.stderr);

  result = run('link', '1', '7');
  assert.equal(result.status, 0, 'A second run finds the link already there');
  assert.equal(readFileSync(join(checkout, 'mutations'), 'utf8').match(/addCloseIssueReferences/g).length, 1, 'No second link write');
  assert.equal(commentWrites(), 1, 'No second comment');

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

  prepare({ linkPages: [['I1']] });
  writeFileSync(join(checkout, 'comment-noop'), '');
  result = run('link', '1', '7');
  assert.equal(result.status, 2, 'A comment the read-back does not show is no success');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(commentWrites(), 1, 'The comment is not written again blindly');

  prepare();
  writeIssue({ ...issue('In progress'), state: 'CLOSED' });
  assert.equal(run('link', '1', '7').status, 2, 'A closed issue takes no backlink');
  assert.equal(mutations() + commentWrites(), 0, 'and is refused before any write');
  writeIssue(issue('In progress'));

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

// GitHub's rendering of the handoff comment's retro section (shape of its Markdown API output).
const link = '<a class="issue-link js-issue-link" href="https://github.com/test/example/issues/12">#12</a>';
const pullLink = '<a class="issue-link js-issue-link" data-hovercard-type="pull_request" href="https://github.com/test/example/pull/12">#12</a>';
const commit = '<a class="commit-link" href="https://github.com/test/example/commit/38e48bd"><tt>38e48bd</tt></a>';
const retro = (...lines) => '<h2 dir="auto">Übergabe</h2>\n<p dir="auto">Head: abcdef1</p>\n<h3 dir="auto">Retro</h3>\n<ul dir="auto">\n'
  + lines.map(line => `<li>${line}</li>`).join('\n') + '\n</ul>';

test('handoff needs a retro section whose every line ends with its resolution', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  const handoff = body_html => {
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([handoffComment({ body_html })]));
    return run('handoff', '1', '7');
  };
  const rejected = (html, named, label) => {
    const result = handoff(html);
    assert.equal(result.status, 1, label + result.stdout + result.stderr);
    for (const line of named) assert.ok(result.stdout.includes(': ' + line), label + result.stdout);
    assert.equal(existsSync(join(checkout, 'mutations')), false, label + 'Rejected handoff never mutates status');
  };

  rejected(retro('Kit-Init dauert: ' + link, 'Rate-Limit: ohne Erledigung', 'Memory veraltet: persönlich gemeldet'), ['Rate-Limit: ohne Erledigung'], 'one line without resolution: ');
  rejected(retro('Zeile mit ' + link + ' mittendrin'), ['Zeile mit #12 mittendrin'], 'reference not at the end: ');
  rejected(retro('Zeile mit <code>#12</code>'), ['Zeile mit #12'], 'reference in code: ');
  rejected(retro('Keine Funde', 'Zusätzlicher Fund: ' + link), ['Keine Funde'], 'Keine Funde is allowed only alone: ');
  rejected(retro('Fund: ' + pullLink), ['Fund: #12'], 'a pull request is no follow-up issue: ');
  rejected('<h2 dir="auto">Übergabe</h2>\n<ul dir="auto">\n<li>Retro: keine Befunde</li>\n</ul>', [], 'no retro section: ');
  rejected('<h2 dir="auto">Übergabe</h2>\n<h3 dir="auto">Retro</h3>\n<p dir="auto">Nichts gefunden.</p>', [], 'section without lines: ');

  for (const [html, label] of [
    [retro('Keine Funde'), 'Keine Funde alone'],
    [retro('Kit-Init: ' + link, 'Reibung: behoben in ' + commit, 'Memory: persönlich gemeldet', 'Einzelfall: kein Handlungsbedarf: nur einmal aufgetreten'), 'every resolution'],
    [retro(`\n<p dir="auto">Fund: ${link}</p>\n`, `\n<p dir="auto">Reibung: behoben in ${commit}</p>\n`), 'loose list: GitHub wraps each line in a paragraph'],
    [retro('Fund: ' + link) + '\n<h3 dir="auto">Reviews</h3>\n<ul>\n<li>Befunde: keine</li>\n</ul>', 'lines after the next heading are not retro lines'],
  ]) {
    const result = handoff(html);
    assert.equal(result.status, 0, label + ': ' + result.stdout + result.stderr);
  }
  assert.equal(handoff(undefined).status, 2, 'An unreadable rendered comment is unknown, never a handoff');
});

test('handoff blocks on open Sonar issues behind a passed quality gate and never reads an unreadable count as clean', t => {
  const { checkout, run, writeIssue, env } = fixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  const base = handoffPr(), commit = base.commits.nodes[0].commit;
  const sonar = { __typename: 'CheckRun', name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS',
    detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7', checkSuite: { app: { slug: 'sonarqubecloud' } } };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, sonar] } } } }] } }));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  // Stands in for the Sonar API in every node process of the run, the board's request child included.
  writeFileSync(join(checkout, 'sonar-mock.cjs'), `const fs = require('node:fs');
globalThis.fetch = async (url, init) => {
  fs.appendFileSync('sonar-requests', JSON.stringify([String(url), init.headers.Authorization]) + '\\n');
  const { status, total } = JSON.parse(fs.readFileSync('sonar.json', 'utf8'));
  return { ok: status === 200, status, text: async () => JSON.stringify({ total }) };
};`);
  env.NODE_OPTIONS = `--require "${join(checkout, 'sonar-mock.cjs').replaceAll(sep, '/')}"`;
  env.SONAR_TOKEN = 'secret-token';
  const answer = (status, total) => writeFileSync(join(checkout, 'sonar.json'), JSON.stringify({ status, total }));
  const mutations = join(checkout, 'mutations');

  answer(200, 3);
  let result = run('handoff', '1', '7');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker:/m);
  assert.equal(existsSync(mutations), false, 'Open Sonar issues keep the status untouched');
  const [requested, authorization] = JSON.parse(readFileSync(join(checkout, 'sonar-requests'), 'utf8').split('\n')[0]);
  assert.equal(authorization, 'Bearer secret-token', 'The anonymous API reports 0 for private projects');
  const query = new URL(requested).searchParams;
  assert.deepEqual([query.get('componentKeys'), query.get('pullRequest'), query.get('issueStatuses')], ['test_example', '7', 'OPEN,CONFIRMED']);

  answer(401, 0);
  result = run('handoff', '1', '7');
  assert.equal(result.status, 2, 'A refused read is UNKNOWN, not green: ' + result.stdout + result.stderr);
  env.SONAR_TOKEN = ''; // overrides a token of the developer's own environment
  answer(200, 0);
  result = run('handoff', '1', '7');
  assert.equal(result.status, 2, 'Without a token the count is unreadable: ' + result.stdout + result.stderr);
  assert.equal(existsSync(mutations), false);

  env.SONAR_TOKEN = 'secret-token';
  result = run('handoff', '1', '7');
  assert.equal(result.status, 0, 'No open issue hands off: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');

  // A skipped check ran no analysis (no PR link to read): it is no lookup, however many issues the project has.
  rmSync(join(checkout, 'stored'));
  answer(200, 9);
  const skipped = { ...sonar, conclusion: 'SKIPPED', detailsUrl: null };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, skipped] } } } }] } }));
  result = run('handoff', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
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

test('board check blocks a newer claim of another session of the same login unless handed over', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const comment = (body, changes) => ({ id: 1, user: { login: 'worker', type: 'User' }, body, html_url: 'https://example.test/c1',
    created_at: '2026-10-06T10:00:00Z', ...changes });
  const claim = (agent, session, changes) => comment(`Claim\n\nAgent: ${agent}, Session: ${session}`, changes);
  const check = (comments, ...args) => {
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
    return run('check', '1', ...args);
  };

  const foreign = check([claim('claude', 'S1'), claim('codex', 'S2', { created_at: '2026-10-06T10:09:00Z' })], '--session', 'S1');
  assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout, /Agent codex, Session S2, 2026-10-06T10:09:00Z, https:\/\/example\.test\/c1/);
  assert.equal(check([claim('claude', 'S1')], '--session', 'S1').status, 0, 'own claim');
  assert.equal(check([claim('claude', 'S1'), claim('codex', 'S2')], '--session', 'S2').status, 0, 'equal times: the later comment wins');
  assert.equal(check([claim('claude', 'S1'), comment('Handover: S2')], '--session', 'S2').status, 0, 'handover');
  assert.equal(check([claim('claude', 'S1'), comment('Handover: S2')], '--session', 'S1').status, 1, 'the earlier session lost the claim');
  assert.equal(check([claim('claude', 'S1', { user: { login: 'someone-else' } })], '--session', 'S2').status, 0, 'other authors are ignored');

  const old = check([comment('Claim: Driver, Branch x')], '--session', 'S2');
  assert.equal(old.status, 0, old.stdout);
  assert.match(old.stdout, /note: claim without Agent\/Session field/);
  const stray = check([claim('claude', 'S1'), comment('Claim: released')], '--session', 'S2');
  assert.equal(stray.status, 1, 'a newer claim without the field never lifts a known holder');
  assert.match(stray.stdout, /note: claim without Agent\/Session field/);
  assert.equal(check([comment('Agent: codex, Session: S1, Branch: x')], '--session', 'S2').status, 1, 'text after the session id is allowed');
  assert.equal(check([comment('Agent: reviewer, Session: S1')], '--session', 'S2').status, 0, 'only claude and codex name a claim');
  assert.equal(check([claim('claude', 'S1')], '--sesion', 'S2').status, 2, 'a misspelled flag is a usage error, not a silent skip');
  const unnamed = check([claim('claude', 'S1')]);
  assert.equal(unnamed.status, 0, 'without --session the verdict stays as before');
  assert.match(unnamed.stdout, /note: newest claim: Agent claude, Session S1/);

  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(run('check', '1', '--session', 'S1').status, 2, 'unreadable comments are unknown');
});

test('sub links a child once, reads the parent back and refuses bad or unconfirmed links', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  writeFileSync(join(checkout, 'child.json'), JSON.stringify({ id: 'C5', parent: null }));
  const mutations = () => (existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8') : '').split('\n').filter(Boolean);

  const bad = run('sub', '1', 'x/y');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage/);
  assert.equal(mutations().length, 0, 'An invalid CHILD makes no API call');

  for (const attempt of [1, 2]) {
    const result = run('sub', '1', '5');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mutations().length, 1, `attempt ${attempt}: the pair is linked once`);
  }

  writeFileSync(join(checkout, 'child.json'), JSON.stringify({ id: 'C6', parent: null }));
  writeFileSync(join(checkout, 'sub-noop'), '');
  const lost = run('sub', '1', 'test/other#6');
  assert.notEqual(lost.status, 0, 'A link GitHub does not show back is never reported as done');
  assert.doesNotMatch(lost.stdout, /has sub-issue/);
});

test('board check lists the sub-issues of a spec with status, assignee and verdict, and leaves the verdict of the parent alone', t => {
  const { run, writeIssue } = fixture(t);
  const child = (number, status, nodes, assignee, changes) => ({ ...issue(status, nodes), number, repository: { nameWithOwner: 'test/example' },
    assignees: { nodes: assignee ? [{ login: assignee }] : [] }, ...changes });
  const spec = (...children) => ({ ...issue(), subIssues: { totalCount: children.length, nodes: children } });

  writeIssue(spec(child(11, 'In progress', [], 'worker'), child(12, 'Ready', [predecessor('OPEN', null)])));
  const result = run('check', '1', '--session', 'S1');
  assert.equal(result.status, 0, 'Sub-issues never change the verdict of the parent');
  const lines = result.stdout.split('\n');
  assert.equal(lines.at(-3), '#11  In progress  worker  STARTABLE', result.stdout);
  assert.equal(lines.at(-2), '#12  Ready  -  BLOCKED', result.stdout);

  writeIssue(spec(child(13, 'Backlog', []), child(14, 'Ready', [], 'worker', { repository: { nameWithOwner: 'test/other' } })));
  assert.match(run('check', '1', '--session', 'S1').stdout, /^#13 {2}Backlog {2}- {2}BLOCKED\ntest\/other#14 {2}Ready {2}worker {2}STARTABLE$/m);
  writeIssue(issue());
  assert.doesNotMatch(run('check', '1', '--session', 'S1').stdout, /#\d+ {2}/, 'No sub-issues, no rows');
});

test('board check shows the age of a claim and whether a linked PR is open', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const claimedAgo = ms => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' },
    body: 'Claim\n\nAgent: claude, Session: S1', html_url: 'https://example.test/c1', created_at: new Date(Date.now() - ms).toISOString() }]));
  const withPrs = prs => writeIssue({ ...issue(), closedByPullRequestsReferences: { nodes: prs } });

  claimedAgo((2 * 24 + 4) * 3_600_000 + 30 * 60_000);
  withPrs([]);
  assert.match(run('check', '1', '--session', 'S1').stdout, /^claim: 2d 4h ago \(Session S1\), open PR: none$/m);
  withPrs([{ number: 123, state: 'OPEN', repository: { nameWithOwner: 'Test/Example' } }, { number: 99, state: 'MERGED', repository: { nameWithOwner: 'test/example' } }, { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/other' } }]);
  assert.match(run('check', '1', '--session', 'S2').stdout, /^claim: 2d 4h ago \(Session S1\), open PR: #123, test\/other#7$/m, 'Shown to other sessions too; foreign PRs are qualified');
  claimedAgo(5 * 60_000 + 10_000);
  assert.match(run('check', '1').stdout, /^claim: 5m ago \(Session S1\), open PR: #123, test\/other#7$/m);
  writeIssue({ ...issue(), closedByPullRequestsReferences: { totalCount: 150, nodes: [{ number: 5, state: 'OPEN', repository: { nameWithOwner: 'test/example' } }] } });
  assert.match(run('check', '1').stdout, /^claim: 5m ago \(Session S1\), open PR: #5 \(first 1 of 150\)$/m, 'A cut list says so');
  writeFileSync(join(checkout, 'issues-comments.json'), '[]');
  assert.doesNotMatch(run('check', '1').stdout, /^claim:/m, 'No claim, no line');
});

test('reviews reports a moved base with the files both sides changed and never blocks on it', t => {
  const { checkout, run } = fixture(t);
  const look = (moved, changes) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(changes)));
    if (moved === 'unreadable') writeFileSync(join(checkout, 'compare.json'), 'unreadable');
    else if (moved) writeFileSync(join(checkout, 'compare.json'), JSON.stringify(moved));
    else rmSync(join(checkout, 'compare.json'), { force: true });
    return run('reviews', '7');
  };
  const quiet = look(undefined);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /base moved/, 'A base that did not move says nothing');
  assert.doesNotMatch(look({ behind: 0, own: ['a'], base: ['a'] }).stdout, /base moved/);

  const moved = look({ behind: 3, own: ['a.mjs', 'b.mjs'], base: ['b.mjs', 'c.mjs'] });
  assert.equal(moved.status, 0, 'A moved base never changes the verdict');
  assert.match(moved.stdout, /base moved: 3 commits since merge-base/);
  assert.match(moved.stdout, /changed on both sides: b\.mjs$/m);
  assert.match(look({ behind: 1, own: ['a.mjs'], base: ['c.mjs'] }).stdout, /no file is changed on both sides/);

  // More than 100 files come on one page (GitHub's cap is 300), and more shared files than are listed.
  const many = Array.from({ length: 150 }, (_, index) => `file-${index}`);
  assert.match(look({ behind: 1, own: many, base: ['file-149'] }).stdout, /changed on both sides: file-149$/m);
  assert.match(look({ behind: 1, own: many.slice(0, 12), base: many.slice(0, 12) }).stdout, /, and 2 more$/m);

  // A red head reports the movement too: that is when the next push is weighed.
  const red = handoffPr().commits.nodes[0].commit;
  const failed = look({ behind: 2, own: ['a'], base: ['a'] }, { commits: { nodes: [{ commit: { ...red, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
    { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }] } });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /base moved: 2 commits/);

  // A branch name with "#" must reach GitHub whole.
  assert.match(look({ behind: 1, own: ['a'], base: ['a'] }, { baseRefName: 'topic#1' }).stdout, /base moved: 1 commits since merge-base \(topic#1\)/);

  const unreadable = look('unreadable');
  assert.equal(unreadable.status, 0, 'An unreadable comparison keeps the verdict');
  assert.match(unreadable.stdout, /note: base movement unreadable/);
});

test('merge merges the checked head by its full id only when no review is running, and proves the merge', t => {
  const { checkout, run } = fixture(t);
  const merges = join(checkout, 'merges');
  const oid = 'abcdef1' + '0'.repeat(33);
  const commit = handoffPr().commits.nodes[0].commit;
  const withHead = (headRefOid, changes) => handoffPr({ headRefOid, commits: { nodes: [{ commit: { ...commit, oid: headRefOid } }] }, ...changes });
  const write = (pr, comments = []) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
  };
  const codexRunning = { id: 1, user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, html_url: 'u', created_at: pushedAt(), updated_at: pushedAt(),
    body: `| Code Review | ⏳ **Running** <relative-time datetime="${pushedAt()}"></relative-time> | \`abcdef1\` |` };
  const failedCi = { ...commit, oid, statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] } } };
  const refused = [
    ['a reviewer that is still running', withHead(oid), [codexRunning], 3],
    ['an open review request', withHead(oid, { reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { login: 'reviewer' } }] },
      requestEvents: { totalCount: 1, nodes: [{ createdAt: pushedAt(), requestedReviewer: { login: 'reviewer' } }] } }), [], 3],
    ['red CI', withHead(oid, { commits: { nodes: [{ commit: failedCi }] } }), [], 1],
    ['a Draft', withHead(oid, { isDraft: true }), [], 1],
    ['a merged PR', withHead(oid, { state: 'MERGED' }), [], 1],
    ['an unresolved thread', withHead(oid, { threadPages: [[false]] }), [], 1],
    ['conflicts', withHead(oid, { mergeStateStatus: 'DIRTY' }), [], 1],
    ['an undetermined merge state', withHead(oid, { mergeStateStatus: 'UNKNOWN' }), [], 3],
    ['a standing change request', withHead(oid, { latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }), [], 1],
    ['a short head id, which gh --match-head-commit refuses', handoffPr(), [], 2],
  ];
  for (const [label, pr, comments, status] of refused) {
    write(pr, comments);
    const result = run('merge', '7');
    assert.equal(result.status, status, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(existsSync(merges), false, `${label}: gh pr merge is never called`);
  }
  // The refusal names the reviewer that is still running.
  write(withHead(oid), [codexRunning]);
  assert.match(run('merge', '7').stdout, /waiting: chatgpt-codex-connector running since/);
  write(withHead(oid));
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('merge', '7').status, 2, 'An API read failure is unknown, never a merge');
  rmSync(join(checkout, 'fail'));
  assert.equal(existsSync(merges), false);
  assert.equal(run('merge', '7', '--stall', '0').status, 2, 'A bad option is rejected');
  assert.equal(run('merge', '7', '8').status, 2, 'A stray argument is rejected');

  const merged = run('merge', '7');
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.equal(readFileSync(merges, 'utf8'), `merge 7 --repo test/example --merge --match-head-commit ${oid}\n`, 'gh gets the full head id');
  assert.match(merged.stdout, new RegExp(`^MERGED #7 head ${oid} merge commit f{40}$`, 'm'));

  for (const flag of ['merge-fails', 'merge-noop']) {
    rmSync(merges);
    write(withHead(oid));
    writeFileSync(join(checkout, flag), '');
    const result = run('merge', '7');
    assert.equal(result.status, 2, `${flag}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^ERROR$/m);
    assert.doesNotMatch(result.stdout, /^MERGED/m, 'Only a read-back showing the merge counts');
    rmSync(join(checkout, flag));
  }
});
