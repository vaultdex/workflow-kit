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
- `link ISSUE PR`: connect the issue natively to the PR (the GraphQL
  `addCloseIssueReferences` mutation behind a closing keyword, which acts only on the
  default branch) and read `closingIssuesReferences` back. A Draft PR works; an existing
  connection is a success without a write; the read-back after the write is repeated up to
  five times, one second apart (GitHub shows a new connection with a delay), and a write
  whose read-back still lacks the issue exits 2. The write itself is never repeated.
  It never closes the issue: that happens when the PR merges into the default branch.
- `ready PR SHA [--attempts N] [--interval SECONDS]`: mark a Draft PR from this
  repository ready for review, but only for the commit you pushed. It rereads the PR
  (default 6 reads, 5 s apart; both waits, before the write and for the read-back, together
  stay within 30 minutes, else exit 2) until GitHub reports `SHA` as the head, because the
  metadata can still show the previous push right after it and Draft-payload events
  then skip the checks. It refuses closed PRs, forks and a head that stays different (exit 1),
  writes once and counts only a read-back showing that head ready; API errors exit 2.
  An already ready PR with that head succeeds without a write.
- `reviews PR`: one look at the head (exit 0 done, 1 red CI, 3 waiting, 2 error).
  It also prints the merge state and `blocker:` lines (standing change requests,
  conflicts), because mergeable is not merge-ready.
- `handoff ISSUE PR`: verifies a fully delivered issue's native PR connection,
  assigned/startable task, open non-draft PR, finished checks/reviews and resolved
  threads/conflicts before writing and reading back Human review (exit 0 verified,
  1 blocked, 2 unreadable or changed state, 3 waiting). Native links are read on
  every page, including manual links on release branches; text and branch links
  alone do not count. It also requires the [handoff comment](#handoff-comment) on the
  PR for the current head (exit 1 otherwise, status untouched). Session ownership, final
  proof and the content of the findings remain driver responsibilities. Use this for
  delivery; `status` is metadata maintenance.
- `wait PR`: repeats `reviews` every minute, prints `WAITING` lines on change and
  ends with `DONE`, `FAILED` (as soon as a check fails) or `ERROR`. Both take
  `--stall MINUTES` (default 20). `wait PR --merged` waits for the human merge
  and ends `FAILED` if the PR is closed unmerged. Analyzers that create their
  check only when finished are awaited when listed in `"awaitApps"`
  ([setup](SETUP.md#3-board-and-labels)).
  Recognized review traces: checks and statuses, Codex's `Running` summary (its code
  and security rows end separately: a security result comment never ends a running code
  review), bot 👀 reactions and review requests. Free-text announcements of other bots are not
  detected; check such reviewers by hand.

### Handoff comment

`handoff` needs one comment on the PR from the driver (the authenticated GitHub user) that
has the heading `## Übergabe` on its own line and was created after the push of the current
head. The push is dated by the creation of the head's first check suite, a few seconds after
the push, so post the comment after the checks have started; a head without any check suite
(CI reported only as a status) cannot be dated, and `handoff` refuses it. A new head, for
example after a review fix, asks for a new comment; an edited older comment does not count. Put the retro result and the list of all findings with their
disposition (fixed, linked follow-up issue, or none) under the heading, and, if a reviewer
was unavailable or stalled, the reviewer, cause and evidence. The command checks the heading,
author and time, not the content, which is for the human reviewer:

```md
## Übergabe

- Retro: <Ergebnis oder „keine Befunde“>
- Befunde: <je Befund: behoben (Commit), Folge-Issue (Link), oder „keine“>
- Eingeschränkte Reviewer: <Reviewer, Ursache, Beleg, oder „keine“>
```

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
`renovate[bot]` pull requests whose commits are all by bots, and checks out the commit of
Renovate's authenticated event, not the branch name. Whatever the branch changed under
`scripts/` never runs: main's scripts replace it, and only the branch's adaptation patch is
kept as input. Whoever wrote its commits, the branch may not change any workflow, script,
`.node-version` or `renovate.json` against main, apart from the three files the updaters
generate (the Ponytail adaptation patch and the Impeccable `VERSION` and `SHA256SUMS`). The job
fails instead of running, because it dispatches the branch's CI workflow with the write token;
it dispatches only while the branch still is the commit it pushed and cancels a run that
started for another commit. Commit author names prove nothing,
so the bot-author rule only leaves branches with other people's commits alone. If the CI
dispatch fails after the push, the job fails and `repository.yml` is started for the branch by
hand. `renovate.json` lists the bot's commit address in
`gitIgnoredAuthors`, so Renovate keeps updating the branch.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/update-ponytail.mjs` on the Renovate branch: it writes the conflicting
files with markers to `.workflow-kit/ponytail-resolve/`. Resolve the markers there, run the
command again to port the patch and regenerate the skills, then commit and push. A branch with
a commit by anyone else is left alone; the same command applies.
