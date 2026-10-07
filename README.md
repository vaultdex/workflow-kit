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
node .vendor/workflow-kit/scripts/init-project.mjs --existing  # kit hooks, .gitignore and .ignore
node .vendor/workflow-kit/scripts/setup-skills.mjs             # skills for every agent
```

Without `--existing`, `init-project` also creates the starter files (AGENTS.md,
CONTRIBUTING.md, issue and PR templates) that are missing; afterwards they belong to
the project and are never overwritten. A template that a kit update adds later does not
reach an existing project: copy it by hand. For the spec form that is
`.vendor/workflow-kit/templates/.github/ISSUE_TEMPLATE/spec.yml` to `.github/ISSUE_TEMPLATE/`,
plus the label `spec` (`gh label create spec`), which the form sets.

`init-project` (also with `--existing`) adds the missing lines of `templates/.ignore` to
the project's `.ignore`, so ripgrep-based search skips the generated provider skill copies
(only `.agents/skills` stays searchable) and `.vendor/`; to search an excluded copy, name its
path (`rg pattern .claude/skills`), then `.ignore` doesn't apply. A project-owned skill in a
provider directory stays visible with `!/.claude/skills/my-skill/` in `.ignore`. Git doesn't read the file; commit it with the other `init-project` outputs: a clean-diff check after
the generators (`git diff --exit-code`) fails on an uncommitted `.ignore`.

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

Commit `.gitmodules`, the kit gitlink, hook definitions, `.agents/hooks` sources,
`.ignore` and all generated discovery files. Personal state, download caches and replaced
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
worktree) or not at the commit the gitlink pins (a base merge moves the pin, not the checkout); a kit at its pin stays untouched,
a kit with local changes or unpublished commits is not moved, and both that case and a failure print a hint. A second handler
reports a checkout that is behind its upstream or `origin/HEAD` and has no commits of its own (a worktree or driver started from a stale branch);
it compares with the last fetched state, so it needs no network and never delays the session, and it changes nothing. A SubagentStart in
a worktree whose kit you deliberately moved ahead of the gitlink resets it, so stage the new pin (`git add .vendor/workflow-kit`) before starting subagents. Files and manual runs don't prove agent loading or
trust; new definitions need personal review and trust. See
[Ponytail](docs/ponytail.md) and [Impeccable](docs/impeccable.md) for hook behavior.

### Git hooks

A project's Git hooks in `.githooks/` run only after each clone sets `core.hooksPath`; Git never
does this on checkout. Run per clone, for example from the project's setup script, on a
branch you trust (the default branch), and again after every change to a hook:

```sh
node .vendor/workflow-kit/scripts/install-git-hooks.mjs          # --check only reports
```

It copies `.githooks/` of the current checkout, plus the kit's `post-checkout`, into
`workflow-kit-hooks/` in the clone's Git directory and sets `core.hooksPath` to that absolute
path, shared by all worktrees of the clone. Git then runs the copy, never the working
tree: a branch that changes or adds a file in `.githooks/` does not get that code run on
checkout or push. Only an explicit rerun replaces the copy (and drops hooks that no longer
exist); hooks no longer follow the branch you are on, so a hook change reaches a clone
only through that rerun, for example by rerunning the project's bootstrap. Symlinks in
`.githooks/` are not copied. A `post-checkout` of the project's own is used instead of the
kit's and reported; integrate `scripts/git-hooks/post-checkout` there by hand.

The earlier settings, the relative `.githooks` and absolute paths into this
repository's worktrees with matching `config.worktree` overrides, become the new path.
Git resolves relative paths per worktree, so any other relative value counts as foreign.
It changes a config file only when every `core.hooksPath` entry there (including
`include` files) points to this repository's hooks and is written in that file itself.
Because Git evaluates `includeIf` per worktree and branch, it changes nothing when any
`includeIf` target, whatever its condition, sets a foreign path. Anything else, such as a
foreign path in local, global or system config, stays and is reported: integrate
`.githooks` there yourself. Without `.githooks/` it does nothing.

After a branch checkout (third argument `1`) the kit's `post-checkout` runs
`git submodule update --init --checkout .vendor/workflow-kit`, so the kit follows the gitlink of the
new branch instead of showing `M .vendor/workflow-kit`. It touches only the kit, not other submodules
or `submodule.recurse`, disables Git's own prompts like the SessionStart hook (ssh may still ask on the terminal) and runs none of the kit clone's own hooks. Like any checkout it applies the user's Git configuration, including filters.
A kit with local changes, ignored or untracked files, or commits no remote has
(a clean, published kit behind or ahead of the old pin still follows) is not touched: the hook prints a hint
and the checkout continues; any failure only prints the command. Without a kit gitlink, as in this repository,
it does nothing. Known limit: where the kit has `core.filemode=false`, a purely local mode change is invisible to
Git and the update may reset it.
Migrating from the earlier design (a committed `.githooks/post-checkout`): delete that file, then rerun
the installer, so the kit's current one is copied.

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`. It acts on the project of the
working directory; `--cwd PROJECT_DIR` as the first argument (`board.mjs --cwd PROJECT_DIR check 7`) reads
the project from that directory instead. Other relative paths (`--body-file`) stay relative to the working directory.
`init-project.mjs`, `setup-skills.mjs` and `affected-tests.mjs` take the same first argument (`takeCwd` in `checkout-root.mjs`),
and then work in that directory, their relative paths (changed files given to `affected-tests.mjs`) included:

