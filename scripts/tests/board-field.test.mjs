import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, predecessor, test } from './board-fixture.mjs';


test('field sets any single-select value and fails when the read-back differs', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const result = run('field', '1', 'Size', 'xs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'XS');
  writeFileSync(join(checkout, 'lost'), 'S');
  assert.notEqual(run('field', '1', 'Size', 'XS').status, 0, 'A write the read-back does not show is a failure');
});


test('field accepts Unicode and punctuation in names and options', t => {
  const { run, writeIssue } = fixture(t);
  writeIssue(issue());
  const result = run('field', '1', 'Größe', 'P0: urgent');
  assert.match(result.stdout, /^ERROR - .*Größe/, 'Validation lets the name through to the field lookup: ' + result.stderr);
  assert.equal(run('field', '1', 'Size', '-x').stdout, '', 'An option-like value is still rejected as usage');
  assert.equal(run('field', '1', 'Size', '-x').status, 2);
});


test('field sets several fields in one call: every pair is validated first, then all are written and read back', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const mutations = join(checkout, 'mutations');
  let result = run('field', '1', 'Size', 'xs', 'Priority', 'low');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(checkout, 'stored-values.json'), 'utf8')), { F3: 'XS', F2: 'Low' });

  rmSync(mutations);
  for (const args of [['Size', 'XS', 'Priority', 'Urgent'], ['Size', 'XS', 'Colour', 'Red'], ['Size', 'XS', 'Priority'], ['Size', 'XS', 'size', 'S']]) {
    result = run('field', '1', ...args);
    assert.match(result.stdout, /^ERROR - /m, result.stdout + result.stderr);
    assert.equal(result.stderr, '', 'No stack trace');
    assert.equal(result.status, 2);
    assert.equal(existsSync(mutations), false, 'One invalid pair writes nothing: ' + args.join(' '));
  }
  // The valid choices are named, for an unknown option and for an unknown field alike.
  assert.match(run('field', '1', 'Size', 'XS', 'Priority', 'Urgent').stdout, /High.*Low/);
  assert.match(run('field', '1', 'Size', 'XS', 'Colour', 'Red').stdout, /Priority.*Size/);

  writeFileSync(join(checkout, 'lost'), 'S');
  const lost = run('field', '1', 'Size', 'XS', 'Priority', 'Low');
  assert.notEqual(lost.status, 0, 'A read-back that differs for any field is a failure');
  assert.match(lost.stdout, /^ERROR - [^\n]*\n$/, 'A failed call shows no write as confirmed and stays one line');
});


test('field, status and priority report failures as one ERROR line, and issue failures name the repository', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  for (const args of [['field', '1', 'Colour', 'Red'], ['priority', '1', 'Urgent'], ['status', '1', 'Done']]) {
    const result = run(...args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^ERROR - /);
    assert.equal(result.stderr, '', 'No stack trace');
  }
  // A passing guard (the readiness check prints) waits until every pair is valid, so the failure stays one line.
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] } });
  const late = run('field', '1', 'Status', 'In progress', 'Colour', 'Red');
  assert.equal(late.status, 2);
  assert.match(late.stdout, /^ERROR - [^\n]*\n$/);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  // Assigned but blocked: the refusal is the one ERROR line too, and nothing is written.
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] }, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } });
  const held = run('status', '1', 'In progress');
  assert.equal(held.status, 2);
  assert.match(held.stdout, /^ERROR - [^\n]*\n$/);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  writeIssue({ ...issue(), assignees: { nodes: [{ login: 'worker' }] } });
  // A write that fails after the guards passed leaves the check's output unprinted too.
  writeFileSync(join(checkout, 'mutation-fails'), '');
  const refused = run('status', '1', 'In progress');
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /^ERROR - [^\n]*\n$/);
  assert.doesNotMatch(refused.stdout, /Assign yourself/, "The start guards passed; the write failed");
  rmSync(join(checkout, 'mutation-fails'));
  writeIssue(issue());
  // GitHub refuses an unknown issue number: the message says which repository was meant.
  writeFileSync(join(checkout, 'fail'), '');
  for (const args of [['check', '1'], ['priority', '1', 'High']]) {
    assert.match(run(...args).stdout, /test\/example#1/, args[0]);
  }
});


test('a field write succeeds when the Project already added the issue itself, and fails on every other refusal', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const noItem = { ...issue(), projectItems: { nodes: [] } };
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean) : [];
  const count = (name, list = mutations()) => list.filter(line => line.includes(name)).length;
  const prepare = (...flags) => {
    for (const file of ['mutations', 'stored', 'add-exists', 'add-exists-unreadable', 'add-fails']) rmSync(join(checkout, file), { force: true });
    writeIssue(noItem);
    writeFileSync(join(checkout, 'issue-with-item.json'), JSON.stringify(issue()));
    for (const flag of flags) writeFileSync(join(checkout, flag), '');
  };

  prepare();
  let result = run('priority', '1', 'High');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual([count('addProjectV2ItemById'), count('updateProjectV2ItemFieldValue')], [1, 1], 'A missing item is added once, then written');

  prepare('add-exists');
  result = run('priority', '1', 'High');
  assert.equal(result.status, 0, 'Already on the Project is no failure: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'High', 'The value is still written');
  assert.deepEqual([count('addProjectV2ItemById'), count('updateProjectV2ItemFieldValue')], [1, 1]);

  prepare('add-exists', 'add-exists-unreadable');
  assert.notEqual(run('priority', '1', 'High').status, 0, 'Already there but no readable item stays a failure');
  assert.equal(count('updateProjectV2ItemFieldValue'), 0, 'Nothing is written without an item');

  prepare('add-fails');
  assert.notEqual(run('priority', '1', 'High').status, 0, 'Any other refusal stays a failure');
  assert.equal(count('updateProjectV2ItemFieldValue'), 0);
});

test('field refuses an unknown flag before any write', t => {
  fixture(t).refusesUnknownFlag('field', '1', 'Size', 'M');
});
