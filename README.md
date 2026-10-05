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

- `next`, `check ISSUE`, `status ISSUE "STATUS"`, `priority ISSUE High`,
  `block ISSUE OWNER/REPO#N`.
- `field ISSUE NAME VALUE`: any single-select field, read back after writing.
- `status ISSUE "Automated review" PR [OTHER_ISSUE...]` (or `field ISSUE Status
  "Automated review" PR [OTHER_ISSUE...]`): verify the declared open PR's reference
  and comment backlink on every delivered issue before writing status. Post and
  read back backlinks immediately after PR creation; see [PR backlinks](docs/CONTRIBUTING.md#pr-backlinks).
- `reviews PR`: one look at the head (exit 0 done, 1 red CI, 3 waiting, 2 error).
  It also prints the merge state and `blocker:` lines (standing change requests,
  conflicts), because mergeable is not merge-ready.
- `handoff ISSUE PR`: verifies a fully delivered issue's native PR connection,
  assigned/startable task, open non-draft PR, finished checks/reviews and resolved
  threads/conflicts before writing and reading back Human review (exit 0 verified,
  1 blocked, 2 unreadable or changed state, 3 waiting). Native links are read on
  every page, including manual links on release branches; text and branch links
  alone do not count. Session ownership, final proof and finding dispositions remain
  driver responsibilities. Use this for delivery; `status` is metadata maintenance.
- `wait PR`: repeats `reviews` every minute, prints `WAITING` lines on change and
  ends with `DONE`, `FAILED` (as soon as a check fails) or `ERROR`. Both take
  `--stall MINUTES` (default 20). `wait PR --merged` waits for the human merge
  and ends `FAILED` if the PR is closed unmerged. Analyzers that create their
  check only when finished are awaited when listed in `"awaitApps"`
  ([setup](SETUP.md#3-board-and-labels)).
  Recognized review traces: checks and statuses, Codex's `Running` summary, bot 👀
  reactions and review requests. Free-text announcements of other bots are not
  detected; check such reviewers by hand.

Before implementation, complete [Start or resume](AGENT_RULES.md#start-or-resume);
a check alone does not claim work.

## Developing the kit

```sh
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs
git status --short    # review intended outputs; preserve unrelated work
node --test scripts/tests
```

CI runs the commands above in one Linux job: about 20
runs a month at up to 10 minutes on a free public runner.

### Submodule updates by Renovate

Renovate only moves a submodule pin, so the Ponytail adaptation patch and the committed
skills are stale until regenerated. The workflow `Renovate regenerate` does that on
Renovate pull requests from this repository that change `.vendor/*`: it runs
`scripts/update-ponytail.mjs` and `scripts/update-impeccable.mjs` as needed, then the CI
generators, pushes the result to the Renovate branch and dispatches the repository CI on the
new head (pushes with `GITHUB_TOKEN` start no workflows). The job holds `contents: write`
and `actions: write` (the token reaches only the push and dispatch steps), runs only for
`renovate[bot]` pull requests whose commits are all by bots, and stops before any script if
Renovate's own commits change more than `.gitmodules` and submodule pins. `renovate.json`
lists the bot's commit address in `gitIgnoredAuthors`, so Renovate keeps updating the branch.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/update-ponytail.mjs` on the Renovate branch: it writes the conflicting
files with markers to `.workflow-kit/ponytail-resolve/`. Resolve the markers there, run the
command again to port the patch and regenerate the skills, then commit and push. A branch with
a commit by anyone else is left alone; the same command applies.
