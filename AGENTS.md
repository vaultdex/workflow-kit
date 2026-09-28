# Workflow Kit contributors

Follow [AGENT_RULES.md](AGENT_RULES.md); here the kit itself is the project.

- Skills come only from the pinned submodules plus the reviewed patches in
  `scripts/`. Never edit generated skills or `.github/skills`.
- After changing scripts, templates or patches, run `node scripts/setup-skills.mjs`,
  `node --test scripts/tests` and `node scripts/check-skills.mjs`. Hook or launcher
  changes also need `node scripts/check-impeccable.mjs`. Documentation changes need
  the tests, which check links and size budgets.
- Add no npm dependencies, automatic installers, secrets or private product content.
