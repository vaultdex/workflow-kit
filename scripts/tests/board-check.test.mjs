import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';


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
  const layer = assigned({ projectItems: issue('Automated review').projectItems,
    closedByPullRequestsReferences: { totalCount: 1, nodes: [
      { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/example' } },
    ] } });
  writeIssue(layer);
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'stored'), 'Automated review');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ baseRefName: 'release/0.1.1' })));
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ number: 42, open: true, base: { ref: 'release/0.1.1' }, pull_requests: [
    { number: 5, state: 'open', draft: false, head: { ref: 'claude/5-base', sha: 'ba5e0001' } },
    { number: 6, state: 'open', draft: false, head: { ref: 'claude/6-base', sha: 'beef0001' } },
    { number: 7, state: 'open', draft: false, head: { ref: 'claude/7-upper', sha: 'abcdef1234' } },
  ] }]));
  // Every rejection changes one thing about the accepted case below and must leave the status untouched.
  const stored = () => readFileSync(join(checkout, 'stored'), 'utf8');
  const rejected = (label, status = 1) => {
    const result = run('handoff', '1', '7');
    assert.equal(result.status, status, `${label}: ${result.stdout}`);
    assert.equal(stored(), 'Automated review', `${label} must not write Human review`);
  };
  const middle = { number: 6, state: 'OPEN', isDraft: false, isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' },
    baseRefName: 'claude/5-base', headRefName: 'claude/6-base', headRefOid: 'beef0001' };
  const upper = { baseRefName: 'claude/6-base', isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' } };
  writeFileSync(join(checkout, 'stack-prs.json'), JSON.stringify({ 6: middle }));
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
  const stack = (numbers, open = true) => [{ number: 42, open, base: { ref: 'release/0.1.1' }, pull_requests: numbers.map(number => ({
    number, state: 'open', draft: false, head: { ref: `claude/${number}-base`, sha: number === 5 ? 'ba5e0001' : number === 6 ? 'beef0001' : `sha-${number}` },
  })) }];
  for (const [stacks, status] of [[[], 1], [stack([5, 6]), 2], [stack([5, 6, 7], false), 1]]) {
    writeFileSync(join(checkout, 'stacks.json'), JSON.stringify(stacks));
    rejected('no linked open stack', status);
  }
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify(stack([5, 6, 7])));
  // The upper head moves after the proof was gathered (4th PR read, inside the guarded write): the proof belongs to the old head.
  writeFileSync(join(checkout, 'pr-reads.json'), JSON.stringify([{}, {}, {}, { headRefOid: 'abcdef9999' }]));
  rejected('a head that moved during handoff');
  rmSync(join(checkout, 'pr-reads.json'));
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(upper)));
  const handed = run('handoff', '1', '7');
  assert.equal(handed.status, 0, handed.stdout + handed.stderr);
  assert.equal(stored(), 'Human review');

  // The base PR (6) may sit further below: another layer (8) between it and this PR is fine when the PR targets that layer;
  // a stack read that puts this PR under the base PR is not.
  writeFileSync(join(checkout, 'stored'), 'Automated review');
  rmSync(join(checkout, 'stacks.json'));
  writeFileSync(join(checkout, 'stack-prs.json'), JSON.stringify({ 6: middle, 8: { ...middle, number: 8, baseRefName: 'claude/6-base', headRefName: 'claude/8-base', headRefOid: 'sha-8' } }));
  writeFileSync(join(checkout, 'stacks-reads.json'), JSON.stringify([stack([5, 6, 7]), stack([7, 5, 6])]));
  rejected('a PR below the base PR');
  writeFileSync(join(checkout, 'stacks-reads.json'), JSON.stringify([stack([5, 6, 7]), stack([5, 6, 8, 7])]));
  rejected('a PR on the base PR branch while another layer sits between');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ ...upper, baseRefName: 'claude/8-base' })));
  writeFileSync(join(checkout, 'stacks-reads.json'), JSON.stringify([stack([5, 6, 7]), stack([5, 6, 8, 7])]));
  const above = run('handoff', '1', '7');
  assert.equal(above.status, 0, above.stdout + above.stderr);
  assert.equal(stored(), 'Human review');
  rmSync(join(checkout, 'stacks-reads.json'));

  // After the base merged into the release branch GitHub has retargeted the layer: a plain PR there, nothing stack-specific left to prove.
  writeIssue(assigned({ projectItems: issue('Automated review').projectItems, blockedBy: { totalCount: 1, nodes: [open(2, [pr(5, { state: 'MERGED' })])] },
    closedByPullRequestsReferences: { totalCount: 1, nodes: [
      { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/example' } },
    ] } }));
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

test('a native stack selects its tip for new work and the immediate lower layer when resuming an appended PR', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const makePr = (number, baseRefName, changes = {}) => ({ number, state: 'OPEN', isDraft: false, isCrossRepository: false,
    repository: { nameWithOwner: 'test/example' }, headRepository: { nameWithOwner: 'test/example' },
    baseRefName, headRefName: `branch-${number}`, headRefOid: `sha-${number}`, ...changes });
  const bottom = makePr(1318, 'release/0.1.1');
  const middle = makePr(1345, bottom.headRefName);
  const top = makePr(1350, middle.headRefName);
  const ownDraft = makePr(1351, top.headRefName, { isDraft: true });
  const member = (pr, changes = {}) => ({ number: pr.number, state: 'open', draft: pr.isDraft, head: { ref: pr.headRefName, sha: pr.headRefOid }, ...changes });
  const basePredecessor = predecessor('OPEN', null, [bottom], { number: 775, repository: { nameWithOwner: 'test/example' } });
  const setStack = (prs, changes = {}) => writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{
    number: 88, open: true, base: { ref: 'release/0.1.1' }, pull_requests: prs.map(pr => member(pr)), ...changes,
  }]));
  const check = () => run('check', '1');
  const checkWithSession = () => run('check', '1', '--session', 'resume1');
  const issueWith = (...blockers) => ({ ...issue('Ready', blockers), closedByPullRequestsReferences: {
    totalCount: 3, nodes: [
      { number: 1351, state: 'OPEN', repository: { nameWithOwner: 'test/example' }, headRefName: ownDraft.headRefName },
      { number: 1300, state: 'CLOSED', repository: { nameWithOwner: 'test/example' } },
      { number: 1200, state: 'MERGED', repository: { nameWithOwner: 'test/example' } },
    ],
  } });

  setStack([bottom, middle]);
  writeFileSync(join(checkout, 'stack-prs.json'), JSON.stringify({ [middle.number]: middle }));
  writeIssue(issue('Ready', [basePredecessor]));
  const atTip = check();
  assert.equal(atTip.status, 4, atTip.stdout + atTip.stderr);
  assert.match(atTip.stdout, /^stack base: PR #1345 in stack #88 \(branch branch-1345, base branch-1318\)/m);

  const second = predecessor('OPEN', null, [middle], { number: 776, repository: { nameWithOwner: 'test/example' } });
  writeIssue(issue('Ready', [basePredecessor, second]));
  assert.equal(check().status, 4, 'Multiple blocker PRs in one native linear stack resolve to its top');
  setStack([bottom, top]);
  const split = check();
  assert.equal(split.status, 1, split.stdout + split.stderr);
  assert.match(split.stdout, /blocker PR #1345 is not in native stack #88/);

  const longStack = Array.from({ length: 128 }, (_, index) => makePr(2000 + index,
    index ? `branch-${1999 + index}` : 'release/0.1.1'));
  longStack.forEach((pr, index) => { pr.headRefName = `branch-${pr.number}`; pr.baseRefName = index ? longStack[index - 1].headRefName : 'release/0.1.1'; });
  const longTip = longStack.at(-1);
  writeFileSync(join(checkout, 'stack-prs.json'), JSON.stringify({ [longTip.number]: longTip }));
  setStack(longStack);
  writeIssue(issue('Ready', [predecessor('OPEN', null, [longStack[0]], { number: 900, repository: { nameWithOwner: 'test/example' } })]));
  const deep = check();
  assert.equal(deep.status, 4, deep.stdout + deep.stderr);
  assert.match(deep.stdout, /^stack base: PR #2127 in stack #88/m);

  setStack([bottom, middle, ownDraft, makePr(1352, ownDraft.headRefName)]);
  const upper = makePr(1352, ownDraft.headRefName);
  writeFileSync(join(checkout, 'stack-prs.json'), JSON.stringify({ [middle.number]: middle, [upper.number]: upper }));
  writeIssue(issue('Ready', [basePredecessor]));
  const newAtTip = check();
  assert.equal(newAtTip.status, 4, newAtTip.stdout + newAtTip.stderr);
  assert.match(newAtTip.stdout, /^stack base: PR #1352 in stack #88/m);

  writeIssue(issueWith(basePredecessor));
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker' },
    body: 'Agent: codex, Session: resume1', created_at: new Date().toISOString(), html_url: 'claim' }]));
  const resumed = run('check', '1', '--session', 'resume1');
  assert.equal(resumed.status, 4, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /^stack base: PR #1345 in stack #88/m, 'Resume uses own PR immediate lower layer, not foreign layer above it');
  assert.doesNotMatch(resumed.stdout, /PR #1351 is still Draft/);

  const ownLink = number => ({ number, state: 'OPEN', repository: { nameWithOwner: 'test/example' } });
  writeIssue({ ...issue('Ready', [basePredecessor]), closedByPullRequestsReferences: {
    totalCount: 2, nodes: [ownLink(1351), ownLink(1352)],
  } });
  const ambiguous = checkWithSession();
  assert.equal(ambiguous.status, 2, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stdout, /multiple open PRs/);
  assert.doesNotMatch(ambiguous.stdout, /^stack base:/m, 'Ambiguous own PR links must not be treated as new work at the tip');

  const partial = { ...issue('Ready', [basePredecessor]), closedByPullRequestsReferences: {
    totalCount: 2, nodes: [ownLink(1351)],
  } };
  writeIssue(partial);
  const incomplete = checkWithSession();
  assert.equal(incomplete.status, 2, incomplete.stdout + incomplete.stderr);
  assert.doesNotMatch(incomplete.stdout, /^stack base:/m);

  const missingLinks = issue('Ready', [basePredecessor]);
  delete missingLinks.closedByPullRequestsReferences;
  writeIssue(missingLinks);
  const missing = checkWithSession();
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.doesNotMatch(missing.stdout, /^stack base:/m);

  writeFileSync(join(checkout, 'fail-stacks'), '');
  writeIssue(issue('Ready', [basePredecessor]));
  const unreadable = check();
  assert.equal(unreadable.status, 2, unreadable.stdout + unreadable.stderr);
  assert.doesNotMatch(unreadable.stdout, /stack base: PR #1318/);
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
  const [older, newer] = [10, 1].map(minutes => new Date(Date.now() - minutes * 60_000).toISOString());
  const comment = (body, changes) => ({ id: 1, user: { login: 'worker', type: 'User' }, body, html_url: 'https://example.test/c1',
    created_at: older, ...changes });
  const claim = (agent, session, changes) => comment(`Claim\n\nAgent: ${agent}, Session: ${session}`, changes);
  const check = (comments, ...args) => {
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
    return run('check', '1', ...args);
  };

  const foreign = check([claim('claude', 'S1'), claim('codex', 'S2', { created_at: newer })], '--session', 'S1');
  assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout, new RegExp(`Agent codex, Session S2, ${newer}, https://example\\.test/c1`));
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
    body, html_url: 'https://example.test/c1', created_at: new Date(Date.now() - 600_000).toISOString() }))));
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
  const pr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/5-base', headRefOid: 'abcdef1234' };
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
  const [short, ...more] = queries().filter(query => !query.includes('search('));
  assert.deepEqual(more, [], 'A list that fits the first page is read once');
  assert.ok(short.includes('subIssues(first:30)'));

  writeIssue(spec(30, 31));
  const cut = run('check', '1', '--session', 'S1');
  assert.match(cut.stdout, /^note: 30 of 31 sub-issues listed$/m, 'A list that is still cut says so');
  const [first, second, ...rest] = queries().filter(query => !query.includes('search('));
  assert.deepEqual(rest, []);
  assert.ok(first.includes('subIssues(first:30)') && second.includes('subIssues(first:100)'), 'The second read asks for 100');
});


