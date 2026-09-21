# Impeccable in this checkout

Impeccable comes from the pinned Git submodule
[`.vendor/impeccable`](../.vendor/impeccable), initially upstream
[`skill-v4.3.1`](https://github.com/pbakaus/impeccable/tree/skill-v4.3.1)
(`cd12f8660e2dde57b9615c8a6b8ea674101f9cfc`). LICENSE and NOTICE stay in the
submodule and each installed skill. `.impeccable/` retains project configuration.

## Setup and updates

After cloning, pulling an Impeccable update or opening a new worktree, review the
checkout and run this explicit setup from the repository root:

```sh
node scripts/setup-impeccable.mjs
```

Git and the repository's Node version suffice; no npm install, global Impeccable,
Bun build or administrator privileges are needed. Setup initializes the committed
submodule revision, stages six upstream provider packages, applies the central
security patch, and links skills into Codex (`.agents`), Claude Code (`.claude`),
OpenCode (`.opencode`), Antigravity (`.agent`) and Pi (`.pi`). POSIX uses relative
symlinks; Windows uses junctions, including with Git's `core.symlinks=false`.
GitHub Copilot's skills and agents remain committed under `.github` because cloud
sessions discover them before setup can run. Setup regenerates this one provider
from the same pinned source. Provider subagents and the OpenCode command refresh together.
Codex agents are also materialized into `.codex/agents/` to preserve existing
project discovery. Other generated files/links are ignored; the source of truth
is the submodule plus `scripts/impeccable/`. Upstream stays clean.

Run setup once per checkout at a time. It refuses foreign skill directories/links,
edited companion files and dirty submodules. Resolve those changes explicitly;
there is no force option. Patch conflicts or an upstream engine-version change
stop before replacing the current installation. Staging uses `.impeccable/setup-*/`;
a publication failure preserves the previous generated bundle there and reports
its location. Correct the error and restore that bundle if needed before retrying.
Do not edit generated files: durable changes belong upstream or in the patch.

Automatic Git/agent hooks and npm postinstall never run setup. Reload the harness
afterward to refresh skills. This command changes neither hooks nor personal trust.

## Automatic update proposals

[Renovate](../renovate.json) enables native `git-submodules` updates, tracks
`skill-vX.Y.Z` release tags, and proposes separate Impeccable PRs before 06:00 on
Mondays (default UTC). Global automerge is overridden for this dependency. The
release tag in [`.gitmodules`](../.gitmodules) and Git submodule commit update
together. No new Actions workflow, job or scheduled run is installed; existing
PR checks still apply and can consume Actions minutes on update PRs.

Existing Renovate has processed repository dependencies. The first Impeccable
proposal is only verifiable after this configuration reaches the default branch
and a newer release exists. Proposals do not install code in developer checkouts.

For each proposed revision, run setup and `node scripts/check-impeccable.mjs`
before human review/merge, and commit refreshed `.github/skills/impeccable` and
`.github/agents/impeccable-*` assets in that same PR. A small repository test checks
their source/setup receipt and compares all five discovery Markdown files with
the pinned Git blobs, normalizing CRLF. Repository CI initializes the shallow
submodule through the existing checkout action; it executes no upstream code or
setup. For the same local test, first run `git submodule update --init --depth 1 -- .vendor/impeccable`.
The full security regression remains a local gate. Review patch conflicts and engine VERSION/SHA256SUMS changes
together with fixed-version hook definitions. After merge, pull and rerun setup.
Personal hook trust remains each developer's decision.

Because `.gitmodules` tracks a release **tag**, do not use `git submodule update
--remote`: Git expects a branch. Renovate handles release selection. For a manual
update, fetch/check out the chosen `skill-vX.Y.Z` tag inside the submodule, update
`.gitmodules` to that tag, and stage **both** files before setup (which follows
the index's gitlink). Keep the same review and verification steps.

## Engine and hook security

The central [launcher patch](../scripts/impeccable/launchers.patch) preserves #72's
pinned downloads and Windows protections. Setup applies it only to generated
copies. Five engine 0.1.5 pins in [SHA256SUMS](../scripts/impeccable/SHA256SUMS)
came from upstream release asset SHA-256 metadata. Changed remote sidecars cannot
replace them. Engine-version mismatches require coordinated pin/patch/hook updates.

Each skill includes POSIX and Windows `.cmd` launchers. First use downloads engine
0.1.5 into the user's `.impeccable/bin/0.1.5/`, checks its pin and runs it. This
requires network, writable cache and curl on Windows, or curl/wget plus a SHA-256
tool on Linux/macOS. Windows uses absolute system paths for curl.exe, certutil.exe
and findstr.exe, never checkout/PATH copies; concurrent downloads use exclusive
staging directories. Missing pins or failed checks stop execution.

Manual launchers retain reviewed local overrides (`IMPECCABLE_BIN`, sibling
binaries and the unversioned user engine); POSIX retains upstream PATH fallback.
Those require checkout trust. `IMPECCABLE_HOME` selects an isolated cache.
Automatic hooks bypass those overrides and all checkout launchers.

Install the independent hook engine explicitly from a reviewed checkout:

```sh
node scripts/install-impeccable-hooks.mjs
```

This verifies the central pin and atomically installs into
`~/.impeccable/vaultdex/engine-0.1.5/`. Existing installs are verified, never
overwritten. Hooks execute only that versioned user binary. Missing engines fail
with setup guidance instead of installing contributor-branch code. Never run the
installer from npm postinstall, an agent hook or a Git hook.

## Hook status and trust

Follow [current-harness preflight](agent-hooks.md). An inaccessible native status
interface leaves status internally unknown, without a routine warning or request
to inspect it. Disclose missing evidence when explicitly asked for status or when
a required check depends on it. Confirmed missing, disabled, untrusted or failing
hooks still need recovery guidance. This wording is coordinated with
[#110](https://github.com/vaultdex/Vaultdex/issues/110). Engine `hooks status`
checks detector configuration, not harness trust.

- **Codex:** inspect `/hooks` in CLI; use hook management in Settings in Desktop.
  Review changed definitions when prompted. Trust is personal and tied to the
  definition; existing Sonar and Ponytail hooks remain configured.
- **Claude Code:** shared hooks remain in `.claude/settings.json`. Review project
  trust and `/hooks`; commands use POSIX shell, including Git Bash on Windows.
  Personal `.claude/settings.local.json` stays ignored.
- **Copilot:** `.github/hooks/impeccable.json` contains Bash/PowerShell commands;
  cloud-agent hooks require definitions on the default branch.
- **Other providers:** skills are included; unsupported native hooks are not
  claimed. Use the skill's manual detector pass.

Post-edit hooks report findings; Codex/Claude also run the Stop pass. They neither
approve nor merge changes. Web detectors do not replace native device/a11y review.

## Web, Mobile and verification

Web inherits [PRODUCT.md](../PRODUCT.md); Mobile uses its
[native supplement](../apps/mobile/PRODUCT.md). Both retain Code-first in their
own `.impeccable/config.json`. Select `frontend` or `apps/mobile` from the root.
Live browser work needs app dependencies and a running devserver; setup does not
start servers or change CSP. After setup, `reference/live-setup.md` in the skill
contains instructions.

```sh
# POSIX: explicit engine download/probe after setup
.agents/skills/impeccable/scripts/impeccable engine-probe
```

```powershell
# Windows PowerShell
& ./.agents/skills/impeccable/scripts/impeccable.cmd engine-probe
```

`node scripts/check-impeccable.mjs` tests the **committed revision** in a temporary
clone with spaces and the real pinned submodule. It verifies fresh/repeated setup,
foreign skill/edited companion preservation, clean upstream, exclusion of local
ignored binaries, attribution in every package, first-use engine
installation, substituted downloads, concurrent starts, both app contexts and
hooks after checkout targets are replaced. Windows tests hostile system-tool
names and POSIX commands under Git Bash. One genuine engine download requires
network; fixtures handle substitutions. This proves executable behavior, not
native harness trust dialogs. Documentation-only changes need diff/link review.

References: [Upstream installation](https://github.com/pbakaus/impeccable#option-2-git-submodule),
[Renovate submodules](https://docs.renovatebot.com/modules/manager/git-submodules/).
