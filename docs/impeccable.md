# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.3.1`. `scripts/impeccable/`
holds the engine `VERSION`, `SHA256SUMS` and the reviewed `launchers.patch`. The
patch makes the skill's CLI launchers verify downloads against the repository's
`SHA256SUMS`, resolve system tools by absolute path so a checkout cannot
substitute `curl` or `where`, and use a private staging file per start so
concurrent first starts don't collide. Consumers should exclude the generated
`.github/skills/**` and `.github/agents/**` from static analysis: it is
third-party code.

`setup-skills` builds `.impeccable/vendor` and links it into five providers.
Copilot gets committed copies in `.github/skills/impeccable` and
`.github/agents/impeccable-*`; Codex/Claude agents and OpenCode commands are
generated alongside. Per-project `PRODUCT.md` and `.impeccable` settings stay
with the consumer.

## Hooks

Hooks run only the engine that `install-impeccable-hooks.mjs` put in
`~/.impeccable/vaultdex/engine-<version>/`. It is verified against `SHA256SUMS`,
also when reused. Without the engine, SessionStart prints an install hint, and
the edit and Stop hooks stay silent without claiming an analysis. Engine 0.1.5
analyzes only the session's touched files at Stop.

`node scripts/check-impeccable.mjs` (kit only) tests setup and hooks in a
disposable clone:

- real and tampered engine downloads,
- concurrent cold starts,
- hostile checkout executables,
- web and mobile app contexts.