test('baseBranch names the base from a Project field and warns, without a verdict, when HEAD is not on it', t => {
  const { checkout, run, writeIssue, queries } = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  const setting = { repository: 'test/example', id: 'P1', baseBranch: { field: 'Zielrelease', pattern: 'release/{value}' } };
  const withField = (base, extra) => ({ ...issue(), projectItems: { nodes: [{ ...issue().projectItems.nodes[0], base }] }, ...extra });
  const baseLines = () => run('check', '1', '--session', 'S1').stdout.split('\n').filter(line => /^(base|note): /.test(line)).map(line => line.split(';')[0]); // what is named, not the advice after it

  writeIssue(withField({ name: '0.1.1' }));
  const plain = run('check', '1', '--session', 'S1').stdout;
  queries();
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'release');
  git('update-ref', 'refs/remotes/origin/release/0.1.1', 'HEAD');
  git('commit', '--allow-empty', '-q', '-m', 'on top');
  assert.equal(run('check', '1', '--session', 'S1').stdout, plain, 'Without the setting nothing is read or printed');
  assert.ok(!queries()[0].includes('Zielrelease'));

  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify(setting));
  assert.deepEqual(baseLines(), ['base: release/0.1.1 (Zielrelease)'], 'HEAD descends from the base: only the base is named');
  const [asked, ...more] = queries().filter(query => !query.includes('search('));
  assert.deepEqual(more, [], 'The field comes with the one issue query, not with one of its own');
  assert.ok(asked.includes('fieldValueByName(name:"Zielrelease")'));

  writeIssue(withField({ text: '0.1.1' }));
  assert.deepEqual(baseLines(), ['base: release/0.1.1 (Zielrelease)'], 'A text field works as well');

  git('checkout', '-q', '--orphan', 'elsewhere');
  git('commit', '--allow-empty', '-q', '-m', 'unrelated');
  const warned = run('check', '1', '--session', 'S1');
  assert.deepEqual(baseLines(), ['base: release/0.1.1 (Zielrelease)', 'note: HEAD is not on origin/release/0.1.1']);
  assert.equal(warned.status, 0, 'A warning is no BLOCKED');
  const stackedPr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'release/0.1.1', headRefName: 'claude/5-base', headRefOid: 'ba5e0001' };
  writeIssue(withField({ name: '0.1.1' }, { blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null, [stackedPr], { number: 2, repository: { nameWithOwner: 'test/example' } })] } }));
  assert.equal(run('check', '1', '--session', 'S1').status, 4);
  assert.deepEqual(baseLines().filter(line => line.includes('HEAD')), [], 'A stack starts on its base PR, not on the base branch');
  writeIssue(withField({ name: '0.1.1' }));
  writeFileSync(join(checkout, 'branches.json'), JSON.stringify(['claude/1-started']));
  assert.ok(!baseLines().some(line => line.includes('HEAD is not on')), 'An issue with a branch is not told to branch again');
  rmSync(join(checkout, 'branches.json'));

  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ ...setting, baseBranch: { ...setting.baseBranch, values: { main: 'main' } } }));
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeIssue(withField({ name: 'main' }));
  assert.deepEqual(baseLines(), ['base: main (Zielrelease)'], 'A fixed value names its own branch instead of the pattern, and HEAD is checked against it');
  writeIssue(withField({ name: '0.1.1' }));
  assert.deepEqual(baseLines()[0], 'base: release/0.1.1 (Zielrelease)', 'Any other value keeps the pattern');
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify(setting));

  writeIssue(withField({ name: '9.9.9' }));
  assert.deepEqual(baseLines(), ['base: release/9.9.9 (Zielrelease)', 'note: origin/release/9.9.9 is not known in this checkout']);
  writeIssue(withField({ text: '0.1.1 LTS' }));
  assert.deepEqual(baseLines(), ['base: release/0.1.1 LTS (Zielrelease)', 'note: release/0.1.1 LTS is not a valid branch name']);
  writeIssue(withField({ name: '0.1.1' }));
  writeFileSync(join(checkout, '.git/HEAD'), 'garbage');
  assert.deepEqual(baseLines().map(line => line.replace(/\(exit \d+\)/, '(exit N)')), ['base: release/0.1.1 (Zielrelease)', 'note: git could not check origin/release/0.1.1 (exit N)'], 'A git failure is no advice about the base');
  writeIssue(withField(null));
  assert.deepEqual(baseLines(), ['note: the Project field Zielrelease is empty']);
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ ...setting, baseBranch: { field: 'Zielrelease' } }));
  assert.equal(run('check', '1', '--session', 'S1').status, 2, 'A malformed setting is unknown, never silently ignored');
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


