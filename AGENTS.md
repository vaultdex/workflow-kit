# Workflow Kit contributors

Read docs/CONTRIBUTING.md for workflow and WATCHDOG.md for engineering/review.
Refresh changed rules/state; reuse valid evidence. The GitHub Project recorded in
`.github/workflow-project.json` owns order/status; issues own scope,
acceptance, dependencies and evidence; PRs own review. No second task ledger,
claim PRs or central steering issue.
Assign every task a milestone, including follow-ups; retain it after closure.
See docs/CONTRIBUTING.md#milestones for scope and the ongoing hotfix milestone.

Before work, check issue, dependencies, current main and competing PRs. Use
codex/<issue>-<topic>, one driver and linked branch/PR. Assignment is not a lock.
Preserve foreign work/ownership; no force-push or admin bypass. Human review/merge
remain default. Driver owns coordination, integration, proof and delivery;
delegation grants no ownership, scope expansion or approval authority.

Finish authorized scope through verification and PR delivery, not the entire
board. Before reporting agent work complete, await automatic reviews triggered by
Ready for Review and fix or link actionable follow-ups for every finding. Return
PR to Draft for further work, then Ready for Review and await reviews again.
Confirmed review unavailability (e.g. exhausted tokens/quota) permits agent
completion only with the missing review and cause disclosed; pending/unknown is
not unavailable. See docs/CONTRIBUTING.md#publication-and-review. Prepare concrete
results before requesting missing approval; cite the blocking rule and continue
unaffected work.

Read architecture/contracts before behavior changes. Product/technology belongs
in design docs and milestone/issues. Accepted API changes update contracts and
consumers together; today's API is not immutable. Preserve validation,
authorization, privacy, integrity and attribution; keep secrets out of clients/logs.

Follow Watchdog's smallest-complete-change rule. Run focused behavior and required
issue/CI checks; never weaken acceptance or equate mocks with live proof. Keep private artifacts and local generated bundles out of commits; commit only
required cloud discovery files verified against the pinned sources. Record blocker/recovery and preserve
branch/PR. In review requires passed checks and disclosed limits; Done requires
acceptance and merge. Disposition concrete findings with a fix or actionable linked
follow-up. Update durable docs; report results and uncertainty concisely.

## Hook preflight

At session start, check Ponytail and Impeccable hook status in the current harness
following [hook preflight](docs/agent-hooks.md). Warn once with activation steps
for confirmed failures or missing/disabled/untrusted hooks. If status is inaccessible,
continue without a warning or user check request; do not claim automatic execution.
Files or manual script runs do not prove live activation. Continue unaffected work.

## Token and Actions budgets

Treat tokens and GitHub Actions usage as limited budgets, not free capacity.

- Read/search only relevant context; reuse valid evidence, keep output concise,
  and avoid duplicate tool calls, checks or unchanged-state polling.
- Prefer smaller, cheaper models when sufficient for a bounded task. Delegate
  only when expected token savings or useful parallel progress outweigh context,
  coordination and verification overhead; handle trivial work directly. Pass only
  necessary context, avoid duplicate work, and preserve requested model constraints.
- Prefer existing workflows or native GitHub features over new automation.
  Before adding workflows/jobs or expanding triggers, schedules, matrices, runners
  or artifact retention, record necessity and estimated incremental monthly usage
  and cost in the issue/PR, including run frequency and billing assumptions.
  Verify fit within the existing budget; unknown or insufficient budget requires
  explicit user approval before enabling additional usage. Convenience alone
  does not justify recurring cost; never raise spending limits autonomously.
- Scope runs safely, cancel superseded runs when safe, and reuse valid results.
  Preserve required checks, security and acceptance; distinguish estimates from
  measured savings. Do not add a monitoring workflow just to enforce this policy.

## Code Review Rules

Preserve validation, authorization, privacy, integrity and attribution. Fix root
causes at the shared boundary. Keep producer, consumer, tests and documentation
consistent. Reuse standard/native facilities before introducing dependencies.

## Kit contracts

Use pinned upstream submodules and reviewed patches; never edit generated skills.
Run `node scripts/setup-skills.mjs`, `node --test scripts/tests` and
`node scripts/check-skills.mjs`. Hook/launcher changes additionally require
`node scripts/check-impeccable.mjs` with its real isolated engine proof.
No npm install, automatic installer hooks, secrets or private product files.
