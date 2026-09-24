# Ponytail

Source: `.vendor/ponytail`, pinned to an upstream release commit. All six current
skills come from that source; `scripts/ponytail/adaptations.patch` retains repository-test,
secret-scan, evidence and hook-isolation adaptations. Original MIT license and
NOTICE accompany generated packages. `scripts/ponytail/NOTICE.md` documents origin.

From a reviewed product checkout, run
`node .vendor/workflow-kit/scripts/setup-skills.mjs .` explicitly. Local Codex,
Claude, OpenCode, Antigravity and Pi discovery directories link to one generated
bundle; Copilot receives committed generated files. No global plugin is required.
Personal plugin installations remain independent; choose one injection source in
your agent's settings if duplicate skill names/hooks are enabled.

Run `node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs .` separately to
install the immutable `~/.ponytail/vaultdex/4.10.0-6/` snapshot. It adds native
launchers before the unchanged JavaScript hooks. Identical snapshots are reused;
changed bytes at the same version are refused. `vaultdex` is the publisher namespace;
runtime state is isolated by checkout hash and host. Personal defaults are retained.

Codex/Claude: SessionStart, UserPromptSubmit, SubagentStart. Copilot: sessionStart,
subagentStart and userPromptSubmitted (prompt stdout is not injected). Cursor:
sessionStart/beforeSubmitPrompt; an existing always-on Ponytail rule takes precedence.
Other providers get skills only. Hook manifests differ because host protocols differ.
Never run installation from an automatic hook or silently change native trust.
The launchers locate the checkout by walking to `.git`, without executing Git.
Before starting Node they skip relative/checkout-local PATH entries and resolve
executable symlinks/junctions, rejecting targets inside the checkout. External
Native fnm/nvm installations remain supported. POSIX requires an ELF or Mach-O
Node executable (including universal Mach-O); the OS `od` utility next to
`readlink` checks its magic bytes before execution. Script shims are skipped:
their absolute shebang or body can execute checkout code regardless of PATH.
Managed native executables outside the checkout remain the user's trust boundary.
After selecting Node by its actual path,
the exported PATH contains only fixed OS directories: `/usr/bin`, `/bin`,
`/usr/sbin`, `/sbin`, NixOS's system profile, or Windows' native system directory.
No inherited PATH directory reaches the
hook: even external directories can expose file links into the checkout.
Node preload environment variables are removed for this hook
process. POSIX uses `cd -P` and absolute system `readlink` without GNU-only flags.
When `/usr/bin/readlink` and `/bin/readlink` are absent, it uses NixOS's root-owned
`/run/current-system/sw/bin/readlink`, including system-profile file symlinks.
These fixed OS paths are the bootstrap trust anchor; `readlink` is never selected
from inherited PATH. Other layouts without these utilities fail closed. Windows
uses native final-path handles through PowerShell. No additional dependency or
checkout JavaScript runs during bootstrap.

Claude explicitly selects Bash (Git Bash on Windows). Codex uses its native cmd
override on Windows; Copilot supplies Bash and PowerShell commands. Cursor's
single command uses an installed cmd/sh launcher via `~`, preserving spaces in
the home path. Install before enabling Cursor hooks: an absent launcher produces
the shell's missing-command error and never installs itself. Other hosts retain
their SessionStart setup hint and silent uninstalled prompt/subagent hooks.
Review the changed hook definitions and trust the new snapshot explicitly; the
old `4.10.0-5` installation is left untouched. An existing enabled old definition
remains vulnerable until replaced and reviewed.

Windows execution policy remains enforced: `Restricted` blocks the installed
PowerShell script. An operator must authorize reviewed local scripts under their
own policy before enabling hooks; installers and launchers never use Bypass or
change personal/managed policy. If `$HOME` itself is a Git checkout, runtimes
under it are checkout-local, including nvm/fnm. Use Node outside that checkout;
do not whitelist the home directory and reopen the executable trust boundary.

The generator reads skill names from the pinned tree. On an upgrade it removes only
unchanged owned files of retired skills and provider links pointing exactly to those
old bundles. Edited files, foreign links and unknown directory contents stop the
migration before publication. The source receipt is updated after cleanup succeeds.

Use `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`
and `ponytail-help`; gain figures are historical upstream measurements, not savings
measured for this project. Run the consumer's hook test with its prepared checkout;
inside the kit itself use `node --test scripts/tests/ponytail-hooks.test.mjs`.
All `node scripts/...` commands in the kit's own checks refer to kit implementation,
not to consumer wrappers. New product repositories contain no such harness wrappers.
