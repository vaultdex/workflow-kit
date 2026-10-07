import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, predecessor, test } from './board-fixture.mjs';


test('In progress requires a startable issue assigned to the authenticated user before any mutation', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  const assigned = changes => ({ ...issue(), assignees: { nodes: [{ login: 'worker' }] }, ...changes });
  const cases = [
    issue(),
    { ...issue(), assignees: { nodes: [{ login: 'someone-else' }] } },
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('CLOSED', 'NOT_PLANNED')] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [] } }),
    assigned({ projectItems: { nodes: [] } }),
    assigned({ projectItems: issue('Backlog').projectItems }),
    assigned({ state: 'CLOSED' }),
  ];
  for (const candidate of cases) {
    writeIssue(candidate);
    const result = run('status', '1', 'in progress');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected starts must not mutate or add a Project item');
  }
  // Not assigned: one ERROR line, not the check's verdict block in front of it.
  writeIssue(issue());
  assert.match(run('status', '1', 'In progress').stdout, /^ERROR - [^\n]*\n$/);
  writeIssue(assigned());
  for (const failure of ['fail', 'fail-viewer']) {
    writeFileSync(join(checkout, failure), '');
    const result = run('status', '1', 'In progress');
    assert.notEqual(result.status, 0);
    if (failure === 'fail-viewer') assert.match(result.stdout, /^ERROR - /);
    assert.equal(existsSync(mutations), false, 'API failure must not mutate status');
    rmSync(join(checkout, failure));
  }
  for (const status of ['Ready', 'In progress', 'Automated review', 'Human review']) {
    writeIssue(assigned({ projectItems: issue(status).projectItems }));
    const result = run('status', '1', 'In progress');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 4);
  writeIssue(issue());
  assert.equal(run('status', '1', 'Ready').status, 0, 'Returning blocked work to Ready does not require assignment');
});


test('Automated review requires the declared open PR and every issue backlink before mutating status', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = join(checkout, 'mutations');
  const pr = { number: 7, state: 'OPEN', url: 'https://github.com/test/example/pull/7', body: 'Refs #1. Related: #99.', baseRefName: 'release/0.1.0' };
  const writePR = changes => writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr, ...changes }));
  let commentId = 0;
  const comment = body => ({ id: ++commentId, body, html_url: `https://github.com/test/example/issues/1#issuecomment-${commentId}` });
  const writeBacklink = (number, comments, changes = {}) => {
    writeFileSync(join(checkout, `backlink-${number}.json`), JSON.stringify({ number, state: 'open', comments: comments.length, ...changes }));
    writeFileSync(join(checkout, `backlink-comments-${number}.json`), JSON.stringify(comments));
  };
  const reject = (...args) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected backlink checks must not mutate or add a Project item');
    return result;
  };
  writePR();
  writeBacklink(1, []);
  reject('status', '1', 'Automated review');
  reject('field', '1', 'Status', 'Automated review');
  reject('status', '1', 'Automated review', '--help');
  reject('status', '1', 'Automated review', '0');
  reject('status', '1', 'Automated review', '7', '--help');
  reject('status', '1', 'Automated review', '7');
  for (const body of [
    'PR #7',
    'https://github.com/other/example/pull/7',
    'https://github.com/test/example/pull/70',
    'https://github.com/test/example/pull/7/files',
    'https://github.com/test/example/pull/6',
    'https://github.com.example.com/test/example/pull/7',
  ]) {
    writeBacklink(1, [comment(body)]);
    reject('status', '1', 'Automated review', '7');
  }
  writeBacklink(1, [comment(`[PR #7](${pr.url}).`)]);
  for (const changes of [
    { state: 'CLOSED' }, { state: 'MERGED' }, { number: 8 },
    { body: 'Refs #10' }, { body: 'Refs other/example#1' }, { body: '' },
  ]) {
    writePR(changes);
    reject('status', '1', 'Automated review', '7');
  }
  writePR();
  writeBacklink(1, [comment(pr.url)], { comments: 2 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { comments: 0 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { number: 2 });
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { pull_request: {} });
  reject('status', '1', 'Automated review', '7');
  const duplicate = comment(pr.url);
  writeBacklink(1, [duplicate, duplicate]);
  reject('status', '1', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)]);
  for (const failure of ['fail', 'fail-rest']) {
    writeFileSync(join(checkout, failure), '');
    reject('status', '1', 'Automated review', '7');
    rmSync(join(checkout, failure));
  }
  writeBacklink(1, Array.from({ length: 100 }, () => comment('Earlier discussion: malformed https://%')).concat(comment(pr.url)));
  writePR({ body: 'Refs #1. Refs test/example#2. Refs test/other#3. Related: #99.' });
  writeBacklink(2, []);
  reject('status', '1', 'Automated review', '7', '2');
  writeBacklink(2, [comment(pr.url)]);
  writeBacklink(3, []);
  reject('status', '1', 'Automated review', '7', '2', 'test/other#3');
  writeBacklink(3, [comment(`${pr.url}/?view=review#discussion`)]);
  for (const args of [
    ['status', '1', 'automated review', '7', '2', 'test/other#3'],
    ['status', '1', 'Automated review', '7', '2'],
    ['field', '1', 'Status', 'Automated review', '7', '2'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /backlink.*#1/);
    assert.match(result.stdout, /backlink.*#2/);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 3);
  assert.equal(JSON.parse(readFileSync(join(checkout, 'backlink-comments-2.json'))).length, 1, 'Repeated verification leaves the existing comment intact');
  writePR({ baseRefName: 'main', body: 'Closes #1' });
  assert.equal(run('status', '1', 'Automated review', '7').status, 0, 'Default-branch delivery works too');
});
