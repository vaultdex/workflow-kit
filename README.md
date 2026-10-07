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

To update, move the gitlink first. `git submodule update` checks out the commit the
index records, so run after a bump it silently puts the old kit back, and the
generators then run against it without an error or a diff:

```sh
git -C .vendor/workflow-kit fetch origin
git -C .vendor/workflow-kit checkout <kit-commit>      # the commit to adopt
git add .vendor/workflow-kit
git -C .vendor/workflow-kit submodule update --init    # the kit's own submodules only
git submodule status .vendor/workflow-kit              # must show <kit-commit> without a leading + or -
```

Then run the two generators above. A generator run that changes nothing after an
update proves nothing about the new kit; check the status line first.

### Generated files and ownership

The kit owns hook handlers pointing into `~/.ponytail/vaultdex/` or
`~/.impeccable/vaultdex/` and the kit init handler (`git ls-files -s -- .vendor/workflow-kit` followed by
`git submodule update --init --checkout`; keep personal hooks elsewhere), and upstream skills, agents and
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

Agents run these installers themselves when the install hint appears, without
asking ([agent rules](AGENT_RULES.md#hooks)); trust stays personal. Review and trust
project hooks in each agent, then start a new session:
`/hooks` in Codex CLI or Claude Code, the hooks view in the Codex app settings,
Settings → Hooks in Cursor, `.github/hooks` for Copilot. Missing snapshots produce
a SessionStart install hint. Session and subagent starts also run
`git submodule update --init .vendor/workflow-kit` when the kit checkout is missing (fresh
worktree); an initialized kit stays untouched and a failure prints the command. Files and manual runs don't prove agent loading or
trust; new definitions need personal review and trust. See
[Ponytail](docs/ponytail.md) and [Impeccable](docs/impeccable.md) for hook behavior.

### Git hooks

A project's versioned Git hooks in `.githooks/` run only after each clone sets
`core.hooksPath`; Git never does this on checkout. Run per clone, for example from the
project's setup script:

```sh
node .vendor/workflow-kit/scripts/install-git-hooks.mjs          # --check only reports
```

It sets the relative `.githooks`, so every worktree runs the hooks of its own branch.
Absolute paths into this repository's worktrees and matching `config.worktree`
overrides become that relative path; Git resolves relative paths per worktree, so any
other relative value counts as foreign. It changes a config file only when every
`core.hooksPath` entry there (including `include` files) points to this
repository's `.githooks` and is written in that file itself. Because Git evaluates
`includeIf` per worktree and branch, it changes nothing when any `includeIf` target,
whatever its condition, sets a foreign path. Anything else, such as a foreign path in
local, global or system config, stays and is reported: integrate `.githooks` there
yourself. Without `.githooks/` it does nothing.

The installer also writes `.githooks/post-checkout` (from `scripts/git-hooks/post-checkout`) when it is
missing, unless the project already has a different one, which stays; commit it with
`git add --chmod=+x .githooks/post-checkout`. After a branch checkout (third argument `1`) the hook runs
`git submodule update --init --checkout .vendor/workflow-kit`, so the kit follows the gitlink of the
new branch instead of showing `M .vendor/workflow-kit`. It touches only the kit, not other submodules
or `submodule.recurse`, disables Git's own prompts like the SessionStart hook (ssh may still ask on the terminal) and runs none of the kit clone's own hooks. Like any checkout it applies the user's Git configuration, including filters.
A rerun of the installer repairs a missing executable bit and reports a hook tracked without it
(`git update-index --chmod=+x`). A kit with local changes, ignored or untracked files, or commits no remote has
(a clean, published kit behind or ahead of the old pin still follows) is not touched: the hook prints a hint
and the checkout continues; any failure only prints the command. Without a kit gitlink, as in this repository,
it does nothing. The hook is versioned with each branch (Git resolves `.githooks` in the new worktree after
the switch), so a branch created before the hook was committed has none and does not sync until it merges
the default branch. Known limit: where the kit has `core.filemode=false`, a purely local mode change is invisible to
Git and the update may reset it. A hook copy with CRLF line endings differs from the kit's and is kept, not blessed.

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`:

- `next`, `check ISSUE [--session ID]` (shows the age and open PR of a claim and one line per native sub-issue; information only), `status ISSUE "STATUS"`, `priority ISSUE High`,
  `block ISSUE OWNER/REPO#N`, `sub PARENT CHILD` (native sub-issue, read back; `CHILD` may be
  `OWNER/REPO#N`; an existing link succeeds again; no removing or reordering).
- `field ISSUE NAME VALUE [NAME VALUE ...]`: any single-select fields, all read back together after writing.
  Every pair is checked against the field definitions before the first write: one invalid pair writes
  nothing and names the valid options. `field`, `status` and `priority` report failures as one
  `ERROR - reason` line (exit 2, nothing else printed), not a stack trace. `check` and issue read errors name `OWNER/REPO#N`.
- `status ISSUE "Automated review" PR [OTHER_ISSUE...]` (or `field ISSUE Status
  "Automated review" PR [OTHER_ISSUE...]`): verify the declared open PR's reference
  and comment backlink on every delivered issue before writing status. Post and
  read back backlinks immediately after PR creation; see [PR backlinks](docs/CONTRIBUTING.md#pr-backlinks).
- `body ISSUE FILE BASE_FILE`: replace an issue body with `FILE` only if the current body
  still equals `BASE_FILE` (the body your change is based on; line endings and trailing
  whitespace are ignored; the text written is `FILE` with LF line endings and no trailing
  whitespace, sent over stdin so the file name never matters), then read it back. A body that
  changed meanwhile is refused with
  a `-`/`+` diff (exit 1, nothing written); a read-back that differs from `FILE` reports
  that another session overwrote it (exit 1, the write is not repeated); API and file
  errors exit 2. See [Changing a body](docs/CONTRIBUTING.md#issues).
- `link ISSUE PR`: connect the issue natively to the PR (the GraphQL
  `addCloseIssueReferences` mutation behind a closing keyword, which acts only on the
  default branch) and read `closingIssuesReferences` back. A Draft PR works; an existing
  connection is a success without a write; the read-back after the write is repeated up to
  five times, one second apart (GitHub shows a new connection with a delay), and a write
  whose read-back still lacks the issue exits 2. The write itself is never repeated.
  It never closes the issue: that happens when the PR merges into the default branch.
  For an open issue of this repository it also posts the PR's backlink comment, the one `status ISSUE "Automated review" PR`
  requires, unless a comment with the PR's URL exists, and reads the comments back
  (a missing comment after the write exits 2; the write is not repeated).
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
  conflicts), because mergeable is not merge-ready. When the PR has a finished
  SonarCloud check it also counts the head's OPEN and CONFIRMED Sonar issues (the
  quality gate judges new-code conditions only) and prints a `blocker:` line for any; `handoff`
  then exits 1. The read needs `SONAR_TOKEN` in the environment (the anonymous API
  reports 0 for private projects); without it, or on a refused read, the command
  ends `ERROR` (exit 2), never green. Security hotspots stay a manual read. A workflow
  whose `pull_request` jobs for the head were all skipped before the Ready event (Draft
  guard), with no executed run since Ready, waits (exit 3): the skip proves nothing
  about the Ready head. Push a commit to start one: a workflow without a `ready_for_review` trigger never does otherwise.
  It also prints `correction pushes after ready: N`, the distinct heads pushed (from the branch's push log)
  after the PR's first Ready event (a PR opened non-draft counts from its creation; the head that set Ready does not count,
  a force-push is one push, a PR that never was ready prints no line). From `N >= 2` it adds
  `cap reached: collect non-blocking findings in one follow-up issue` ([review loop](docs/CONTRIBUTING.md#review-loop)).
  It is information only: no exit code changes (an unreadable push log prints a note instead), and blocking findings are still corrected. `wait` prints it with the final result.
- `handoff ISSUE PR`: verifies a fully delivered issue's native PR connection,
  assigned/startable task, open non-draft PR, finished checks/reviews and resolved
  threads/conflicts before writing and reading back Human review (exit 0 verified,
  1 blocked, 2 unreadable or changed state, 3 waiting). Native links are read on
  every page, including manual links on release branches; text and branch links
  alone do not count. It also requires the [handoff comment](#handoff-comment) on the
  PR for the current head and rejects an issue body that still has an open task-list item
  (`- [ ]`) without an issue reference (`#N` or `OWNER/REPO#N`; exit 1 otherwise, status
  untouched, every such item is printed). It reads the body as GitHub renders it: checked-off
  items, items with a reference GitHub links, and code blocks do not count (a `#N` in a code
  span or glued to letters is no reference). The handoff comment must also carry a
  `Retro` section whose every list line ends with its resolution (exit 1 otherwise, status
  untouched, every line without one is printed); it is read as GitHub renders it too.
  Session ownership, final
  proof and whether a finding is justified remain driver responsibilities. Use this for
  delivery; `status` is metadata maintenance.
- `wait PR`: repeats `reviews` every minute, prints `WAITING` lines on change and
  ends with `DONE`, `FAILED` (as soon as a check fails) or `ERROR`. Both take
  `--stall MINUTES` (default 20) and `--grace MINUTES` (default 3): for that long after
  the PR became ready (Ready event, or creation as non-draft) and after each push of the
  head (read from the branch's push log, so a reused commit counts too), whichever is later, they keep
  waiting for reviewers that start on Ready or on new commits, such as Codex, even when CI is already
  green; `handoff` honors both. `wait PR --merged` waits for the human merge
  and ends `FAILED` if the PR is closed unmerged. Analyzers that create their
  check only when finished are awaited when listed in `"awaitApps"`
  ([setup](SETUP.md#3-board-and-labels)).
  Recognized review traces: checks and statuses, Codex's `Running` summary (its code
  and security rows end separately: a security result comment never ends a running code
  review), bot 👀 reactions and review requests. Free-text announcements of other bots are not
  detected; check such reviewers by hand.

### Handoff comment

`handoff` needs one comment on the PR from the driver (the authenticated GitHub user) that
has the heading `## Übergabe` on its own line and a line `Head: <SHA>` that starts with the
first seven characters of the PR's current head commit. The comment names the head it is
about, so no timestamp is involved: a new head, for example after a review fix, asks for a new
comment, a comment for an earlier push does not count, and it works the same for a head without
a check suite or one that was pushed and checked on another branch first. Put the retro under
the heading `Retro` (any level, usually `###`), one list line per finding, and, after another
heading, the review findings with their disposition and, if a reviewer was unavailable or
stalled, the reviewer, cause and evidence. Every retro line ends with exactly one resolution:

- an issue link: `#N` or `OWNER/REPO#N` (the issue that owns the fix),
- `behoben in <SHA>`,
- `persönlich gemeldet` (memory, shell profile: the human changes those),
- `kein Handlungsbedarf: <Grund>`.

Without findings the section has the single line `Keine Funde`. The command checks that the
section exists and that each line ends this way, as GitHub renders the comment (an issue
reference in a code span does not count); it does not judge whether a finding is justified.
Of the rest, only heading, head and author are checked; the content is for the human reviewer.
With several comments for the head the newest counts.

```md
## Übergabe

Head: abcdef1

### Retro

- <Fund>: <Issue-Link, `behoben in <SHA>`, `persönlich gemeldet` oder `kein Handlungsbedarf: <Grund>`>
- Oder als einzige Zeile: Keine Funde

### Reviews

- Befunde: <je Befund: behoben (Commit), Folge-Issue (Link), oder „keine“>
- Eingeschränkte Reviewer: <Reviewer, Ursache, Beleg, oder „keine“>
```

Before implementation, complete [Start or resume](AGENT_RULES.md#start-or-resume);
a check alone does not claim work.

## Developing the kit

```sh
git submodule update --init --recursive    # the tests clone the pinned submodules
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
`gitIgnoredAuthors`, so Renovate keeps updating the branch. Submodules are not fetched at
checkout: the job first requires the submodule URLs in the branch's `.gitmodules` to equal
main's and fails otherwise, so a branch cannot point the generators at another repository.
`update-ponytail.mjs` keeps its conflict files in `.workflow-kit/ponytail-resolve/` and
refuses to read, write or delete there when any part of that path is a link.

Known limit, accepted ([#104](https://github.com/vaultdex/workflow-kit/issues/104)): the CI dispatch
runs the Renovate branch's workflow definition, because `workflow_dispatch` takes a branch or tag,
not a commit. Between the push and the dispatch another repository writer could move the branch;
the job checks the branch just before and cancels a run it started for another commit, but cannot
undo what such a run already did. A writer can run any workflow definition on a branch of their
own with the same permissions, so this race gives them nothing more. Dispatching `main`'s
workflow instead is no way out: its check runs would hang on `main`'s head, not the PR's. If the
threat model changes, report the CI result as a commit status from the job itself.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/update-ponytail.mjs` on the Renovate branch: it writes the conflicting
files with markers to `.workflow-kit/ponytail-resolve/`. Resolve the markers there, run the
command again to port the patch and regenerate the skills, then commit and push. A branch with
a commit by anyone else is left alone; the same command applies.
