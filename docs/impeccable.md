# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.3.1`. `scripts/impeccable/` owns
the reviewed launcher patch, engine VERSION and SHA256SUMS. Setup stages upstream
packages, applies that patch, retains LICENSE/NOTICE and leaves upstream untouched.

Run `node scripts/setup-skills.mjs` after cloning or a reviewed kit update. Five
local providers use links (Windows junctions, POSIX relative symlinks); Copilot cloud
requires committed `.github/skills/impeccable` and `.github/agents/impeccable-*`.
Codex/Claude agents and OpenCode commands are generated alongside skills. Edited or
foreign destinations are refused. A failed publication preserves the previous bundle.

Review engine-version changes with pins, patches and fixed hook definitions. Hooks
execute only an explicitly installed user-local engine. Install with
`node scripts/install-impeccable-hooks.mjs`; checksums are verified even for existing
installations. No automatic hook/postinstall installs or executes checkout code.
Personal hook trust is separate. Per-project PRODUCT.md and `.impeccable` settings
remain in consumers and are not overwritten by this kit.

`node scripts/check-skills.mjs` compares regenerated cloud discovery with pinned
sources. `node scripts/check-impeccable.mjs` clones the committed kit into a disposable
directory with spaces and tests fresh/repeated setup, foreign files, upgrades,
incompatible engines, real engine downloads, substituted hashes, concurrent cold
starts, hostile Windows executables, web/mobile fixtures and hook isolation.
This does not prove native UI discovery, trust dialogs or device acceptance.
