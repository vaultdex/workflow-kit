import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';


test('board check exits 0 only for startable issues: 1 blocked, 2 unknown', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const check = (...args) => { writeIssue(issue(...args)); return run('check', '1').status; };

  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')]), 0);
  assert.equal(check('Ready', [predecessor('OPEN', null)]), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'NOT_PLANNED')]), 1);
  assert.equal(check('Backlog', []), 1);
  assert.equal(check('Ready', [predecessor('CLOSED', 'COMPLETED')], 2), 2, 'Unreadable predecessors are unknown');
  assert.equal(check('Ready', [predecessor('CLOSED', null)]), 2, 'A closure without a reason is unknown');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(check('Ready', []), 2, 'A failed read is never "no blockers"');
});


test('an issue held only by open predecessors is STACKABLE on the one open, ready PR that delivers them all, else BLOCKED', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const pr = (number, changes) => ({ number, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'release/0.1.1', headRefName: `claude/${number}-base`, headRefOid: 'ba5e0001', ...changes });
  const open = (number, prs, changes) => predecessor('OPEN', null, prs, { number, repository: { nameWithOwner: 'test/example' }, ...changes });
  const check = (...predecessors) => { writeIssue(issue('Ready', predecessors)); return run('check', '1'); };

  const stackable = check(open(2, [pr(5)]));
  assert.equal(stackable.status, 4, stackable.stdout);
  assert.equal(check(open(2, [pr(5)]), open(3, [pr(5)]), predecessor('CLOSED', 'COMPLETED')).status, 4, 'Several predecessors delivered by one PR');
  assert.equal(check(open(2, [pr(5), pr(6, { state: 'CLOSED' })])).status, 4, 'A closed PR delivers nothing');
  assert.equal(check(open(2, [pr(5, { state: 'MERGED' })])).status, 4, 'A base merged into the release branch (its issue stays open) still counts');
  assert.equal(check(open(2, [pr(5, { state: 'MERGED' }), pr(6)])).status, 1, 'A merged and an open PR are two deliveries');
  const refused = [
    ['no PR', open(2, [])],
    ['only a Draft PR', open(2, [pr(5, { isDraft: true })])],
    ['a PR from a fork', open(2, [pr(5, { isCrossRepository: true })])],
    ['a closed PR', open(2, [pr(5, { state: 'CLOSED' })])],
    ['a PR of another repository that closes the issue', open(2, [pr(5, { repository: { nameWithOwner: 'test/elsewhere' } })])],
    ['two PRs for one predecessor', open(2, [pr(5), pr(6)])],
    ['a predecessor in another repository', open(2, [pr(5)], { repository: { nameWithOwner: 'test/other' } })],
  ];
  for (const [label, candidate] of refused) assert.equal(check(candidate).status, 1, `${label} stays BLOCKED`);
  assert.equal(check(open(2, [pr(5)]), open(3, [pr(6)])).status, 1, 'Two predecessors in two PRs are not linear');
  assert.equal(check(open(2, [pr(5)]), open(3, [])).status, 1, 'Every open predecessor needs the PR');
  assert.equal(check(open(2, [pr(5)]), predecessor('CLOSED', 'NOT_PLANNED')).status, 1, 'A decision-less closure still blocks');
  assert.equal(check(open(2, [pr(5)]), predecessor('CLOSED', null)).status, 1, 'An unreadable predecessor never turns a wait into a stack');
  const partial = open(2, [pr(5)]);
  partial.closedByPullRequestsReferences.totalCount = 2;
  assert.equal(check(partial).status, 2, 'Incomplete PR data is unknown, not "no PR"');
  assert.equal(check(partial, open(3, [])).status, 1, 'A definitive refusal stays BLOCKED next to unreadable PR data');
  writeIssue({ ...issue('Backlog', [open(2, [pr(5)])]) });
  assert.equal(run('check', '1').status, 1, 'Another blocker is not lifted by a stack');
  writeIssue({ ...issue('Ready', [open(2, [pr(5)])]), body: 'Wartet bis: 2999-01-01T00:00Z' });
  assert.equal(run('check', '1').status, 1, '"Wartet bis" is not lifted by a stack');

  // status accepts STACKABLE and still rejects BLOCKED.
  const assigned = changes => ({ ...issue('Ready', [open(2, [pr(5)])]), assignees: { nodes: [{ login: 'worker' }] }, ...changes });
  writeIssue(assigned({ blockedBy: { totalCount: 1, nodes: [open(2, [])] } }));
  assert.notEqual(run('status', '1', 'In progress').status, 0);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  writeIssue(assigned());
  assert.equal(run('status', '1', 'In progress').status, 0);
  assert.equal(readFileSync(join(checkout, 'mutations'), 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 1);

  // The upper layer may reach Human review before the base is merged, but only as a layer on that base.
  const layer = assigned({ projectItems: issue('Automated review').projectItems });
  writeIssue(layer);
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'stored'), 'Automated review');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ baseRefName: 'release/0.1.1' })));
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ open: true, pull_requests: [{ number: 5, state: 'open' }, { number: 7, state: 'open' }] }]));
  // Every rejection changes one thing about the accepted case below and must leave the status untouched.
  const stored = () => readFileSync(join(checkout, 'stored'), 'utf8');
  const rejected = (label, status = 1) => {
    const result = run('handoff', '1', '7');
    assert.equal(result.status, status, `${label}: ${result.stdout}`);
    assert.equal(stored(), 'Automated review', `${label} must not write Human review`);
  };
  const upper = { baseRefName: 'claude/5-base', isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' } };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ baseRefName: 'release/0.1.1' })));
  rejected('a PR on the release branch while its base is open');
  for (const fork of [{ isCrossRepository: true, headRepository: { nameWithOwner: 'someone/example' } }, { headRepository: { nameWithOwner: 'someone/example' } }, { isCrossRepository: undefined }]) {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ ...upper, ...fork })));
    rejected('a fork PR');
  }
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(upper)));
  for (const status of ['behind', 'diverged']) {
    writeFileSync(join(checkout, 'stack-compare.json'), JSON.stringify({ status }));
    rejected(`a head that is ${status} the base head`);
  }
  rmSync(join(checkout, 'stack-compare.json'));
  for (const stacks of [[], [{ open: true, pull_requests: [{ number: 7 }] }], [{ open: false, pull_requests: [{ number: 5 }, { number: 7 }] }]]) {
    writeFileSync(join(checkout, 'stacks.json'), JSON.stringify(stacks));
    rejected('no linked open stack');
  }
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ open: true, pull_requests: [{ number: 5, state: 'open' }, { number: 7, state: 'open' }] }]));
  // The upper head moves after the proof was gathered (4th PR read, inside the guarded write): the proof belongs to the old head.
  writeFileSync(join(checkout, 'pr-reads.json'), JSON.stringify([{}, {}, {}, { headRefOid: 'abcdef9999' }]));
  rejected('a head that moved during handoff');
  rmSync(join(checkout, 'pr-reads.json'));
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(upper)));
  const handed = run('handoff', '1', '7');
  assert.equal(handed.status, 0, handed.stdout + handed.stderr);
  assert.equal(stored(), 'Human review');

  // After the base merged into the release branch GitHub has retargeted the layer: a plain PR there, nothing stack-specific left to prove.
  writeIssue(assigned({ projectItems: issue('Automated review').projectItems, blockedBy: { totalCount: 1, nodes: [open(2, [pr(5, { state: 'MERGED' })])] } }));
  writeFileSync(join(checkout, 'stored'), 'Automated review');
  writeFileSync(join(checkout, 'stacks.json'), '[]');
  const plain = { baseRefName: 'release/0.1.1', isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' } };
  for (const wrong of [{ baseRefName: 'main' }, { isCrossRepository: true }, { headRepository: { nameWithOwner: 'someone/example' } }]) {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ ...plain, ...wrong })));
    rejected('a merged base with a PR that is not a plain PR of this repository on the release branch');
  }
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(plain)));
  assert.equal(run('handoff', '1', '7').status, 0);
  assert.equal(stored(), 'Human review');
});


