import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffPr, pushedAt, test } from './board-fixture.mjs';


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
  // An upper layer of a stack is not merged while a layer below is open: that merge would take the lower layer along.
  write(withHead(oid));
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ open: true, pull_requests: [{ number: 5, state: 'open' }, { number: 7, state: 'open' }] }]));
  assert.equal(run('merge', '7').status, 1);
  assert.equal(existsSync(merges), false, 'gh pr merge is never called for an upper layer');
  rmSync(join(checkout, 'stacks.json'));
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
