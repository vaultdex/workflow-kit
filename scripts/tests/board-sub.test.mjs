import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';


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