// Vaultdex #1458, #1484: drivers left issues in Automated review and started new ones.
test('check of a new issue is BLOCKED with "finish #N first" while the own session has an unfinished issue, unless it stacks on that work', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const own = (status, assignee = 'worker') => ({ ...issue(status), number: 5, assignees: { nodes: [{ login: assignee }] } });
  const search = row => writeFileSync(join(checkout, 'search.json'), JSON.stringify([row]));
  writeFileSync(join(checkout, 'backlink-comments-5.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' }, body: 'Agent: claude, Session: S1',
    html_url: 'https://example.test/c5', created_at: '2026-10-06T10:00:00Z' }]));
  writeIssue(issue());

  search(own('Automated review'));
  const blocked = run('check', '1', '--session', 'S1');
  assert.equal(blocked.status, 1, blocked.stdout);
  assert.match(blocked.stdout, /^- finish #5 first/m);
  const other = run('check', '1', '--session', 'S2');
  assert.equal(other.status, 0, `the claim of another session is not mine: ${other.stdout}`);
  search(own('Human review'));
  assert.equal(run('check', '1', '--session', 'S1').status, 0, 'handed off work is finished');
  search(own('Automated review', 'someone'));
  assert.equal(run('check', '1', '--session', 'S1').status, 0, 'an issue assigned to someone else is not mine');

  const pr = { number: 8, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/8-base', headRefOid: 'ba5e0001' };
  const stack = number => writeIssue(issue('Ready', [predecessor('OPEN', null, [pr], { number, repository: { nameWithOwner: 'test/example' } })]));
  search(own('Automated review'));
  stack(5);
  assert.equal(run('check', '1', '--session', 'S1').status, 4, 'stacking on the own work continues it');
  stack(2);
  assert.equal(run('check', '1', '--session', 'S1').status, 1, 'stacking on other work is a new start');
});


