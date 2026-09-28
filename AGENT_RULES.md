# Agent rules

Read this once per task together with the project's AGENTS.md. Project rules and
user instructions add local contracts; they cannot relax the hard rules. Links
resolve inside the pinned kit: open a linked section only when you reach that
step, and never load guides or skill trees you don't need.

## Hard rules

- Humans accept and merge. Never merge, enable auto-merge or set Done before a
  human merged.
- Never force-push, rewrite shared history, reset, stash or discard work you don't
  own, or bypass branch protection, required checks or spending limits.
- Never expose secrets or commit personal configuration.
- Start or resume implementation only on a STARTABLE issue that the start policy
  authorizes you to take ([Starting work](docs/CONTRIBUTING.md#starting-work)).
- Continue only your own work. Another session's issue, branch or PR needs an
  explicit handover, even under a shared GitHub login.

## Workflow

| Status | What you do |
| --- | --- |
| Backlog | Nothing without a human request; propose, don't implement. |
| Ready | Start after `board.mjs check` says STARTABLE. |
| In progress | Implement on the issue-linked branch; the PR stays Draft. |
| Automated review | PR ready; wait for CI and every review bot; fix or link each finding. |
| Human review | Hand off. A human accepts and merges. |
| Done | Merged and accepted. |

Board commands, run in the project (`gh` must be logged in):

```sh
node .vendor/workflow-kit/scripts/board.mjs next                      # startable Ready issues
node .vendor/workflow-kit/scripts/board.mjs check 123                 # STARTABLE, BLOCKED or UNKNOWN
node .vendor/workflow-kit/scripts/board.mjs status 123 "In progress"
node .vendor/workflow-kit/scripts/board.mjs priority 123 High
node .vendor/workflow-kit/scripts/board.mjs block 124 123              # 124 is blocked by 123 (or OWNER/REPO#N)
```

## Engineering

- Understand the affected flow, contracts and callers first. Fix the root cause at
  the narrowest shared layer with the smallest complete change.
- Verify each review finding against the code and contract first; fix its
  neighboring paths in the same push. If the same class of finding returns after
  two correction pushes, stop patching and re-examine the whole area's states, data
  flow and assumptions.
- Take the first option that works: skip speculative needs, reuse repository code,
  use the standard library or platform, use an installed dependency, and only then
  write minimal new code. Check the pinned version's docs before reimplementing.
- Add no speculative abstraction, option, wrapper, dependency or scaffolding.
  Prefer deleting obsolete code to adding a replacement.
- Preserve validation, authorization, privacy, data integrity, error handling,
  attribution and accessibility.
- Scale proof with risk: focused regression, then cross-component contracts, then
  security, migration and recovery, then authorized live targets. Add one focused
  check for new non-trivial behavior in the existing test setup; it must fail on the
  known faulty behavior and assert its preconditions. Cover a cross-layer change
  with its whole flow (save → load → display). Mocks don't prove live integration.
- Treat every warning or deprecation you meet (install, build, lint, tests, CI,
  runtime, browser console) as a finding. Mark deliberate shortcuts with
  `ponytail: <ceiling>; replace when <trigger>`.
- Every finding ends as a verified fix in scope or a linked follow-up issue
  ([findings](docs/CONTRIBUTING.md#findings-and-follow-ups)). Report skipped checks
  and why; untested is not error-free.

## Economy

- Tokens and Actions minutes are budgets. Read only what the step needs, reuse
  evidence whose inputs are unchanged, and wait for CI and reviews with the
  harness's wait mechanism instead of polling.
- No routine setup reruns, broad audits, or new CI jobs and triggers without an
  estimate of the added usage; get approval when the budget is unknown.

## Details

| Step | Read |
| --- | --- |
| Pick, start or resume work | [Starting work](docs/CONTRIBUTING.md#starting-work) |
| Write or change an issue | [Issues](docs/CONTRIBUTING.md#issues) |
| Branch, PR and review loop | [Delivery](docs/CONTRIBUTING.md#delivery) |
| Blocked, failed or out-of-scope work | [Blockers and scope](docs/CONTRIBUTING.md#blockers-and-scope) |
| Set up or update the kit, hooks | [README](README.md), [SETUP](SETUP.md) |
