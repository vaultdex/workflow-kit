# Ponytail

Source: `.vendor/ponytail`, pinned to an upstream release (MIT). `setup-skills`
generates ordinary files from the pinned blobs plus
`scripts/ponytail/adaptations.patch`. The patch changes the test rule, the help
and debt texts and the hooks' host and state handling
([provenance](../scripts/ponytail/NOTICE.md)). Skills are committed in `.agent`,
`.agents`, `.claude`, `.github`, `.opencode` and `.pi`; hook sources are committed
in `.agents/hooks`. A checkout needs no generation or provider links. Regenerate
only during a reviewed kit update; replaced local content stays in
`.workflow-kit/replaced`.

Skills: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`,
`ponytail-gain`, `ponytail-help`. The gain figures are upstream benchmarks, not
measurements from this project. If a personal Ponytail plugin is also enabled,
choose one source in the agent's settings.

## Hooks

`install-ponytail-hooks.mjs` copies the generated hooks into
`~/.ponytail/vaultdex/<version>/`; it refuses a location inside any Git checkout.
Install once per machine and version; all projects and worktrees reuse that snapshot.
It then writes `launch.sh` and `launch.cmd`, which start the absolute Node binary
that ran the installer. As a result:

- Hooks never search PATH and never run checkout files.
- `NODE_OPTIONS` and `NODE_PATH` are cleared.
- A Node inside a checkout is refused.
- If that Node is removed later, rerun the installer.

Hook code is immutable per version: a changed snapshot at the same version is
refused. A new version changes the hook commands, so agents ask for trust again.
Execution policies are untouched: no PowerShell script file runs.

| Host | Events |
| --- | --- |
| Codex, Claude Code | SessionStart, UserPromptSubmit, SubagentStart |
| Copilot | sessionStart, userPromptSubmitted, subagentStart |
| Cursor | sessionStart, beforeSubmitPrompt |

In Cursor, an existing always-on Ponytail rule takes precedence. Cursor needs one
command string for Windows and POSIX, so its sessionStart hook is a Bash/PowerShell
[polyglot](https://shogo82148.github.io/blog/2021/12/30/polyglot-of-bash-and-powershell/),
and `launch.cmd` is a cmd/sh polyglot.

The mode is stored per Git checkout and host under the Ponytail config directory.
`/ponytail lite|full|ultra|off` switches it, and `/ponytail default <mode>` saves a
personal default. `node --test scripts/tests/ponytail-hooks.test.mjs` runs the
real manifest commands with hostile PATH entries. It doesn't prove that an agent
loaded or trusted them.