- `next`, `check ISSUE [--session ID]` (exit 0 STARTABLE, 1 BLOCKED, 2 UNKNOWN, 4 STACKABLE: only an open
  predecessor PR holds the issue, see [Stacked pull requests](docs/CONTRIBUTING.md#stacked-pull-requests);
  `next` lists such issues apart, with the base PR; shows the age and open PR of a claim and one line per
  native sub-issue; information only), `status ISSUE "STATUS"`, `priority ISSUE High`,
  `block ISSUE OWNER/REPO#N`, `sub PARENT CHILD` (native sub-issue, read back; `CHILD` may be
  `OWNER/REPO#N`; an existing link succeeds again; no removing or reordering).
- `new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--field NAME=VALUE ...] [--start --agent claude|codex --session ID]`:
  create an issue with its required metadata in one call and print one line, `NEW URL | milestone | labels |
  Status | Priority | …`, of the values read back. Title, body file, an open milestone, one label that exists
  (the REST API would create an unknown one), a Priority and every field named in the optional
  `"requiredFields"` of `.github/workflow-project.json` (for example `["Size"]`) are required; `Status`
  and `Priority` are not `--field` values. Everything is validated against the Project and repository before
  the issue exists, so a missing or invalid value creates nothing (`ERROR - reason`, exit 2). The Status is Backlog;
  `--start` (only under a human start request, [Starting work](docs/CONTRIBUTING.md#starting-work)) assigns the
  authenticated user, sets Ready, posts `Agent: …, Session: …`, reads the claim back and ends on In progress; it
  refuses a body whose `Wartet bis:` line holds the issue. A failure after the issue exists names its URL and
  the failed step: finish by hand, never create it again. Branch and `check` stay separate.
- `new --from FILE`: create many issues at once. `FILE` is a JSON list (1 to 50 entries) of
  `{ "title", "bodyFile", "milestone", "priority", "labels": [..], "fields": { "Size": "XS" } }`: the values of
  the flags above, `bodyFile` relative to the working directory, Status Backlog, no `--start`. Every entry is checked
  before the first issue exists (an unknown key, label, milestone or option, or a missing required value creates
  nothing and names the entry). The issues are created over REST, which costs no GraphQL points; their Project items
  and fields are then written in blocks of 5 issues (aliased mutations: add, write, read back, 3 requests per block),
  so the GraphQL cost is 1 request for the field definitions plus 3 per block: 4 for up to 5 issues, 10 for 13, 31 for 50
  (instead of 9 per issue). When GitHub refuses a block with "Resource limits for this query exceeded", `new` halves it
  and asks again, down to one issue. An issue that is still refused, or whose values do not read back, is listed with
  the `board.mjs field ISSUE NAME VALUE …` command that finishes it; everything else is complete. The output is one
  `NEW …` line per issue. A failure after the first issue exists names every issue that exists: finish those by hand and
  create only the missing ones. The field definitions are also read once per run by a single `new`, which therefore needs 4 requests (before: 8 to 9).
- `field ISSUE NAME VALUE [NAME VALUE ...]`: any single-select fields, all read back together after writing.
  Every pair is checked against the field definitions before the first write: one invalid pair writes
  nothing and names the valid options. `field`, `status` and `priority` report failures as one
  `ERROR - reason` line (exit 2, nothing else printed), not a stack trace. `check` and issue read errors name `OWNER/REPO#N`.
- `status ISSUE "Automated review" PR [OTHER_ISSUE...]` (or `field ISSUE Status
  "Automated review" PR [OTHER_ISSUE...]`): verify the declared open PR's reference
  and comment backlink on every delivered issue before writing status. A missing
  backlink on an issue of this repository is set like `link` does and read back
  (a failure refuses); `link` first is not needed. It also prints one `warning:` line per open acceptance box
  of the issue that names no issue (what `handoff` will refuse); the status is written regardless.
  See [PR backlinks](docs/CONTRIBUTING.md#pr-backlinks).
- `body ISSUE FILE BASE_FILE`: replace an issue body with `FILE` only if the current body
  still equals `BASE_FILE` (the body your change is based on; line endings and trailing
  whitespace are ignored; the text written is `FILE` with LF line endings and no trailing
  whitespace, sent over stdin so the file name never matters), then read it back. A body that
  changed meanwhile is refused with
  a `-`/`+` diff (exit 1, nothing written); a read-back that differs from `FILE` reports
  that another session overwrote it (exit 1, the write is not repeated); API and file
  errors exit 2. See [Changing a body](docs/CONTRIBUTING.md#issues).
- `body-replace ISSUE --from FILE --to FILE`: replace exactly one occurrence of the text in
  `FILE` after `--from` with the text after `--to` (plain text, no regular expressions, one
  replacement per call; line endings and trailing whitespace are ignored like in `body`;
  `--to` may be empty). The body read at that moment is the base, then the write and read-back
  of `body` apply. No match or several matches are refused with the reason (exit 1, nothing
  written; several matches are listed by line); an empty `--from` text, unreadable files and API
  errors exit 2.
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
- `ready PR SHA|--local [--attempts N] [--interval SECONDS]`: mark a Draft PR from this
  repository ready for review, but only for the commit you pushed. `SHA` must be the full
  40-character commit id (`git rev-parse HEAD`); a short id exits 2 with that reason. `--local` reads that
  id itself from the project's checkout (`--cwd`, else the working directory), so no `$(git rev-parse HEAD)` has to
  be spliced into the call; the PR must still show exactly that head, so a commit that was not pushed is refused
  like a wrong id. It rereads the PR
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
  quality gate judges new-code conditions only) and prints a `blocker:` line for any, after up to 10
  `sonar: RULE file:line message` lines (the rest only counted); `handoff`
  then exits 1. The read needs `SONAR_TOKEN` in the environment (the anonymous API
  reports 0 for private projects); without it, or on a refused read, the command
  ends `ERROR` (exit 2), never green. Security hotspots stay a manual read. A workflow
  whose `pull_request` jobs for the head were all skipped before the Ready event (Draft
  guard), with no executed run since Ready, waits (exit 3): the skip proves nothing
  about the Ready head. Push a commit to start one: a workflow without a `ready_for_review` trigger never does otherwise.
  The kit's own CI skips Drafts this way (`pull_request` types incl. `ready_for_review` and `converted_to_draft`, job `if: github.event_name != 'pull_request' || !github.event.pull_request.draft`);
  projects decide on the same guard themselves, the kit ships no CI template.
  It also prints `correction pushes after ready: N`, the distinct heads pushed (from the branch's push log)
  after the PR's first Ready event (a PR opened non-draft counts from its creation; the head that set Ready does not count,
  a force-push is one push, a PR that never was ready prints no line). From `N >= 2` it adds
  `cap reached: collect non-blocking findings in one follow-up issue` ([review loop](docs/CONTRIBUTING.md#review-loop)).
  It is information only: no exit code changes (an unreadable push log prints a note instead), and blocking findings are still corrected. `wait` prints it with the final result.
  It also reports a moved base: `base moved: N commits since merge-base (BASE)` when the PR's base branch has commits the head lacks
  (GitHub compare `behind_by`), then `changed on both sides:` with the files the PR and those commits both change (first 10),
  or `no file is changed on both sides`. Information only, like the correction count: no exit code changes, an unreadable
  comparison prints a note, and nothing is merged or rebased for you. `wait` prints it with the final result.
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
  One run lists every missing point together (open acceptance, assignment, handoff comment, retro, native link, blockers
  and threads; a refused issue state, an unreadable read or running reviews are reported alone or first), so one fix round
  suffices. An undetermined merge state (`UNKNOWN`) is read again up to 3 times, `--interval SECONDS` apart (default 3,
  1 point per read; `merge` too) before `handoff` reports it as waiting.
  Session ownership, final
  proof and whether a finding is justified remain driver responsibilities. Use this for
  delivery; `status` is metadata maintenance.
- `merge PR [--stall MINUTES] [--grace MINUTES] [--interval SECONDS] [--max-minutes N]`: the only way for an agent with merge
  authority to merge ([review loop](docs/CONTRIBUTING.md#review-loop) step 7). It applies the review gates of
  `handoff` (open non-draft PR, CI green, every reviewer with a trace on the head finished or
  stalled, no `blocker:` line, no open thread, determined merge state) and prints the same
  lines; a running reviewer ends `WAITING` (exit 3) and names it, a red check or blocker
  `FAILED` (exit 1), and nothing is merged. If the base moved and `changed on both sides` lists files, it first
  merges the base into the PR branch (`PUT pulls/N/update-branch` with the checked head as `expected_head_sha`),
  waits for the new head and its CI like `wait` (`--max-minutes`, default 9: then `still waiting: call merge again`,
  exit 4; run `merge` again), checks the gates again and merges that head; a base that moved without
  an overlap does not hold the merge. If GitHub refuses that update with 403 (a PR with stacked children), `merge` ends
  `FAILED` (exit 1) and tells you to run `git merge origin/<base>` in the PR's worktree, push once and call `merge` again;
  it never pushes for you. Then it runs `gh pr merge --merge
  --match-head-commit <full head id>` once (a push after the check makes gh refuse; a refusal "part of a stack ... asynchronous merge REST API" or HTTP 403 for a PR with stacked children
  goes once to `PUT pulls/N/merge-async` with `merge_action=direct_merge`, `merge_method=merge` and `sha` = the same head,
  and the merge is read back until it shows) and counts
  only a read-back showing the PR as merged (`MERGED #N head … merge commit …`, exit 0; any other gh
  refusal or a read-back that differs: `ERROR`, exit 2). A layer of a [stack](docs/CONTRIBUTING.md#stacked-pull-requests)
  with an open layer below it is refused (`FAILED`, exit 1): merging it would merge that layer too. After the merge it
  deletes the head branch (`branch deleted: …`) unless the repository's setting "Automatically delete head branches" does it,
  the branch is not of this repository, is the default branch or is the base of another open PR (a stack: GitHub would close
  that PR); it prints `branch kept: …` with the reason. A failed or already done delete is a `note:` or `branch gone:` line,
  never an error of the merge. It does not read the issue, claims or the [handoff comment](#handoff-comment).
- `wait PR`: repeats `reviews` (first after 60 s, then at longer intervals up to 5 minutes, again from 60 s
  when what it awaits changes; twice as long below 1000 quota points), prints `WAITING` lines on change and
  ends with `DONE`, `FAILED` (as soon as a check fails or a non-draft PR has merge conflicts, `blocker: merge conflicts`) or `ERROR`. Both end
  with a `quota: …` line (points left, points this run used, reset time). When GitHub's shared GraphQL
  quota is used up or low (under 300 points for `wait`, 50 for `reviews` and `handoff`), these three sleep until the reset and
  say so on stderr (`rate limited until 2026-10-07T04:20:34.000Z (in 7 min)`); every other command stops with the reset time, also as
  minutes from now. Points left and the reset come from the `x-ratelimit-remaining` and `x-ratelimit-reset` headers of the
  command's own GraphQL answers, a refusal included, never from `gh api rate_limit`
  ([parallel drivers](docs/parallel-drivers.md)). Both take
  `--stall MINUTES` (default 20) and `--grace MINUTES` (default 3, or `"reviewerGraceMinutes"` of the project file; `0` turns it off): for that long after
  the PR became ready (Ready event, or creation as non-draft) and after each push of the
  head (read from the branch's push log, so a reused commit counts too), whichever is later, they keep
  waiting for reviewers that start on Ready or on new commits, such as Codex, even when CI is already
  green, unless a required bot has already answered for good on this head (a review, a finished comment, a final reaction, or a limit notice such as "usage limit" or "rate limited" in a comment or check): that ends the grace at once, an optional reviewer never does; `handoff` honors both. `wait PR --head SHA` (the full id you just pushed, `git rev-parse HEAD`)
  keeps waiting (`waiting: PR still shows head …`) while an open PR still reports another head:
  right after a push GitHub serves the previous head for a moment, and a plain `wait` would end `DONE` for it.
  A head that never matches waits on until stopped by hand. `wait PR --merged` waits for the human merge
  and ends `FAILED` if the PR is closed unmerged. After `--max-minutes N` (default 9, `0` = no limit) `wait` stops
  unfinished with exit 4 and the line `still waiting: call wait again`, so it ends before the 10-minute limit of an agent's
  shell tool; a quota pause that would end after that time is not slept through, the line then names the reset
  (`still waiting: call wait again after <time> (GitHub quota pause)`). Call `wait` again on exit 4. Analyzers that create their
  check only when finished are awaited when listed in `"awaitApps"`
  ([setup](SETUP.md#3-board-and-labels)).
  Recognized review traces: checks and statuses, Codex's `Running` summary (its code
  and security rows end separately: a security result comment never ends a running code
  review), bot 👀 reactions and review requests. Free-text announcements of other bots are not
  detected; check such reviewers by hand. Reviewers in `"optionalReviewers"`
  ([setup](SETUP.md#3-board-and-labels)) are skipped for all of these: their checks, comments and
  reviews are listed and their 👀 reaction is shown as a note, but they never wait, stall or fail; their open threads and
  change requests still block, and an analyzer such as SonarCloud listed there still reports open issues as a blocker.

### Handoff comment

`handoff` needs one comment on the PR from the driver (the authenticated GitHub user) that
has the heading `## Übergabe` on its own line and a line `Head: <SHA>` that starts with the
first seven characters of the PR's current head commit. The comment names the head it is
about, so no timestamp is involved: a new head, for example after a review fix, asks for a new
comment, a comment for an earlier push does not count, and it works the same for a head without
a check suite or one that was pushed and checked on another branch first. Put the retro under
the heading `Retro` (any level, usually `###`), one list line per finding, and, after another
heading, the review findings with their disposition and, if a reviewer was unavailable or
stalled, the reviewer, cause and evidence (an optional reviewer only when it found something). Every retro line ends with exactly one resolution (a closing `.`, `,` or `;` after it is ignored):

- an issue link: `#N` or `OWNER/REPO#N` (the issue that owns the fix; a pull request link does not count),
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

<Ergebnis in einem Satz in einfacher Sprache>

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

## Project test map

`node .vendor/workflow-kit/scripts/affected-tests.mjs` knows only the kit's tests. A project adds its own map in
`.github/affected-tests.json` (`init-project.mjs` does not create it): a path pattern (`*` inside a folder, `**` across
folders, relative to the project root) and a command or a list of commands. The script prints each matching
command once after the kit's tests; `--run` runs them in the project root and stops at the first failure. A green `--run` prints only the test counts (`ok: <command>` per project command), a red one the failure's output; `--verbose` shows every line.
Without the file nothing changes. The changed files are those against the merge base with `origin/main`, or with
`--base origin/release/1.2` for projects that target release branches; files listed as arguments replace them.
Run it from the project root: the working directory decides which project it reads.

```json
{
  "backend/domain/**": "sh backend/gradlew -p backend :domain:test",
  "backend/api/**": ["sh backend/gradlew -p backend :api:test", "sh backend/gradlew -p backend :tests:test"],
  "frontend/web/**": "npm --prefix frontend/web run test -- --changed"
}
```

On Windows the commands run through `cmd.exe`, so a bare path or a `./` prefix does not work as the program
(`backend/gradlew` fails there with "'backend' is not recognized"); `sh backend/gradlew` runs on both systems.

The commands run with the permissions of whoever runs the script, like a `package.json` script; change the
file only through a reviewed pull request.

## Developing the kit

```sh
git submodule update --init --recursive    # the tests clone the pinned submodules
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs
git status --short    # review intended outputs; preserve unrelated work
node --test scripts/tests/<affected>.test.mjs    # add --test-name-pattern for one test
node scripts/affected-tests.mjs    # test files for the changed files (--run runs them); new scripts need a row in its table
```

Locally run only the affected tests; CI runs the commands above plus the full
`node --test scripts/tests` in one Linux job: about 20
runs a month at up to 10 minutes on a free public runner.

Per clone, run `node scripts/install-git-hooks.mjs` once (rerun after changing `.githooks/`). The copied
`pre-push` hook then runs the static file test `scripts/tests/text-files.test.mjs` (stray control characters,
well under a second) and stops the push when it fails. It checks the working tree, adds no network or
fixture tests, and `git push --no-verify` skips it; CI runs everything either way.

### Submodule updates by Renovate

Renovate only moves a submodule pin, so the Ponytail adaptation patch and the committed
skills are stale until regenerated. The workflow `Renovate regenerate` does that on
Renovate pull requests from this repository that change `.vendor/*`. It starts on
`pull_request_target`, so GitHub loads the workflow from `main`: a branch cannot rewrite the
definition that holds the write token. That is safe only because the job never runs code of the
branch (see below), and it must stay so. The job runs
`scripts/update-ponytail.mjs` and `scripts/update-impeccable.mjs` as needed, then the CI
generators, pushes the result to the Renovate branch and approves the repository CI run for the
new head: a push with `GITHUB_TOKEN` makes GitHub create the `pull_request` run but hold it as
`action_required`, and the required check `Workflow Kit checks` stays "expected" until it has run
(a `workflow_dispatch` run beside it is not accepted). The job holds `contents: write`
and `actions: write` (the checkout action fetches with it and drops it; no step that runs a script sees it except the push and approval steps), runs only for
`renovate[bot]` pull requests whose commits are all by bots, and checks out the commit of
Renovate's authenticated event, not the branch name. Whatever the branch changed under
`scripts/` never runs: main's scripts replace it, and only the branch's adaptation patch is
kept as input. Whoever wrote its commits, the branch may not change any workflow, script,
`.node-version` or `renovate.json` against main, apart from the three files the updaters
generate (the Ponytail adaptation patch and the Impeccable `VERSION` and `SHA256SUMS`). The job
fails instead of running, because the approved CI run executes the branch's workflow definition
(read-only token, no secrets). The job approves only the `pull_request` run of the commit it
pushed (the list is asked for that commit), waits up to two minutes for it and fails when none
appears. Commit author names prove nothing,
so the bot-author rule only leaves branches with other people's commits alone. If the approval
fails, approve the held run on the pull request ("Approve and run") or restart it:
`gh run rerun <id>`. `renovate.json` lists the bot's commit address in
`gitIgnoredAuthors`, so Renovate keeps updating the branch. Submodules are not fetched at
checkout: the job first requires the submodule URLs in the branch's `.gitmodules` to equal
main's and fails otherwise, so a branch cannot point the generators at another repository.
`update-ponytail.mjs` keeps its conflict files in `.workflow-kit/ponytail-resolve/` and
refuses to read, write or delete there when any part of that path is a link.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/update-ponytail.mjs` on the Renovate branch: it writes the conflicting
files with markers to `.workflow-kit/ponytail-resolve/`. Resolve the markers there, run the
command again to port the patch and regenerate the skills, then commit and push. A branch with
a commit by anyone else is left alone; the same command applies.

Renovate merges its pull requests itself once every check on the head is green, all updates
including skills and hooks ([#244](https://github.com/vaultdex/workflow-kit/issues/244)). The
risk is accepted: vendored skills and hooks steer agents or load executable code, and nobody
reads them before the merge. `platformAutomerge` is off; `main` is protected by the "Reviewed
main" ruleset requiring the "Workflow Kit checks" verification. Renovate treats a head without
any check as pending, so it waits for the regenerated commit's CI run.
