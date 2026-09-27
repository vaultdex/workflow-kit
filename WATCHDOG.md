# Watchdog

Use [shared agent rules](AGENT_RULES.md); read this detail for behavior changes.
Understand the affected flow, then ship the smallest correct change.

## Decision ladder

Stop at the first option that works:

1. Do nothing when the need is speculative.
2. Reuse existing repository code or patterns.
3. Use the standard library or a native platform feature.
4. Use an already-installed dependency.
5. Write the minimum local code.

Before reimplementing library/platform behavior, check official documentation or
source for the repository's pinned versions. Record the reused API or concrete
capability gap in the owning issue; the PR links it and driver review verifies
that comparison.
Passing custom-code tests do not establish that the implementation is needed.

## Rules

- Fix the root cause at the narrowest shared layer.
- Prefer deleting obsolete code to adding replacements when both satisfy the requirement.
- Minimize files and public API surface; refactor only within the requested outcome.
- Add no speculative abstraction, extension point, configuration, wrapper, factory, compatibility shim, dependency, or scaffolding.
- Use a single-implementation interface only for a current boundary; a single-use helper only for material clarity. Do not generalize one known case.
- Preserve validation, security, accessibility, durability, error handling, workflow gates, and explicit product contracts.
- Add one focused regression check for new non-trivial behavior, without new test infrastructure.
- Mark an intentional shortcut only when its ceiling is real and known: `watchdog: <ceiling>; replace when <measurable trigger>`.

## Continuous improvement

During every task, actively watch the touched product flows, code, documentation,
tool output and workflow for defects, emerging risks, inconsistencies and wasted
time, tokens or Actions usage. Investigate credible signals with bounded checks;
distinguish observed facts, suspected causes and estimates. Do not invent findings
or launch broad audits merely to populate the backlog.

Before delivery, give every concrete finding a verified in-scope root-cause fix or,
without waiting for another request, a linked actionable follow-up under
[the contribution workflow](docs/CONTRIBUTING.md#recovery-scope-and-findings).
Check relevant open/closed issues, board items and PRs first; extend compatible
existing work and coordinate foreign active scope instead of duplicating it.
Follow-ups use the contribution workflow's metadata, Backlog and ownership rules.
Include reproduction or durable evidence, impact/urgency, bounded scope, acceptance,
verification and known blockers. Unconfirmed signals need a concrete
investigation question and evidence needed, never a claim of a proven defect.
Surface critical security, data-loss or availability risks immediately without
exposing secrets. Link dispositions in delivery; task creation grants no authority
to expand implementation scope, reprioritize others or merge. Reuse evidence and
existing checks; this duty adds no recurring monitors or automatic all-board loop.

## Warnings and deprecations

Treat every encountered warning or deprecation as actionable immediately, including
pre-existing and dependency messages from install, build, lint, tests, CI and runtime.
Investigate the cause; apply straightforward, safe root-cause fixes in the current
work and verify them. A passing command does not justify ignoring its warnings;
silencing messages alone is not a fix.

If a fix is not straightforward or exceeds authorized scope, create or reuse a
linked actionable issue with the message/source, impact, remediation, acceptance
and verification. If remediation is currently impossible, record the concrete blocker,
supporting evidence and revisit condition in the linked owning/follow-up issue.
Before delivery, account for every encountered warning or deprecation with its
verified fix or linked disposition; documentation alone does not replace an actionable issue.

## Change test

Before accepting added code, answer:

- What current requirement needs this?
- What existing path can be reused?
- Why does the simpler option fail?
- Can any new type, branch, file, option, dependency, or layer be removed?
- Does verification prove observable behavior rather than implementation detail?

If an answer is unclear, clarify the requirement or reduce the change.

## Exceptions

Complexity is justified only by current evidence: a security boundary, data-loss prevention, required compatibility, measured performance limit, hardware calibration, repository workflow, or explicit product contract. Record the reason beside the owning code or issue.

## Delivery

Issues and PRs follow the shared
[planning and PR rules](docs/CONTRIBUTING.md#issue-plans-and-pr-descriptions):
simple German, concrete purpose/benefit, actionable steps, resolved comment
questions and verifiable outcomes. PRs explain the actual change, reason and benefit.

Report changed behavior, focused verification, and intentionally skipped scope. Suggest future machinery only with a measurable trigger.
