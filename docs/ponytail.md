# Ponytail

Source: `.vendor/ponytail`, pinned upstream release (MIT), plus
`scripts/ponytail/adaptations.patch`: repository tests, help/debt text and hook
host/state handling ([provenance](../scripts/ponytail/NOTICE.md)).
For discovery paths, reviewed regeneration and preserved local changes, follow
[generated files](../README.md#generated-files-and-ownership).

Skills: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`,
`ponytail-gain`, `ponytail-help`. The gain figures are upstream benchmarks, not
measurements from this project. If a personal Ponytail plugin is also enabled,
choose one source in the agent's settings.

## Hooks

Follow [hook installation and trust](../README.md#hooks).
`install-ponytail-hooks.mjs` copies generated hooks to
`~/.ponytail/vaultdex/<version>/`, refusing destinations inside any Git checkout.
Its `launch.sh` and `launch.cmd` use the installer's absolute Node binary:

- Hooks never search PATH and never run checkout files.
- `NODE_OPTIONS` and `NODE_PATH` are cleared.
- A Node inside a checkout is refused.
- If that Node is removed later, rerun the installer.

Snapshots are immutable per version; changed same-version snapshots are refused.
New versions change hook commands and need trust again. Execution policies stay
unchanged; no PowerShell script file runs.

| Host | Events |
| --- | --- |
| Codex, Claude Code | SessionStart, UserPromptSubmit, SubagentStart |
| Copilot | sessionStart, userPromptSubmitted, subagentStart |
| Cursor | sessionStart, beforeSubmitPrompt |

Cursor's existing always-on Ponytail rule takes precedence. Its sessionStart hook
uses one Windows/POSIX command: a Bash/PowerShell
[polyglot](https://shogo82148.github.io/blog/2021/12/30/polyglot-of-bash-and-powershell/),
and `launch.cmd` is a cmd/sh polyglot.

Mode is stored per Git checkout and host in the Ponytail config directory.
`/ponytail lite|full|ultra|off` switches it, and `/ponytail default <mode>` saves a
personal default. `node --test scripts/tests/ponytail-hooks.test.mjs` runs the
real manifest commands with hostile PATH entries; agent loading/trust needs
separate verification.
