import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryAt, waitInterval } from '../quota.mjs';
import { fixture, handoffPr, issue, test } from './board-fixture.mjs';

test('a used-up GraphQL quota is waited out by reviews and reported by the other commands', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeIssue(issue());
  writeFileSync(join(checkout, 'limited'), '');
  const started = Date.now();
  const waited = run('reviews', '7');
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.ok(Date.now() - started >= 1000, 'The command slept until the reset (a second away) before asking again');
  assert.equal(existsSync(join(checkout, 'limited')), false, 'The refused query was asked again');
  writeFileSync(join(checkout, 'limited'), '');
  const stopped = run('check', '1');
  assert.equal(stopped.status, 2, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /\d{4}-\d\d-\d\dT/, 'Commands that cannot wait name the time to try again');
});

test('little quota left makes reviews wait for the reset before the next query', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeFileSync(join(checkout, 'quota-left'), '10');
  const started = Date.now();
  const result = run('reviews', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The fixture reports the reset 3 seconds after its first answer, so a run that did not wait for it ends sooner.
  assert.ok(Date.now() - started >= 3000, 'The second query waited for the reset');
});

test('wait pauses longer with every quiet read and, below 1000 points left, twice as long', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(reads => waitInterval(reads, 5000)), [60, 90, 135, 202.5, 300, 300, 300]);
  for (const reads of [0, 3, 9]) assert.ok(waitInterval(reads, 999) > waitInterval(reads, 1000), 'Little quota left lengthens the pause');
  assert.equal(waitInterval(0, undefined), 60, 'An unknown quota changes nothing');
});

test('a secondary limit is retried within minutes, only the primary one waits for the hourly reset', () => {
  const now = Date.parse('2026-10-07T00:00:00Z'), hourly = () => '2026-10-07T00:55:00.000Z';
  const secondary = 'You have exceeded a secondary rate limit';
  assert.deepEqual([0, 1, 2].map(refusals => retryAt(secondary, refusals, hourly, now)),
    ['2026-10-07T00:01:00.000Z', '2026-10-07T00:02:00.000Z', '2026-10-07T00:04:00.000Z']);
  assert.equal(retryAt('API rate limit already exceeded for user ID 1', 0, hourly, now), hourly());
});
