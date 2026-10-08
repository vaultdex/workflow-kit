import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffComment, handoffPr, issue, pushedAt, test } from './board-fixture.mjs';


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
    ['a reviewer that is still running', withHead(oid), [codexRunning], 4],
    ['an open review request', withHead(oid, { reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { login: 'reviewer' } }] },
      requestEvents: { totalCount: 1, nodes: [{ createdAt: pushedAt(), requestedReviewer: { login: 'reviewer' } }] } }), [], 4],
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
    const result = run('merge', '7', '--interval', '0', '--max-minutes', '0.01');
    assert.equal(result.status, status, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(existsSync(merges), false, `${label}: gh pr merge is never called`);
    if (label === 'red CI') assert.match(result.stdout, /^FAILED: check CI FAILURE$/m, 'the FAILED line names the red check');
  }
  // An upper layer of a stack is not merged while a layer below is open: that merge would take the lower layer along.
  write(withHead(oid));
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ open: true, pull_requests: [{ number: 5, state: 'open' }, { number: 7, state: 'open' }] }]));
  assert.equal(run('merge', '7').status, 1);
  assert.equal(existsSync(merges), false, 'gh pr merge is never called for an upper layer');
  rmSync(join(checkout, 'stacks.json'));
  // The refusal names the reviewer that is still running.
  write(withHead(oid), [codexRunning]);
  assert.match(run('merge', '7', '--max-minutes', '0.01').stdout, /waiting: chatgpt-codex-connector running since/);
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

/** A checkout whose PR 7 is ready to merge from the branch `claude/7-topic` of this repository; `calls` is what merge did, in order. */
function mergeFixture(t) {
  const { checkout, run } = fixture(t);
  const [first, second] = ['abcdef1', '1234567'].map(prefix => prefix + '0'.repeat(33));
  const commit = handoffPr().commits.nodes[0].commit;
  const headOf = (oid, changes) => ({ headRefOid: oid, commits: { nodes: [{ commit: { ...commit, oid, ...changes } }] } });
  const show = (changes = {}) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ headRefName: 'claude/7-topic', isCrossRepository: false,
      headRepository: { nameWithOwner: 'Test/Example' }, ...headOf(first), ...changes })));
    writeFileSync(join(checkout, 'issues-comments.json'), '[]');
    for (const file of ['calls', 'merges', 'pr-reads.json', 'compare.json', 'dependents.json', 'update-fails', 'delete-fails', 'delete-gone', 'auto-delete', 'merge-403', 'merge-async-late', 'merge-async-fails', 'async-merges']) rmSync(join(checkout, file), { force: true });
  };
  const calls = () => existsSync(join(checkout, 'calls')) ? readFileSync(join(checkout, 'calls'), 'utf8').trim().split('\n') : [];
  const flag = name => writeFileSync(join(checkout, name), '');
  const json = (name, data) => writeFileSync(join(checkout, name), JSON.stringify(data));
  return { checkout, run, show, calls, flag, json, first, second, headOf };
}

test('merge refuses a PR body without the Selbstprüfung section the project asks for', t => {
  const { checkout, run, show, calls } = mergeFixture(t);
  const config = join(checkout, '.github/workflow-project.json'), plain = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...plain, selfReview: ['ponytail-review'] }));
  show({ bodyHTML: '<p>Beschreibung</p>' });
  const refused = run('merge', '7');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /^FAILED$/m);
  assert.deepEqual(calls(), [], 'nothing is merged');
  show({ bodyHTML: '<h2 dir="auto">Selbstprüfung</h2>\n<p>ponytail-review: nichts zu streichen.</p>' });
  assert.equal(run('merge', '7').status, 0);
  assert.deepEqual(calls(), ['merge', 'delete claude/7-topic']);
});

test('merge looks again at a running check from the first look on, merges once it is green, and ends with exit 4 when --max-minutes runs out', t => {
  const { run, show, calls, json, first, headOf } = mergeFixture(t);
  const running = { statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }] } } };

  show();
  json('pr-reads.json', [headOf(first, running), headOf(first)]);
  const merged = run('merge', '7', '--interval', '0', '--max-minutes', '1');
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.deepEqual(calls(), ['merge', 'delete claude/7-topic']);

  show(headOf(first, running));
  const waiting = run('merge', '7', '--interval', '0', '--max-minutes', '0.01');
  assert.equal(waiting.status, 4, waiting.stdout + waiting.stderr);
  assert.match(waiting.stdout, /call merge again/);
  assert.deepEqual(calls(), [], 'nothing is merged');
});