test('"Wartet bis" holds an issue until its tag exists or its UTC time has passed; unreadable values are unknown', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const waiting = line => ({ ...issue(), body: `## Was\n\nKein Blocker hier, Wartet bis: kommt später.\n\n## Abhängigkeiten und Wiederaufnahme\n\n${line}\n` });
  const check = line => { writeIssue(waiting(line)); return run('check', '1'); };
  const tag = (name, ...refs) => writeFileSync(join(checkout, `matching-refs-${name}.json`), JSON.stringify(refs.map(ref => ({ ref: `refs/tags/${ref}` }))));

  const missing = check('Wartet bis: v1.2.3');
  assert.equal(missing.status, 1, missing.stdout);
  assert.ok(missing.stdout.includes('v1.2.3'), 'The unmet condition is named');
  tag('v1.2.3', 'v1.2.30'); // A prefix match is no match.
  assert.equal(check('Wartet bis: v1.2.3').status, 1);
  tag('v1.2.3', 'v1.2.3');
  assert.equal(check('Wartet bis: v1.2.3').status, 0);
  const future = check('Wartet bis: 2999-01-01T00:00Z');
  assert.equal(future.status, 1, future.stdout);
  assert.ok(future.stdout.includes('2999-01-01T00:00Z'), 'The unmet condition is named');
  assert.equal(check('Wartet bis: 2000-01-01T00:00Z').status, 0);
  writeFileSync(join(checkout, 'tags-2026.json'), JSON.stringify([{ ref: 'refs/tags/release/2026' }])); // Der Mock benennt die Datei nach den Pfadteilen -3 und -1.
  assert.equal(check('Wartet bis: release/2026').status, 0, 'Tags need not look like versions');
  assert.equal(check('Wartet bis: release/2027').status, 1);
  writeFileSync(join(checkout, 'matching-refs-release%402026.json'), JSON.stringify([{ ref: 'refs/tags/release@2026' }]));
  assert.equal(check('Wartet bis: release@2026').status, 0, 'Any tag Git accepts is looked up, URL-encoded');
  writeFileSync(join(checkout, 'matching-refs-%C2%A0release.json'), JSON.stringify([{ ref: 'refs/tags/ release' }]));
  assert.equal(check('Wartet bis:  release').status, 0, 'Only ASCII separators are stripped from the value');
  // No Markdown section logic: a condition is never silently overlooked, wherever the line sits.
  for (const body of ['### Abhängigkeiten und Wiederaufnahme ###\n\n#### Release\n\nWartet bis: 2999-01-01T00:00Z\n',
    '## Weiteres\n\n- Wartet bis: 2999-01-01T00:00Z\n', 'Wartet bis: 2999-01-01T00:00Z\r\n\r\n```sh\n## x\n```\n']) {
    writeIssue({ ...issue(), body });
    assert.equal(run('check', '1').status, 1, body);
  }
  for (const variant of ['**Wartet bis:** v1.2.3', '> Wartet bis: v1.2.3', '1. Wartet bis: v1.2.3', '- [ ] Wartet bis: v1.2.3', '## Wartet bis: v1.2.3', '| Wartet bis: v1.2.3 |', '`Wartet bis: v1.2.3`','Wartet bis v1.2.3']) {
    assert.equal(check(variant).status, 2, `${variant} is unknown, never overlooked`);
  }
  for (const invalid of ['Wartet bis: bald nach dem Release', 'Wartet bis: release.', 'Wartet bis: foo.lock', 'Wartet bis: 2026-02-30T10:00Z', 'Wartet bis: 2999-01-01T00:00+02:00', 'Wartet bis:']) {
    assert.equal(check(invalid).status, 2, `${invalid} is unknown, never "no blocker"`);
  }
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(check('Wartet bis: v1.2.3').status, 2, 'A failed tag lookup is unknown');
  rmSync(join(checkout, 'fail-rest'));
  assert.equal(check('Keine Wartebedingung.').status, 0);
});