test('check lets a new session take over a claim without activity for staleHours, also with its open PR', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const hoursAgo = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  const work = (issueHours, prHours, status = 'In progress', mergeStateStatus = 'CLEAN') => {
    const base = issue(status);
    writeIssue({ ...base, updatedAt: hoursAgo(issueHours), projectItems: { nodes: [{ ...base.projectItems.nodes[0], updatedAt: hoursAgo(issueHours) }] },
      closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', mergeStateStatus, updatedAt: hoursAgo(prHours), repository: { nameWithOwner: 'test/example' }, headRefName: 'claude/1-work' }] } });
  };
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' }, body: 'Agent: claude, Session: OLD',
    html_url: 'https://example.test/c1', created_at: '2026-10-06T10:00:00Z' }]));

  work(5, 5);
  assert.equal(run('check', '1', '--session', 'NEW').status, 1, 'within staleHours the claim holds');
  work(7, 7);
  const taken = run('check', '1', '--session', 'NEW');
  assert.equal(taken.status, 0, taken.stdout);
  assert.match(taken.stdout, /Takeover of stale claim OLD/);
  assert.equal(run('check', '1').status, 1, 'without a session nothing is taken over');
  work(7, 1);
  assert.equal(run('check', '1', '--session', 'NEW').status, 1, 'a push to the PR is activity');
  work(1, 1, 'Human review', 'DIRTY');
  assert.equal(run('check', '1', '--session', 'NEW').status, 0, 'a Human-review PR with conflicts is abandoned at once');
  work(1, 1, 'Human review');
  assert.equal(run('check', '1', '--session', 'NEW').status, 1, 'a clean one is not');
});

