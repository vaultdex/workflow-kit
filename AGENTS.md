# Workflow Kit contributors

Follow [AGENT_RULES.md](AGENT_RULES.md); here the kit itself is the project, so
kit paths drop the `.vendor/workflow-kit/` prefix (`node scripts/board.mjs check 123`).

- Skills use pinned submodules, reviewed `scripts/` patches and the canonical
  `.agents/skills/find-skills` snapshot. Update its source notice with its upstream
  pin; never edit generated provider copies.
- After scripts, templates or patches change, run [Developing the kit](README.md#developing-the-kit)
  and [Commit generated files](README.md#commit-generated-files), including executable modes.
- Tests cover behavior that protects users (no checkout code in hooks, no lost
  files, board verdicts), never wording. Don't add tests for text or upstream logic.
- Add no npm dependencies, automatic installers, secrets or private product content.
