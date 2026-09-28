# Workflow Kit

Contribution workflow, GitHub Project setup and agent skills (Ponytail,
Impeccable) for agent-driven development, maintained by Vaultdex under MIT.
Ponytail and Impeccable are pinned upstream submodules with reviewed patches;
their licenses and notices ship with the generated skills.

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

What the kit owns and rewrites: hook handlers that mention its snapshot directories
`~/.ponytail/vaultdex/` or `~/.impeccable/vaultdex/` (don't point your own hooks
there), and the skills, agents and commands the pinned upstreams ship, by name.
Generated `.github` files are committed, so Git keeps any earlier content. Anything
else at a kit path moves to `.workflow-kit/replaced/`; foreign hooks and settings
stay, and nothing else is deleted.
Commit `.gitmodules`, the kit gitlink, the hook files and the generated `.github`
files; local skill links and bundles stay ignored. In CI, run both commands and then
`git add --intent-to-add --all && git diff --exit-code HEAD`: any diff, including a new
file, means committed outputs were stale.

A kit update is a PR that bumps the gitlink, reruns `init-project` and
`setup-skills`, and commits the result. Each developer then updates the submodule
and reruns `setup-skills`; a changed hook snapshot also needs the installers below.

## Hooks

The committed hook files call only personal snapshots that you install
explicitly:

```sh
node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs    # Ponytail mode at session start
node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs  # Impeccable UI checks
```

Then review and trust the project hooks in each agent and start a new session:
`/hooks` in Codex CLI or Claude Code, the hooks view in the Codex app settings,
Settings → Hooks in Cursor, `.github/hooks` for Copilot. While a snapshot is
missing, the SessionStart hook prints an install hint. Hook files and manual runs
don't prove that an agent loaded or trusted them. See [Ponytail](docs/ponytail.md)
and [Impeccable](docs/impeccable.md).

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`:
`next`, `check ISSUE`, `status ISSUE "In progress"`, `priority ISSUE High`,
`block ISSUE OWNER/REPO#N`. See
[Starting work](docs/CONTRIBUTING.md#starting-work).

## Developing the kit

```sh
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs
git status --short    # commit everything listed
node --test scripts/tests
```

CI runs the commands above in one Linux job: about 20
runs a month at up to 10 minutes on a free public runner.
