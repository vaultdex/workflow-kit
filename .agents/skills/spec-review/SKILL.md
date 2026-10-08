---
name: spec-review
description: "Check a spec issue against the code: complete, correct, as planned. Open work becomes new sub-issues of the spec."
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
   (`gh api repos/{owner}/{repo}/issues/SPEC/sub_issues --jq '.[]|[.number,.state,.title]'`) and their merged PRs.
   The review ref is the remote branch those PRs merged into, after `git fetch`.
   Done when every acceptance point and planned decision is listed.

2. **Architecture pass.** Read [`improve-codebase-architecture`](../improve-codebase-architecture/SKILL.md) and run its
   steps 1 and 2 (explore, HTML report) with the spec's code as the named direction, on the review ref.
   It is user-invoked, so follow the file; its grilling loop runs only when the user picks a candidate.
   A candidate counts as **deviates** when it breaks the spec, an ADR or the project's target architecture;
   the rest stays in the report.

3. **Verdict per point.** Check each listed point against the review ref: presence with `file:line`,
   absence with one `git grep` per pattern over the whole result. Done when every point carries a verdict and its proof.

4. **Open work to tickets.** Each **deviates** or **open** verdict without a matching open sub-issue becomes a
   new issue via `board.mjs new` (required fields per the project's tracker doc), then `board.mjs sub SPEC NEW`.
   A deviation that needs a human decision gets `needs-human-input`.
   Done when every gap has an open sub-issue, read back from the sub-issues API.

5. **Report on the spec.** One comment on the spec in plain language (kit `docs/CONTRIBUTING.md`, Einfache Sprache):
   verdict table with proofs, new sub-issues, path of the HTML report. When all sub-issues are closed and
   no gap is left, continue with the project's spec acceptance handoff.
