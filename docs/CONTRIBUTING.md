# Contribution workflow

Reference for [AGENT_RULES.md](../AGENT_RULES.md). `.github/workflow-project.json`
identifies the Project: it owns status/priority, issues own scope/acceptance/blockers/
evidence, PRs own review. Keep no second task list, ledger or tracking issue.

## Starting work

For the complete ordered procedure, follow [Start or resume](../AGENT_RULES.md#start-or-resume).
New issues and follow-ups start in Backlog. Only human authorization permits moving
Backlog to Ready; Ready can still contain blocked work.

**Start policy.** By default every start needs an explicit human request that
covers the issue. A project may set `"start": "ready"` in
`.github/workflow-project.json`; then a human placing an issue in Ready is that
request. A human request to implement a Backlog issue covers moving it through
Ready. Authorization for an issue covers its review fixes; a different issue needs
its own. Automations and bots never authorize a start.

**Finding work.** `board.mjs next` lists open Ready issues with every native
predecessor completed, highest Priority first, then the Ready issues that are
[stackable](#stacked-pull-requests) with their base PR, then the remaining Ready issues with
their native blockers; all show assignees. It does not check session ownership or
external prerequisites. Check remaining candidates before reporting no available
work. Then report blockers and propose a Backlog issue with a reason; do not start
it or change its status without authorization.

### Execution check

The [start procedure](../AGENT_RULES.md#start-or-resume) requires a fresh check on
claim, resume, handoff and review fixes. Memory, an existing branch or Ready status
does not replace it.

| Verdict | Meaning |
| --- | --- |
| STARTABLE | Open, on the configured Project with an active status, every native predecessor closed as completed, every `Wartet bis` condition met. |
| STACKABLE | Held only by open native predecessors, all in this repository and all delivered by the same single open, non-Draft PR from a branch of this repository (or by the same single PR once it is merged into a release branch, where the predecessor issue stays open until the release: then there is no stack, only a plain PR on that branch). `check` names it (`stack base: PR #N`); work starts as a [stacked pull request](#stacked-pull-requests) on that PR. Exit code 4, never 0. |
| BLOCKED | An open predecessor that is not STACKABLE (no open PR, only a Draft PR, a fork PR, several PRs, another repository), a predecessor closed as not planned or duplicate (needs a recorded decision), a closed issue, status Backlog or Done, an unmet `Wartet bis` condition, or work of another session (see Claims). |
| UNKNOWN | API error, incomplete dependency data (including the PR list of an open predecessor), an inaccessible predecessor, an unset or unknown status, the issue is missing from the Project, or an unreadable `Wartet bis` line. Retry the read; never read it as "no blockers". |

**Claims.** `check ISSUE --session ID` also reads the issue comments of the authenticated login
(other authors are ignored). A claim carries `Agent: claude|codex, Session: ID` (anywhere in a line, not quoted in code); `Agent: codex`
alone is a claim of an unknown session. A comment
with the line `Handover: ID` (from the earlier session or the human handing over, under the same login) passes the claim to
that session. The newest claim or handover decides, the later comment wins on equal times. If it names
another session than `--session` (or no session), `check` reports BLOCKED with agent, session, time and comment link.
Without `--session`, or when the newest claim is an old one that lacks the field (no known session), `check` only shows a note.
Whatever the claims say, `check` also reports BLOCKED while an open PR closes the issue (a Draft too) or a branch `<agent>/<issue number>-…`
exists, unless the newest claim is of `--session` (the own session resumes its own PR and branch); without `--session` nothing proves it. Both come
with the one issue query. Two sessions that check within seconds, before either has a claim or a branch, are not caught. Unreadable
comments are UNKNOWN. Assignment stays no lock; this check only reports, and `status` and `handoff` do not read claims.

**Claim-Alter und Sub-Issues.** Nur Information, kein neues Verdict und keine Erlaubnis zur Übernahme (die braucht
weiter eine ausdrückliche Übergabe). Bei einem bekannten Claim nennt `check` danach Alter und PR-Lage, etwa
`claim: 2d 4h ago (Session S1), open PR: none` oder `open PR: #123` (offene PRs mit Closing-Link auf das Issue).
Hat das Issue native Sub-Issues, folgt pro Sub-Issue eine Zeile `#N  Status  Assignee  Verdict` mit der Logik des
Verdicts oben, ohne Claims; sie ändern das Verdict des Issues nicht.

STARTABLE covers native prerequisites, not permission or ownership. Also inspect
**Abhängigkeiten und Wiederaufnahme** for external access, releases and decisions.
`status ISSUE "In progress"` accepts STARTABLE and STACKABLE, repeats this check and requires assignment to the
authenticated GitHub user before writing; it cannot distinguish sessions sharing
a login. Failed reads prevent the transition. Automated review also checks
[PR backlinks](#pr-backlinks); remaining status commands are metadata operations,
not approval checks.

BLOCKED or UNKNOWN stops claims, In progress and dependent edits. Preserve
dependencies and acceptance; calling a blocker "merge-only" does not clear it.
Only a specific human instruction naming that blocker authorizes bounded work:
record its source, allowed work and remaining gates first. "Continue", a review
request or Ready placement does not qualify. The guarded command still rejects a
failed check: keep the current status and verdict, verify ownership and claim
fields, then work only within the documented exception. It is never STARTABLE.

**Wartet bis.** Eine Zeile `Wartet bis: <Wert>` (üblich im Abschnitt **Abhängigkeiten
und Wiederaufnahme**) macht eine Wartebedingung maschinenlesbar. Der Wert ist entweder
ein Tag des Projekt-Repositorys (`Wartet bis: v0.1.1`) oder ein UTC-Zeitpunkt
`JJJJ-MM-TTThh:mmZ` (`Wartet bis: 2026-10-12T18:51Z`); mehrere Zeilen gelten alle.
Die Zeile zählt, wo immer sie im Issue-Text steht, auch in einem Code-Block: so wird
keine Bedingung durch Markdown-Besonderheiten still überlesen. Ein Beispiel im Text
steht deshalb im Satz oder in Anführungszeichen, nicht als eigene Zeile.
`check` und `next` melden BLOCKED mit der Bedingung, solange der Tag fehlt oder der
Zeitpunkt in der Zukunft liegt. Ein ungültiger Wert oder ein fehlschlagender Tag-Lookup
ist UNKNOWN, nie „kein Blocker“. Das ersetzt keine nativen Blocker und verschiebt
nichts nach Ready; Zeitzonen außer UTC gibt es nicht.

**Claiming.** Complete and verify every step in [Start or resume](../AGENT_RULES.md#start-or-resume).

**Delegation.** The driver owns integration, decisions, proof and delivery.
Subagents get bounded, non-overlapping paths with acceptance and non-goals; they
never claim, change status or approve.

## Issues

Write issues, PRs and comments in [simple German](#einfache-sprache) and keep
technical names exact. Before creating one, search open and closed issues and PRs, and extend compatible work
instead of duplicating it. Separate deliverables need separate issues before
branching; a kit change and its consumer update are two issues.

Use the issue form's sections. A spec or longer task uses the form „Spec oder längere
Aufgabe“: the same sections, with the required **Kurz gesagt** first
([Einfache Sprache](#einfache-sprache)). The form sets the title prefix `(Spec) ` and
the label `spec`; a spec created another way gets both by hand.

- **Wofür brauchen wir das?** The evidenced problem; for bugs, reproduction and
  expected behavior.
- **Was bringt es uns?** The concrete benefit or avoided harm.
- **Was muss gemacht werden?** The complete outcome and its non-goals.
- **Wie soll es umgesetzt werden?** Steps, files, callers, contracts, data, the
  properties that must not break, and failure and retry cases (in depth for
  bookings, migrations and process control).
- **Woran erkennen wir, dass es fertig ist?** Checkable criteria with commands;
  say which proof is a mock and which is live.
- **Abhängigkeiten und Wiederaufnahme.** Prerequisites with evidence and the next
  action, or „keine bekannt“.

Small tasks stay short. Move answers and decisions from comments into the body,
naming their source. See the [examples](task-writing-examples.md).

**Changing a body.** Several sessions often work on related issues, and GitHub replaces a
whole body without any version check. Change the body of an issue another session may also
edit only with `board.mjs body ISSUE FILE BASE_FILE`: `BASE_FILE` holds the body your change
is based on (`gh api repos/OWNER/REPO/issues/N --jq .body`, REST), `FILE` the new one. The command
refuses and prints the difference when the body changed since you read it, and reports a
conflict when the read-back after the write is not what was written. On a conflict read the
body again, merge both changes and write again. A small window between the read and the write
remains, because GitHub has no conditional write; the read-back catches every overwrite before it.
To change one passage only, use `board.mjs body-replace ISSUE --from FILE --to FILE`: `FILE` after
`--from` holds the old text, `FILE` after `--to` the new text. The command replaces exactly one
match in the body it just read and refuses when the text is missing or occurs more than once
(then take more surrounding text); the guard and read-back are the same as for `body`.

**Metadata.** Every issue, including Backlog items and follow-ups, gets one
repository milestone, a Project Priority and area/type labels when it is created,
and keeps them after closing. Set the real fields, not text in the body. The standard way is one call,
`board.mjs new --title … --body-file FILE --milestone … --label … --priority … [--field NAME=VALUE …]`
([README](../README.md#board-commands)): it checks every value before creating the issue, sets the Status Backlog,
and reads everything back. Several issues at once (a spec with its sub-issues, a batch of follow-ups): write them in
a JSON list and run `board.mjs new --from FILE` ([README](../README.md#board-commands)), which needs 3 GraphQL
requests per 5 issues instead of nine per issue. Add `--start --agent claude|codex --session ID` only when a human request covers the
[start](#starting-work); it then runs steps 4 to 6 of [Start or resume](../AGENT_RULES.md#start-or-resume) (assignee, claim comment, In progress after the readiness check). Create the issue-linked branch and run `check ISSUE --session ID` right afterwards, before the first edit. For an existing issue use
`board.mjs priority` and `board.mjs field` (several NAME VALUE pairs per call). Priority reflects
impact and urgency (Urgent, High, Medium, Low). If unsure, give a provisional one
and state its basis. Don't reprioritize others' active work. Confirmed production,
security or data-loss fixes use the milestone `Hotfixes · laufend`. Labels describe
scope, never approval, priority or checks. The sub-tasks of a spec are native sub-issues:
`board.mjs sub PARENT CHILD` links and reads back (no raw GraphQL).

### Human input

When an issue needs a human decision or action, make `## Menschliche Mitwirkung
nötig` its first section and add the label `needs-human-input`. For each open point
name:

- **Wer:** who decides or acts.
- **Was fehlt:** the question or action, with options and a recommendation.
- **Wirkung:** what is blocked and what can proceed.
- **Antwortweg:** an issue comment or the agent chat; both count.

Before dependent work, record the answer, its scope and its source in the body:
a comment link, or the date, person and session for a chat answer. Silence, a
recommendation or elapsed time is not approval. Remove the section and the label
only when every point is resolved. Routine technical decisions are yours.
[Example](task-writing-examples.md#menschliche-mitwirkung).

**Asking a human.** This applies to every question a human must decide, in a
grilling or anywhere else, not to routine technical choices:

1. **Overview first.** Start with a numbered overview in plain language. For each
   question give the context, the options with their consequences, and your
   recommendation.
2. **Then the question tool.** Ask the same questions through the harness's question
   tool (Claude Code: `AskUserQuestion`), in batches of at most 4. Questions only as
   text in a status report are not enough: they get lost. A harness without such a
   tool gets the numbered list at the end of your answer, and you stop there.
3. **Never skip.** Don't answer the question yourself, skip it, postpone it
   silently or work around it. Work that depends on the answer waits; everything
   else continues. If the human closes the dialog without answering, the question
   stays open. This extends "Silence, a recommendation or elapsed time is not
   approval" above.

### Einfache Sprache

Issues, Specs, PRs und Kommentare muss ein Mensch ohne Code-Kenntnis verstehen. Das gilt
beim Erstellen, bei jeder Body-Änderung und bei Claim-, Übergabe- und Statuskommentaren.

- Titel: was besser wird oder was kaputt ist, in Alltagssprache, etwa 40 bis 70 Zeichen.
  Keine Klassen-, Modul- oder Frameworknamen und nicht mehrere Ziele in einem Titel.
  Beispiele sind nicht das Ziel: Ein allgemeiner Umbau nennt nicht eine einzelne
  Beispielquelle im Titel.
- Kurze Sätze, ein Gedanke pro Satz. Einen Fachbegriff beim ersten Auftreten in wenigen
  Worten erklären; konkrete Beispiele vor abstrakten Regeln.
- Technisches nie weglassen: Implementierende Agenten brauchen exakte Namen, Verträge,
  Befehle, Reihenfolgen und Belege. Sie stehen im Text oder am Ende ihres Abschnitts in
  `<details><summary>Technische Details</summary>`. Vereinfachen heißt umformulieren,
  nicht löschen; Entscheidungen mit Quelle, Blocker, Teiltickets, Links und
  Abnahmekriterien bleiben.
- Specs und längere Issues beginnen mit dem Abschnitt „Kurz gesagt“ (nach `## Menschliche
  Mitwirkung nötig`, falls vorhanden; die Überschriftenebene ist offen, das Formular erzeugt `###`): 2 bis 4 Sätze, was heute stört, was anders wird und
  wer es merkt. Eine Spec trägt außerdem den Titelpräfix `(Spec) ` und das Label `spec`;
  das Formular „Spec oder längere Aufgabe“ setzt beides.
- PRs und Kommentare beginnen mit dem Ergebnis in einem Satz, Details danach. Das gilt
  auch für den [Übergabekommentar](../README.md#handoff-comment). Maschinell erzeugte
  Kommentare wie der Backlink von `board.mjs link` sind ausgenommen. Ein Hinweis, den
  ein Skill an den Anfang stellt (der KI-Hinweis von `/triage`), steht zuerst, das
  Ergebnis direkt danach.
- Kein Status im Text: Project-Status, Priorität und Größe stehen nur auf dem Board. Ein
  Issue-Text schreibt keine Zeilen wie „Status: Backlog, keine Ready-Freigabe“; sie
  veralten beim nächsten Statuswechsel. Das gilt auch, wenn die Vorlage eines Skills
  (zum Beispiel `to-tickets`) eine Statuszeile zeigt. Eine Ausnahme ist die Statuszeile
  einer lokalen Ticketdatei (Tracker „lokales Markdown“): Sie ist dort der Triage-Stand
  und bleibt. Freigaben und Entscheidungen stehen weiter mit Quelle im Text, aber ohne
  den Board-Status zu wiederholen.

## Delivery

**Branch.** Create the branch from the issue so GitHub links it:
`gh issue develop ISSUE --repo OWNER/REPO --name <agent>/ISSUE-topic --base main`.
GitHub cuts it from the current remote base, which a local clone often does not have yet:
then run `git fetch origin` and `git switch --track origin/<agent>/ISSUE-topic`, never
a branch cut from your local `main`. Reuse your existing branch and PR for the same
issue. If creation fails, check the
remote branches and issue links before retrying.

**PR body.** From the first push, write `Closes #N` (cross-repo:
`Closes OWNER/REPO#N`) for each issue the PR fully delivers, and `Refs #N` for
related work. Closing keywords work only in PRs into the default branch. Partial
delivery never closes an issue; split the undeliverable part first
([undeliverable acceptance](#undeliverable-acceptance)). A branch created from the
issue is a branch connection, not proof of a direct PR connection. After creating
the PR or changing its body or base, verify the delivered issue in
`gh pr view PR --json closingIssuesReferences`. On a non-default base, connect
the issue with `board.mjs link ISSUE PR` (or GitHub's Development sidebar); the
command reads the connection back. This connection closes
the issue only when merged into the default branch; keep the project's release
rules for references and completion.

Write the PR in [simple German](#einfache-sprache): **Was wurde geändert und warum?**
starts with the result in one plain sentence, then the reason and the benefit, with
before/after where useful, plus the issue links. The `pr` skill's template (Summary,
Evidence, Merge Danger) is upstream and doesn't override this; keep its technical
evidence (diagrams, diffs, test output) after that sentence. Add
**Prüfung und Grenzen** only for problems, skipped checks or proof limits. Link the
evidence in the issue instead of pasting logs or CI status. Delete template hints
and empty sections.

### Stacked pull requests

Use GitHub's [stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
(public preview) so a dependent issue does not wait for the merge of its predecessor's
PR. Stack only when `check` says STACKABLE; otherwise the issue stays BLOCKED. Nothing
obliges you to stack, and humans still merge, the whole stack included, bottom layer first.
No stacks across forks or repositories and none made of several parallel branches.
There is no local maximum depth: continue at the current tip when the native stack is
linear and the issue is STACKABLE. Every correction below restarts CI and reviews above
it; treat that as an Economy cost, not a reason to stop after an arbitrary number of
layers or create a wait/summary issue solely for stack depth or merge-queue progress.
Keep real planning and product work as issues; use native dependencies and stacks plus
existing issue, PR and chat progress for coordination.

1. **Branch.** Create the issue-linked branch from the head of the base PR's branch (`stack
   base: … branch B` in the `check` output). When a predecessor PR is already in a native
   stack, `check` names the current top PR and its stack number; branch from that top:
   `gh issue develop ISSUE --repo OWNER/REPO --name <agent>/ISSUE-topic --base B`, then
   `git fetch origin` and `git switch --track origin/<agent>/ISSUE-topic` as in [Delivery](#delivery).
   On a base PR into `release/X.Y.Z` the stack's trunk is that release branch; that is allowed.
2. **PR and stack.** Create your PR as Draft with base `B` (`gh pr create --draft --base B`).
   If `B` is already the tip of a native stack, append your PR with
   `gh stack link STACK_NUMBER YOUR_PR` (the number is shown by `check`; extension
   `gh extension install github/gh-stack`). Without the extension, call
   `POST repos/OWNER/REPO/stacks/STACK_NUMBER/add` with `{"pull_requests":[YOUR_PR]}`.
   If `B` is not already in a native stack, link the base and your PR bottom-first:
   `gh stack link --base BASE_OF_BASE_PR BASE_PR YOUR_PR`; without the extension,
   `gh api -X POST repos/OWNER/REPO/stacks -F 'pull_requests[]=BASE_PR' -F 'pull_requests[]=YOUR_PR'`.
   `BASE_OF_BASE_PR` is the `base` shown after `stack base`; this preserves a
   `release/X.Y.Z` trunk instead of retargeting to the default branch.
   Read it back with `gh api "repos/OWNER/REPO/stacks?pull_request=YOUR_PR"`; an empty result is
   no stack. If `gh stack` or the Stacks API is unavailable or fails (for example exit code 9, not
   enabled for the repository), keep the PR Draft, record the error in the issue and treat the issue
   as BLOCKED until `check` says STARTABLE.
3. **Body and link.** `Closes #N` stays in the PR body. Because the base is not the default branch,
   also run `board.mjs link ISSUE PR` and read the connection back, as for any
   [non-default base](#delivery). Post the [backlinks](#pr-backlinks) as usual.
4. **Force-push.** The one exception to the force-push ban: `git push --force-with-lease=<branch>:<expected SHA> origin <branch>`
   on your own upper layer. Never push, rebase or force anything else, the base PR's branch
   included. So don't run `gh stack push`, `sync`, `rebase` or `submit`: they act on every layer,
   lower ones too. If the lease fails, read the remote again and decide from what changed; never
   repeat with `--force`.
5. **Corrections below.** When the lower layer's owner changes the base branch, you rebase only your
   branch onto the new base head (`git rebase --onto NEW_BASE_HEAD OLD_BASE_HEAD <your branch>`) and
   push it with the lease. When the base PR is merged, GitHub retargets your PR and rewrites your branch
   itself (new SHAs, same content); don't retarget a stacked PR yourself, `gh pr edit --base` fails while it
   is part of a stack. Local commits on top of the old history make the next push non-fast-forward, and
   the lease fails. So before the next push, rebase your local work onto the rewritten remote branch and
   never push the old history: `git branch backup/<branch> HEAD`, then `git pull --rebase` (the branch
   needs its upstream; the fork-point logic drops your commits that GitHub rewrote and replays only the
   local ones, so no `reset --hard` is needed), then `git diff --stat backup/<branch> HEAD`, which must
   show nothing but what the base branch gained meanwhile, then a plain `git push` and `git branch -D
   backup/<branch>`. After that check the base branch and CI on the new head. On a release branch the base PR's issue stays open after the merge, so `check` keeps saying STACKABLE ("already merged"): your layer is then a plain PR on the release branch, and `handoff` skips the stack checks. If the base PR is closed
   without merge, your layer stops: run `check` again and report; don't retarget your PR on your own.
6. **Handoff.** Your layer may go to Human review before the base PR is merged. `board.mjs handoff`
   then requires your PR to come from this repository, to be linked with the base PR as a stack on GitHub
   (the Stacks API read-back from step 2, not just an aligned branch chain), to target the base PR's branch
   and to contain that branch's current head (after a push below, rebase first and let CI run again). The handoff
   comment names the merge order (base PR first, then yours). `board.mjs merge` refuses an upper layer while a layer below it is
   open, because GitHub would merge that one along.

### PR backlinks

Immediately after creating a PR, post its full URL in a comment on every issue
being delivered and read back the comments (`gh api --paginate
repos/OWNER/REPO/issues/ISSUE/comments`). PR creation is complete only after every
backlink is confirmed, including for Draft PRs. Reuse an existing comment pointing
to the same open PR on resume; after a partial write or an API error, read first
before retrying. A link in the chat or PR body does not replace the issue comment.
`board.mjs link ISSUE PR` does both for an issue of this repository: the native
connection and, if no comment with the PR's URL exists yet, that comment, read back
afterwards. A second run writes nothing twice. `status ISSUE "Automated review" PR`
runs the same logic for a missing backlink on an issue of this repository, so `link`
is not needed beforehand; only a failing link or read-back refuses.

Before Automated review, run `board.mjs status ISSUE "Automated review" PR
[OTHER_ISSUE...]` with the PR number and all other issues it delivers in this
repository (numbers), or another repository (`OWNER/REPO#N`). The command checks
the open PR's explicit issue references and every issue's complete comment list
before changing status. Wrong/old backlinks, a missing one it cannot set,
unreadable or incomplete API data fail without changing status. The `field ISSUE
Status "Automated review" PR [OTHER_ISSUE...]` route performs the same check.

This check accepts `Refs` on release branches as well as `Closes` on the default
branch. It proves the comment backlinks, not native closing links, session
ownership, full delivery or review completion. Keep those separate checks and the
project's release policy. List only delivered issues; related references do not
expand the declared scope. Repository PRs without a delivered issue still use
`reviews PR` and `wait PR` without an artificial issue requirement. Creating a
backlink never closes an issue.

### Review loop

1. Before the first push, focused checks pass, the diff is reviewed and current
   main is merged if the branch is behind. Push once, then update the same PR.
   For every changed rule, state transition or background flow, write the cases
   before that push and keep them in the PR body section **Randfälle**, complete
   before Ready for Review: one line per case with the expected behavior and the
   test or the reason none is needed. Cover four classes: concurrency and timing;
   missing, stale, partial, deleted (retention) or unrelated data; interruption and
   cancellation; error paths and error classification. Settle open cases with the
   human; add cases that review uncovers. Pure text or configuration changes need
   no section. Where the project lists `"selfReview"` ([setup](../SETUP.md#3-board-and-labels)),
   run those checks on the diff before Ready for Review, once per PR, and name each in the PR body
   section **Selbstprüfung**; `handoff` and `merge` check that each name appears there, but do not judge
   whether a check ran or whether its result was good.
2. Keep the PR Draft only while implementation or focused checks are unfinished.
   Then mark it Ready for Review with `board.mjs ready PR SHA` (the full 40-character id of the commit you just
   pushed, or `--local` for the checkout's own head: it waits until GitHub reports that head, so CI starts for the right
   revision) and set Automated review with the PR number and
   all delivered issues ([PR backlinks](#pr-backlinks); `status` sets a missing
   backlink itself, no `link` call needed). Don't wait for optional
   self-reviews; bots and CI start only outside Draft.
3. Wait for CI and every non-optional review with a trace on the current head with `board.mjs
   wait PR --head SHA` (SHA: full id of the head you just pushed; the flag keeps it from ending
   on the old head right after a push) in the background (a driver subagent: foreground, see
   [parallel-drivers.md](parallel-drivers.md#driver-regeln) rule 4), not hand-written polling. Review bots run unreliably,
   so find out per head who reviews instead of assuming it. A trace is a check,
   status or review on the head commit, or, created after the head was pushed, a
   review comment, an open review request, an announced review or a bot's reaction
   to the PR or a review request. Once CI is green, a reviewer without such a trace
   is not coming; that grace (`reviewerGraceMinutes`, default 3 minutes, `0` turns it off, [setup](../SETUP.md#3-board-and-labels))
   ends at once when a required bot has answered on the head, also with a limit notice. A traced review finishes when it posts its result: a review, a
   completed summary or a final status. If no result arrives within the time the
   reviewer's last completed review on this PR took (otherwise its usual duration),
   it is stalled. Pending, cancelled or missing expected CI checks are not success; a
   workflow whose only runs for the head were skipped before the PR became ready (Draft
   guard) has no run for the Ready head yet and keeps `wait` waiting for up to 10 minutes after Ready;
   after that it is only a `note:` (a workflow that does not start on Ready never will).
   Read all findings and every review, comment and thread from bots and humans,
   including every page of analyzer results such as Sonar issues and hotspots. A
   green quality gate does not mean zero findings, and a missing or stale analysis
   is not clean. Never request a review by hand (no `@codex review` comment, no
   re-request), not afterwards either. If a reviewer that is not optional has no trace on
   the head, say so in the handoff comment (`Codex: keine Spur auf <Head>`); the handoff
   stands. A reviewer the project lists as
   `"optionalReviewers"` ([setup](../SETUP.md#3-board-and-labels)) is never awaited,
   re-requested or replaced by a self-review: `wait` and `handoff` ignore its traces,
   while its findings, open threads and change requests count like any other. Once all threads
   are resolved, `handoff` dismisses its standing change request itself (GitHub's ruleset would block the merge).
4. To change code: complete [Start or resume](../AGENT_RULES.md#start-or-resume),
   set the PR to Draft, batch fixes and rerun affected checks. Mark Ready for Review
   (`board.mjs ready PR SHA`), set Automated review and wait again. When `reviews` or `wait` print
   `base moved: N commits since merge-base`, merge the base once before the next correction push: the files listed
   as changed on both sides are where a parallel merge conflicts or breaks a test, and it saves the red CI run that would
   show it. Otherwise merge the base only for conflicts or a real need.
   After two correction pushes, collect new findings that neither block (P0/P1,
   security, data loss) nor regress against main in one follow-up issue instead of
   another push; every push restarts CI and reviews. `board.mjs reviews` and `wait` print
   `correction pushes after ready: N` (distinct heads pushed after the PR's first Ready,
   not the head that set it) and from `N >= 2` `cap reached`; nothing is blocked, and
   findings that block or regress (as defined above) and a red required CI are still corrected.
5. After the last automatic correction, run the project's expensive final proof if
   it defines one, and record the tested commit. Reuse proof only while its inputs
   are unchanged. Then run a retro once per PR: call the `retro` skill with the Skill
   tool (the kit's copy is invocable; if the tool still refuses, your checkout is
   older than the kit pin that fixed it, so update it, and don't substitute a short
   review). Its sources are your own session: the commands you ran, failed attempts
   and retries, tool refusals and errors, waiting times and the files you had to
   search for. "Present these candidates to the user" means the finding list in the
   handoff comment. A driver spawned by a chief session skips the skill and lists at
   most three friction lines from its own session instead
   ([parallel drivers](parallel-drivers.md#driver-regeln) rule 6). Fix findings within the
   issue's scope through step 4; record the rest as follow-up issues in the
   repository that owns the fix, with evidence from the session. Report findings
   about personal configuration (memory, shell profile, scheduled tasks) to the
   human instead of editing it. List every finding in the `Retro` section of the
   [handoff comment](../README.md#handoff-comment), one line each, ending with its
   resolution: an issue link, `behoben in <SHA>`, `persönlich gemeldet` or
   `kein Handlungsbedarf: <Grund>`; `Keine Funde` as the only line when there are none.
   A fixable finding that no issue covers yet becomes an issue first; a comment alone
   is no record. `board.mjs handoff` refuses a missing section or a line without a resolution.
6. Run `board.mjs handoff ISSUE PR` for the fully delivered issue only when CI
   passes, every non-optional review with a trace on the current head has finished or stalled,
   each finding is fixed or linked to a follow-up, the
   final proof has passed, the retro is recorded and no prerequisite is open. Name an
   optional reviewer in the handoff only when it found something. If a
   reviewer that is not optional is confirmed unavailable (quota, outage) or stalled, record the
   reviewer, cause and evidence in the PR and hand off with that limitation stated
   in the handoff comment. Post that [handoff comment](../README.md#handoff-comment)
   on the PR for the current head (a `Head: <SHA>` line); `board.mjs handoff` refuses without it.
   Otherwise pending or unknown does not count as unavailable. Mergeable is not
   merge-ready: resolve every `blocker:` that `board.mjs reviews` lists (a standing
   change request, conflicts) or name it for the human when only a human may clear
   it, such as dismissing a review (`handoff` dismisses an optional reviewer's itself)
   or resolving a thread you declined to fix.
   Handoff reuses the review check, verifies the native PR link and assigned active
   task, rejects Draft/closed PRs, changed heads, conflicts and open threads, waits
   for a determined merge state, rechecks PR proof and issue prerequisites immediately before mutation, then
   writes and reads back Human review. A failed or unreadable check leaves the
   status untouched. An unsuccessful status read-back is an error, not a delivery;
   inspect the actual status before retrying. Plain `status` writes maintain
   metadata and do not prove these delivery gates.
   Check off every fulfilled acceptance box in the issue body (`board.mjs body-replace`, one box per call, or `board.mjs body`) before the handoff; a part
   moved to a follow-up stays unchecked and links that issue (`- [ ] … → #12`). `board.mjs handoff`
   refuses while an open `- [ ]` line has no issue reference.
7. A human merges. An agent that was given merge authority (for example by the chief of
   staff) merges only with `board.mjs merge PR`, never with a plain `gh pr merge`: the
   command applies the review gates of `handoff` (CI, every review with a trace on the head
   finished, no `blocker:`, no open thread, determined merge state) and refuses while a
   reviewer is still running. It merges exactly the checked head by its full commit id
   (`gh pr merge --merge --match-head-commit`, or `merge-async` when GitHub refuses a PR with stacked children as "part of a stack" or HTTP 403)
   and reads the merge back. When the base moved
   under files the PR changes too, it first merges the base into the PR branch and waits for CI
   again; if GitHub refuses that update with 403, it names the manual way
   (`git merge origin/<base>`, push once, `merge` again); afterwards it deletes the head branch (not a stack base, not the default branch, not
   where the repository deletes it itself). Codex is the only
   required review bot; CodeRabbit is optional and is neither awaited nor re-requested.
8. After the merge, confirm the delivered scope is accepted and the issue is
   closed; then it is Done. A not-planned closure never becomes Done.

Update the affected docs (behavior, API, operations, workflow) in the same PR, and
add notable user-visible changes to the project's changelog or release notes.

## Blockers and scope

**Blocked mid-work.** Stop the affected edits. In the issue, record the blocker, its
evidence, what unblocks it, the next action and your branch and PR. Return a
triaged issue to Ready with the blocker noted and unassign yourself; resume only
through the execution check. Other authorized, startable work or read-only
investigation can continue.

**Failures.** Inspect the real Git and GitHub state, fix the cause and continue on
the same branch and PR. No resets, duplicate PRs or workarounds for your own
mistakes. Report tool or service defects with a reproduction. Missing credentials
stay explicit gaps.

### Findings and follow-ups

Every concrete finding needs evidence, impact and a disposition. Either it gets a
verified fix within the issue's scope, with a regression check, or it gets a
linked follow-up issue.

Follow-ups are deduplicated, carry full metadata, start in Backlog, and state
evidence, acceptance and checks. Phrase an unconfirmed signal as an investigation
question, not as a proven defect. A follow-up grants no authority to implement it
now. For research or audits, record each finding's accept, defer or reject decision
with the human's call; accepted findings become issues. Report critical security,
data-loss or availability risks at once, without exposing secrets.

### Undeliverable acceptance

If part of the acceptance can't be delivered, for example because access is
missing, get explicit human authorization before opening the PR. Then move that
part into a follow-up issue: Backlog, full metadata, native `blocked by` the
original issue (`board.mjs block FOLLOW-UP ORIGINAL`). Record the split in the original issue: leave that acceptance line unchecked and add the link to the follow-up (`- [ ] … → #12`), which `handoff` accepts as moved; the PR then closes the
reduced scope. Without authorization it stays a blocker. A split never waives
security or required checks.

**Cancellation.** A rejected or closed PR is not delivery. Only a human cancels
work (close as not planned), and its history stays.
