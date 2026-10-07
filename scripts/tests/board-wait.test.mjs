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