test('board check blocks a newer claim of another session of the same login unless handed over', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue());
  const comment = (body, changes) => ({ id: 1, user: { login: 'worker', type: 'User' }, body, html_url: 'https://example.test/c1',
    created_at: '2026-10-06T10:00:00Z', ...changes });
  const claim = (agent, session, changes) => comment(`Claim\n\nAgent: ${agent}, Session: ${session}`, changes);
  const check = (comments, ...args) => {
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
    return run('check', '1', ...args);
  };

  const foreign = check([claim('claude', 'S1'), claim('codex', 'S2', { created_at: '2026-10-06T10:09:00Z' })], '--session', 'S1');
  assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout, /Agent codex, Session S2, 2026-10-06T10:09:00Z, https:\/\/example\.test\/c1/);
  assert.equal(check([claim('claude', 'S1')], '--session', 'S1').status, 0, 'own claim');
  assert.equal(check([claim('claude', 'S1'), claim('codex', 'S2')], '--session', 'S2').status, 0, 'equal times: the later comment wins');
  assert.equal(check([claim('claude', 'S1'), comment('Handover: S2')], '--session', 'S2').status, 0, 'handover');
  assert.equal(check([claim('claude', 'S1'), comment('Handover: S2')], '--session', 'S1').status, 1, 'the earlier session lost the claim');
  assert.equal(check([claim('claude', 'S1', { user: { login: 'someone-else' } })], '--session', 'S2').status, 0, 'other authors are ignored');

  const old = check([comment('Claim: Driver, Branch x')], '--session', 'S2');
  assert.equal(old.status, 0, old.stdout);
  assert.match(old.stdout, /note: claim without Agent\/Session field/);
  const stray = check([claim('claude', 'S1'), comment('Claim: released')], '--session', 'S2');
  assert.equal(stray.status, 1, 'a newer claim without the field never lifts a known holder');
  assert.match(stray.stdout, /note: claim without Agent\/Session field/);
  assert.equal(check([comment('Agent: codex, Session: S1, Branch: x')], '--session', 'S2').status, 1, 'text after the session id is allowed');
  assert.equal(check([comment('Agent: reviewer, Session: S1')], '--session', 'S2').status, 0, 'only claude and codex name a claim');
  assert.equal(check([claim('claude', 'S1')], '--sesion', 'S2').status, 2, 'a misspelled flag is a usage error, not a silent skip');
  const unnamed = check([claim('claude', 'S1')]);
  assert.equal(unnamed.status, 0, 'without --session the verdict stays as before');
  assert.match(unnamed.stdout, /note: newest claim: Agent claude, Session S1/);

  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(run('check', '1', '--session', 'S1').status, 2, 'unreadable comments are unknown');
});


