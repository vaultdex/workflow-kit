import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffComment, handoffFixture, handoffPr, issue, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

// A checkout with one commit, which the Draft PR 7 shows as its head, and the files the fake gh answers from.
function delivery(t, fixtureOf) {
  const { checkout, run, writeIssue } = fixtureOf(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'pushed');
  const head = git('rev-parse', 'HEAD');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  const json = name => JSON.parse(text(name));
  const pr = handoffPr({ id: 'PR7', isDraft: true, headRefOid: head, isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' }, url: 'https://github.com/test/example/pull/7', body: 'Closes #1' });
  pr.commits.nodes[0].commit.oid = head;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('stored'), 'In progress');
  writeFileSync(file('issues-comments.json'), '[]');
  writeFileSync(file('posted-html'), handoffComment().body_html);
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 1, body: '- [ ] first\n- [ ] moved on, see #12\n- [x] done' }));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, body: 'https://github.com/test/example/pull/7', html_url: 'u' }]));
  writeFileSync(file('result.md'), 'Alles geliefert.\n\n### Retro\n\n- Keine Funde\n');
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] } });
  return { run, writeIssue, head, file, text, json };
}

test('done takes the pushed work to Human review: tests, ready, ticked boxes, Automated review, wait, handoff comment', t => {
  const { run, head, text, json } = delivery(t, handoffFixture);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HANDOFF #1/);
  assert.match(text('affected-tests-calls'), /--run/, 'the targeted tests ran');
  assert.equal(json('pr.json').isDraft, false, 'the PR is ready');
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done', 'the box without a follow-up is ticked');
  assert.equal(text('stored'), 'Human review');
  const posted = json('issues-comments.json').at(-1).body;
  assert.match(posted, new RegExp(`^## Übergabe\\n\\nHead: ${head.slice(0, 7)}\\n\\nAlles geliefert\\.\\n\\n### Retro`));

  // The same call again: the comment for this head exists, so there is no second one.
  const comments = json('issues-comments.json').length;
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(json('issues-comments.json').length, comments);
});


test('done closes a PR without a change, puts the result on the issue and moves it to Human review', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('pr.json'), JSON.stringify({ ...json('pr.json'), changedFiles: 0 }));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^CLOSED PR #7 /m);
  assert.equal(json('pr.json').state, 'CLOSED');
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
});

test('done hands a partial PR off without a native link, status or ticked boxes, also when no other PR closes the issue', t => {
  const { run, writeIssue, text, json } = delivery(t, fixture);
  // No PR closes the issue: the PR only names it, and the issue is neither assigned nor in review.
  writeIssue(issue('In progress'));
  const result = run('done', '1', '7', 'result.md', '--refs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^HANDOFF #1 PR #7 /m);
  assert.equal(text('stored'), 'In progress', 'the issue status stays');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'the boxes of the issue stay open');
  assert.equal(json('pr.json').isDraft, false);
});
