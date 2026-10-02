# Setting up a repository

For kit setup/update requests. Use kit scripts and deliver a verified PR. Ask only
for missing decisions, access or approvals; never request credentials in chat.

## 1. Agree on the target

Read target AGENTS.md and contribution rules; inspect remote, Git status, board,
CI, update bots and agent configuration. Confirm the actual target, which may
differ from this checkout. Resolve only missing choices in one compact round:

- **Repository:** a new one from
  [project-template](https://github.com/vaultdex/project-template), or an existing
  one? Get the exact OWNER/REPO and local path. For a new one, also the owner, name
  and visibility; recommend private.
- **Board:** an existing GitHub Project number under the same owner, or a copy of
  the kit's template board?
- **Tools:** which agents (Codex, Claude Code, Cursor, Copilot, OpenCode/Pi) and
  reviewers (CodeRabbit, Codex)? Which updater: the existing Renovate or
  Dependabot, never both? Optional Sonar?
- **Start policy:** does every start need an explicit human request (the
  default), or does a human placing an issue in Ready count (`"start": "ready"`)?

New paid usage, such as Actions on private repositories or reviewer plans, needs
the user's budget decision first.

## 2. Repository

For a new repository run
`gh repo create OWNER/REPO --template vaultdex/project-template --private`, then
clone it with `--recurse-submodules`.

For an existing repository, follow [Starting work](docs/CONTRIBUTING.md#starting-work)
and use its issue branch. Add the kit only if absent. Run the
[install commands](README.md#install-or-update-in-a-project); new projects use
`init-project.mjs` without `--existing`. Preserve project rules, templates and CI.

Link `.vendor/workflow-kit/AGENT_RULES.md` from root AGENTS.md: about 20–40 lines
of project facts and routes to build/tests, architecture, final proof and exceptions.

## 3. Board and labels

Run `node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO [PROJECT_NUMBER]`.
It copies or reuses the Project and records it in `.github/workflow-project.json`,
keeping `"start"`. It also checks the six statuses and Priority, links the
repository, and adds the missing default labels: ci, documentation, testing,
security, dependencies, needs-human-input.

Finish and verify these settings in the Project and repository; Project workflows
require UI configuration:

- **Statuses:** exactly Backlog, Ready, In progress, Automated review, Human
  review, Done. To migrate a five-state board, rename In review to Automated review
  in place and add Human review before Done, keeping option IDs and cards.
- **Automation:** auto-add `repo:OWNER/REPO is:issue` to Backlog. Disable
  automations that move items to Ready or In progress on PR links or bot events,
  and any that set Human review from PR readiness or CI. Not-planned closures must
  not become Done.
- **Priority:** keep an existing scale, even an organization-linked one. A new
  project-local field gets Urgent, High, Medium, Low. Show Labels and Milestone.
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