test('check and next let a new session take over a claim without PR and branch once the claim itself is older than staleHours', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const hoursAgo = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  const base = issue();
  // A field change just now: it must not renew the claim (#497).
  const fresh = { ...base, updatedAt: hoursAgo(0), projectItems: { nodes: [{ ...base.projectItems.nodes[0], updatedAt: hoursAgo(0) }] } };
  const claim = hours => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([{ id: 1, user: { login: 'worker', type: 'User' },
    body: 'Agent: claude, Session: OLD', html_url: 'https://example.test/c1', created_at: hoursAgo(hours) }]));
  const startable = () => /^#1 /m.test(run('next', '--session', 'NEW').stdout.split('\n\n').find(part => !part.startsWith('Ready but not startable')) ?? '');
  writeIssue(fresh);
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...fresh, issueFieldValues: { nodes: [] } }]));

  claim(2);
  assert.equal(run('check', '1', '--session', 'NEW').status, 1, 'a fresh claim holds');
  assert.equal(startable(), false, 'next does not offer what check blocks');
  claim(7);
  const taken = run('check', '1', '--session', 'NEW');
  assert.equal(taken.status, 0, taken.stdout);
  assert.match(taken.stdout, /Takeover of stale claim OLD/);
  assert.equal(startable(), true, 'next offers what check allows');
  writeFileSync(join(checkout, 'branches.json'), JSON.stringify(['claude/1-started']));
  assert.equal(run('check', '1', '--session', 'NEW').status, 1, 'a branch keeps holding it');
  assert.equal(startable(), false, 'next sees the branch too');
});
