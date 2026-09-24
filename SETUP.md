# Agent setup entry

Give your agent this URL and ask it to set up your project:
https://github.com/vaultdex/workflow-kit/blob/main/SETUP.md

Agent: conduct the short conversation below, then perform the agreed setup through
verification and a reviewable PR. Reuse the scripts in this kit; do not create a
second installer. The user's answers and existing authorization persist. Ask only
for missing decisions, access or required approvals, and continue unaffected work.
Never request credentials in chat or copy personal account configuration.

## 1. Establish the destination

Read the target's applicable AGENTS.md and contribution rules before changing it.
Inspect the current checkout, Git remote/status, existing board, CI, update bots,
skills and agent configurations when available. Preserve foreign work and ownership.
Do not silently assume the checkout hosting this document is the target project.

Ask a compact first round, using facts already supplied instead of asking again:

- New project from the template, or integrate an existing repository? Obtain the
  exact OWNER/REPO or URL and local checkout path. For a new repo, confirm owner,
  name and visibility; recommend private unless the user wants public sharing.
- Which GitHub Project should own the work: an existing project number under the
  same owner, or a new project copied from the kit's public board template?
- Which agents and integrations should be active: Codex, Claude, Cursor, Copilot,
  OpenCode/Pi; CodeRabbit/Codex reviews; existing Renovate or Dependabot; optional
  Sonar? Reuse installed org Apps and the existing updater. Ask only about unclear
  choices; do not enable duplicate update bots or invent product/quality settings.

Explain the intended files and remote settings in a few lines, then carry out the
authorized choices. Missing rights are a specific blocked step, not a reason to
stop all setup. New paid usage requires the user's concrete budget decision before
enabling it. New private repos require checking Actions/reviewer plan limits.

## 2. Obtain and configure the checkout

Use installed Git, authenticated `gh` and Node 26. Verify identity/access without
printing tokens. For a new repository use GitHub's template creation or:

```sh
gh repo create OWNER/REPO --template vaultdex/project-template --private
git clone --recurse-submodules https://github.com/OWNER/REPO.git
cd REPO
```

Substitute the agreed owner/name and visibility; do not run placeholder commands.
The public template must already contain its implementation on main. If its
bootstrap PR is still pending, report that dependency instead of generating an
empty repo or merging it without authorization. Do not overwrite an existing path.

For an existing repository, inspect current main and competing work, then use an
isolated `codex/<issue>-workflow-setup` branch when needed. Reuse the repository's
task process. Add the kit only if absent; verify an existing gitlink/remote first:

```sh
git submodule add https://github.com/vaultdex/workflow-kit.git .vendor/workflow-kit
git submodule update --init --recursive
node .vendor/workflow-kit/scripts/init-project.mjs . --existing
node scripts/setup-skills.mjs
node .vendor/workflow-kit/scripts/init-project.mjs . --existing --check
node .vendor/workflow-kit/scripts/check-skills.mjs .
```

Use the init/setup/check sequence for a new template checkout too, omitting the
already-present submodule add. Read scripts from the pinned kit, not an unrelated
download. If a file was intentionally edited, reconcile it with the user/project
contract; never delete or rewrite the receipt merely to silence a conflict.

The consumer keeps only three documented entrypoints: `setup-skills.mjs` for
workspace bootstrap and the two hook installers named by recovery messages.
All implementation stays in the kit. Run the checker directly as shown above;
the final `.` selects the consumer, not the kit. During a kit update, `init-project`
retires an unedited, kit-managed `scripts/check-skills.mjs`; update the consumer's
CI and documentation in the same PR. Edited or unmanaged files are not removed.
Do not copy product-specific database, API or runtime proofs into this generic kit.

Existing-project mode preserves unmanaged files. Integrate links to the shared
CONTRIBUTING.md and WATCHDOG.md into its root AGENTS.md, retaining project-specific
rules, architecture, build/test commands and required checks. For new projects,
ask about language/runtime and checks only if the repository provides no evidence;
do not claim the kit integration check validates the application itself.

## 3. Set up GitHub and the board

