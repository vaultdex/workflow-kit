# Matt Pocock skills

Source: [mattpocock/skills](https://github.com/mattpocock/skills), pinned at
`.vendor/matt-pocock-skills` (MIT). `setup-matt-pocock.mjs` copies complete skills,
including references, templates, scripts and `agents/openai.yaml`, without
executing upstream installers.

The pin includes every upstream skill (engineering, productivity, miscellaneous and
in-progress), more than upstream's Claude plugin, which ships only the promoted ones.

**Review of new skills.** An upstream update with a new skill stops at the test in
`scripts/tests/matt-pocock.test.mjs` until a human has read the skill and added its path to
`scripts/tests/matt-pocock-reviewed-skills.json`; the test names the skill. Everything else
in an update (changed files, new reference files, new revision) passes without a manual step:
the Renovate regenerate workflow regenerates the outputs, and the test compares every
tracked file of every listed skill with the published copy.

**Deviation from upstream.** The generated `retro` copy drops `disable-model-invocation`
(`adapt` in `setup-matt-pocock.mjs`), because the review loop makes every agent run the
retro before handoff and the Skill tool refuses a flagged skill. No other file or skill
is changed; the test pins both. A Renovate update keeps the deviation.

Follow [generated files](../README.md#generated-files-and-ownership) for updates,
discovery paths and preservation. Each provider's `MATT-POCOCK-SOURCES.json`
records revision/source paths; `MATT-POCOCK-LICENSE.md` preserves attribution.

Unrelated skills stay untouched. Dirty upstream sources and hidden local changes
are refused. Pinned text uses LF; executable permissions are preserved.

Importing hook-installation skills does not install or activate hooks. Follow
project rules/configuration; link issue tracker, triage and domain instructions
from `AGENTS.md`.

Run `node --test scripts/tests/matt-pocock.test.mjs` in the kit: full inventory,
support files, provenance, repeatability, clean-checkout discovery, preservation
and dirty-source refusal. This does not verify harness trust.
