# Ponytail in this checkout

All six Ponytail 4.10.0 instruction skills are committed, using the same native
discovery directories as the Impeccable integration in
[PR #62](https://github.com/vaultdex/Vaultdex/pull/62):

| Agent | Skill directory |
| --- | --- |
| Codex | [.agents/skills](../.agents/skills/ponytail/SKILL.md) |
| Claude Code | [.claude/skills](../.claude/skills/ponytail/SKILL.md) |
| GitHub Copilot | [.github/skills](../.github/skills/ponytail/SKILL.md) |
| OpenCode | [.opencode/skills](../.opencode/skills/ponytail/SKILL.md) |
| Antigravity | [.agent/skills](../.agent/skills/ponytail/SKILL.md) |
| Pi | [.pi/skills](../.pi/skills/ponytail/SKILL.md) |

Open the checkout in a supporting agent and select its repository skill.
Agent installation/login and ordinary development prerequisites still apply;
no global Ponytail plugin, npm dependency or runtime download is needed for skills.
Lifecycle hooks require a reviewed user-local snapshot, the repository's Node.js
version and Git on the host's non-interactive PATH.
Host support determines automatic discovery. If a skill is not listed, start
a fresh session or explicitly ask the agent to read its linked `SKILL.md`.

## Use

| Skill | Purpose |
| --- | --- |
| `ponytail` | Simplest complete implementation; `lite`, `full` (default), `ultra`. |
| `ponytail-review` | Over-engineering review of a diff; report only. |
| `ponytail-audit` | Repository-wide over-engineering audit; report only. |
| `ponytail-debt` | Report `ponytail:` and existing `watchdog:` shortcut comments. |
| `ponytail-gain` | Historical upstream benchmark card, never Vaultdex savings. |
| `ponytail-help` | Modes and checkout-specific usage. |

For example, invoke `$ponytail` with a task in Codex CLI, select Ponytail in
the desktop skill picker, or use `/ponytail` in Claude Code. Other hosts can load
the named skill explicitly. Say `stop ponytail` or `normal mode` to end the mode.
See [official Codex skill documentation](https://learn.chatgpt.com/docs/build-skills).

Existing globally installed Ponytail plugins remain separate; duplicate names
may appear. Disable duplicate personal Ponytail hooks for this checkout through
your host's settings; otherwise both installations can inject instructions.
[Contributing](CONTRIBUTING.md), [Watchdog](../WATCHDOG.md), required tests and
secret scanning remain authoritative. Debt reports do not create another task ledger.

## Shared hooks

Initialize Ponytail hooks once from a reviewed checkout:

```sh
node scripts/install-ponytail-hooks.mjs
```

This copies the six scripts and core skill into
`~/.ponytail/vaultdex/4.10.0-5/` (Windows: `%USERPROFILE%/.ponytail/vaultdex/4.10.0-5/`).
It preserves personal agent settings and trust. An identical installation is reused;
different content at the same version is rejected. Hook commands execute only this
snapshot. If missing, SessionStart emits the setup instruction; prompt/subagent hooks
stay silent and execute no checkout code. Re-run the installer after snapshot updates; each update uses a new snapshot
version and versioned directory, preserving previous installations.
An agent may perform the installation when the user requests setup; hook trust
remains a separate personal host action. Impeccable's setup is documented in
[its installation guide](impeccable.md); its hardening is tracked in
[issue #72](https://github.com/vaultdex/Vaultdex/issues/72).

| Host | Configuration and behavior |
| --- | --- |
| Codex | [.codex/hooks.json](../.codex/hooks.json): SessionStart, UserPromptSubmit, SubagentStart. Sonar remains configured. Trust the project and review/approve changed definitions through `/hooks` in the CLI or hook management in Desktop settings. |
| Claude Code | [.claude/settings.json](../.claude/settings.json): same three events. Review project trust and `/hooks`; personal `settings.local.json` stays ignored. |
| Copilot | [.github/hooks/ponytail.json](../.github/hooks/ponytail.json): sessionStart, subagentStart and userPromptSubmitted, with Bash/PowerShell commands. Session/subagent hooks inject context; prompt-hook output is ignored by Copilot, so mode commands also rely on the invoked skill. Its built-in general-purpose agent does not emit subagentStart. Cloud use requires the file on the default branch. |
| Cursor | [.cursor/hooks.json](../.cursor/hooks.json): sessionStart and beforeSubmitPrompt. Local sessions only; upstream does not inject into Cursor subagents/cloud sessions. Existing `.cursor/rules/ponytail.mdc` makes these hooks defer to that rule. |

OpenCode, Pi and Antigravity receive skills; these lifecycle manifests do not
install their separate extension plugins. No statusline, MCP server or auto-updater
is installed. Hook trust belongs to each developer and is not committed.

Hooks call the installed snapshot of the six scripts under `.agents/hooks/`.
They resolve the current Git root for state isolation, including when launched
from an app subdirectory or a path with spaces.
They emit mode instructions and maintain local flags; they do not send prompt
contents to a service. Prompt/subagent stdin has upstream's one-second fallback.

Default mode priority: `PONYTAIL_DEFAULT_MODE` → personal `defaultMode` in
`$XDG_CONFIG_HOME/ponytail/config.json`, or `%APPDATA%/ponytail/config.json` on
Windows, or `~/.config/ponytail/config.json` elsewhere → `full`.
`/ponytail default off` changes that personal default. `/ponytail lite|full|ultra|off`
changes the active mode; bare `/ponytail` only reports it (`off` without active state)
and never initializes the default. `stop ponytail` and
`normal mode` deactivate only when sent as standalone commands.

Flags live beneath the same personal Ponytail config directory in
`vaultdex/<checkout-path-sha256>/<host>/.ponytail-active`, outside Git.
As upstream, sessions of one host in one checkout share the active mode;
separate worktrees isolate it. New sessions (`startup`/`clear`) load the configured
default. Codex/Claude `resume` and `compact` retain the current mode, including off,
and re-inject its rules; Claude forks retain it too. Other hosts keep their native
sessionStart behavior. Personal defaults are shared with other Ponytail installs.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference),
[upstream Cursor contract](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/docs/cursor-hooks.md).

## Updates and verification

Source: [upstream 4.10.0 revision](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156).
Each host's `ponytail` folder includes the original [MIT license](../.agents/skills/ponytail/LICENSE.md)
and [adaptation notice](../.agents/skills/ponytail/NOTICE.md), covering all six sibling skills.
The other host copies are identical to `.agents/skills/ponytail*`; regular files
avoid requiring symlink support on Windows.

Update through a repository PR: review the six upstream skills, retain the notice's
adaptations and license, then copy the resulting packages to every host directory.
Runtime changes require a new snapshot version in the installer and hook commands,
explicit installation and renewed host trust. Never overwrite an installed version
with different checkout code.
Verify frontmatter and local links, compare copies, run secret scans and
`git diff --check`. For hook/installation changes run
`node --test scripts/tests/ponytail-hooks.test.mjs`; documentation-only changes
reuse valid runtime evidence. No additional CI workflow is installed.
The focused test uses temporary checkouts and user directories; it verifies
hook processes and emitted protocols, not interactive trust or discovery in each UI.