From the target checkout run:

```sh
node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO
```

Pass the chosen existing project number as the final argument when reusing a board.
The script reuses `.github/workflow-project.json` on retries. A marker naming
another repo is a conflict to investigate, not permission to change that board.

Complete account settings through supported GitHub/App APIs or their UI; the
script's success alone is not full setup. Follow [GitHub integration](docs/github.md):

- Verify Backlog, Ready, In progress (Doing), Automated review, Human review and Done;
  rename existing In review in place, insert Human review before Done and preserve
  option IDs/card assignments. Follow the review gates in the contribution workflow;
  PR readiness starts Automated review, not Human review. Preserve existing
  fields/views. Provide Priority and show Labels/Milestone. Reuse scoped milestones,
  including the ongoing hotfix milestone where applicable, and appropriate labels.
- Configure native Auto-add for this exact repository and Item added → Backlog.
  New issues start Backlog. Human-authorized triage may move feasible work to Ready
  despite unresolved dependencies. Keep native dependency links and external
  blocker evidence. Agents skip blocked Ready work and recheck before execution.
- Disable automatic promotion to Ready/In progress from PR linking or bot events.
  Implementation/Doing requires resolved execution blockers and the start policy's
  authorization: by default an explicit human request; set `"start": "ready"` in
  `.github/workflow-project.json` only when the user chooses human triage to Ready as
  that authorization. If Ready is empty, analyze Backlog and propose work, without starting.
  Cancelled/not-planned closures must not imply accepted/merged Done work.
- Reuse the selected updater; configure git-submodule and GitHub Actions proposals.
  Integrate into existing Renovate rules or use the template's Dependabot setup.
  Keep kit updates reviewable; regenerate managed files and skills in each update PR.
- Reuse CodeRabbit/Codex App access where present, configure automatic reviews for
  this exact repo, and verify a real setup PR is reviewed at its current commit.
  Where new App access or account interaction is required, prepare the precise
  destination/permissions and let the user complete required authorization. Do not
  claim that committing configuration installs or authorizes an App.
- Reuse compatible server rules; require human PR review and actual required checks
  without bypasses. Never require a path-filtered check that can remain absent.
  Report unavailable plan features; do not change visibility/plans to obtain them.

No new scheduled agent loop, dashboard sync or all-board worker is needed.

## 4. Activate selected agents and verify

The kit supplies one pinned source per upstream skill and generated discovery for
the supported providers. Run setup, inspect the resulting links/manifests, and
preserve unrelated skills and personal plugins. Do not install every provider's
personal hooks when the user selected only one agent.

Read [hook preflight](docs/agent-hooks.md) and the pinned integration documentation.
Explain any known blocking security findings before activation. In particular,
[Ponytail PATH hardening](https://github.com/vaultdex/workflow-kit/issues/3) is an
open inherited risk until its actual resolution; do not treat Impeccable's hostile
checkout proof as evidence for Ponytail's native start commands. Keep affected
automatic Ponytail hooks disabled while that start boundary is unresolved; manual
skill use and the rest of setup can continue.

For supported, reviewed hooks use the provided explicit installers; personal host
trust remains a user decision. Files and manual runs do not prove automatic hook
activation. Report confirmed enabled/disabled/unavailable status separately and
request a fresh agent session only when discovery actually requires it.

Verify managed output before regeneration, source pins, repeated setup, a clean
recursive checkout where needed, relevant existing checks, and the actual board,
updater and reviewer configuration. Use the setup issue/PR as evidence; do not
create test tasks or recurring runs solely to make the board appear active.

Commit only intended source/configuration and generated cloud discovery. Local
bundles, personal settings, credentials and private artifacts remain uncommitted.
Deliver the PR, wait for automatic reviews, and fix or link actionable findings.
Human review/merge remains the default; unavailable integrations stay explicitly
listed with the exact missing access/decision and next action.

Finish with repository, board and PR links; verified checks/integrations; remaining
user-only steps. Explain the update path: updater PR → review kit revision → init
and setup → checks/reviews → merge → developers update submodules and rerun setup.