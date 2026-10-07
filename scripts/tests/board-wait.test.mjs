import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewsFixture, test } from './board-fixture.mjs';

test('wait ends at once on merge conflicts of a non-draft PR and ignores every other merge state', t => {
  const { checkout, minutesAgo, pr, look, reviews } = reviewsFixture(t);
  // Conflicts start no workflow: without any check, a non-draft PR would wait for "first CI check" forever.
  const noCi = mergeStateStatus => look({ ...pr({ contexts: [] }), isDraft: false, mergeStateStatus });
  const conflicted = noCi('DIRTY');
  assert.equal(conflicted.status, 1, 'Merge conflicts end the wait at once, however little CI there is');
  assert.match(conflicted.stdout, /^FAILED$/m);
  assert.match(conflicted.stdout, /^blocker: merge conflicts$/m);
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(noCi('DIRTY').status, 1, 'A later read failure keeps the known conflict verdict');
  rmSync(join(checkout, 'fail-rest'));
  for (const state of ['UNKNOWN', 'BEHIND']) assert.equal(noCi(state).status, 3, `${state} keeps waiting`);
  assert.equal(look({ ...pr({ contexts: [] }), mergeStateStatus: 'DIRTY' }).status, 3, 'A draft with conflicts keeps waiting');
  const readied = { ...pr({ pushed: 5 }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(5) }] } };
  assert.equal(reviews({ ...readied, mergeStateStatus: 'BEHIND' }), 0, 'BEHIND is no conflict');
});

test('wait --head keeps waiting while the PR still shows the previous head, and a closed PR ends it', t => {
  const { checkout, run, runBriefly, pr } = reviewsFixture(t);
  const [old, pushed] = ['a', 'b'].map(letter => letter.repeat(40));
  const show = (head, changes) => {
    const data = pr(); // CI is green, so only the head can keep this PR waiting
    data.headRefOid = data.commits.nodes[0].commit.oid = head;
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...data, ...changes }));
    for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments', 'comments-reactions', 'pulls-reviews']) writeFileSync(join(checkout, `${file}.json`), '[]');
  };
  show(old);
  assert.equal(run('wait', '7').status, 0, 'Precondition: without --head the old head is DONE');
  assert.match(runBriefly(3000, 'wait', '7', '--head', pushed), /^WAITING\nwaiting: PR still shows head aaaaaaa, expected bbbbbbb/, 'The old head keeps waiting');
  show(pushed);
  assert.equal(run('wait', '7', '--head', pushed).status, 0, 'The expected head is DONE');
  show(old, { state: 'CLOSED' });
  assert.equal(run('wait', '7', '--head', pushed).status, 1, 'A closed PR ends the wait whatever its head');
  const short = run('wait', '7', '--head', 'bbbbbbb');
  assert.equal(short.status, 2, 'A short id is refused');
  assert.match(short.stderr, /full 40-character commit id/, 'and the reason is named, not just the usage line');
  assert.equal(run('reviews', '7', '--head', pushed).status, 2, '--head belongs to wait');
});

test('wait gives up before the tool limit with exit 4 and names the quota reset when a pause would outlast it', t => {
  const { checkout, run, check, pr, look } = reviewsFixture(t);
  assert.equal(look(pr({ contexts: [check('IN_PROGRESS')] })).status, 3, 'Precondition: CI never finishes');
  const unfinished = run('wait', '7', '--max-minutes', '0.01');
  assert.equal(unfinished.status, 4, 'An unfinished wait ends with its own exit code');
  assert.match(unfinished.stdout, /^still waiting: call wait again$/m);
  // The fake gh reports an empty quota that resets in 3 s: sleeping until then would pass the deadline.
  writeFileSync(join(checkout, 'quota-left'), '0');
  const paused = run('wait', '7', '--max-minutes', '0.01');
  assert.equal(paused.status, 4);
  assert.match(paused.stdout, /^still waiting: call wait again after \d{4}-\d\d-\d\dT[\d:.]+Z \(GitHub quota pause\)$/m);
  assert.equal(run('wait', '7', '--max-minutes', 'abc').status, 2, 'A bad limit is refused, not read as no limit');
  assert.equal(run('reviews', '7', '--max-minutes', '1').status, 2, '--max-minutes belongs to wait');
});

// `wait` asks REST whether anything changed and reads GraphQL (the PR, then its review threads) only when it did (#324).
// --interval 0 makes many rounds out of the short --max-minutes; the fake gh counts the REST reads of the PR in rest-reads.
function restFixture(t) {
  const fixture = reviewsFixture(t);
  const { checkout, queries } = fixture;
  return {
    ...fixture,
    show: data => {
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
      for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments', 'comments-reactions', 'pulls-reviews']) writeFileSync(join(checkout, `${file}.json`), '[]');
    },
    restReads: () => readFileSync(join(checkout, 'rest-reads'), 'utf8').trim().split('\n').length,
    // The GraphQL reads of the PR and of its review threads since the last call.
    graphqlReads: () => {
      const sent = queries();
      return { pr: sent.filter(query => query.includes('readyEvents')).length, threads: sent.filter(query => query.includes('reviewThreads')).length, all: sent.length };
    },
  };
}

test('wait reads GraphQL once while REST shows no change, and once more per change', t => {
  const { checkout, run, check, pr, show, restReads, graphqlReads } = restFixture(t);
  show(pr({ contexts: [check('IN_PROGRESS')] })); // CI never finishes
  assert.equal(run('wait', '7', '--interval', '0', '--max-minutes', '0.02').status, 4, 'Precondition: the wait is still waiting');
  assert.ok(restReads() >= 3, 'Precondition: several rounds ran');
  assert.deepEqual(graphqlReads(), { pr: 1, threads: 1, all: 2 }, 'Many rounds without a change: one read of the PR (and of its threads)');

  // The third look at REST shows a new update time, the later ones keep it.
  writeFileSync(join(checkout, 'pr-rest-reads.json'), JSON.stringify([{}, {}, { updatedAt: 'later' }]));
  assert.equal(run('wait', '7', '--interval', '0', '--max-minutes', '0.02').status, 4);
  assert.deepEqual(graphqlReads(), { pr: 2, threads: 2, all: 4 }, 'The change costs exactly one more read of the PR (and of its threads)');
});

test('wait confirms every end with a full read', t => {
  const { run, check, readyHead, show, graphqlReads } = restFixture(t);
  // Ready since 5 minutes with a 5 minute and 2 second grace: the cached look says "waiting" first, then "done" once the clock passed the grace.
  show(readyHead([check('COMPLETED')]));
  const result = run('wait', '7', '--interval', '0', '--max-minutes', '0.2', '--grace', String(5 + 2 / 60));
  assert.equal(result.status, 0, 'The grace ends the wait');
  assert.deepEqual(graphqlReads(), { pr: 2, threads: 2, all: 4 }, 'The first read, and the full read that confirms the end');
});

test('wait --merged reads REST only, and --interval is bounded', t => {
  const { run, pr, show, graphqlReads } = restFixture(t);
  show(pr());
  assert.equal(run('wait', '7', '--merged', '--interval', '0', '--max-minutes', '0.02').status, 4, 'An open PR keeps waiting');
  show({ ...pr(), state: 'MERGED' });
  assert.equal(run('wait', '7', '--merged').status, 0);
  assert.equal(graphqlReads().all, 0, 'No GraphQL point is spent while waiting for the merge');
  assert.equal(run('wait', '7', '--interval', '301').status, 2, 'A pause above 5 minutes is refused');
  assert.equal(run('wait', '7', '--interval', 'x').status, 2, 'and so is a bad one');
});
