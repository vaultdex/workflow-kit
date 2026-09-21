# Ponytail

Source: `.vendor/ponytail`, pinned to an upstream release commit. All six skills
come from that source; `scripts/ponytail/adaptations.patch` retains repository-test,
secret-scan, evidence and hook-isolation adaptations. Original MIT license and
NOTICE accompany generated packages. `scripts/ponytail/NOTICE.md` documents origin.

Run `node scripts/setup-skills.mjs` explicitly from a reviewed checkout. Local
Codex, Claude, OpenCode, Antigravity and Pi discovery directories link to one
generated bundle; Copilot receives committed generated files. No global plugin is
required. Personal plugin installations remain independent; choose one injection
source in your agent's settings if duplicate skill names/hooks are enabled.

Run `node scripts/install-ponytail-hooks.mjs` separately to install the immutable
`~/.ponytail/vaultdex/4.10.0-5/` snapshot. Its source bytes remain identical to the
previous reviewed integration. Existing identical snapshots are reused; changed
bytes at the same version are refused. `vaultdex` is the publisher namespace;
runtime state is isolated by checkout hash and host. Personal defaults are retained.

Codex/Claude: SessionStart, UserPromptSubmit, SubagentStart. Copilot: sessionStart,
subagentStart and userPromptSubmitted (prompt stdout is not injected). Cursor:
sessionStart/beforeSubmitPrompt; an existing always-on Ponytail rule takes precedence.
Other providers get skills only. Hook manifests differ because host protocols differ.
Never run installation from an automatic hook or silently change native trust.

Use `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`
and `ponytail-help`; gain figures are historical upstream measurements, not savings
measured for this project. Runtime regression: `node --test scripts/tests/ponytail-hooks.test.mjs`.
