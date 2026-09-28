# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.3.1` and used unchanged.
`scripts/impeccable/` holds the hook engine's `VERSION` and `SHA256SUMS`.
`setup-skills` builds `.impeccable/vendor` and links it into five providers. Copilot
gets committed copies in `.github/skills/impeccable` and `.github/agents/impeccable-*`,
and Codex/Claude agents and OpenCode commands are generated alongside. Per-project
`PRODUCT.md` and `.impeccable` settings stay with the consumer. Consumers exclude
the generated `.github/skills/**` and `.github/agents/**` from static analysis:
it is third-party code.

## Hooks

Hooks run only the engine that `install-impeccable-hooks.mjs` put in
`~/.impeccable/vaultdex/engine-<version>/`. It is verified against `SHA256SUMS`,
also when reused. Without it, SessionStart prints an install hint, and the edit
and Stop hooks stay silent without claiming an analysis. Engine 0.1.5 analyzes
only the session's touched files at Stop.

The skill's own CLI launcher (`scripts/impeccable`) downloads its engine on first
use and checks it against the release's checksum file. If two first starts on
Windows collide, run the command again.
