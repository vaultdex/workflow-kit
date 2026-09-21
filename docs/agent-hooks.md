# Agent hook preflight

Once per session, check Ponytail and Impeccable in the **current harness** before
relying on automatic hooks. Recheck only after a hook, trust or configuration change.
Use a native hook-status tool when exposed; otherwise continue without a warning
or user check request. Do not launch another agent session to manufacture evidence.

For Codex, native `hooks/list` reports effective `enabled`, `trustStatus`, event,
source and definition hash for a working directory. `trusted` or `managed` plus
enabled means the definition is eligible to run; it does not prove a successful
invocation. If native status cannot be accessed from this harness, keep it unknown;
do not report that limitation routinely or infer that hooks are disabled or active.
Do not read credentials or private transcripts to recover that status.

Assess each integration separately:

| Evidence | Status and response |
| --- | --- |
| Current harness reports enabled/trusted relevant events | Ready; no activation warning. Describe successful execution only when current-session hook output confirms it. |
| Confirmed hook failure, missing definitions, disabled hooks, untrusted/modified definitions | Warn once, identify the integration and concrete failure or missing event/trust, then give the applicable recovery or host-specific activation step below. |
| No current status interface or insufficient evidence | Keep status unknown; continue without a warning or user check request. Do not claim automatic checks ran. Explain the evidence limit when explicitly asked about status or when required proof depends on automatic execution. |

Files in Git, an installed plugin, a `.ponytail-active` flag, mode instructions in
the prompt, manual execution of a hook script and Impeccable's engine-level
`hooks status` alone do **not** prove the current harness loaded/trusted its hooks.
Check all relevant events and distinguish personal/plugin definitions from project
definitions; duplicate installations may be enabled at the same time.

## Activation messages

When the user requests initial setup, the agent can run the installers from the
reviewed checkout. These are explicit setup commands, never automatic hook bodies:

```sh
node scripts/install-ponytail-hooks.mjs
```

Impeccable's equivalent `node scripts/install-impeccable-hooks.mjs` is delivered
separately by [#72](https://github.com/vaultdex/Vaultdex/issues/72). Run it once it
is present in the checkout; until then follow the existing Impeccable installation
guide. After installation, the developer reviews/enables native hook definitions.
Do not claim either integration is initialized merely because the other succeeded.

- **Codex CLI:** open `/hooks` to review, enable and trust the named definitions.
- **Codex Desktop:** use the hook management view in the app's settings; `/hooks`
  is a CLI command, not a desktop chat command. For either Codex host, start a fresh
  task if SessionStart already passed. Never use a trust-bypass flag.
- **Claude Code:** review project trust and `/hooks`, enable the relevant shared
  definitions and restart the session. Preserve other hooks and personal settings.
- **Copilot:** inspect native hook loading and `.github/hooks/*.json`; cloud hooks
  require the definitions on the default branch. Report unsupported events explicitly.
- **Cursor:** inspect Settings → Hooks and enable supported local hooks. The
  bundled Ponytail rule, if separately installed, overrides its mode-switching hooks.
- **Other hosts:** state that these manifests do not supply native hooks there;
  use the skills and their documented manual checks.

For Impeccable, also run its existing `hooks status` once when the skill is used;
it checks detector configuration, separately from harness trust. If the detector
was deliberately disabled, report that choice without silently reversing it.
On an activation request use the existing `impeccable hooks on` command, then
verify harness trust separately. Do not change another developer's consent.

The agent reports these warnings because repository AGENTS.md requests this
preflight. Warnings do not create a new approval gate or stop unrelated work.
Use focused manual checks where available. Disclose missing automatic coverage
when required proof depends on it; unavailable status alone needs no routine notice.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Ponytail installation](ponytail.md), [Impeccable installation](impeccable.md).