test('merge merges a base that moved under the same files into the PR branch, waits for CI on the new head, then merges', t => {
  const { checkout, run, show, calls, flag, json, first, second, headOf } = mergeFixture(t);
  const running = { statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }] } } };
  // GitHub shows the previous head for one more read after the update, then the new one.
  const staleThenNew = (...overlays) => json('pr-reads.json', [{}, {}, ...overlays]);

  show();
  json('compare.json', { behind: 2, own: ['a.txt', 'b.txt'], base: ['a.txt', 'c.txt'] });
  staleThenNew(headOf(second));
  const updated = run('merge', '7', '--interval', '0');
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.deepEqual(calls(), [`update-branch ${first}`, 'merge', 'delete claude/7-topic'], 'update first, then the merge of the new head, then the branch');
  assert.match(updated.stdout, new RegExp(`^MERGED #7 head ${second} `, 'm'), 'the new head is the one merged');

  // The new head's CI still runs: nothing is merged, the next call continues.
  show();
  json('compare.json', { behind: 2, own: ['a.txt'], base: ['a.txt'] });
  staleThenNew(headOf(second, running));
  const waiting = run('merge', '7', '--interval', '0', '--max-minutes', '0.01');
  assert.equal(waiting.status, 4, waiting.stdout + waiting.stderr);
  assert.deepEqual(calls(), [`update-branch ${first}`]);

  // The base moved without touching the PR's files: no update, straight to the merge.
  show();
  json('compare.json', { behind: 2, own: ['a.txt'], base: ['c.txt'] });
  assert.equal(run('merge', '7').status, 0);
  assert.deepEqual(calls(), ['merge', 'delete claude/7-topic']);

  // GitHub refuses the update (conflict, or another head): an error, never a merge of the old head.
  show();
  json('compare.json', { behind: 2, own: ['a.txt'], base: ['a.txt'] });
  flag('update-fails');
  const refused = run('merge', '7');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.deepEqual(calls(), [`update-branch ${first}`]);

  // A PR with stacked children: GitHub answers 403 to the update. Nothing is merged or pushed; the manual way is named.
  // The exact text of GitHub (#332), with and without its status code.
  for (const kind of ['403', 'no-code']) {
    show();
    json('compare.json', { behind: 2, own: ['a.txt'], base: ['a.txt'] });
    writeFileSync(join(checkout, 'update-fails'), kind);
    const stacked = run('merge', '7');
    assert.equal(stacked.status, 1, kind + stacked.stdout + stacked.stderr);
    assert.match(stacked.stdout, /^blocker: .*`git merge origin\/\S+`.*`board\.mjs merge 7`/m);
    // The raw refusal of gh is not copied to stderr: a caller that reads the last line of the output sees the instruction.
    assert.equal(stacked.stderr, '');
    assert.deepEqual(calls(), [`update-branch ${first}`]);
  }
});

test('merge merges the base for a red check from updateBranchChecks, but only when it is the sole reason', t => {
  const { checkout, run, show, calls, json, first, second, headOf } = mergeFixture(t);
  const red = name => ({ statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' }] } } });
  const restart = red('Restart CI after retarget');
  const config = join(checkout, '.github/workflow-project.json'), plain = JSON.parse(readFileSync(config, 'utf8'));

  // Without the setting the red check is a plain FAILED.
  show(headOf(first, restart));
  assert.equal(run('merge', '7').status, 1);
  assert.deepEqual(calls(), []);

  writeFileSync(config, JSON.stringify({ ...plain, updateBranchChecks: ['Restart CI after retarget'] }));
  // wait names the way out instead of ending in a bare FAILED.
  show(headOf(first, restart));
  assert.match(run('wait', '7').stdout, /^FAILED: check Restart CI after retarget FAILURE asks for the base: run board\.mjs merge 7/m);

  show(headOf(first, restart));
  json('pr-reads.json', [{}, {}, headOf(second)]);
  const merged = run('merge', '7', '--interval', '0');
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.deepEqual(calls(), [`update-branch ${first}`, 'merge', 'delete claude/7-topic']);

  // Another red check next to it is a real failure: no update.
  const both = { statusCheckRollup: { contexts: { totalCount: 2, nodes: [...restart.statusCheckRollup.contexts.nodes, ...red('CI').statusCheckRollup.contexts.nodes] } } };
  show(headOf(first, both));
  assert.equal(run('merge', '7').status, 1);
  assert.deepEqual(calls(), []);
});

test('merge gives both CI waits around a base update one shared --max-minutes deadline', t => {
  const { checkout, run, show, calls, json, first, second, headOf } = mergeFixture(t);
  const check = (conclusion, status = 'COMPLETED', name = 'Restart CI after retarget') => ({ statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name, status, conclusion }] } } });
  const config = join(checkout, '.github/workflow-project.json'), plain = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...plain, updateBranchChecks: ['Restart CI after retarget'] }));
  // The restart check fails only when the deadline (0.3 s) is reached; the new head's CI is still running, then green.
  show(headOf(first, check(null, 'IN_PROGRESS')));
  json('pr-reads.json', [{}, headOf(first, check('FAILURE')), headOf(second, check(null, 'IN_PROGRESS', 'CI')), headOf(second, check(null, 'IN_PROGRESS', 'CI')), headOf(second)]);
  const waiting = run('merge', '7', '--interval', '0.4', '--max-minutes', '0.005');
  assert.equal(waiting.status, 4, waiting.stdout + waiting.stderr);
  assert.deepEqual(calls(), [`update-branch ${first}`], 'the second wait has no time left of its own: nothing is merged');
});

