import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usedDelta } from '../quota-sample.mjs';

test('quota samples calculate account usage per minute and across reset', () => {
  const previous = { used: 120, resetAt: '2026-10-07T18:00:00Z' };
  assert.equal(usedDelta(undefined, previous), null);
  assert.equal(usedDelta(previous, { used: 127, resetAt: previous.resetAt }), 7);
  assert.equal(usedDelta(previous, { used: 3, resetAt: '2026-10-07T19:00:00Z' }), 3);
});
