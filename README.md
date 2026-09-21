# Workflow Kit

Portable contribution rules, GitHub project setup and agent skills maintained by
Vaultdex. Ponytail and Impeccable are pinned upstream submodules. Local discovery
uses links; Copilot cloud gets generated committed files. MIT; upstream licenses
and adaptation notices remain with each package. No private Vaultdex history or
product code is included.

## Let your agent set it up

Give your agent [SETUP.md](SETUP.md) with this request:

> Read https://github.com/vaultdex/workflow-kit/blob/main/SETUP.md, ask me the
> missing setup questions, then configure my repository and deliver a verified PR.

The entry covers new/existing repos, board, rules, skills, updates and reviews.
It reuses existing choices and asks only for missing information or account steps.

## New project

Use [vaultdex/project-template](https://github.com/vaultdex/project-template) on GitHub.
It contains this kit as a pinned submodule, so future kit changes arrive as update PRs.
Clone recursively, then run `node scripts/setup-skills.mjs`. Follow the starter README
for board setup and the one-time reviewer/hook authorizations.

## Existing project

Use Node 26 and Git. Start in a Git repository (paths with spaces are supported):

```sh
git submodule add https://github.com/vaultdex/workflow-kit.git .vendor/workflow-kit
git submodule update --init --recursive
node .vendor/workflow-kit/scripts/init-project.mjs .
node scripts/setup-skills.mjs
node scripts/check-skills.mjs
```

For an existing project use `init-project.mjs . --existing`: managed hooks,
entry points and ignored generated paths are integrated; previously managed template
files are updated if unedited. Unmanaged contribution rules, issue forms, update bots
and product CI remain yours. Add links to the shared
[contribution workflow](docs/CONTRIBUTING.md) and [Watchdog](WATCHDOG.md) in your root
AGENTS.md. Existing conflicting files are refused, never force-overwritten.

`.github/workflow-kit.json` records hashes of generated files in the consumer
checkout (including thin entry-point wrappers), not hashes of kit implementations.

This repository owns implementation and source pins. The separate thin starter
owns the initial product-repository layout; no source implementation is copied
into each new project. Both paths use the same init/setup/check commands.

Commit `.gitmodules`, the kit gitlink, `.github` generated discovery, hook manifests
and entry points. Local links/bundles and personal settings stay ignored. Agents
may need a fresh session. Config files do not prove actual native hook activation.

## Hooks and reviews

Explicitly install verified user-local hook snapshots after reviewing the checkout:

```sh
node scripts/install-ponytail-hooks.mjs
node scripts/install-impeccable-hooks.mjs
```

Review changed hook definitions in each agent. Setup never grants personal trust,
executes upstream installers, changes global plugins or installs from automatic
hooks/postinstall. If a personal plugin injects the same rules, choose one source
in that agent's settings; this kit preserves personal installations.

CodeRabbit configuration is included for new projects; authorize its GitHub App.
Connect the repository in Codex Cloud and enable automatic reviews in Codex settings.
`AGENTS.md` supplies shared review rules. Existing organization-wide App access is
reused. Paid plans/quotas are never enabled by setup. Sonar remains optional and
project-specific; do not copy another project's key or credentials.

## GitHub board and labels

```sh
node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO
```

Uses authenticated `gh` with repo/project permissions. Creates or reuses the project
recorded in `.github/workflow-project.json`, verifies the five workflow states
and links the repo. New projects inherit the template's fields and views;
existing projects are preserved. No issue data
is copied from Vaultdex. See [integration limits](docs/github.md) for native
automation and server rules. Review/merge remains human-owned.

## Updates

The kit itself uses Renovate for upstream release-tag proposals. Consumers can use
existing Renovate or the included Dependabot configuration, never both for the same
dependencies. A kit update PR pins a new commit; run init-project and setup-skills,
commit regenerated `.github` files, run check-skills and review patch/engine changes
before merging. Required workflow source checks catch stale generated output.
`node .vendor/workflow-kit/scripts/init-project.mjs . --existing --check`
validates every recorded managed file and hook snapshot without writing files;
review intentional local edits before reconciling the receipt.
Submodule proposals alone do not regenerate files or update a developer's checkout.
Changed hook snapshots need explicit installation and renewed host trust.

## Verification and budget

`node --test scripts/tests` checks actual setup, update preservation and hook protocols.
`node scripts/check-skills.mjs` regenerates all cloud discovery from real pinned
sources and compares content. `node scripts/check-impeccable.mjs` runs isolated
real-engine security checks, including hostile checkout executables and downloads.
Tests never certify interactive agent trust dialogs or external reviewer access.

The public kit has one standard Linux PR job, no schedule/cache/artifacts. Budget:
20 updates/month Ã— at most 10 minutes = 200 estimated runner minutes, $0 standard
public-runner charges. Product CI stays project-specific. Private consumers must
review their own Actions and reviewer budgets before adding runs.
