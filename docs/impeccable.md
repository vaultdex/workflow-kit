# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.3.1`. `scripts/impeccable/` owns
the reviewed launcher patch, engine VERSION and SHA256SUMS. Setup stages upstream
packages, applies that patch, retains LICENSE/NOTICE and leaves upstream untouched.

From the product root, run `node .vendor/workflow-kit/scripts/setup-skills.mjs .`
after cloning or a reviewed kit update. Five local providers use links (Windows
junctions, POSIX relative symlinks); Copilot cloud requires committed
`.github/skills/impeccable` and `.github/agents/impeccable-*`. Codex/Claude agents
and OpenCode commands are generated alongside skills. Edited or foreign destinations
are refused. A failed publication preserves the previous bundle.

Review engine-version changes with pins, patches and fixed hook definitions. Hooks
execute only an explicitly installed user-local engine. Install with
`node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs .`; checksums are
verified even for existing installations. No automatic hook/postinstall installs
or executes checkout code. Personal hook trust is separate. Per-project PRODUCT.md
and `.impeccable` settings remain in consumers and are not overwritten by this kit.

## Missing engine and Stop work

A missing engine produces a setup warning at the native SessionStart event, not
on every edit and Stop. Codex/Claude restrict that warning to startup/clear; Copilot
uses its native sessionStart event. Missing edit/Stop handlers return quietly without
claiming that an analysis ran. An installed engine is still executed and its exit
status is preserved. Reinstall/review hooks explicitly after correcting a failure.

Engine 0.1.5 already returns `no-touched-files` from Stop when its session cache has
no touched targets. The deep pass uses the session's touched files, not a recursive
repository scan, and has a re-entry guard. Touched files may still be revisited at a
later Stop in the same session. We do not add another change registry or disable
that coverage to save a process. Source: pinned
[run_stop_hook](https://github.com/pbakaus/impeccable/blob/engine-v0.1.5/crates/hook/src/hook.rs).

## Verification

`node .vendor/workflow-kit/scripts/check-skills.mjs .` compares regenerated cloud
discovery with pinned sources. For real-engine security checks, run
`node scripts/check-impeccable.mjs` **inside the kit directory**. That command clones
the committed kit into a disposable directory with spaces and tests fresh/repeated
setup, foreign files, upgrades, incompatible engines, real downloads, substituted
hashes, concurrent cold starts, hostile Windows executables, web/mobile fixtures
and hook isolation. It does not prove native UI discovery, trust or device acceptance.

`node --test scripts/tests/impeccable-hooks.test.mjs`, inside the kit, exercises the
actual manifest commands for missing and failed engines. With
`WORKFLOW_KIT_ENGINE_PROOF=1` it additionally downloads the pinned checksum-verified
engine into an isolated temporary HOME and records Stop process times before and
after a CSS edit. The existing GitHub Actions test step runs that case too; no
separate workflow, schedule or persistent benchmark service is added. These process
times are not a productive agent or token-savings benchmark.
