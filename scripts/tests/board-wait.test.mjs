import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(run('wait', '7', '--head', 'bbbbbbb').status, 2, 'A short id is refused');
  assert.equal(run('reviews', '7', '--head', pushed).status, 2, '--head belongs to wait');
});
