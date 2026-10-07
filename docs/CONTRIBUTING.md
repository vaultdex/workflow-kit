# Contribution workflow

Reference for [AGENT_RULES.md](../AGENT_RULES.md). `.github/workflow-project.json`
identifies the Project: it owns status/priority, issues own scope/acceptance/blockers/
evidence, PRs own review. Keep no second task list, ledger or tracking issue.

## Starting work

For the complete ordered procedure, follow [Start or resume](../AGENT_RULES.md#start-or-resume).
New issues and follow-ups start in Backlog. Only human authorization permits moving
Backlog to Ready; Ready can still contain blocked work.

**Start policy.** By default every start needs an explicit human request that
covers the issue. A project may set `"start": "ready"` in
`.github/workflow-project.json`; then a human placing an issue in Ready is that
request. A human request to implement a Backlog issue covers moving it through
Ready. Authorization for an issue covers its review fixes; a different issue needs
its own. Automations and bots never authorize a start.

**Finding work.** `board.mjs next` lists open Ready issues with every native
predecessor completed, highest Priority first, then the remaining Ready issues with
their native blockers; both show assignees. It does not check session ownership or
external prerequisites. Check remaining candidates before reporting no available
work. Then report blockers and propose a Backlog issue with a reason; do not start
it or change its status without authorization.

### Execution check

The [start procedure](../AGENT_RULES.md#start-or-resume) requires a fresh check on
claim, resume, handoff and review fixes. Memory, an existing branch or Ready status
does not replace it.

| Verdict | Meaning |
| --- | --- |
| STARTABLE | Open, on the configured Project with an active status, every native predecessor closed as completed, every `Wartet bis` condition met. |
| BLOCKED | An open predecessor, a predecessor closed as not planned or duplicate (needs a recorded decision), a closed issue, status Backlog or Done, or an unmet `Wartet bis` condition. |
| UNKNOWN | API error, incomplete dependency data, an inaccessible predecessor, an unset or unknown status, the issue is missing from the Project, or an unreadable `Wartet bis` line. Retry the read; never read it as "no blockers". |

**Claims.** `check ISSUE --session ID` also reads the issue comments of the authenticated login
(other authors are ignored). A claim carries the line `Agent: claude|codex, Session: ID`; a comment
with the line `Handover: ID` (from the earlier session or the human handing over, under the same login) passes the claim to
that session. The newest claim or handover decides, the later comment wins on equal times. If it names
another session than `--session`, `check` reports BLOCKED with agent, session, time and comment link.
Without `--session`, or when the newest claim is an old one that lacks the field (no known session), `check` only shows a note. Unreadable
comments are UNKNOWN. Assignment stays no lock; this check only reports, and `status` and `handoff` do not read claims.

**Claim-Alter und Sub-Issues.** Nur Information, kein neues Verdict und keine Erlaubnis zur Übernahme (die braucht
weiter eine ausdrückliche Übergabe). Bei einem bekannten Claim nennt `check` danach Alter und PR-Lage, etwa
`claim: 2d 4h ago (Session S1), open PR: none` oder `open PR: #123` (offene PRs mit Closing-Link auf das Issue).
Hat das Issue native Sub-Issues, folgt pro Sub-Issue eine Zeile `#N  Status  Assignee  Verdict` mit der Logik des
Verdicts oben, ohne Claims; sie ändern das Verdict des Issues nicht.

STARTABLE covers native prerequisites, not permission or ownership. Also inspect
**Abhängigkeiten und Wiederaufnahme** for external access, releases and decisions.
`status ISSUE "In progress"` repeats this check and requires assignment to the
authenticated GitHub user before writing; it cannot distinguish sessions sharing
a login. Failed reads prevent the transition. Automated review also checks
[PR backlinks](#pr-backlinks); remaining status commands are metadata operations,
not approval checks.

BLOCKED or UNKNOWN stops claims, In progress and dependent edits. Preserve
dependencies and acceptance; calling a blocker "merge-only" does not clear it.
Only a specific human instruction naming that blocker authorizes bounded work:
record its source, allowed work and remaining gates first. "Continue", a review
request or Ready placement does not qualify. The guarded command still rejects a
failed check: keep the current status and verdict, verify ownership and claim
fields, then work only within the documented exception. It is never STARTABLE.

**Wartet bis.** Eine Zeile `Wartet bis: <Wert>` (üblich im Abschnitt **Abhängigkeiten
und Wiederaufnahme**) macht eine Wartebedingung maschinenlesbar. Der Wert ist entweder
ein Tag des Projekt-Repositorys (`Wartet bis: v0.1.1`) oder ein UTC-Zeitpunkt
`JJJJ-MM-TTThh:mmZ` (`Wartet bis: 2026-10-12T18:51Z`); mehrere Zeilen gelten alle.
Die Zeile zählt, wo immer sie im Issue-Text steht, auch in einem Code-Block: so wird
keine Bedingung durch Markdown-Besonderheiten still überlesen. Ein Beispiel im Text
steht deshalb im Satz oder in Anführungszeichen, nicht als eigene Zeile.
`check` und `next` melden BLOCKED mit der Bedingung, solange der Tag fehlt oder der
Zeitpunkt in der Zukunft liegt. Ein ungültiger Wert oder ein fehlschlagender Tag-Lookup
ist UNKNOWN, nie „kein Blocker“. Das ersetzt keine nativen Blocker und verschiebt
nichts nach Ready; Zeitzonen außer UTC gibt es nicht.

**Claiming.** Complete and verify every step in [Start or resume](../AGENT_RULES.md#start-or-resume).

**Delegation.** The driver owns integration, decisions, proof and delivery.
Subagents get bounded, non-overlapping paths with acceptance and non-goals; they
never claim, change status or approve.

## Issues

Write issues and PRs in simple German and keep technical names exact. Before
creating one, search open and closed issues and PRs, and extend compatible work
instead of duplicating it. Separate deliverables need separate issues before
branching; a kit change and its consumer update are two issues.

Use the issue form's sections:

- **Wofür brauchen wir das?** The evidenced problem; for bugs, reproduction and
  expected behavior.
- **Was bringt es uns?** The concrete benefit or avoided harm.
- **Was muss gemacht werden?** The complete outcome and its non-goals.
- **Wie soll es umgesetzt werden?** Steps, files, callers, contracts, data, the
  properties that must not break, and failure and retry cases (in depth for
  bookings, migrations and process control).
- **Woran erkennen wir, dass es fertig ist?** Checkable criteria with commands;
  say which proof is a mock and which is live.
- **Abhängigkeiten und Wiederaufnahme.** Prerequisites with evidence and the next
  action, or „keine bekannt“.

Small tasks stay short. Move answers and decisions from comments into the body,
naming their source. See the [examples](task-writing-examples.md).

**Changing a body.** Several sessions often work on related issues, and GitHub replaces a
whole body without any version check. Change the body of an issue another session may also
edit only with `board.mjs body ISSUE FILE BASE_FILE`: `BASE_FILE` holds the body your change
is based on (`gh issue view N --json body --jq .body`), `FILE` the new one. The command
refuses and prints the difference when the body changed since you read it, and reports a
conflict when the read-back after the write is not what was written. On a conflict read the
body again, merge both changes and write again. A small window between the read and the write
remains, because GitHub has no conditional write; the read-back catches every overwrite before it.

**Metadata.** Every issue, including Backlog items and follow-ups, gets one
repository milestone, a Project Priority and area/type labels when it is created,
and keeps them after closing. Set the real fields (`gh issue create --milestone …
--label …`, then `board.mjs priority` and `board.mjs field` for other
single-select fields), not text in the body. Priority reflects
impact and urgency (Urgent, High, Medium, Low). If unsure, give a provisional one
and state its basis. Don't reprioritize others' active work. Confirmed production,
security or data-loss fixes use the milestone `Hotfixes · laufend`. Labels describe
scope, never approval, priority or checks. The sub-tasks of a spec are native sub-issues:
`board.mjs sub PARENT CHILD` links and reads back (no raw GraphQL).

### Human input

When an issue needs a human decision or action, make `## Menschliche Mitwirkung
nötig` its first section and add the label `needs-human-input`. For each open point
name:

- **Wer:** who decides or acts.
- **Was fehlt:** the question or action, with options and a recommendation.
- **Wirkung:** what is blocked and what can proceed.
- **Antwortweg:** an issue comment or the agent chat; both count.

Before dependent work, record the answer, its scope and its source in the body:
a comment link, or the date, person and session for a chat answer. Silence, a
recommendation or elapsed time is not approval. Remove the section and the label
only when every point is resolved. Routine technical decisions are yours.
[Example](task-writing-examples.md#menschliche-mitwirkung).

## Delivery

**Branch.** Create the branch from the issue so GitHub links it:
`gh issue develop ISSUE --repo OWNER/REPO --name <agent>/ISSUE-topic --base main`.
Reuse your existing branch and PR for the same issue. If creation fails, check the
remote branches and issue links before retrying.

**PR body.** From the first push, write `Closes #N` (cross-repo:
`Closes OWNER/REPO#N`) for each issue the PR fully delivers, and `Refs #N` for
related work. Closing keywords work only in PRs into the default branch. Partial
delivery never closes an issue; split the undeliverable part first
([undeliverable acceptance](#undeliverable-acceptance)). A branch created from the
issue is a branch connection, not proof of a direct PR connection. After creating
the PR or changing its body or base, verify the delivered issue in
`gh pr view PR --json closingIssuesReferences`. On a non-default base, connect
the issue with `board.mjs link ISSUE PR` (or GitHub's Development sidebar); the
command reads the connection back. This connection closes
the issue only when merged into the default branch; keep the project's release
rules for references and completion.

Write the PR in German: **Was wurde geändert und warum?** covers the result, the
reason and the benefit, with before/after where useful, plus the issue links. Add
**Prüfung und Grenzen** only for problems, skipped checks or proof limits. Link the
evidence in the issue instead of pasting logs or CI status. Delete template hints
and empty sections.

### PR backlinks

Immediately after creating a PR, post its full URL in a comment on every issue
being delivered and read back the comments (`gh api --paginate
repos/OWNER/REPO/issues/ISSUE/comments`). PR creation is complete only after every
backlink is confirmed, including for Draft PRs. Reuse an existing comment pointing
to the same open PR on resume; after a partial write or an API error, read first
before retrying. A link in the chat or PR body does not replace the issue comment.
`board.mjs link ISSUE PR` does both for an issue of this repository: the native
connection and, if no comment with the PR's URL exists yet, that comment, read back
afterwards. A second run writes nothing twice. `status` never writes it; its
refusal names `link` as the remedy.

Before Automated review, run `board.mjs status ISSUE "Automated review" PR
[OTHER_ISSUE...]` with the PR number and all other issues it delivers in this
repository (numbers), or another repository (`OWNER/REPO#N`). The command checks
the open PR's explicit issue references and every issue's complete comment list
before changing status. Missing/wrong/old backlinks,
unreadable or incomplete API data fail without changing status. The `field ISSUE
Status "Automated review" PR [OTHER_ISSUE...]` route performs the same check.

This check accepts `Refs` on release branches as well as `Closes` on the default
branch. It proves the comment backlinks, not native closing links, session
ownership, full delivery or review completion. Keep those separate checks and the
project's release policy. List only delivered issues; related references do not
expand the declared scope. Repository PRs without a delivered issue still use
`reviews PR` and `wait PR` without an artificial issue requirement. Creating a
backlink never closes an issue.

### Review loop

1. Before the first push, focused checks pass, the diff is reviewed and current
   main is merged if the branch is behind. Push once, then update the same PR.
   For every changed rule, state transition or background flow, write the cases
   before that push and keep them in the PR body section **Randfälle**, complete
   before Ready for Review: one line per case with the expected behavior and the
   test or the reason none is needed. Cover four classes: concurrency and timing;
   missing, stale, partial, deleted (retention) or unrelated data; interruption and
   cancellation; error paths and error classification. Settle open cases with the
   human; add cases that review uncovers. Pure text or configuration changes need
   no section.
2. Keep the PR Draft only while implementation or focused checks are unfinished.
   Then mark it Ready for Review with `board.mjs ready PR SHA` (the commit you just
   pushed: it waits until GitHub reports that head, so CI starts for the right
   revision) and set Automated review with the PR number and
   all delivered issues ([PR backlinks](#pr-backlinks)). Don't wait for optional
   self-reviews; bots and CI start only outside Draft.
3. Wait for CI and every review with a trace on the current head with `board.mjs
   wait PR` in the background (a driver subagent: foreground, see
   [parallel-drivers.md](parallel-drivers.md#driver-regeln) rule 4), not hand-written polling. Review bots run unreliably,
   so find out per head who reviews instead of assuming it. A trace is a check,
   status or review on the head commit, or, created after the head was pushed, a
   review comment, an open review request, an announced review or a bot's reaction
   to the PR or a review request. Once CI is green, a reviewer without such a trace
   is not coming. A traced review finishes when it posts its result: a review, a
   completed summary or a final status. If no result arrives within the time the
   reviewer's last completed review on this PR took (otherwise its usual duration),
   it is stalled. Pending, cancelled or missing expected CI checks are not success; a
   workflow whose only runs for the head were skipped before the PR became ready (Draft
   guard) has no run for the Ready head yet and keeps `wait` waiting.
   Read all findings and every review, comment and thread from bots and humans,
   including every page of analyzer results such as Sonar issues and hotspots. A
   green quality gate does not mean zero findings, and a missing or stale analysis
   is not clean. Don't re-request a review that is running or finished for the
   current commit without a concrete reason.
4. To change code: complete [Start or resume](../AGENT_RULES.md#start-or-resume),
   set the PR to Draft, batch fixes and rerun affected checks. Mark Ready for Review
   (`board.mjs ready PR SHA`), set Automated review and wait again. Merge main only for conflicts or a real need.
   After two correction pushes, collect new findings that neither block (P0/P1,
   security, data loss) nor regress against main in one follow-up issue instead of
   another push; every push restarts CI and reviews. `board.mjs reviews` and `wait` print
   `correction pushes after ready: N` (distinct heads pushed after the PR's first Ready,
   not the head that set it) and from `N >= 2` `cap reached`; nothing is blocked, and
   findings that block or regress (as defined above) and a red required CI are still corrected.
5. After the last automatic correction, run the project's expensive final proof if
   it defines one, and record the tested commit. Reuse proof only while its inputs
   are unchanged. Then run a retro once per PR: apply the retro skill
   (`.agents/skills/retro/SKILL.md`) to your own session. Fix findings within the
   issue's scope through step 4; record the rest as follow-up issues in the
   repository that owns the fix, with evidence from the session. Report findings
   about personal configuration (memory, shell profile, scheduled tasks) to the
   human instead of editing it. List every finding and its disposition, or none,
   in the [handoff comment](../README.md#handoff-comment).
6. Run `board.mjs handoff ISSUE PR` for the fully delivered issue only when CI
   passes, every review with a trace on the current head has finished or stalled,
   each finding is fixed or linked to a follow-up, the
   final proof has passed, the retro is recorded and no prerequisite is open. If a
   reviewer is confirmed unavailable (quota, outage) or stalled, record the
   reviewer, cause and evidence in the PR and hand off with that limitation stated
   in the handoff comment. Post that [handoff comment](../README.md#handoff-comment)
   on the PR for the current head (a `Head: <SHA>` line); `board.mjs handoff` refuses without it.
   Otherwise pending or unknown does not count as unavailable. Mergeable is not
   merge-ready: resolve every `blocker:` that `board.mjs reviews` lists (a standing
   change request, conflicts) or name it for the human when only a human may clear
   it, such as dismissing a review or resolving a thread you declined to fix.
   Handoff reuses the review check, verifies the native PR link and assigned active
   task, rejects Draft/closed PRs, changed heads, conflicts and open threads, waits
   for a determined merge state, rechecks PR proof and issue prerequisites immediately before mutation, then
   writes and reads back Human review. A failed or unreadable check leaves the
   status untouched. An unsuccessful status read-back is an error, not a delivery;
   inspect the actual status before retrying. Plain `status` writes maintain
   metadata and do not prove these delivery gates.
   Check off every fulfilled acceptance box in the issue body (`board.mjs body`) before the handoff; a part
   moved to a follow-up stays unchecked and links that issue (`- [ ] … → #12`). `board.mjs handoff`
   refuses while an open `- [ ]` line has no issue reference.
7. After the human merges, confirm the delivered scope is accepted and the issue is
   closed; then it is Done. A not-planned closure never becomes Done.

Update the affected docs (behavior, API, operations, workflow) in the same PR, and
add notable user-visible changes to the project's changelog or release notes.

## Blockers and scope

**Blocked mid-work.** Stop the affected edits. In the issue, record the blocker, its
evidence, what unblocks it, the next action and your branch and PR. Return a
triaged issue to Ready with the blocker noted and unassign yourself; resume only
through the execution check. Other authorized, startable work or read-only
investigation can continue.

**Failures.** Inspect the real Git and GitHub state, fix the cause and continue on
the same branch and PR. No resets, duplicate PRs or workarounds for your own
mistakes. Report tool or service defects with a reproduction. Missing credentials
stay explicit gaps.

### Findings and follow-ups

Every concrete finding needs evidence, impact and a disposition. Either it gets a
verified fix within the issue's scope, with a regression check, or it gets a
linked follow-up issue.

Follow-ups are deduplicated, carry full metadata, start in Backlog, and state
evidence, acceptance and checks. Phrase an unconfirmed signal as an investigation
question, not as a proven defect. A follow-up grants no authority to implement it
now. For research or audits, record each finding's accept, defer or reject decision
with the human's call; accepted findings become issues. Report critical security,
data-loss or availability risks at once, without exposing secrets.

### Undeliverable acceptance

If part of the acceptance can't be delivered, for example because access is
missing, get explicit human authorization before opening the PR. Then move that
part into a follow-up issue: Backlog, full metadata, native `blocked by` the
original issue (`board.mjs block FOLLOW-UP ORIGINAL`). Record the split in the original issue: leave that acceptance line unchecked and add the link to the follow-up (`- [ ] … → #12`), which `handoff` accepts as moved; the PR then closes the
reduced scope. Without authorization it stays a blocker. A split never waives
security or required checks.

**Cancellation.** A rejected or closed PR is not delivery. Only a human cancels
work (close as not planned), and its history stays.
