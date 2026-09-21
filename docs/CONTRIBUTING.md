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
| Backlog | Proposed or blocked; blockers include cause and recovery condition. |
| Ready | Accepted scope, required authorization and satisfied execution dependencies. |
| In progress | One driver; linked session, branch and PR when available. |
| In review | Ready PR, passed selected checks, disclosed evidence limits. |
| Done | Acceptance satisfied; delivered repository work actually merged. |

- Before adding work, inspect relevant open/closed issues, cards and competing PRs.
  Extend compatible unowned work; coordinate foreign active scope. Plans specify
  outcome, files/contracts, non-goals, steps, acceptance, checks, real dependencies,
  risks and recovery. Evidence needs durable authorized links/paths, not chat alone.
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

Use the project's existing priority scale (template: Urgent, High, Medium, Low),
assessing impact and urgency. Do not default everything to High or reprioritize
foreign active work without coordination. If impact is uncertain, document the
basis of a provisional priority and the investigation needed; do not leave it blank.
Reuse labels that describe affected areas and work type; create new labels only
for a missing meaningful category. Priority never grants approval or waives checks.
Verify all three fields before handing off or moving an issue to Ready/In review.
This is a contributor obligation, not a server-enforced required-field check.

## Labels

Use native issue forms and explicit labels on CLI-created issues/PRs. Labels describe
scope, never approval, priority, checks or merge authority. Preserve existing labels.

## Recovery, scope and findings

- Block only affected work: record failure, unblocking evidence needed, next action
  and prior driver/branch/commit/PR; preserve partial work. Store handoff, set
  Backlog, release assignment and verify. Anyone may refine unowned blockers;
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
   failed checks are not success. Keep Draft while work/gates remain. Refresh unknown
   metadata boundedly, then report blocker; otherwise refresh only meaningful changes.
4. Once implementation and selected checks are complete, mark PR Ready for Review
   and set In review; this triggers automatic code reviews. Await all configured
   automatic reviews for the delivered revision before reporting agent work complete;
   green CI alone is insufficient. Link all delivered issues; `Closes #N` only for
   full acceptance. Record local proof against tested revision in issue; CI owns
   check state.
   Query analyzer findings directly (Sonar issues/security hotspots and review-body
   comments), including every page; verify analysis covers delivered HEAD. A green
   quality gate does not mean zero findings. Re-query after the final push and record
   remaining counts/dispositions. Missing or stale analysis is not a clean result;
   apply step 6 only for confirmed service limitations.
5. Further work, including review fixes, returns PR to Draft and issue to In progress
   before edits. Finish changes and affected checks, then mark Ready for Review / In
   review again and await the new review cycle. Before agent completion, fix every
   finding with verification or link an actionable follow-up issue under
   [findings disposition](#recovery-scope-and-findings). Record dispositions in PR;
   creating follow-ups does not waive this PR's acceptance or required checks.
6. If automatic reviews cannot run because of exhausted tokens/quota, service failure
   or another confirmed blocker, record affected reviewer, cause and evidence in PR
   and explicitly disclose the missing review in the final report. After other work,
   checks and received findings are handled, agent work may finish with that review
   limitation. Pending, queued or unknown review state is not this exception; inspect
   PR reviews, comments and checks, not only CI. This exception grants no merge
   authority, check bypass or pre-merge Done status.
7. After actual merge, verify acceptance/delivered work before closure and Done.
   Unprovable post-merge/external acceptance needs a dependent task. Queued merge or
   PR closure is not delivery. Verify native Project automation before relying on it;
   not-planned closure must not become Done. GITHUB_TOKEN Project access is not assumed.

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
