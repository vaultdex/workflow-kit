# Setting up a repository

For kit setup/update requests. Use kit scripts and deliver a verified PR. Ask only
for missing decisions, access or approvals; never request credentials in chat.

## 1. Agree on the target

Read any existing target AGENTS.md and contribution rules; inspect its remote,
Git status, board, CI, update bots and agent configuration. Confirm the target, which may
differ from this checkout. Resolve only missing choices in one compact round:

- **Repository:** a new one from
  [project-template](https://github.com/vaultdex/project-template), or an existing
  one? Get the exact OWNER/REPO and local path. For a new one, also the owner, name
  and visibility; recommend private.
- **Board:** an existing GitHub Project number under the same owner, or a copy of
  the kit's template board?
- **Tools:** which agents (Codex, Claude Code, Cursor, Copilot, OpenCode/Pi) and
  reviewers (CodeRabbit, Codex), and which of them are optional
  (`"optionalReviewers"`, see [section 3](#3-board-and-labels))? Which updater: the existing Renovate or
  Dependabot, never both? Optional Sonar?
- **Start policy:** does every start need an explicit human request (the
  default), or does a human placing an issue in Ready count (`"start": "ready"`)?

New paid usage, such as Actions on private repositories or reviewer plans, needs
the user's budget decision first.

## 2. Repository

For a new repository run
`gh repo create OWNER/REPO --template vaultdex/project-template --private`, then
clone it with `--recurse-submodules`.

With a working kit and `.github/workflow-project.json`, follow
[Start or resume](AGENT_RULES.md#start-or-resume) before setup edits.

**First installation:** the explicit setup request authorizes only bootstrapping
the missing kit/Project binding. Follow existing project rules; create or reuse
the setup issue and its linked branch, switch to it, assign yourself and record
your session, scope and unavailable checks or metadata before editing. Verify
ownership and native/external prerequisites; missing tooling is not STARTABLE
and does not waive blockers or unreadable dependencies.
Limit edits to establishing the kit and board below, then complete the normal start.

Add the kit only if absent. Run the
[install commands](README.md#install-or-update-in-a-project); new projects use
`init-project.mjs` without `--existing`. Preserve project rules, templates and CI.

Link `.vendor/workflow-kit/AGENT_RULES.md` from root AGENTS.md: about 20–40 lines
of project facts and routes to build/tests, architecture, final proof and exceptions.

## 3. Board and labels

Before reusing a board, configure exactly Backlog, Ready, In progress, Automated
review, Human review, Done, plus a usable Priority scale. Migrate In review by
renaming it to Automated review in place and adding Human review before Done;
preserve option IDs, cards and existing Priority, including organization fields.

Run `node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO [PROJECT_NUMBER]`.
It copies or reuses the Project and records it in `.github/workflow-project.json`,
keeping `"start"`. It also checks the six statuses and Priority, links the
repository, and adds the missing default labels: ci, documentation, testing,
security, dependencies, needs-human-input, spec.

If field validation fails, correct that board and repeat the same command; a
copied board is already recorded, so do not create a replacement. Write and verify
the agreed policy: `"start": "ready"`, or omit `start` for explicit requests.
The script preserves an existing policy rather than choosing one.

If an analyzer reports through a GitHub App that creates its check only when it
finishes (SonarCloud), list the app slug in `"awaitApps"`, for example
`"awaitApps": ["sonarqubecloud"]`, so `board.mjs wait` waits for it. A review bot the
project does not depend on (CodeRabbit on a free plan that is mostly rate limited) goes in
`"optionalReviewers"`, a list of bot logins or app slugs, for example
`"optionalReviewers": ["coderabbitai"]`: `board.mjs wait`, `reviews` and `handoff` never
wait for it or call it stalled, and agents neither re-request nor replace its review.
Its findings, open threads and change requests still count. The script keeps these settings too.
Likewise `"requiredFields": ["Size"]` names Project fields that
`board.mjs new` demands besides Priority.

For first installation, add the setup issue to this Project, complete its
[metadata](docs/CONTRIBUTING.md#issues), and set Ready under the explicit setup
request. Now complete [Start or resume](AGENT_RULES.md#start-or-resume) before
continuing. Failed checks stop dependent work; never label bootstrap as a passed check.

Finish and verify these settings in the Project and repository; Project workflows
require UI configuration:

- **Automation:** auto-add `repo:OWNER/REPO is:issue` to Backlog. Disable
  automations that move items to Ready or In progress on PR links or bot events,
  and any that set Human review from PR readiness or CI. Not-planned closures must
  not become Done.
- **Metadata:** a new project-local Priority field gets Urgent, High, Medium, Low.
  Show Labels and Milestone.
  Create the milestone `Hotfixes · laufend` if the project takes hotfixes.
- **Reviewers:** enable only the chosen reviewers (CodeRabbit needs App
  authorization; Codex needs automatic reviews enabled), then verify each on the
  setup PR. Committed configuration doesn't install an App. Analyzers must exclude generated
  third-party skills and companions in every provider's discovery paths.
- **Rules:** require PRs, human approval and always-reported checks, never a
  path-filtered check that can be absent. If rulesets are unavailable (HTTP 403 on
  the plan), report it; don't change the plan or the visibility.
- **Updater:** add git-submodule and GitHub Actions updates to the existing
  Renovate rules, or use the template's Dependabot file.

## 4. Agents and hooks

Use [Hooks](README.md#hooks) for the chosen agents; personal trust remains required.
Projects with `.githooks/` call [install-git-hooks.mjs](README.md#git-hooks) from their setup; a rerun is what updates a clone's hooks.
Report each integration as enabled, untrusted or unavailable.

## 5. Deliver

Commit intended configuration and follow [Commit generated files](README.md#commit-generated-files),
including all provider discovery files and executable modes; exclude personal settings, staging
bundles, backups and credentials. Verify a plain clone discovers ordinary skills
and companions without setup. Verify snapshots and agent trust separately.
Then follow [Delivery](docs/CONTRIBUTING.md#delivery) through checks, automatic
reviews and findings to human handoff. Finish with:

- links to the repository, board and PR,
- what was verified,
- the remaining user-only steps: App authorization, hook trust and the merge.
