---
name: spec-review
description: "Check a spec issue against the code: complete, correct, as planned. Open decisions and architecture candidates are settled with the user first; agreed work becomes new sub-issues of the spec."
disable-model-invocation: true
argument-hint: "<spec issue number, URL or title words>"
---

# Spec review

Target spec: `$ARGUMENTS`. A number or URL names it directly; title words go through
`gh issue list --label spec --state all --search "<words>"`. Empty or several matches: ask once which spec.

Every acceptance point and every planned decision of the spec ends with one **verdict**:

- **done**: implemented as planned, proof `file:line` on the review ref.
- **deviates**: implemented, but differently from the plan.
- **open**: missing or only partly there.

Project rules win: the project's `AGENTS.md` names its tracker, architecture and spec acceptance docs; read the rows
that apply before step 1. `board.mjs` is the kit's `scripts/board.mjs`.

## Steps

1. **Read the plan.** Spec body (to a file when large), comments, sub-issues with state
   (`gh api --paginate "repos/{owner}/{repo}/issues/SPEC/sub_issues?per_page=100" --jq '.[]|[.number,.state,.title]'`) and their merged PRs.
   The review ref is the remote branch those PRs merged into, after `git fetch`.
   Done when every acceptance point and planned decision is listed.

2. **Architecture pass.** Read [`improve-codebase-architecture`](../improve-codebase-architecture/SKILL.md) and run its
   steps 1 and 2 (explore, HTML report) with the spec's code as the named direction, on the review ref.
   It is user-invoked, so follow the file; skip its closing question, step 5 asks about every candidate.
   A candidate counts as **deviates** when it breaks the spec, an ADR or the project's target architecture.
   Done when every candidate is listed for step 5.

3. **Verdict per point.** Check each listed point against the review ref: presence with `file:line`,
   absence with one `git grep` per pattern over the whole result. Done when every point carries a verdict and its proof.

4. **Collect the questions.** One question per **deviates** or **open** verdict whose fix needs a decision
   (two reasonable ways, where a rule lives, scope, accept the deviation or fix it), and one per architecture
   candidate from step 2 (follow-up, reject, or leave). A gap with one obvious fix needs no question.

5. **Settle them with the user.** Call the Skill tool with "grilling"; the questions from step 4 are its first
   frontier, in plain language (kit `docs/CONTRIBUTING.md`, Einfache Sprache), each with your recommendation.
   Every answer ends in exactly one outcome: follow-up work (its scope), accepted deviation, rejected candidate,
   or left on purpose. A rejection with a load-bearing reason gets the ADR offer of
   `improve-codebase-architecture` step 3. Done when the frontier is empty and the user confirmed.

6. **Agreed work to tickets.** Each open gap and each answer that asks for follow-up work, without a matching open
   sub-issue, first gets a search of open issues (`gh issue list --search "<finding words>"`): an unlinked match
   from an earlier run is linked with `board.mjs sub SPEC N`. Otherwise it becomes a new issue via `board.mjs new`
   (required fields per the project's tracker doc), then `board.mjs sub SPEC NEW`. The body states the
   decision from step 5 with date and source. No ticket carries an open decision; `needs-human-input` is only for
   work a human must do. Done when every agreed gap has an open sub-issue, read back from the sub-issues API.

7. **Report on the spec.** One comment on the spec in plain language: verdict table with proofs, the decisions
   from step 5 with their outcome, new sub-issues, path of the HTML report. When all sub-issues are closed and
   no gap is left, continue with the project's spec acceptance handoff, which proves the acceptance in a comment on the spec,
   and set the spec to Human review (`board.mjs field SPEC Status "Human review"`). It stays open: only a human closes it or sets Done (`AGENT_RULES.md`, Hard rules).
