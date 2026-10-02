# Matt Pocock skills

Source: [mattpocock/skills](https://github.com/mattpocock/skills), pinned at
`.vendor/matt-pocock-skills` (MIT). `setup-matt-pocock.mjs` copies complete skills,
including references, templates, scripts and `agents/openai.yaml`, without
executing upstream installers.

The initial pin includes all 37 skills: 20 engineering, seven productivity, four
miscellaneous and six in-progress; upstream's Claude plugin has only 27 promoted skills.

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
