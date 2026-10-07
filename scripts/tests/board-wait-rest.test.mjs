import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewsFixture, test } from './board-fixture.mjs';

// `wait` asks REST whether anything changed and reads GraphQL (the PR, then its review threads) only when it did (#324).
// --interval 0 makes many rounds out of the short --max-minutes; the fake gh counts the REST reads of the PR in rest-reads.
const restReads = checkout => readFileSync(join(checkout, 'rest-reads'), 'utf8').trim().split('\n').length;

function waitFixture(t) {
  const fixture = reviewsFixture(t);
  const { checkout, queries } = fixture;
  return {
    ...fixture,
    show: data => {
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
      for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments', 'comments-reactions', 'pulls-reviews']) writeFileSync(join(checkout, `${file}.json`), '[]');
    },
    // The GraphQL reads of the PR and of its review threads since the last call.
    graphqlReads: () => {
      const sent = queries();
      return { pr: sent.filter(query => query.includes('readyEvents')).length, threads: sent.filter(query => query.includes('reviewThreads')).length, other: sent.length };
    },
  };
}

test('wait reads GraphQL once while REST shows no change, and once more per change', t => {
  const { checkout, run, check, pr, show, graphqlReads } = waitFixture(t);
  show(pr({ contexts: [check('IN_PROGRESS')] })); // CI never finishes
  const unchanged = run('wait', '7', '--interval', '0', '--max-minutes', '0.02');
  assert.equal(unchanged.status, 4, 'Precondition: the wait is still waiting');
  assert.ok(restReads(checkout) >= 3, 'Precondition: several rounds ran');
  assert.deepEqual(graphqlReads(), { pr: 1, threads: 1, other: 2 }, 'Many rounds without a change: one read of the PR and one of its threads');

  // The third look at REST shows a new update time, the later ones keep it.
  writeFileSync(join(checkout, 'rest-reads'), '');
  writeFileSync(join(checkout, 'pr-rest-reads.json'), JSON.stringify([{}, {}, { updatedAt: 'later' }]));
  assert.equal(run('wait', '7', '--interval', '0', '--max-minutes', '0.02').status, 4);
  assert.deepEqual(graphqlReads(), { pr: 2, threads: 2, other: 4 }, 'The change costs exactly one more read');
});

test('wait confirms every end with a full read', t => {
  const { run, check, readyHead, show, graphqlReads } = waitFixture(t);
  // Ready since 5 minutes with a 5 minute and 2 second grace: the cached look says "waiting" first, then "done" once the clock passed the grace.
  show(readyHead([check('COMPLETED')]));
  const result = run('wait', '7', '--interval', '0', '--max-minutes', '0.2', '--grace', String(5 + 2 / 60));
  assert.equal(result.status, 0, 'The grace ends the wait');
  assert.match(result.stdout, /^WAITING\nwaiting: reviewers may still start/, 'Precondition: it waited for the grace first');
  assert.match(result.stdout, /^DONE$/m);
  assert.deepEqual(graphqlReads(), { pr: 2, threads: 2, other: 4 }, 'The first read, and the full read that confirms the end');
});

test('wait --merged reads REST only', t => {
  const { checkout, run, pr, show, graphqlReads } = waitFixture(t);
  show(pr());
  assert.equal(run('wait', '7', '--merged', '--interval', '0', '--max-minutes', '0.02').status, 4, 'An open PR keeps waiting');
  show({ ...pr(), state: 'MERGED' });
  const merged = run('wait', '7', '--merged');
  assert.equal(merged.status, 0);
  assert.match(merged.stdout, /^#7 MERGED$/m);
  assert.equal(graphqlReads().other, 0, 'No GraphQL point is spent while waiting for the merge');
  assert.ok(restReads(checkout) >= 2);
  assert.equal(run('wait', '7', '--interval', '301').status, 2, 'A pause above 5 minutes is refused');
  assert.equal(run('wait', '7', '--interval', 'x').status, 2, 'and so is a bad one');
});
