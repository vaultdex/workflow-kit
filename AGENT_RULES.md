# Shared agent rules

Read this file once per task with the project's short AGENTS.md. "Project" means
the consumer checkout (this kit when developing it); configuration and local
contracts belong there. Links below resolve inside the pinned kit. User instructions
take precedence within system, permission and safety boundaries.

## Always

- Deliver the authorized outcome. Preserve foreign work, ownership and history;
  no destructive resets, force-push, secret exposure or autonomous merge.
- Understand affected contracts and callers. Reuse existing code, standard libraries
  and native features; fix root causes with the smallest complete change. Preserve
  validation, authorization, privacy, integrity, attribution and accessibility.
- Start only executable, authorized Ready work. Check current main, ownership,
  external blockers and competing PRs; record the driver. Before taking or resuming
  work, including review fixes and every move to In progress, run the live
  [execution check](docs/CONTRIBUTING.md#execution-check). An open native predecessor
  or failed/incomplete check means STOP: no claim, In progress or dependent edits,
  except for the check's specific, recorded human exception with source, permitted
  work and remaining gates.
  Ready, an existing branch/driver or a review request does not waive this check;
  never reinterpret a native blocker as merge-only. New work
  enters Backlog with milestone, Priority and labels. Never promote it without
  human authorization; follow the project's configured start policy.
- Issues own scope/evidence, the configured Project owns status, PRs own review.
  Separate deliveries need separate complete issues before branching. Use native
  issue-linked branches and verify PR closing links; never close partial work.
- Run focused checks early; review corrections rerun affected checks. Existing CI
  and automatic reviews run together. Project-defined expensive final proof may
  follow the last automatic correction, but must pass before Human review/merge.
  Disclose pending proof; missing access is a blocker, not a scheduled final gate.
- Inspect encountered warnings/deprecations and affected UI behavior/browser
  console. Investigate concrete signals, reuse existing findings; fix in scope or
  link a deduplicated actionable follow-up. Blockers need evidence and a revisit
  condition. Name relevant skipped checks and reasons; untested is not error-free.
- Finish required reviews and proof before Human review; fix or track every finding.
  Further changes invalidate affected evidence and require the applicable review
  cycle. Only humans accept/merge; Done needs acceptance and actual merge.
- Reuse unchanged context/evidence; refresh live ownership and changed inputs.
  Read only relevant sections, never recursively load linked guides or skill trees.
  No routine skill regeneration, installation, polling loops or broad speculative
  audits. Setup/trust stays explicit; unknown hook status is not failure or success.
- Minimize tokens and Actions. Use existing workflows; estimate incremental usage
  before expanding CI and obtain approval if budget is unknown/insufficient.
  Never weaken required checks or raise spending limits to save time.

## Read at the relevant step

| Step | Required detail |
| --- | --- |
| Take, resume or create work | [Board/ownership and execution check](docs/CONTRIBUTING.md#board-and-ownership), [issue plan](docs/CONTRIBUTING.md#issue-plans-and-pr-descriptions), [milestones](docs/CONTRIBUTING.md#milestones), [metadata](docs/CONTRIBUTING.md#priority-and-issue-metadata) |
| Branch, PR or scope boundary | [Issue/branch/PR links](docs/CONTRIBUTING.md#issue-branch-and-pr-links), [blockers and findings](docs/CONTRIBUTING.md#recovery-scope-and-findings) |
| Change behavior | Affected project architecture/contracts and [Watchdog](WATCHDOG.md) |
| Publish or rework | [Publication/review](docs/CONTRIBUTING.md#publication-and-review); local test commands and final gates |
| Missing human decision | [Human input](docs/CONTRIBUTING.md#human-input) |
| Session hook preflight | [Hook status](docs/agent-hooks.md#agent-hook-preflight), once when native status is accessible |
| Explicit setup/kit upgrade | [Setup](SETUP.md); source/discovery checks and personal trust boundaries |

Read each relevant section once; reuse it until its rules change. Do not read
kit-maintainer AGENTS.md from a consumer. Keep local rules to actual project
contracts and exceptions, not copies of this file.
