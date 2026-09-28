# Contribution workflow

Details for the steps listed in [AGENT_RULES.md](../AGENT_RULES.md). The GitHub
Project named in `.github/workflow-project.json` owns status and priority; issues
own scope, acceptance, blockers and evidence; PRs own review. Keep no second task
list, ledger or tracking issue.

## Starting work

Statuses: Backlog → Ready → In progress → Automated review → Human review → Done.
New issues, follow-ups included, start in Backlog. Only a human moves an issue from
Backlog to Ready, and Ready may still hold issues with unresolved blockers.

**Start policy.** By default every start needs an explicit human request that
covers the issue. A project may set `"start": "ready"` in
`.github/workflow-project.json`; then a human placing an issue in Ready is that
request. A human request to implement a Backlog issue covers moving it through
Ready. Authorization for an issue covers its review fixes; a different issue needs
its own. Automations and bots never authorize a start.

**Finding work.** `board.mjs next` lists open Ready issues without open native
blockers, highest Priority first. If nothing is startable, report the blockers and
propose the next issue from Backlog with a short reason; don't implement it or
change its status.

### Execution check

Run `board.mjs check ISSUE` right before you claim an issue, resume after an
interruption or handoff, or return to In progress for review fixes. Earlier
results, memory, an existing branch or the Ready status are not evidence.

| Verdict | Meaning |
| --- | --- |
| STARTABLE | Open, on the configured Project with an active status, every native predecessor closed as completed. |
| BLOCKED | An open predecessor, a predecessor closed as not planned or duplicate (needs a recorded decision), a closed issue, or status Backlog or Done. |
| UNKNOWN | API error, incomplete dependency data, an inaccessible predecessor, an unset or unknown status, or the issue is missing from the Project. Retry the read; never read it as "no blockers". |

The check covers native blockers only. Also read the issue's **Abhängigkeiten und
Wiederaufnahme** section for external prerequisites such as access, releases or
decisions.

BLOCKED or UNKNOWN means: don't claim, don't move to In progress, don't edit
dependent code. Don't remove dependencies, narrow acceptance or call a blocker
"merge-only" to make an issue startable. Only a specific human instruction that
names the blocker allows bounded work despite it; record its source, the permitted
work and the remaining gates in the issue first. "Continue", a review request or
Ready placement is not such an instruction.

**Claiming.** After STARTABLE, assign yourself, set In progress and note the
verdict, your session and branch in the issue. Assignment is not a lock. If
prerequisites change while you work, stop the affected edits and check again;
check once more before Human review.

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

**Metadata.** Every issue, including Backlog items and follow-ups, gets one
repository milestone, a Project Priority and area/type labels when it is created,
and keeps them after closing. Set the real fields (`gh issue create --milestone …
--label …`, then `board.mjs priority`), not text in the body. Priority reflects
impact and urgency (Urgent, High, Medium, Low). If unsure, give a provisional one
and state its basis. Don't reprioritize others' active work. Confirmed production,
security or data-loss fixes use the milestone `Hotfixes · laufend`. Labels describe
scope, never approval, priority or checks.

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
issue already counts as a closing link. After creating the PR or changing its body
or base, verify with `gh pr view PR --json closingIssuesReferences`.

Write the PR in German: **Was wurde geändert und warum?** covers the result, the
reason and the benefit, with before/after where useful, plus the issue links. Add
**Prüfung und Grenzen** only for problems, skipped checks or proof limits. Link the
evidence in the issue instead of pasting logs or CI status. Delete template hints
and empty sections.

### Review loop

1. Before the first push, focused checks pass, the diff is reviewed and current
   main is merged if the branch is behind. Push once, then update the same PR.
2. Keep the PR Draft only while implementation or focused checks are unfinished.
   Then mark it Ready for Review and set Automated review. Don't wait for optional
   self-reviews; bots and CI start only outside Draft.
3. Wait for CI and every configured automatic review on the current head, using the
   harness's waiting, not polling. Pending, cancelled or missing expected checks are
   not success. Read all findings, including every page of analyzer results such
   as Sonar issues and hotspots. A green quality gate does not mean zero findings,
   and a missing or stale analysis is not clean. Don't re-request a review that is
   running or finished for the current commit without a concrete reason.
4. To change code: run the execution check, set the PR to Draft and the issue to In
   progress, batch the fixes, rerun the affected checks, mark the PR Ready for
   Review, set Automated review and wait again. Merge main only for conflicts or a
   real need.
5. After the last automatic correction, run the project's expensive final proof if
   it defines one, and record the tested commit. Reuse proof only while its inputs
   are unchanged.
6. Set Human review only when CI passes, every automatic review of the current head
   has finished, each finding is fixed or linked to a follow-up, the final proof has
   passed and no prerequisite is open. If a reviewer is confirmed unavailable
   (quota, outage), record the reviewer, cause and evidence in the PR and hand off
   with that limitation stated. Pending or unknown does not count as unavailable.
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
original issue (`board.mjs block FOLLOW-UP ORIGINAL`). Record the split in the original issue; the PR then closes the
reduced scope. Without authorization it stays a blocker. A split never waives
security or required checks.

**Cancellation.** A rejected or closed PR is not delivery. Only a human cancels
work (close as not planned), and its history stays.
