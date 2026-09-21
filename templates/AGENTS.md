# Contributors

Read `.vendor/workflow-kit/docs/CONTRIBUTING.md` and
`.vendor/workflow-kit/WATCHDOG.md`. The GitHub Project recorded in
`.github/workflow-project.json` owns status; issues own scope; PRs own review.
Check current main, ownership, dependencies and competing PRs before work.
Use one driver and `codex/<issue>-<topic>`. Human review/merge remain default.
Wait for configured reviews; fix or link actionable findings. Report unavailable
reviews explicitly. Never equate mocks, absent checks or config files with live proof.

## Code Review Rules

Preserve validation, authorization, privacy, integrity and attribution. Fix root
causes at the shared boundary. Keep producer, consumer, tests and documentation
consistent. Reuse standard/native facilities before introducing dependencies.

## Project-specific contracts

Record architecture, build/test commands and acceptance here before behavior changes.
