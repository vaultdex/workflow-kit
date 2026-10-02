# Workflow Kit

Contribution workflow, GitHub Project setup and agent skills: Ponytail,
Impeccable, Matt Pocock's complete collection and Vercel's `find-skills`.
Maintained by Vaultdex under MIT. Pinned upstream submodules and the
[find-skills snapshot](.agents/skills/find-skills/NOTICE.md) retain their licenses,
notices and reviewed adaptations in generated skills.

- Agents start at [AGENT_RULES.md](AGENT_RULES.md), linked from the project's AGENTS.md.
- To set up a repository, give your agent [SETUP.md](SETUP.md).

## Install or update in a project

Needs Git, Node 26 and, for the board commands, an authenticated `gh`. Kit commands
act on the Git checkout they run in; from the project root:

```sh
git submodule add https://github.com/vaultdex/workflow-kit.git .vendor/workflow-kit  # first time only
git submodule update --init --recursive
node .vendor/workflow-kit/scripts/init-project.mjs --existing  # kit hooks and .gitignore
node .vendor/workflow-kit/scripts/setup-skills.mjs             # skills for every agent
```

Without `--existing`, `init-project` also creates the starter files (AGENTS.md,
CONTRIBUTING.md, issue and PR templates) that are missing; afterwards they belong to
the project and are never overwritten.

### Generated files and ownership

The kit owns hook handlers pointing into `~/.ponytail/vaultdex/` or
`~/.impeccable/vaultdex/` (keep personal hooks elsewhere), and upstream skills, agents and
commands by name. Generated discovery files are ordinary committed files in
`.agent`, `.agents`, `.claude`, `.github`, `.opencode` and `.pi`, plus
`.codex/agents`. Equal files stay untouched; changed content and old links move to
`.workflow-kit/replaced/`. Foreign hooks and settings stay.

A fresh clone/worktree discovers these files without generation, links or dependency
installation. Generate only during kit installation/update. An update PR bumps the
gitlink, reruns both generators above and commits their intended outputs. Changed
hook snapshots also need the [installers](#hooks).

### Commit generated files

Commit `.gitmodules`, the kit gitlink, hook definitions, `.agents/hooks` sources
and all generated discovery files. Personal state, download caches and replaced
files stay ignored. After staging the intended files, preserve Unix launcher modes
in Git explicitly, including on Windows and with `core.filemode=false`:

```sh
git add --chmod=+x -- ":(glob)**/skills/impeccable/scripts/impeccable" ":(glob)**/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh"
```

The clone test verifies all twelve executable Git entries. In Linux CI, regenerate,
then run
`git add --intent-to-add --all && git diff --exit-code HEAD`: any diff, including a new
file, means committed outputs were stale.

## Hooks

Committed hooks call explicitly installed personal snapshots. Install once per
machine and snapshot version; all checkouts reuse them:

```sh
node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs    # Ponytail mode at session start
node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs  # Impeccable UI checks
```

Review and trust project hooks in each agent, then start a new session:
`/hooks` in Codex CLI or Claude Code, the hooks view in the Codex app settings,
Settings → Hooks in Cursor, `.github/hooks` for Copilot. Missing snapshots produce
a SessionStart install hint. Files and manual runs don't prove agent loading or
trust; new definitions need personal review and trust. See
[Ponytail](docs/ponytail.md) and [Impeccable](docs/impeccable.md) for hook behavior.

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`:
`next`, `check ISSUE`, `status ISSUE "STATUS"`, `priority ISSUE High`,
`block ISSUE OWNER/REPO#N`. Before implementation, complete
[Start or resume](AGENT_RULES.md#start-or-resume); a check alone does not claim work.

## Developing the kit

```sh
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs
git status --short    # review intended outputs; preserve unrelated work
node --test scripts/tests
```

CI runs the commands above in one Linux job: about 20
runs a month at up to 10 minutes on a free public runner.
