# Workflow Kit contributors

Follow [shared agent rules](AGENT_RULES.md). The kit is the project here.
Only load the detailed sections needed for the current step.

## Kit contracts

Use pinned upstream submodules and reviewed patches; never edit generated skills.
For setup, source, template or test changes run `node scripts/setup-skills.mjs`,
`node --test scripts/tests` and `node scripts/check-skills.mjs`.
Documentation-only changes need diff/link review, not skill regeneration;
required CI still applies. Hook/launcher changes additionally require
`node scripts/check-impeccable.mjs` with its real isolated engine proof.
No npm install, automatic installer hooks, secrets or private product files.
