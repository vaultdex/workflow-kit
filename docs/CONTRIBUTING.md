# Contributing

Read applicable `AGENTS.md`, this guide and [WATCHDOG.md](../WATCHDOG.md) once;
refresh changed rules/state and reuse valid evidence. User instructions override
skill guidelines within higher-priority/permission boundaries. If a rule blocks
work, cite its file/text and continue unaffected authorized work.

## Board and ownership

The project recorded in `.github/workflow-project.json` owns order/status; issues
own scope/evidence/recovery; PRs own review/checks. No task JSON, central issue,
claim/paired-research/completion PRs, dashboard synchronizer or automatic all-board loop.

| Status | Required state |
| --- | --- |
| Backlog | Newly proposed, awaiting human triage, or still infeasible after blockers resolve; record reasons. |
| Ready | Human-approved feasible work; unresolved dependencies/blockers may remain. Placement authorizes a start only under `"start": "ready"` (start policy below). |
| In progress | Taken from Ready under the start policy after all execution blockers are resolved; one driver and linked session, branch/PR. This is the Doing state. |
| Automated review | Ready PR, passed selected checks, disclosed evidence limits; automatic reviews of the delivered revision are running or awaiting disposition. |
| Human review | Ready for human acceptance: selected checks passed, automatic reviews finished and every finding fixed or linked to an actionable follow-up; disclose confirmed unavailable reviews under the exception below. |
| Done | Acceptance satisfied; delivered repository work actually merged. |

- New issues start in Backlog, including immediately actionable work. A human may
  authorize triage of one issue or the whole Backlog: check scope and metadata,
  promote feasible work to Ready even with unresolved blockers, and retain only
  work that remains infeasible after its blockers are resolved, with reasons.
  Under the default start policy, triage authorization never authorizes
  implementation or moving to In progress; under `"start": "ready"`, Ready placement
  from human-authorized triage is that authorization (start policy below).
  Preserve native dependency links and explicit external blocker/recovery evidence.
  Before selecting Ready work, recheck blockers and skip blocked items: GitHub
  resolves dependency relationships when predecessors close, but Ready itself is
  not an execution gate. If no Ready issue is executable, report its blockers;
  never bypass them or treat waiting as permission.
- Before adding work, inspect relevant open/closed issues, cards and competing PRs.
  Extend compatible unowned work; coordinate foreign active scope. Plans specify
  outcome, files/contracts, non-goals, steps, acceptance, checks, real dependencies,
  risks and recovery. Evidence needs durable authorized links/paths, not chat alone.
- Start policy: implementation starts only from Ready. By default each start needs
  an explicit human request covering that issue/scope. A project may instead set
  `"start": "ready"` in `.github/workflow-project.json` (project-owned; setup and
  kit updates keep it) to declare human triage to Ready as that authorization;
  every other gate here still applies. Never take implementation
  directly from Backlog or autonomously move a candidate to Ready/In progress
  because it seems useful or executable.
- If Ready is empty, inspect Backlog without implementation: assess scope, evidence,
  dependencies, ownership and blockers; propose the next executable issue with a
  short reason and needed preparation. Leave its status unchanged pending a human
  decision. If none is executable, report the concrete blockers instead of starting
  unrelated work. Analysis permission is not implementation permission.
- A human request to implement a Backlog issue authorizes preparing/checking Ready:
  record the instruction and accepted scope, move through Ready,
  then start In progress only after resolving execution blockers. Do not skip unresolved dependencies or required approval.
  Existing authorization covers verification/review fixes within the same active
  scope; starting another issue needs new authorization under the start policy. Native automations must
  not promote work to Ready/In progress just because a PR was linked or a bot acted.
- Before taking work, refresh main, status, assignee, dependencies and linked PRs.
  Record driver/session/branch, assign and set In progress, then re-read. Shared
  GitHub logins still need distinct sessions. Edits are not atomic claims; competing
  ownership/overlap stops affected work pending coordination. Inactivity grants nothing.
- Driver owns integration, decisions, proof and delivery. Delegated slices need
  bounded non-overlapping paths, acceptance, non-goals and shared contracts; workers
  cannot claim, change status or approve/merge. Use sufficient model capability;
  no fixed model/version or legacy model_reasoning metadata. Respect requested scope.