test('merge falls back to merge-async with the checked head when gh refuses a PR with stacked children, and reads the merge back', t => {
  const { checkout, run, show, calls, flag, first } = mergeFixture(t);
  const asyncMerges = () => readFileSync(join(checkout, 'async-merges'), 'utf8');
  // The 403 is no reason for a second plain merge: merge-async once, the merge shows at once or on a later read.
  for (const late of [false, true]) {
    show();
    flag('merge-403');
    if (late) flag('merge-async-late');
    const result = run('merge', '7', '--interval', '0');
    assert.equal(result.status, 0, `late ${late}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, '', 'the refusal handled by merge-async is not copied to stderr');
    assert.deepEqual(calls(), ['merge', 'merge-async', 'delete claude/7-topic']);
    assert.equal(asyncMerges(), `merge_action=direct_merge merge_method=merge sha=${first}\n`);
    assert.match(result.stdout, new RegExp(`^MERGED #7 head ${first} `, 'm'));
  }
  // The REST merge answers a stack with HTTP 403.
  show();
  writeFileSync(join(checkout, 'merge-403'), 'gh: Forbidden (HTTP 403)');
  const rest = run('merge', '7', '--interval', '0');
  assert.equal(rest.status, 0, rest.stdout + rest.stderr);
  assert.match(rest.stdout, new RegExp(`^MERGED #7 head ${first} `, 'm'));
  assert.deepEqual(calls(), ['merge', 'merge-async', 'delete claude/7-topic']);
  // A "forbidden" without stack reference is a plain refusal: an error, no merge-async.
  show();
  writeFileSync(join(checkout, 'merge-403'), 'GraphQL: Resource not accessible by integration (forbidden)');
  const plain = run('merge', '7');
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  assert.deepEqual(calls(), ['merge']);
  // merge-async refused too: an error, no third try.
  show();
  flag('merge-403');
  flag('merge-async-fails');
  const refused = run('merge', '7');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.deepEqual(calls(), ['merge', 'merge-async']);
});

test('merge deletes the head branch only when nothing else needs it, and the merge stands when the delete fails', t => {
  const { run, show, calls, flag, json } = mergeFixture(t);
  const dependent = (number, ref) => ({ number, base: { ref } });
  const cases = [
    ['a free branch is deleted', {}, () => {}, ['merge', 'delete claude/7-topic']],
    ['the base of an open PR (a stack) is kept', {}, () => json('dependents.json', [dependent(8, 'claude/7-topic')]), ['merge']],
    ['an open PR on another base does not hold it', {}, () => json('dependents.json', [dependent(9, 'main')]), ['merge', 'delete claude/7-topic']],
    ['a repository that deletes merged branches itself is left alone', {}, () => flag('auto-delete'), ['merge']],
    ['a branch of a fork is kept', { isCrossRepository: true, headRepository: { nameWithOwner: 'someone/example' } }, () => {}, ['merge']],
    ['the default branch is kept', { headRefName: 'main' }, () => {}, ['merge']],
    ['a branch that is already gone is no failure', {}, () => flag('delete-gone'), ['merge', 'delete claude/7-topic']],
    ['a refused delete is a note, not an error', {}, () => flag('delete-fails'), ['merge', 'delete claude/7-topic']],
  ];
  for (const [label, changes, prepare, expected] of cases) {
    show(changes);
    prepare();
    const result = run('merge', '7');
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^MERGED #7 /m, label);
    assert.deepEqual(calls(), expected, label);
  }
  // No merge, no delete.
  show({ mergeStateStatus: 'DIRTY' });
  assert.equal(run('merge', '7').status, 1);
  assert.deepEqual(calls(), []);
});

test('merge refuses an unknown flag before any write', t => {
  fixture(t).refusesUnknownFlag('merge', '7');
});

test('merge --stack gates every layer, merges only the top through merge-async and reports each layer (#389)', t => {
  const { checkout, run, show, calls, flag, json, first, second, headOf } = mergeFixture(t);
  const redCi = { statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] } } };
  // The layer below has a red CI: only the top head's CI counts.
  const layer = changes => handoffPr({ number: 5, headRefName: 'claude/5-lower', isCrossRepository: false, headRepository: { nameWithOwner: 'Test/Example' },
    ...headOf(second, redCi), ...changes });
  const handoff = head => handoffComment({ id: head === first ? 900 : 901, body: `## Übergabe\n\nHead: ${head.slice(0, 7)}\n\n### Retro\n\n- Keine Funde` });
  const complete = [handoff(first), handoff(second)];
  const prepare = ({ lower = layer(), comments = complete, members = [5, 7], status = 'Human review' } = {}) => {
    show();
    json('stacks.json', [{ number: 42, open: true, base: { ref: 'release/0.1.1' }, pull_requests: members.map(number => ({ number, state: 'open' })) }]);
    json('stack-prs.json', { 5: lower });
    json('issues-comments.json', comments);
    json('issue.json', issue(status));
  };
  const asyncMerges = () => readFileSync(join(checkout, 'async-merges'), 'utf8');

  // A layer that lacks something is named, and nothing is merged.
  const refused = [
    ['a layer without a handoff comment for its head', { comments: [handoff(first)] }, /^blocker: PR #5 has no handoff comment for head 1234567/m],
    ['a layer with an open thread', { lower: layer({ threadPages: [[false]] }) }, /^blocker: PR #5 has 1 unresolved review thread/m],
    ['a layer with a change request', { lower: layer({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }) },
      /^blocker: PR #5 has a change request by reviewer/m],
    ['an issue that is not in Human review', { status: 'In progress' }, /^blocker: PR #5 delivers issue #1, whose status is In progress/m],
    ['a PR that is not the top', { members: [5, 7, 8] }, /^blocker: PR #8 is above PR #7/m],
  ];
  for (const [label, setup, expected] of refused) {
    prepare(setup);
    const result = run('merge', '7', '--stack', '--interval', '0');
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, expected, label);
    assert.deepEqual(calls(), [], `${label}: nothing is merged`);
  }
  prepare();
  rmSync(join(checkout, 'stacks.json'));
  assert.match(run('merge', '7', '--stack').stdout, /^blocker: PR #7 is not in a native stack/m);

  // The trunk gained commits under files the stack changes: the driver merges it into the top layer (update-branch would only merge the layer below).
  prepare();
  json('compare.json', { behind: 2, own: ['a.txt'], base: ['a.txt'] });
  const moved = run('merge', '7', '--stack', '--interval', '0');
  assert.equal(moved.status, 1, moved.stdout + moved.stderr);
  assert.match(moved.stdout, /^blocker: release\/0\.1\.1 gained 2 commits .*`git merge origin\/release\/0\.1\.1`.*`board\.mjs merge 7 --stack`/m);
  assert.deepEqual(calls(), []);

  // Complete layers: one merge-async of the top head, no plain merge, no update; every layer shows as merged, with its issue and branch.
  prepare();
  const merged = run('merge', '7', '--stack', '--interval', '0');
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.deepEqual(calls(), ['merge-async', 'delete claude/5-lower', 'delete claude/7-topic']);
  assert.equal(asyncMerges(), `merge_action=direct_merge merge_method=merge sha=${first}\n`, 'only the top head goes to GitHub');
  assert.match(merged.stdout, new RegExp(`^MERGED #7 head ${first} merge commit f{40}$`, 'm'));
  assert.match(merged.stdout, new RegExp(`^MERGED #5 head ${second} merge commit f{40}$`, 'm'));
  assert.match(merged.stdout, /^issue #1 \(PR #5\): open, status Human review$/m);
  assert.match(merged.stdout, /^issue #1 \(PR #7\): open, status Human review$/m);

  // A layer that GitHub did not merge with the top is not hidden: ERROR exit, no branch delete for it.
  prepare();
  flag('stack-layers-stay');
  const stayed = run('merge', '7', '--stack', '--interval', '0');
  assert.equal(stayed.status, 2, stayed.stdout + stayed.stderr);
  assert.match(stayed.stdout, /^NOT MERGED \(OPEN\) #5 /m);
  assert.deepEqual(calls(), ['merge-async', 'delete claude/7-topic']);
});
