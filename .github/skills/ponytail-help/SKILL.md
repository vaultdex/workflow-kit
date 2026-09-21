---
name: ponytail-help
description: >
  Quick-reference card for all ponytail modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /ponytail-help,
  "ponytail help", "what ponytail commands", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/ponytail` | The ladder enforced: YAGNI → stdlib → native → one line → minimum. Default. |
| **Ultra** | `/ponytail ultra` | YAGNI extremist. Deletion before addition. Challenges requirements before building. |

Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Lazy mode itself. Simplest solution that works. |
| **ponytail-review** | `/ponytail-review` | Over-engineering review: `L42: yagni: factory, one product. Inline.` |
| **ponytail-audit** | `/ponytail-audit` | Whole-repo over-engineering audit: ranked list of what to delete. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `ponytail:` shortcut comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

Select the repository skill in your agent's skill picker. Codex CLI supports
`$ponytail`; desktop picker syntax can vary. Claude Code uses the slash-command
forms above. Other hosts can load the named skill or its `SKILL.md` explicitly.

## Deactivate

Say "stop ponytail" or "normal mode". With hooks, `/ponytail off` also works;
resume with `/ponytail full` (bare `/ponytail` reports the current mode).

## Checkout scope

This checkout bundles skills plus Node.js lifecycle hooks for Codex, Claude Code,
Copilot and Cursor. From a reviewed checkout, initialize them with
`node scripts/install-ponytail-hooks.mjs`, then enable the host's project trust/hooks
to activate the default mode at session start. Default priority: `PONYTAIL_DEFAULT_MODE`, then personal
Ponytail config `defaultMode`, then `full`. Supported defaults: off/lite/full/ultra.
`/ponytail default lite` saves a personal default; ordinary mode switches do not.
No global statusline or automatic plugin update is installed. Other hosts use
the skills directly. Repository workflow, validation and security rules remain authoritative.

## Update

Updates arrive through repository changes. See
[checkout usage and updates](../../../docs/ponytail.md). Update all six host
copies together and preserve the documented adaptations and MIT attribution.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
