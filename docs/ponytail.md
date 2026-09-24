# Ponytail

Source: `.vendor/ponytail`, pinned to an upstream release commit. All six current
skills come from that source; `scripts/ponytail/adaptations.patch` retains repository-test,
secret-scan, evidence and hook-isolation adaptations. Original MIT license and
NOTICE accompany generated packages. `scripts/ponytail/NOTICE.md` documents origin.

From a reviewed product checkout, run
`node .vendor/workflow-kit/scripts/setup-skills.mjs .` explicitly. Local Codex,
Claude, OpenCode, Antigravity and Pi discovery directories link to one generated
bundle; Copilot receives committed generated files. No global plugin is required.
Personal plugin installations remain independent; choose one injection source in
your agent's settings if duplicate skill names/hooks are enabled.

Run `node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs .` separately to
install the immutable `~/.ponytail/vaultdex/4.10.0-5/` snapshot. Runtime bytes remain
identical to the previous reviewed integration. Identical snapshots are reused;
changed bytes at the same version are refused. `vaultdex` is the publisher namespace;
runtime state is isolated by checkout hash and host. Personal defaults are retained.

Codex/Claude: SessionStart, UserPromptSubmit, SubagentStart. Copilot: sessionStart,
subagentStart and userPromptSubmitted (prompt stdout is not injected). Cursor:
sessionStart/beforeSubmitPrompt; an existing always-on Ponytail rule takes precedence.
Other providers get skills only. Hook manifests differ because host protocols differ.
Never run installation from an automatic hook or silently change native trust.
The inherited PATH issue [#3](https://github.com/vaultdex/workflow-kit/issues/3)
remains a separate activation blocker until its runtime fix and platform proofs are accepted.

The generator reads skill names from the pinned tree. On an upgrade it removes only
unchanged owned files of retired skills and provider links pointing exactly to those
old bundles. Edited files, foreign links and unknown directory contents stop the
migration before publication. The source receipt is updated after cleanup succeeds.

Use `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`
and `ponytail-help`; gain figures are historical upstream measurements, not savings
measured for this project. Run the consumer's hook test with its prepared checkout;
inside the kit itself use `node --test scripts/tests/ponytail-hooks.test.mjs`.
All `node scripts/...` commands in the kit's own checks refer to kit implementation,
not to consumer wrappers. New product repositories contain no such harness wrappers.
