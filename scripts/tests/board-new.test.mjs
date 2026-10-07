import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';


test('new checks every required value before creating, reads all values back and starts the issue on request', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  const read = file => JSON.parse(readFileSync(join(checkout, file), 'utf8'));
  const created = join(checkout, 'created.json'), mutations = join(checkout, 'mutations');
  const stored = changes => write('backlink-1.json', { number: 1, state: 'open', comments: 0, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }], assignees: [], ...changes });
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }, { name: 'ci' }]);
  write('create-response.json', { number: 1, html_url: 'https://github.com/test/example/issues/1' });
  write('backlink-comments-1.json', []);
  write('body.md', 'Text\r\n');
  stored();
  writeIssue(issue('Backlog'));
  const base = ['new', '--title', 'Titel', '--body-file', 'body.md', '--milestone', '0.1.1', '--label', 'Enhancement', '--priority', 'low', '--field', 'Size=xs'];

  // A missing or invalid value stops the command before anything exists.
  const refused = (reason, ...args) => {
    const result = run(...args);
    assert.equal(result.status, 2, `${reason}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^ERROR - [^\n]*\n$/, reason);
    assert.equal(result.stderr, '', 'No stack trace');
    assert.equal(existsSync(created), false, `${reason}: the issue must not be created`);
    assert.equal(existsSync(mutations), false, reason);
    return result.stdout;
  };
  refused('no priority', ...base.filter((arg, index) => ![8, 9].includes(index)));
  refused('no label', ...base.filter((arg, index) => ![6, 7].includes(index)));
  refused('unknown label', ...base, '--label', 'nope');
  refused('unknown milestone', ...base.map(arg => arg === '0.1.1' ? '9.9' : arg));
  assert.match(refused('unknown option', ...base.map(arg => arg === 'Size=xs' ? 'Size=XXL' : arg)), /XS.*S/);
  refused('Status is no --field', ...base, '--field', 'Status=Done');
  refused('--start without a session', ...base, '--start', '--agent', 'claude');
  refused('a session without --start', ...base, '--session', 'S1');
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', requiredFields: ['Zielrelease'] }));
  assert.match(refused('a field the project requires', ...base), /Zielrelease/);
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', requiredFields: ['Size'] }));

  // An unreadable answer to the creation does not prove that nothing exists: the error says so.
  write('create-response.json', 'not json');
  let result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*may exist anyway.*before trying again/);
  rmSync(created);
  write('create-response.json', { number: 1, html_url: 'https://github.com/test/example/issues/1' });

  // Without --start the issue lands in Backlog; a label given twice (other casing) is one label.
  result = run(...base, '--label', 'ENHANCEMENT');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // One line with the URL and the values read back; their order and separators are not pinned.
  assert.match(result.stdout, /^NEW https:\/\/github\.com\/test\/example\/issues\/1\b[^\n]*\n$/);
  for (const value of ['0.1.1', 'enhancement', 'Backlog', 'Low', 'XS']) assert.ok(result.stdout.includes(value), value);
  assert.deepEqual(read('created.json'), { title: 'Titel', body: 'Text', milestone: 4, labels: ['enhancement'] });
  assert.deepEqual(read('stored-values.json'), { F1: 'Backlog', F2: 'Low', F3: 'XS' });
  assert.equal(existsSync(join(checkout, 'comment-writes')), false, 'No claim without --start');

  // A value that does not read back is a failure that names the created issue.
  stored({ milestone: { title: 'other' } });
  result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*issues\/1 was created, but reading it back failed/);
  stored();

  // --start: Ready, assignee, claim comment, In progress; the claim is read back.
  rmSync(join(checkout, 'stored-values.json'));
  rmSync(mutations);
  stored({ assignees: [{ login: 'worker' }] });
  writeIssue({ ...issue('Ready'), assignees: { nodes: [{ login: 'worker' }] } });
  result = run(...base, '--start', '--agent', 'claude', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEW https:\/\/github\.com\/test\/example\/issues\/1\b[^\n]*\n$/);
  for (const value of ['In progress', 'worker', 'https://github.com/test/example/issues/1#issuecomment-1']) assert.ok(result.stdout.includes(value), value);
  assert.ok(!result.stdout.includes('Ready'), 'The final status is shown, not the intermediate one');
  assert.deepEqual(read('created.json').assignees, ['worker']);
  assert.equal(read('backlink-comments-1.json')[0].body, 'Agent: claude, Session: S1\n');
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 4, 'Ready, Priority, Size, In progress');

  // A failing write after the issue exists says so instead of failing as if nothing happened.
  writeFileSync(join(checkout, 'mutation-fails'), '');
  result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*issues\/1 was created, but setting the Project fields failed.*do not create it again/);
});