- Risk determines proof: local regression → cross-component contracts → security,
  workflow/migration boundaries and recovery → authorized live targets/operator
  evidence. Old R0–R4 labels and agent-merge exceptions are retired. Human review
  and merge remain default; green checks, labels or board edits grant no authority.

## Issue, branch and PR links

After the Ready/authorization/ownership checks above, create new branches through
the issue's native **Development → Create a branch** action or its CLI equivalent.
On GitHub, use explicit repository, issue, branch name and current base:

```sh
gh issue develop ISSUE --repo OWNER/REPO --list
gh issue develop ISSUE --repo OWNER/REPO --name codex/ISSUE-topic --base main
gh issue develop ISSUE --repo OWNER/REPO --list
```

Replace placeholders and use the repository's actual approved base. Fetch the
created remote branch into the intended checkout/worktree; add `--checkout` only
when switching the current checkout is safe. Verify the expected branch/repository
in the returned list before editing. Reuse compatible owned branches/PRs instead
of creating duplicates. Link an existing branch through the issue's Development
control. After an error, inspect remote refs and issue links before retrying;
branch creation may have succeeded even when the command reported failure.

Decide the delivery boundary **before creating the PR, including a Draft**. When
an acceptance item cannot be performed within this delivery (for example a live
provider check requiring unavailable credentials), split that separately executable
acceptance into a follow-up under [scope and findings](#recovery-scope-and-findings).
Record the split and remaining limits in the original issue first. The delivery PR
uses `Closes #N` for the original issue's resulting, fully delivered scope; it does
not close the follow-up or claim its missing acceptance passed.

Every PR description must identify all delivered issues from its first publication,
including Drafts. For complete issue scope targeting the default branch, put
`Closes #N` in the PR body (`Closes OWNER/REPO#N` across repositories), repeating
the keyword for each issue. A branch name, title, comment or commit-only closing
keyword does not establish the required PR relationship. GitHub normally converts
an issue-linked branch into a linked PR when that PR is created; verify the result.

Use `Refs OWNER/REPO#N` without closing keywords only when there is no sensible
separate delivery unit, for example several PRs contributing to one issue or a
non-default target branch. State remaining acceptance and delivery steps. A manual
Development closing relationship must be removed through the PR's Development UI;
removing a keyword only removes a keyword-based link. Do not repeatedly attempt
body edits to remove a manual relationship. Resolve closure intent before PR
creation to avoid an unnecessary later UI handoff. For non-default targets, closing
keywords are ignored; recheck closure intent when the base or scope changes.
A scope split is not a way to waive required security, integrity or merge gates.

Immediately after PR creation/body or base changes, and before Ready for Review
or Human review, read back the saved description and actual GitHub relationships:

```sh
gh pr view PR --repo OWNER/REPO --json url,body,baseRefName,closingIssuesReferences
```

For complete default-branch deliveries, verify every intended issue appears in
`closingIssuesReferences` (or the Development UI) and no unrelated/partial issue
will close. For partial/non-default deliveries, verify references in the saved
body and the issue's cross-reference activity, plus absence of unintended closing
links. A `Refs` mention is traceability, not a closing link. GitHub may replace the
branch link with the PR link, so an empty branch list after PR creation is not
itself a failure. Repair missing/wrong links on the same PR before review handoff;
missing access or unverifiable linkage stays an explicit blocker, never claimed
as linked. Record verification in the owning issue; no separate ledger or job.

For GitLab repositories, use the issue's native **Create branch / Create merge
request** flow and `ISSUE-topic` instead of the GitHub `codex/ISSUE-topic` convention.
Automatic cross-linking requires the issue number followed by a hyphen at the
start of the branch name. Verify the generated MR
description, related issue and closure behavior; remove closing patterns for
partial deliveries. These are contributor checks, not server enforcement.

References: [GitHub CLI](https://cli.github.com/manual/gh_issue_develop),
[GitHub branch links](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-a-branch-for-an-issue),
[GitHub PR links](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue),
[GitLab cross-links](https://docs.gitlab.com/user/project/issues/crosslinking_issues/).

## Milestones

Every task issue needs one repository milestone when created or added to the project,
including Backlog, investigations and follow-ups. Reuse a matching milestone; create
a scoped one when none fits. Set the actual GitHub Milestone field, not just an issue
body reference or label. Convert draft cards to issues before tracking them as tasks.
Keep the assignment after closure; completeness checks include Done/closed cards.

Urgent fixes for confirmed production failures, security problems or data-loss risks
use the repository milestone `Hotfixes · laufend`, kept open
without a due date. Close hotfix issues individually; normal bug fixes and planned
work use their scoped milestone. Hotfix urgency never bypasses acceptance, review
or merge rules. This is a contributor obligation, not automatic server enforcement.

## Priority and issue metadata

Every issue needs a matching repository milestone, an explicit `Priority` in the
GitHub Project and appropriate area/type labels when created or added to the board.
This includes Backlog, investigations, hotfixes and follow-ups; retain metadata
when closing. Set the actual fields: an issue-body mention or a `priority` label
does not replace Project Priority. Convert draft cards to issues first.

When taking an authorized Ready issue, the driver checks its milestone, labels and
Project Priority before implementation and independently fills missing metadata.
GitHub Projects can link organization issue fields: an empty Project `options`
array does not prove an empty scale. Read the linked `issueField.options` and the
issue's `issueFieldValues` first. Set the underlying issue field for linked
Priority fields; do not create a duplicate Project field or replace its scale.
For a project-local Priority field with no selectable options, completing its
scale is routine setup within authorized project work: initialize Urgent, High,
Medium, Low without requesting additional approval. Changing a linked organization
scale requires authorization covering that shared schema; reuse existing authority.
Filling a missing issue priority from an existing scale within authorized work
needs no additional approval and does not change its schema. Preserve existing
options and priorities of foreign active work; coordinate any changes to those.
Complete this preflight early so missing metadata does not first become a blocker
at review handoff.

Use the project's existing priority scale (template: Urgent, High, Medium, Low),
assessing impact and urgency. Do not default everything to High or reprioritize
foreign active work without coordination. If impact is uncertain, document the
basis of a provisional priority and the investigation needed; do not leave it blank.
Reuse labels that describe affected areas and work type; create new labels only
for a missing meaningful category. Priority never grants approval or waives checks.
Verify all three fields before handing off or moving an issue to Ready, Automated review or Human review.
This is a contributor obligation, not a server-enforced required-field check.

## Labels

Use native issue forms and explicit labels on CLI-created issues/PRs. Labels describe
scope, never approval, priority, checks or merge authority. Preserve existing labels.

## Recovery, scope and findings

- Block only affected work: record failure, unblocking evidence needed, next action
  and prior driver/branch/commit/PR; preserve partial work. Store handoff, return
  previously triaged feasible work to Ready with explicit blockers, release
  assignment and verify. Untriaged or inherently infeasible work stays Backlog.
  Anyone may refine unowned blockers;
  preserve approvals. Resume after verified unblocking and fresh ownership/dependency
  checks, never merely elapsed time.
- Inspect actual Git/GitHub state after failure; correct the cause and resume the
  same branch/PR. No resets, duplicate PRs, credential/protection changes or repo
  workarounds for invocation mistakes. Report tool/service defects with reproduction.
  Missing credentials, metadata or evidence remain explicit gaps.
- Requested corrections return work to In progress and PR to Draft until settled.
  PR rejection/closure is not delivery or permission to take ownership. Cancellation
  needs a human not-planned disposition; preserve history, never mark implemented/Done.
  Reopening requires reconciling scope/status.
- Every concrete finding needs evidence, consequence and disposition: bounded
  same-outcome/root-cause fix plus regression, or linked actionable unowned follow-up
  with acceptance/checks. Update scope before work; distinct outcomes, ownership,
  dependencies, risk, product/architecture or protected-data changes need separately
  scoped work/authorization. Preserve foreign work; retain out-of-scope findings.
  Independent follow-ups need planning, not implementation before this delivery.
- Before PR creation, move separately executable unavailable acceptance into a
  follow-up issue: record exact acceptance, missing access/evidence, recovery and
  checks; assign milestone, Project Priority, labels and Backlog; set its native
  `blocked by` dependency to the original issue. Record the split, follow-up link
  and resulting deliverable scope in the original issue. Preserve historical
  acceptance text with an explicit superseding decision, not silent deletion.
  This policy permits that bounded split, not a waiver of security/integrity or
  mandatory pre-merge checks. If safe delivery depends on the missing proof,
  retain the blocker. Changed outcomes, risk or ownership still need the separately
  scoped authorization above. Creating the follow-up grants no implementation
  authority: Backlog-to-Ready remains human triage under the start policy.
- Research retains full results and each finding's accept/defer/reject rationale
  with human decision. Accepted implementation findings become deduplicated tasks;
  result PR only when files change. Closing PRs never substitutes for that decision.

## Publication and review

Preserve unrelated edits; isolate worktrees when needed. Never stash/discard foreign
work, rewrite task history through rebase/amend/reset/force-push, or bypass protections.
Ordinary owned code conflicts are driver work; preserve foreign intent and coordinate
ownership conflicts. Use `codex/ISSUE-topic` branches from current origin/main.

1. Finish scope, local proof and diff review, including Drafts. Before first push
   and every PR creation, fetch main and merge if missing; resolve permitted
   conflicts and rerun invalidated checks. Recheck delayed publication if main moved.
2. Push prepared head once; update the same PR. Later main integration requires
   conflicts, affected correctness/ownership or an actual gate—not unrelated movement.
3. Inspect live base/head, ownership, mergeability and selected checks together.
   Empty checks do not prove no workflow runs; missing expected/pending/cancelled/
   failed checks are not success. Keep Draft only while implementation, local proof
   or a selected pre-review check remains open. Await running checks through the
   harness waiting mechanism, not model polling. Refresh unknown metadata boundedly,
   then report the concrete blocker; do not park a finished PR in Draft without one.
4. Before marking the PR Ready for Review and setting Automated review, verify
   delivered issue links and closure intent under [issue, branch and PR links](#issue-branch-and-pr-links).
   Once that verification, implementation, local proof and selected checks are
   complete, immediately mark Ready for Review / Automated review. Automatic
   reviews start outside Draft; never wait for them while the PR is Draft.
   Optional extra self-reviews, subagents or analyses are not new gates delaying
   this transition. Their actionable findings enter the same rework cycle below.
   Await all configured automatic reviews for the delivered revision before
   reporting agent work complete; green CI alone is insufficient. Record local
   proof against tested revision in issue; CI owns check state.
   Query analyzer findings directly (Sonar issues/security hotspots and review-body
   comments), including every page; verify analysis covers delivered HEAD. A green
   quality gate does not mean zero findings. Re-query after the final push and record
   remaining counts/dispositions. Missing or stale analysis is not a clean result;
   apply step 6 only for confirmed service limitations.
5. Further work, including review fixes, returns PR to Draft and issue to In progress
   before edits, including corrections requested during Human review. Finish changes
   and affected checks, then mark Ready for Review / Automated review again and await
   the new review cycle. Before agent completion, fix every
   finding with verification or link an actionable follow-up issue under
   [findings disposition](#recovery-scope-and-findings). Record dispositions in PR;
   creating follow-ups does not waive this PR's acceptance or required checks.
   Once these gates are satisfied, move the issue to Human review and hand off for
   human acceptance. Ready for Review alone never means Human review.
6. If automatic reviews cannot run because of exhausted tokens/quota, service failure
   or another confirmed blocker, record affected reviewer, cause and evidence in PR
   and explicitly disclose the missing review in the final report. After other work,
   checks and received findings are handled, move to Human review with the missing
   review prominently disclosed; agent work may finish with that limitation.
   Pending, queued or unknown review state remains Automated review and is not this exception; inspect
   PR reviews, comments and checks, not only CI. This exception grants no merge
   authority, check bypass or pre-merge Done status.
7. After actual merge, verify acceptance of the recorded delivered scope before
   closure and Done. Separately scoped external acceptance remains in its dependent
   follow-up; it is not certified by this merge. Apply the split before PR creation,
   not for the first time after merge. Queued merge or PR closure is not delivery.
   Verify native Project automation before relying on it; not-planned closure must
   not become Done. GITHUB_TOKEN Project access is not assumed.

Write concise PR titles/descriptions in the project language: **Was wurde geändert und warum?**
(plans: **Was ist geplant und warum?**), resulting behavior/reason and issue links.
Routine evidence stays in issues/native checks. **Prüfung und Ergebnisse** only for
problems/material proof limits; **Retro** only for findings and fix/follow-up links.
Remove hints, empty sections, copied logs/status, mandatory inventories/SHAs, legacy
role/task metadata, generic rollback fields and decorative alerts. Explain material
risk/recovery where relevant.

Update durable behavior/API/architecture/operations/configuration/workflow docs and
affected unowned follow-ups. Preserve historical results through supersession links;
notable delivered user changes belong in release notes, not another task ledger.
