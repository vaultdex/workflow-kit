# GitHub integration

The setup uses native Projects and existing Apps, not an all-board agent loop.
Backlog → Ready → In progress → In review → Done; cancellation is not Done.
Native Project automation has no public creation/update mutation in the inspected
GitHub GraphQL schema. Configure Auto-add for `repo:OWNER/REPO is:issue` and review
native workflow settings in the Project UI. Do not mark every closed issue Done:
not-planned closures must remain distinct. Record actual acceptance before Done.

CodeRabbit: https://docs.coderabbit.ai/platforms/github-com
Codex: https://learn.chatgpt.com/docs/third-party/github
Dependabot: https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file
Renovate: https://docs.renovatebot.com/modules/manager/git-submodules/

Default labels: ci, documentation, testing, security, dependencies. Existing label
colors/descriptions are preserved. Add product-specific areas in the consumer.

For server enforcement, configure a GitHub ruleset requiring PRs, human approval
and the project's verified checks. Never require a path-filtered check that can
be absent; use an always-reported gate first. Ruleset availability depends on plan
and visibility. HTTP 403 is reported as unavailable, not fixed by changing a plan,
making a private repo public or bypassing protections.

App authorization and Codex review activation belong to the account/org owner.
The setup must report missing integrations rather than claiming config = installed.
