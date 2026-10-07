import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, predecessor, test } from './board-fixture.mjs';


test('next lists stackable Ready issues with their base PR apart from blocked ones', t => {
  const { checkout, run } = fixture(t);
  const pr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/5-base' };
  const ready = (number, nodes) => ({ ...issue('Ready', nodes), number, issueFieldValues: { nodes: [] } });
  const open = prs => predecessor('OPEN', null, prs, { repository: { nameWithOwner: 'test/example' } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([ready(1, [open([pr])]), ready(2, [open([])]), ready(3, [predecessor('CLOSED', 'COMPLETED')])]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, stackable, held] = result.stdout.split('\n\n');
  assert.deepEqual(startable.match(/^#\d+/gm), ['#3']);
  assert.deepEqual(stackable.match(/^#\d+/gm), ['#1']);
  assert.ok(stackable.includes('base PR #5'), 'The base PR is named');
  assert.deepEqual(held.match(/^#\d+/gm), ['#2']);
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
