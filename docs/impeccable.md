# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.5.0` and used unchanged.
`scripts/impeccable/` holds the hook engine's `VERSION` and `SHA256SUMS`.
Follow [generated files](../README.md#generated-files-and-ownership) for reviewed
updates and discovery paths, including Codex/Claude/Copilot agents and OpenCode
commands. Consumer `PRODUCT.md` and `.impeccable` settings stay in the project.
Exclude generated third-party skills and companions in every provider from static analysis.

## Hooks

Follow [hook installation and trust](../README.md#hooks). Hooks run only the
engine installed by `install-impeccable-hooks.mjs` in
`~/.impeccable/vaultdex/engine-<version>/`, verified against `SHA256SUMS` even when
reused. Without it, SessionStart prints an install hint; edit/Stop hooks stay
silent without claiming analysis. Engine 0.1.11 analyzes only session-touched files at Stop.
After an update, explicitly install the reviewed engine and trust the updated hook
commands. Older engine directories remain untouched; the fixed hooks use only
the newly pinned version.

The skill's own CLI launcher (`scripts/impeccable`) downloads its engine on first
use and checks it against the release's checksum file. If two first starts on
Windows collide, run the command again.
