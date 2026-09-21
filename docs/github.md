# GitHub integration

The setup uses native Projects and existing Apps, not an all-board agent loop.
Backlog → Ready → In progress → Automated review → Human review → Done; cancellation is not Done.
Ready for Review starts Automated review. Move to Human review only after the
delivered revision's automatic reviews and finding dispositions are complete and
selected checks pass; disclose confirmed unavailable reviews under the contribution
workflow's exception. Further edits return to Draft/In progress and another automatic
review cycle. Human acceptance and merge remain required for Done.

For an existing five-state board, rename In review to Automated review in place
and insert Human review immediately before Done. Preserve existing option IDs,
card assignments, other fields and views. Existing review cards stay in Automated
review until their driver verifies the human-handoff gates. Verify visible columns,
saved filters and native workflows after migration: any review-entry automation
must target Automated review, never Human review based only on PR readiness or CI.
The setup script validates the six required statuses; it does not migrate boards.
New issues start Backlog. Human triage may move feasible work to Ready with unresolved
dependencies; preserve links and external blockers. Start only after blockers resolve
and a human requests implementation. Disable PR-linked/bot promotion to In progress.
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
