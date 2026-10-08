import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffPr, issue, test } from './board-fixture.mjs';


test('link connects the issue natively to the PR, repeats safely and trusts only the read-back', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const commentWrites = () => existsSync(join(checkout, 'comment-writes')) ? readFileSync(join(checkout, 'comment-writes'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = (changes = {}) => {
    for (const file of ['mutations', 'link-noop', 'fail', 'comment-writes', 'comment-noop']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: false, linkPages: [[]],
      url: 'https://github.com/test/example/pull/7', body: 'Refs #1', ...changes })));
    writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
    writeFileSync(join(checkout, 'backlink-comments-1.json'), '[]');
  };

  prepare();
  let result = run('link', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(mutations(), 1, 'A Draft PR is connected with one write');
  assert.match(readFileSync(join(checkout, 'mutations'), 'utf8'), /addCloseIssueReferences\(input:\{issueId:\$issue,pullRequestIds:\[\$pr\]\}\)/);
  assert.equal(commentWrites(), 1, 'The missing backlink comment is written once');
  result = run('status', '1', 'Automated review', '7');
  assert.equal(result.status, 0, 'The guard accepts what link wrote: ' + result.stdout + result.stderr);

  result = run('link', '1', '7');
  assert.equal(result.status, 0, 'A second run finds the link already there');
  assert.equal(readFileSync(join(checkout, 'mutations'), 'utf8').match(/addCloseIssueReferences/g).length, 1, 'No second link write');
  assert.equal(commentWrites(), 1, 'No second comment');

  prepare();
  writeFileSync(join(checkout, 'link-delay'), '2');
  result = run('link', '1', '7');
  assert.equal(result.status, 0, 'A connection GitHub shows only after a delay is read back repeatedly: ' + result.stdout + result.stderr);
  assert.equal(mutations(), 1, 'The write is not repeated while waiting');
  rmSync(join(checkout, 'link-delay'));

  prepare({ state: 'CLOSED' });
  assert.equal(run('link', '1', '7').status, 2, 'A closed PR is never linked');
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'link-noop'), '');
  result = run('link', '1', '7');
  assert.equal(result.status, 2, 'A write whose read-back lacks the issue is no success');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(mutations(), 1, 'The write is not repeated blindly');

  prepare({ linkPages: [['I1']] });
  writeFileSync(join(checkout, 'comment-noop'), '');
  result = run('link', '1', '7');
  assert.equal(result.status, 2, 'A comment the read-back does not show is no success');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(commentWrites(), 1, 'The comment is not written again blindly');

  prepare();
  writeIssue({ ...issue('In progress'), state: 'CLOSED' });
  assert.equal(run('link', '1', '7').status, 2, 'A closed issue takes no backlink');
  assert.equal(mutations() + commentWrites(), 0, 'and is refused before any write');
  writeIssue(issue('In progress'));

  prepare();
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('link', '1', '7').status, 2, 'An API error is ERROR');
  assert.equal(mutations(), 0);

  assert.equal(run('link', '1', 'seven').status, 2, 'Only a PR number is accepted');
});

test('link refuses an unknown flag before any write', t => {
  fixture(t).refusesUnknownFlag('link', '1', '7');
});
