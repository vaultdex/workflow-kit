# Setting up a repository

For an agent asked to set up or update a project with this kit. Carry the agreed
setup through to a verified PR. Reuse the kit scripts instead of writing another
installer. Ask only for missing decisions, access or approvals, and never ask for
credentials in chat.

## 1. Agree on the target

Read the target's AGENTS.md and contribution rules. Inspect its Git remote and
status, board, CI, update bots and agent configuration. Don't assume the checkout
holding this file is the target. Ask one compact round, skipping what you already
know:

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

For an existing repository, work on an issue branch and add the kit only if it is
absent. Run the [install commands](README.md#install-or-update-in-a-project) (for a
new project `init-project.mjs` without `--existing`). Keep the project's own rules,
templates and CI.

Link `.vendor/workflow-kit/AGENT_RULES.md` from a short root AGENTS.md. Keep that
file to 20–40 lines of project facts: build and test commands, architecture docs,
final proof and exceptions.

## 3. Board and labels

Run `node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO [PROJECT_NUMBER]`.
It copies or reuses the Project and records it in `.github/workflow-project.json`,
keeping `"start"`. It also checks the six statuses and Priority, links the
repository, and adds the missing default labels: ci, documentation, testing,
security, dependencies, needs-human-input.

Then finish in the Project and repository settings; GitHub has no API for Project
workflows:

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
- **Reviewers:** authorize the CodeRabbit App and enable Codex automatic reviews for
  this repository, then verify both on the setup PR. Committed configuration
  doesn't install an App. If Sonar or another analyzer runs, exclude generated
  third-party skills and companions in every provider's discovery paths.
- **Rules:** require PRs, human approval and always-reported checks, never a
  path-filtered check that can be absent. If rulesets are unavailable (HTTP 403 on
  the plan), report it; don't change the plan or the visibility.
- **Updater:** add git-submodule and GitHub Actions updates to the existing
  Renovate rules, or use the template's Dependabot file.

## 4. Agents and hooks

Run the [hook installers](README.md#hooks) only for the agents the user chose.
Trusting hooks stays a personal step in each agent. Report each integration as
enabled, untrusted or unavailable.

## 5. Deliver

Commit intended configuration, generated discovery files for every provider and
`.agents/hooks` sources. Personal settings, staging bundles, backups and credentials
stay out. Verify a plain clone has ordinary skill files and companions without
running setup; verify hook snapshots and trust separately. Open the PR, wait for
the automatic reviews, and fix or link their findings. Finish with:

- links to the repository, board and PR,
- what was verified,
- the remaining user-only steps: App authorization, hook trust and the merge.
