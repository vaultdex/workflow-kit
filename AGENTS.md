# Workflow Kit contributors

Follow [AGENT_RULES.md](AGENT_RULES.md); here the kit itself is the project, so
kit paths drop the `.vendor/workflow-kit/` prefix (`node scripts/board.mjs check 123`).

- Skills come from the pinned submodules plus reviewed patches in `scripts/`, and
  the canonical `.agents/skills/find-skills` snapshot (update its source notice
  when changing the upstream pin). Never edit generated provider copies.
- After changing scripts, templates or patches, run `node scripts/init-project.mjs --existing`,
  `node scripts/setup-skills.mjs` and `node --test scripts/tests`, then follow
  [Commit generated files](README.md#commit-generated-files) to preserve executable modes.
- Tests cover behavior that protects users (no checkout code in hooks, no lost
  files, board verdicts), never wording. Don't add tests for text or upstream logic.
- Add no npm dependencies, automatic installers, secrets or private product content.
