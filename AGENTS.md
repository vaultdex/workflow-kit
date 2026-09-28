# Workflow Kit contributors

Follow [AGENT_RULES.md](AGENT_RULES.md); here the kit itself is the project, so
kit paths drop the `.vendor/workflow-kit/` prefix (`node scripts/board.mjs check 123`).

- Skills come only from the pinned submodules plus the reviewed patches in
  `scripts/`. Never edit generated skills or `.github/skills`.
- After changing scripts, templates or patches, run `node scripts/init-project.mjs --existing`,
  `node scripts/setup-skills.mjs` and `node --test scripts/tests`, and commit the regenerated files.
- Tests cover behavior that protects users (no checkout code in hooks, no lost
  files, board verdicts), never wording. Don't add tests for text or upstream logic.
- Add no npm dependencies, automatic installers, secrets or private product content.
