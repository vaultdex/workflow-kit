import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';

test('sweep sends a Human-review issue with a conflicting PR back to Automated review with a comment and leaves the others alone', t => {
  const { checkout, run, queries } = fixture(t);
  const pr = (mergeStateStatus, changes) => ({ number: 70, url: 'https://github.com/test/example/pull/70', mergeStateStatus, repository: { nameWithOwner: 'test/example' }, ...changes });
  const row = (number, status, prs = []) => ({ ...issue(status), number, id: `I${number}`,
    projectItems: { nodes: [{ id: `PI${number}`, project: { id: 'P1' }, status: status && { name: status } }] }, closedByPullRequestsReferences: { totalCount: prs.length, nodes: prs } });
  const targets = () => existsSync(join(checkout, 'mutation-targets')) ? readFileSync(join(checkout, 'mutation-targets'), 'utf8').trim().split('\n') : [];
  const untouched = (label, rows) => {
    rmSync(join(checkout, 'mutations'), { force: true });
    writeFileSync(join(checkout, 'search.json'), JSON.stringify(rows));
    const result = run('sweep');
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^clean$/m, label);
    assert.equal(existsSync(join(checkout, 'mutations')), false, `${label}: nothing is written`);
  };

  // Clean PRs, PRs still being computed, other statuses, no open PR and a PR of another repository are not touched; one query reads them all.
  untouched('nothing to reset', [row(1, 'Human review', [pr('CLEAN')]), row(2, 'Human review', [pr('UNKNOWN')]), row(3, 'Human review'),
    row(4, 'Automated review', [pr('DIRTY')]), row(5, 'In progress', [pr('DIRTY')]), row(6, undefined, [pr('DIRTY')]),
    row(7, 'Human review', [pr('DIRTY', { repository: { nameWithOwner: 'someone/else' } })])]);
  assert.equal(queries().length, 1, 'A clean sweep costs one query');
  // A lower stack layer (an open PR is based on its branch) conflicts with its own base until the top PR merges it: it stays in Human review (#405).
  writeFileSync(join(checkout, 'dependents.json'), JSON.stringify([{ number: 71, base: { ref: 'claude/9-lower' } }]));
  untouched('lower stack layer', [row(9, 'Human review', [pr('DIRTY', { headRefName: 'claude/9-lower' })])]);
  rmSync(join(checkout, 'dependents.json'));

  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Human review', [pr('CLEAN')]), row(2, 'Human review', [pr('DIRTY')]), row(3, 'Automated review', [pr('DIRTY')])]));
  const result = run('sweep');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^#2 reset to Automated review: PR #70 has merge conflicts$/m);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Automated review');
  assert.deepEqual(targets(), ['issue=I2', 'item=PI2'], 'Only issue 2 got its comment (first) and its status');

  // A list that is cut off (more linked PRs than read, more open issues than the search returns) never ends as "clean".
  const cut = { ...row(8, 'Human review', [pr('CLEAN')]) };
  cut.closedByPullRequestsReferences.totalCount = 11;
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([cut]));
  assert.notEqual(run('sweep').status, 0, 'a truncated PR list is not clean');
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Human review', [pr('CLEAN')])]));
  writeFileSync(join(checkout, 'truncate'), '');
  assert.notEqual(run('sweep').status, 0, 'a capped search is not clean');
  rmSync(join(checkout, 'truncate'));

  assert.equal(run('sweep', 'extra').status, 2, 'A word after sweep is refused before any write');
});
