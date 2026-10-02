# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.3.1` and used unchanged.
`scripts/impeccable/` holds the hook engine's `VERSION` and `SHA256SUMS`.
`setup-skills` generates committed ordinary files in `.agent`, `.agents`, `.claude`,
`.github`, `.opencode` and `.pi`, plus Codex/Claude/Copilot agents and OpenCode
commands. A checkout already contains all discovery files; generation runs only
during reviewed kit updates. Per-project `PRODUCT.md` and `.impeccable` settings
stay with the consumer. Consumers exclude generated skills and companions for
every provider from static analysis: it is third-party code.

## Hooks

Hooks run only the engine that `install-impeccable-hooks.mjs` put in
`~/.impeccable/vaultdex/engine-<version>/`. It is verified against `SHA256SUMS`,
also when reused. Install once per machine and version, then review and trust the
hook definitions in each agent; worktrees reuse the same engine. Without it,
SessionStart prints an install hint, and the edit
and Stop hooks stay silent without claiming an analysis. Engine 0.1.5 analyzes
only the session's touched files at Stop.

The skill's own CLI launcher (`scripts/impeccable`) downloads its engine on first
use and checks it against the release's checksum file. If two first starts on
Windows collide, run the command again.
