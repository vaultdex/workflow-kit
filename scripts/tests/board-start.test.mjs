import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('start takes a Ready issue to a Draft PR that closes it, and the same call resumes', t => {
  const { checkout, run, writeIssue, env } = fixture(t);
  env.CODEX_THREAD_ID = '';
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  const origin = join(dirname(checkout), 'origin.git');
  git(dirname(checkout), 'init', '-q', '--bare', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  // start commits too, so the identity lives in the checkout (a CI runner has none).
  git(checkout, 'config', 'user.name', 't');
  git(checkout, 'config', 'user.email', 't@t');
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'origin', origin);
  // The branch `gh issue develop` makes on GitHub.
  git(checkout, 'push', '-q', 'origin', 'main', 'main:refs/heads/claude/1-fixture');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]], url: 'https://github.com/test/example/pull/7' })));
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
  writeFileSync(file('backlink-comments-1.json'), '[]');

  // A blocked issue is refused by the check, before anything is written.
  writeIssue(issue('Ready', [predecessor('OPEN', null)]));
  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const written of ['develops', 'comment-writes', 'created-pr', 'stored']) assert.equal(existsSync(file(written)), false, written);

  writeIssue(issue('Ready'));
  // A change the driver staged before the start is theirs: the first commit of start does not take it.
  writeFileSync(file('staged.txt'), 'x');
  git(checkout, 'add', 'staged.txt');
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'diff', '--cached', '--name-only'), 'staged.txt', 'still staged');
  assert.equal(git(checkout, 'ls-tree', '-r', '--name-only', 'origin/claude/1-fixture'), '', 'not in the pushed commit');
  assert.match(result.stdout, /^START #1 session S1 branch claude\/1-fixture base main PR #7$/m);
  assert.equal(text('stored'), 'In progress');
  assert.equal(JSON.parse(text('issue.json')).assignees.nodes[0].login, 'worker');
  assert.match(JSON.parse(text('backlink-comments-1.json'))[0].body, /^Agent: claude, Session: S1\n$/);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(git(checkout, 'rev-list', '--count', 'origin/main..origin/claude/1-fixture'), '1', 'the branch is pushed with its first commit');
  const created = text('created-pr');
  for (const part of ['head=claude/1-fixture', 'base=main', 'draft=true', 'Closes #1']) assert.ok(created.includes(part), part);
  assert.deepEqual(JSON.parse(text('pr.json')).linkPages, [['I1']], 'the issue is linked natively');

  // The same call again: the issue now has its PR, claim and branch, so nothing is created twice.
  rmSync(file('created-pr'));
  const developed = text('develops'), comments = JSON.parse(text('backlink-comments-1.json')).length;
  writeIssue({ ...JSON.parse(text('issue.json')), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/example' } }] } });
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^START #1 .* PR #7$/m);
  assert.equal(existsSync(file('created-pr')), false, 'no second PR');
  assert.equal(text('develops'), developed, 'no second branch');
  assert.equal(JSON.parse(text('backlink-comments-1.json')).length, comments, 'no second claim or backlink');
});