// Vaultdex #1178: Codex claimed at the end of a sentence and had an open PR; check said STARTABLE and a second driver began.
test('board check blocks an issue another agent works on: its open PR, its branch or a claim that names no session', t => {
  const { checkout, run, writeIssue, queries } = fixture(t);
  const pr = (state, changes) => ({ number: 7, state, repository: { nameWithOwner: 'test/example' }, headRefName: 'codex/1-work', ...changes });
  const comments = (...bodies) => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(bodies.map((body, id) => ({ id, user: { login: 'worker', type: 'User' },
    body, html_url: 'https://example.test/c1', created_at: '2026-10-06T10:00:00Z' }))));
  const withWork = (prs, branches = []) => {
    writeIssue({ ...issue(), closedByPullRequestsReferences: { totalCount: prs.length, nodes: prs } });
    writeFileSync(join(checkout, 'branches.json'), JSON.stringify(branches));
  };
  const check = (...args) => run('check', '1', ...args);

  comments();
  withWork([pr('OPEN')], ['codex/1-work']);
  const found = check('--session', 'S2');
  assert.equal(found.status, 1, found.stdout);
  assert.match(found.stdout, /^- open PR #7 \(branch codex\/1-work\) closes this issue; no claim of session S2$/m);
  assert.doesNotMatch(found.stdout, /^- branch /m, 'the branch of the PR is not named twice');
  assert.match(check().stdout, /^- open PR #7 .*pass --session ID/m, 'without a session nobody proves the PR is theirs');
  assert.equal(queries().length, 2, 'both checks read the PR and the branches with the one issue query');

  comments('Agent: claude, Session: S2');
  assert.equal(check('--session', 'S2').status, 0, 'the own claim lifts it');
  assert.equal(check('--session', 'S3').status, 1, 'a claim of another session does not');
  withWork([pr('MERGED'), pr('CLOSED')]);
  comments();
  assert.equal(check('--session', 'S2').status, 0, 'a merged or closed PR holds nothing');

  withWork([], ['claude/1-first', 'claude/12-other', 'codex/10-1-nope', 'release/1-0']);
  const branch = check('--session', 'S2');
  assert.equal(branch.status, 1, branch.stdout);
  assert.match(branch.stdout, /^- branch claude\/1-first belongs to this issue; no claim of session S2$/m);
  assert.doesNotMatch(branch.stdout, /12-other|10-1-nope/, 'only <agent>/<number>- belongs to the issue');
  assert.match(branch.stdout, /^- branch release\/1-0 /m, 'any prefix names a branch of the issue');
  withWork([], ['claude/12-other']);
  assert.equal(check('--session', 'S2').status, 0, 'a branch of another issue holds nothing');

  withWork([]);
  const sentence = 'Quota-Blocker aufgehoben: frischer board check ist STARTABLE. Agent: codex, Session: S1';
  assert.equal(check('--session', 'S2').status, 0);
  comments(sentence);
  assert.equal(check('--session', 'S2').status, 1, 'the field counts at the end of a sentence');
  assert.equal(check('--session', 'S1').status, 0, 'and names the session of its writer');
  comments('Claim\n\nAgent: codex');
  const unnamed = check('--session', 'S2');
  assert.equal(unnamed.status, 1, 'a claim of an agent without a session is never the caller');
  assert.match(unnamed.stdout, /claimed by another session \(Agent codex, no session named,/);
  comments('Agent: codex', 'Handover: S2');
  assert.equal(check('--session', 'S2').status, 0, 'a handover passes it on');
  comments('Use `Agent: codex, Session: S1` as the claim line.');
  assert.equal(check('--session', 'S2').status, 0, 'a quoted example is no claim');
});


test('board check lists the sub-issues of a spec with status, assignee and verdict, and leaves the verdict of the parent alone', t => {
  const { run, writeIssue } = fixture(t);
  const child = (number, status, nodes, assignee, changes) => ({ ...issue(status, nodes), number, repository: { nameWithOwner: 'test/example' },
    assignees: { nodes: assignee ? [{ login: assignee }] : [] }, ...changes });
  const spec = (...children) => ({ ...issue(), subIssues: { totalCount: children.length, nodes: children } });

  writeIssue(spec(child(11, 'In progress', [], 'worker'), child(12, 'Ready', [predecessor('OPEN', null)])));
  const result = run('check', '1', '--session', 'S1');
  assert.equal(result.status, 0, 'Sub-issues never change the verdict of the parent');
  const lines = result.stdout.split('\n');
  assert.equal(lines.at(-3), '#11  In progress  worker  STARTABLE', result.stdout);
  assert.equal(lines.at(-2), '#12  Ready  -  BLOCKED', result.stdout);

  writeIssue(spec(child(13, 'Backlog', []), child(14, 'Ready', [], 'worker', { repository: { nameWithOwner: 'test/other' } })));
  assert.match(run('check', '1', '--session', 'S1').stdout, /^#13 {2}Backlog {2}- {2}BLOCKED\ntest\/other#14 {2}Ready {2}worker {2}STARTABLE$/m);
  writeIssue(issue());
  assert.doesNotMatch(run('check', '1', '--session', 'S1').stdout, /#\d+ {2}/, 'No sub-issues, no rows');
});


test('board check shows the age of a claim and whether a linked PR is open', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const claimedAgo = ms => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' },
    body: 'Claim\n\nAgent: claude, Session: S1', html_url: 'https://example.test/c1', created_at: new Date(Date.now() - ms).toISOString() }]));
  const withPrs = prs => writeIssue({ ...issue(), closedByPullRequestsReferences: { nodes: prs } });

  claimedAgo((2 * 24 + 4) * 3_600_000 + 30 * 60_000);
  withPrs([]);
  assert.match(run('check', '1', '--session', 'S1').stdout, /^claim: 2d 4h ago \(Session S1\), open PR: none$/m);
  withPrs([{ number: 123, state: 'OPEN', repository: { nameWithOwner: 'Test/Example' } }, { number: 99, state: 'MERGED', repository: { nameWithOwner: 'test/example' } }, { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/other' } }]);
  assert.match(run('check', '1', '--session', 'S2').stdout, /^claim: 2d 4h ago \(Session S1\), open PR: #123, test\/other#7$/m, 'Shown to other sessions too; foreign PRs are qualified');
  claimedAgo(5 * 60_000 + 10_000);
  assert.match(run('check', '1').stdout, /^claim: 5m ago \(Session S1\), open PR: #123, test\/other#7$/m);
  writeIssue({ ...issue(), closedByPullRequestsReferences: { totalCount: 150, nodes: [{ number: 5, state: 'OPEN', repository: { nameWithOwner: 'test/example' } }] } });
  assert.match(run('check', '1').stdout, /^claim: 5m ago \(Session S1\), open PR: #5 \(first 1 of 150\)$/m, 'A cut list says so');
  writeFileSync(join(checkout, 'issues-comments.json'), '[]');
  assert.doesNotMatch(run('check', '1').stdout, /^claim:/m, 'No claim, no line');
});


// GitHub charges a query by the lists it asks for: the shared quota is spent by what a command asks, not by what it finds.
test('board check reads the issue, the viewer and the claim comments in one query, without the PRs of closed predecessors', t => {
  const { checkout, run, writeIssue, queries } = fixture(t);
  writeIssue(issue('Ready', [predecessor('CLOSED', 'COMPLETED')]));
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' },
    body: 'Claim\n\nAgent: claude, Session: S1', html_url: 'https://example.test/c1', created_at: new Date().toISOString() }]));
  const result = run('check', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^claim: /m, 'The claim was judged against the viewer');
  const [only, ...more] = queries();
  assert.deepEqual(more, [], 'No second query for the viewer or the predecessors');
  assert.ok(only.includes('viewer{login}'));
  assert.ok(!only.includes('includeClosedPrs'), 'The PRs of predecessors are not part of the issue query');
});


test('board check asks for the PRs of predecessors only when open predecessors alone hold the issue', t => {
  const { checkout, run, writeIssue, queries } = fixture(t);
  const pr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/5-base' };
  // As GitHub answers the issue query: the predecessor has an id and no PRs; they come from a lookup by id (deliveries.json).
  const bare = id => ({ id, number: 2, state: 'OPEN', stateReason: null, repository: { nameWithOwner: 'test/example' } });
  const deliveries = value => writeFileSync(join(checkout, 'deliveries.json'), JSON.stringify(value));

  writeIssue(issue('Ready', [bare('P2')]));
  deliveries({ P2: { totalCount: 1, nodes: [pr] } });
  const stackable = run('check', '1');
  assert.equal(stackable.status, 4, stackable.stdout + stackable.stderr);
  assert.match(stackable.stdout, /^stack base: PR #5 /m);
  const [issueQuery, lookup, ...more] = queries();
  assert.deepEqual(more, []);
  assert.ok(lookup.includes('nodes(ids:["P2"])'), 'One lookup of the open predecessor by id');
  assert.ok(!issueQuery.includes('nodes(ids'));

  deliveries({});
  assert.equal(run('check', '1').status, 2, 'A predecessor whose PRs cannot be read is unknown, never "no PR"');
  queries();
  writeIssue(issue('Backlog', [bare('P2')]));
  assert.equal(run('check', '1').status, 1);
  assert.equal(queries().length, 1, 'Another blocker decides without a lookup');
  writeIssue(issue('Ready', [predecessor('CLOSED', 'COMPLETED')]));
  assert.equal(run('check', '1').status, 0);
  assert.equal(queries().length, 1, 'A closed predecessor needs no lookup');
});


test('board check asks for a short list of sub-issues and reads a longer one again in full', t => {
  const { run, writeIssue, queries } = fixture(t);
  const children = count => Array.from({ length: count }, (_, index) => ({ ...issue('Ready'), number: 100 + index, repository: { nameWithOwner: 'test/example' } }));
  const spec = (count, totalCount = count) => ({ ...issue(), subIssues: { totalCount, nodes: children(count) } });

  writeIssue(spec(30));
  assert.equal(run('check', '1', '--session', 'S1').stdout.match(/^#\d+ {2}/gm).length, 30);
  const [short, ...more] = queries();
  assert.deepEqual(more, [], 'A list that fits the first page is read once');
  assert.ok(short.includes('subIssues(first:30)'));

  writeIssue(spec(30, 31));
  const cut = run('check', '1', '--session', 'S1');
  assert.match(cut.stdout, /^note: 30 of 31 sub-issues listed$/m, 'A list that is still cut says so');
  const [first, second, ...rest] = queries();
  assert.deepEqual(rest, []);
  assert.ok(first.includes('subIssues(first:30)') && second.includes('subIssues(first:100)'), 'The second read asks for 100');
});


test('--cwd names the project of a command, not the working directory', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const other = join(checkout, '..', 'other-project');
  mkdirSync(join(other, '.github'), { recursive: true });
  writeFileSync(join(other, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/other-project', id: 'P2' }));
  // Startable on the board of the other project only: its item is in P2, the working directory's project is P1.
  writeIssue({ ...issue(), projectItems: { nodes: [{ id: 'PI2', project: { id: 'P2' }, status: { name: 'Ready' } }] } });

  const here = run('check', '1');
  assert.match(here.stdout, /^test\/example#1 /, 'Without --cwd the working directory decides');
  assert.equal(here.status, 2, here.stdout);
  const there = run('--cwd', other, 'check', '1');
  assert.match(there.stdout, /^test\/other-project#1 /);
  assert.equal(there.status, 0, there.stdout + there.stderr);
  assert.equal(run('--cwd').status, 2, 'A missing directory is a usage error, not the working directory');
});
