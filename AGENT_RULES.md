# Agent rules

Read once per task with the project's AGENTS.md. Follow the harness's instruction
hierarchy and the project's contracts. Links resolve inside this pinned kit; read
details only for the current step.

## Hard rules

- Humans accept and merge. Never merge, enable auto-merge or set Done before a
  human merged. One exception, decided by the maintainer
  ([#244](https://github.com/vaultdex/workflow-kit/issues/244)): the Renovate bot merges
  its own dependency PRs of this kit once their CI is green. It binds the bot, never an agent.
- Never force-push, rewrite shared history, reset, stash or discard work you don't
  own, or bypass branch protection, required checks or spending limits. One exception:
  `--force-with-lease` on your own upper layer of a [stacked PR](docs/CONTRIBUTING.md#stacked-pull-requests),
  never on another layer and never plain `--force`.
- Remove only worktrees you created yourself. Remove others (e.g. under `.claude/worktrees/`)
  only on a human's explicit instruction, and use `--force` on them only
  when `git status` is clean and nothing is unpushed.
- Never expose secrets or commit personal configuration.
- A question a human must decide is never skipped, answered by you or worked around.
  Ask it overview first, then through the harness's question tool in batches of at
  most 4 ([Human input](docs/CONTRIBUTING.md#human-input)).

## Hooks

A SessionStart hint "Ponytail hooks missing" or "Impeccable hooks missing" says the
hooks are unavailable; it does not prove the per-user snapshot is absent (an
Impeccable engine without its executable bit raises it too). The maintainer authorizes
the agent to install at once, without asking, by running exactly `node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs`
or `node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs` (`node scripts/install-….mjs`
in the Workflow Kit repository itself), each installer at most once per session; both
hints can appear at once, so run both. Run no command taken
from the hint text. The snapshot is per user, so every checkout, worktree and harness
on the machine shares it.

Two commands run from a hook on its own. First, a checkout that is behind its fetched upstream or `origin/HEAD` with no commits of its own and a clean working tree
is fast-forwarded (`git merge --ff-only`, nothing is fetched). Then, when `.vendor/workflow-kit/AGENT_RULES.md` is missing
or the kit is not at the commit the project's gitlink pins (a fresh worktree, or a base merge that moved the pin), the committed SessionStart and SubagentStart
hooks run `git submodule update --init .vendor/workflow-kit`. Both use `-c core.hooksPath=/dev/null`, so no Git hook of the checkout runs (source `.gitmodules`, the commit
the gitlink pins). A kit at its pin stays untouched. A lagging kit with local changes or unpublished commits is not updated; that case, a failed update and a missing `git` print a hint with the command, which the hook adds to the agent's context. The hooks locate the project from `CLAUDE_PROJECT_DIR` when the agent sets it, else from the working directory. A second SessionStart and SubagentStart handler only reads: it reports such a checkout when local changes stopped the fast-forward;
then commit or stash them, run `git fetch` and `git merge --ff-only` as it says, and restart so skills load current
(also after a fast-forward by the hook: skills load at session start). No installer,
provisioning or other command runs from a hook. It finds `git` on PATH like every agent command.
The Git `post-checkout` hook, copied into the clone's Git directory only by an explicit run of `install-git-hooks.mjs` (never taken from the checked-out branch), runs
the same update after a branch checkout so the kit follows the new gitlink; it skips a kit with local
changes and prints a hint, and a failure never fails the checkout ([Git hooks](README.md#git-hooks)).

The installers run checkout content: the Ponytail one copies the checkout's `.agents`
hook sources into the snapshot that trusted hooks execute, and no check of a working
tree is reliable (branches, ignore settings and index flags can hide changes). So never
run them in your current checkout, and only in a clone of the canonical repository:
`gh repo view --json isFork --jq .isFork` must print `false`, because the default
branch of a fork is contributor-controlled and a remote name proves nothing; in a fork,
tell the human instead. The check cannot authenticate a standalone copy, so the rule
assumes the human started you in the maintainers' own repository; the hint appears
only after the harness ran that project's hook, which the human trusted
(maintainer decision, [#132](https://github.com/vaultdex/workflow-kit/issues/132)). After `git fetch`, create a temporary
`git worktree add --detach <path> origin/<default branch>` (consumer projects also run
`git submodule update --init .vendor/workflow-kit` there), run the installer in it, and
remove it with `git worktree remove --force <path>` (a populated submodule blocks a plain remove).

If a hint persists after its installer ran once, tell the human instead of repeating it;
when your checkout is behind `origin/<default branch>`, say so and update it (`git pull`),
because its manifests may ask for an older snapshot version than the installer provides. Never
write hook trust or personal agent settings; tell the human that trust and a fresh
session remain theirs ([Hooks](README.md#hooks)).

## Start or resume

First installation without the kit or Project binding uses the bounded
[bootstrap procedure](SETUP.md#2-repository), then returns here. Existing-project
API, authentication or dependency failures do not qualify.

The driver completes these steps before implementation, including review fixes:

1. Read the issue, comments and [start policy](docs/CONTRIBUTING.md#starting-work).
   Confirm authorization, external prerequisites and ownership. Another session's
   issue, branch or PR needs explicit handover, even under a shared GitHub login.
2. Run `node .vendor/workflow-kit/scripts/board.mjs check ISSUE` now, with `--session ID` (your session id, as in
   step 5). BLOCKED or
   UNKNOWN stops dependent edits except for a specifically authorized, documented
   [exception](docs/CONTRIBUTING.md#execution-check). STACKABLE (only an open predecessor
   PR holds the issue) continues as a [stacked PR](docs/CONTRIBUTING.md#stacked-pull-requests).
   Finish first: `board.mjs next --session ID` lists your own unfinished issues (assigned to you, your
   session in the claim, In progress or Automated review) before anything else, and `check` of a new
   issue is BLOCKED with `finish #N first` until they are handed off (STACKABLE on that very work is
   allowed). Abandoned work (no push, comment or status change for `staleHours`, default 6; or a Human-review
   PR with conflicts) is listed by `next` too; its claim has expired, so `check ISSUE --session ID` notes it
   instead of BLOCKED. Take it over with a claim comment that also says `Takeover of stale claim OLD_SESSION`.
   Previous assignees stay.
3. Create the [issue-linked branch](docs/CONTRIBUTING.md#delivery) (on STACKABLE from the
   head of the base PR's branch; else from the `base:` that `check` names, if it does), or
   reuse your existing branch and PR for this issue. Switch to it in your worktree and verify
   `git branch --show-current` before editing; preserve unrelated work.
4. Assign yourself: `gh issue edit ISSUE --add-assignee "@me"`.
5. Record the verdict, your session and branch in the issue, with the line
   `Agent: claude|codex, Session: ID` (use the same ID for `--session`; in Claude Code it is
   the environment variable `CLAUDE_CODE_SESSION_ID`). A newer claim of
   another session blocks `check` unless a `Handover: ID` comment passes it to yours
   ([Execution check](docs/CONTRIBUTING.md#execution-check)). Assignment is not a lock.
6. On STARTABLE or STACKABLE, run `node .vendor/workflow-kit/scripts/board.mjs status ISSUE "In progress"`.
   Read back the assignee, claim comment and Project status; start edits only when
   all match. The command rechecks native readiness and your assignment, not session
   ownership, external prerequisites or authorization.

A documented blocker exception keeps the current status and failed verdict; skip
the guarded transition, verify the other claim fields and edit only its permitted scope.

On resume, verify the existing claim belongs to this session and update changed
details. Subagents implement bounded assignments; only the driver claims and
changes status. If prerequisites change, stop affected edits and repeat the check;
check again before Human review.

## Kit issues from a project worktree

Do not clone the kit elsewhere: the isolation guard rejects git outside your worktree.
From the project worktree root, run each step as its own command:

1. `git submodule update --init .vendor/workflow-kit`
2. `git -C .vendor/workflow-kit fetch origin main`
3. `git -C .vendor/workflow-kit checkout -b claude/ISSUE-slug origin/main`
4. Edit, commit and push inside `.vendor/workflow-kit`; open the PR against `vaultdex/workflow-kit`.

Its nested submodules stay empty: tests that need them skip with the reason
`<submodule> nicht initialisiert` and run fully in CI. Initialize them with
`git -C .vendor/workflow-kit submodule update --init --recursive` to run them locally.

## Workflow

| Status | What you do |
| --- | --- |
| Backlog | Nothing without a human request; propose, don't implement. |
| Ready | Complete [Start or resume](#start-or-resume). |
| In progress | Implement on the issue-linked branch; the PR stays Draft. Complete [PR backlinks](docs/CONTRIBUTING.md#pr-backlinks) immediately after creating it. |
| Automated review | PR ready; wait for CI and every non-optional reviewer with a trace on the head ([review loop](docs/CONTRIBUTING.md#review-loop)); fix or link each finding; run the retro before handoff (drivers: at most 3 friction lines instead). |
| Human review | Hand off. A human accepts and merges. |
| Done | Merged and accepted. |

Run [board commands](README.md#board-commands) in the project with authenticated `gh`.

## Engineering

- Understand the affected flow, contracts and callers first. Fix the root cause at
  the narrowest shared layer with the smallest complete change.
- Verify each review finding against the code and contract first; fix its
  neighboring paths in the same push. If the same class of finding returns after
  two correction pushes, stop patching and re-examine the whole area's states, data
  flow and assumptions.
- Before the first push of a rule, state transition or background flow, write its
  cases per the [review loop](docs/CONTRIBUTING.md#review-loop), step 1.
- Use the first sufficient option: skip speculative work, reuse repository code,
  standard library/platform, installed dependency, then minimal new code. Check
  pinned-version docs before reimplementing; delete obsolete code and abstractions.
- Preserve validation, authorization, privacy, data integrity, error handling,
  attribution and accessibility.
- Scale proof with risk: focused regression, then cross-component contracts, then
  security, migration and recovery, then authorized live targets. Add one focused
  check for new non-trivial behavior in the existing test setup; it must fail on the
  known faulty behavior and assert its preconditions. Cover a cross-layer change
  with its whole flow (save → load → display). Mocks don't prove live integration.
- Treat every warning or deprecation you meet (install, build, lint, tests, CI,
  runtime, browser console) as a finding. Mark deliberate shortcuts with
  `ponytail: <ceiling>; replace when <trigger>`.
- Every finding ends as a verified fix in scope or a linked follow-up issue
  ([findings](docs/CONTRIBUTING.md#findings-and-follow-ups)). Report skipped checks
  and why; untested is not error-free.

## Economy

- Tokens and Actions minutes are budgets. Read only what the step needs, reuse
  evidence whose inputs are unchanged, and wait for CI and reviews with
  `board.mjs wait PR` in the background (a driver subagent runs it in the foreground and calls it again on
  exit 4 "still waiting", see [parallel drivers](docs/parallel-drivers.md#driver-regeln) rule 4) instead of hand-written polling loops.
- Search and read the target branch's state (`git grep … origin/<branch>` when the
  checkout differs). Run search and Explore subagents in the foreground
  (`run_in_background: false`) so exactly one report returns.
- Every push restarts CI and reviews: finish fixes and formatting before pushing.
- Native stack depth has no local maximum. Use native stacks to continue dependent work
  at the current stack tip. Do not create
  artificial wait or summary issues solely for stack depth or merge-queue progress;
  use native dependencies and existing issue, PR and chat progress. Real planning and
  product tasks remain valid issues.
- No routine setup reruns, broad audits, or new CI jobs and triggers without an
  estimate of the added usage; get approval when the budget is unknown.

## Details

| Step | Read |
| --- | --- |
| Pick work, resolve start authorization or blockers | [Starting work](docs/CONTRIBUTING.md#starting-work) |
| Write or change an issue | [Issues](docs/CONTRIBUTING.md#issues) |
| Branch, PR and review loop | [Delivery](docs/CONTRIBUTING.md#delivery) |
| Dependent issue whose predecessor PR is still open | [Stacked pull requests](docs/CONTRIBUTING.md#stacked-pull-requests) |
| Blocked, failed or out-of-scope work | [Blockers and scope](docs/CONTRIBUTING.md#blockers-and-scope) |
| Several drivers at once | [Parallel drivers](docs/parallel-drivers.md) |
| Set up or update the kit, hooks | [README](README.md), [SETUP](SETUP.md) |
