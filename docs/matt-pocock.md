# Matt Pocock skills

Source: [mattpocock/skills](https://github.com/mattpocock/skills), pinned by
`.vendor/matt-pocock-skills` (MIT). `setup-matt-pocock.mjs` publishes complete
skill directories, including their references, templates, scripts and
`agents/openai.yaml`. It never executes upstream installation scripts.

The initial pin contains 37 skills: 20 engineering, seven productivity, four
miscellaneous and six in-progress skills. This deliberately includes the full
source inventory; upstream's Claude plugin includes only the 27 promoted skills.

Run `node .vendor/workflow-kit/scripts/setup-skills.mjs` from the consumer project
only when deliberately updating the pinned packages. Commit the generated
ordinary files in `.agent/skills`, `.agents/skills`, `.claude/skills`,
`.github/skills`, `.opencode/skills` and `.pi/skills`. New clones and worktrees
receive them without setup. Each provider's `MATT-POCOCK-SOURCES.json` records the
revision and original skill paths; `MATT-POCOCK-LICENSE.md` preserves attribution.

Changed destinations are preserved under `.workflow-kit/replaced/`. Unrelated
skills remain untouched. Dirty upstream sources and hidden local changes are
refused. The importer copies the pinned text with LF line endings and preserves
executable script permissions.

Skills describing hook installation are available as instructions; importing
them does not install or activate those hooks. Existing project rules and
repository configuration remain authoritative. Keep the repository's issue
tracker, triage and domain configuration linked from `AGENTS.md`.

Run `node --test scripts/tests/matt-pocock.test.mjs` in the kit to verify the full
inventory, support files, provenance, repeatability, clean checkout discovery
paths, preservation and dirty-source refusal. The check makes no harness trust
claim.
