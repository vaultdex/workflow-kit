---
name: ponytail-debt
description: >
  Harvest every `ponytail:` comment in the codebase into a debt ledger, so the
  deliberate shortcuts and deferrals ponytail leaves behind get tracked instead
  of rotting into "later means never". Use when the user says "ponytail debt",
  "/ponytail-debt", "what did ponytail defer", "list the shortcuts", "ponytail
  ledger", or "what did we mark to do later". One-shot report, changes nothing.
---

Every deliberate ponytail shortcut is marked with a `ponytail:` comment naming
its ceiling and upgrade path. This collects them into one ledger so a deferral
can't quietly become permanent.

## Scan

Search application code for comment markers, skipping dependencies, build
output and vendored skills. Scan files for secrets before reading their contents,
as required by repository AGENTS.md. Include Vaultdex's existing `watchdog:`
markers; do not rename them merely to use this report.

Use `rg -n '(#|//) ?(ponytail|watchdog):'` on the scanned source files
(add other comment prefixes if your stack uses them).

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `ponytail: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? add
`git blame -L<line>,<line>`.

Flag the rot risk: any shortcut comment that names no upgrade path or
trigger gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No shortcut markers found.`

## Boundaries

Reads and reports only, changes nothing. Follow repository CONTRIBUTING.md for
durable findings in existing issues; do not create a second task ledger.
One-shot. "stop ponytail-debt" or "normal mode" to revert.
