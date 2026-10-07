// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs next | check | status | priority | field | new | block | sub | reviews | wait | quota-wait | merge (see usage below).
// `--cwd PATH` as the first argument runs it for the project in PATH from any directory: without it the
// working directory decides the project, and a driver in another project would read and write the wrong board.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalTool, takeCwd } from './checkout-root.mjs';
import { isRateLimited, quotaOf, retryAt, splitResponse, untilText, waitInterval } from './quota.mjs';

// Taken off here: the commands below read their arguments by position.
const projectDirectory = takeCwd();
const [command, ref, typed] = process.argv.slice(2);
const project = JSON.parse(readFileSync(join(projectDirectory, '.github/workflow-project.json'), 'utf8'));
const [owner, name] = project.repository.split('/');
// `new` has no issue yet and assigns the number it creates.
let number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd(), projectDirectory);

/** The commit the project's checkout (--cwd, else the working directory) has checked out: what `ready PR --local` expects the PR to show. */
function localHead() {
  const git = externalTool('git', process.cwd(), projectDirectory);
  try {
    return execFileSync(git.file, ['-C', projectDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: git.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    console.error(`ready --local cannot read the head of ${projectDirectory}: ${String(error.stderr || error.message).trim()}`);
    process.exit(2);
  }
}
// The first argument after the PR; `ready PR --local` takes the head from the checkout, so a shell never has to splice `$(git rev-parse HEAD)` into the call.
// The PR must still show exactly that head before it is marked ready, so a commit that was not pushed is refused like a mistyped id.
const value = command === 'ready' && typed === '--local' && Number.isSafeInteger(number) ? localHead() : typed;

// The account's GraphQL quota (5000 points an hour) is shared by every agent on it. Every response carries what is left and when it
// resets in its headers (`gh api -i`, also on a refusal), so no extra request asks for it; a query reads its own cost.
// wait, reviews and handoff sleep until the reset instead of failing when it runs out or falls below their reserve;
// every other command stops with the reset time.
const sleepers = { wait: 300, reviews: 50, handoff: 50, 'quota-wait': 300 };
let quota, spent = 0; // the latest { remaining, resetAt } a response reported, and the points this run has used
// `wait` gives up at this time (--max-minutes), before the 10-minute limit of an agent's shell tool would push it into the background.
let deadline = Infinity;
/** A quota pause that would end after the deadline: `wait` ends "still waiting" instead of sleeping through it. */
class StillWaiting extends Error {
  constructor(resetAt) { super('still waiting'); this.resetAt = resetAt; }
}

/** The quota is used up until `resetAt`: `wait` does not sleep through it but keeps looking over REST (pausedRound). */
class QuotaPause extends Error {
  constructor(resetAt) { super('quota pause'); this.resetAt = resetAt; }
}

/** Say so in one line (stderr keeps stdout for the verdict) and sleep until the reset. */
function sleepUntilReset(resetAt) {
  if (command === 'wait') throw new QuotaPause(resetAt);
  if (Date.parse(resetAt) > deadline) throw new StillWaiting(resetAt);
  console.error(`rate limited until ${untilText(resetAt)}`);
  sleep(Math.max(1, (Date.parse(resetAt) - Date.now()) / 1000 + 1));
}

/**
 * One GraphQL request. `tolerate` is a pattern for a failure whose partial answer is still wanted (one of several aliased mutations
 * failed): gh then exits non-zero, but the data of the others is in its output.
 */
function graphql(query, variables = {}, tolerate) {
  // Organization-linked Priority fields live on the issue and need this preview header.
  const args = ['api', 'graphql', '-i', '-H', 'GraphQL-Features: issue_fields', '-f',
    `query=${query.startsWith('query') ? `${query.slice(0, query.lastIndexOf('}'))} rateLimit{cost}}` : query}`];
  for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
  for (let sleeps = 0; ; sleeps++) {
    if (command in sleepers && quota?.remaining < sleepers[command] && Date.parse(quota.resetAt) > Date.now()) sleepUntilReset(quota.resetAt);
    try {
      const response = execFileSync(gh.file, args, { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 });
      const { headers, body } = splitResponse(response);
      const { data, errors } = JSON.parse(body);
      quota = quotaOf(headers) ?? quota;
      if (errors?.length) {
        const message = errors.map(({ type, message }) => `${type ?? ''} ${message ?? ''}`).join('\n').trim();
        if (!(tolerate?.test(message) && data)) throw Object.assign(new Error(message), { stdout: response, stderr: message });
      }
      // A mutation reports no cost; GitHub charges it one point.
      spent += data?.rateLimit?.cost ?? (query.startsWith('mutation') ? 1 : 0);
      return data;
    } catch (error) {
      const text = `${error.stderr}${error.stdout}`, { headers, body } = splitResponse(error.stdout);
      if (tolerate?.test(text)) {
        let partial;
        try { partial = JSON.parse(body).data; } catch { /* no usable answer: the error below */ }
        if (partial) return partial;
      }
      if (!isRateLimited(text)) throw error;
      quota = quotaOf(headers) ?? quota;
      // A primary refusal whose own headers show free quota is stale (the window reset meanwhile): ask again now, never wait for a reset time.
      if (!/secondary rate limit/i.test(text) && quota?.remaining > 0 && quotaOf(headers)) {
        assert.ok(sleeps < 3, `GitHub keeps refusing although its headers report ${quota.remaining} points left; run ${command} again later`);
        continue;
      }
      // The refusal names its own reset; without headers, a minute from now.
      const resetAt = retryAt(text, sleeps, () => quotaOf(headers)?.resetAt ?? new Date(Date.now() + 60_000).toISOString(), Date.now(), headers);
      assert.ok(command in sleepers && sleeps < 3, `The GitHub GraphQL quota is used up until ${untilText(resetAt)}; run ${command} again after that`);
      sleepUntilReset(resetAt);
    }
  }
}

// GitHub charges a query by its nested lists, not by what they return: every list inside a list (and every node of a list of
// up to 100) multiplies the cost. So a query asks for little, and the rest is read only where a verdict needs it.
// The PRs that close a predecessor (closed ones included, so a merged one stays visible; stackBase keeps open and merged) find the
// base of a stack through the native closing links (manual ones included). They are read by loadDeliveries, only where a stack is judged.
const predecessorFields = 'id number state stateReason repository{nameWithOwner}';
const deliveryFields = `closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number state isDraft isCrossRepository repository{nameWithOwner} baseRefName headRefName headRefOid}}`;
// Everything the verdict reads; sub-issues carry the same fields, so their verdict needs no further query.
const issueFields = predecessor => `id number title state body repository{nameWithOwner} assignees(first:10){nodes{login}}
  projectItems(first:100){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
  blockedBy(first:100){totalCount nodes{${predecessor}}}`;
// The login of the viewer comes along, so a claim check needs no query of its own. Sub-issues (only `check` lists them) are asked
// for in the number given: each costs three lists, so the first page is short and a longer list is read again at 100.
// ponytail: closedByPullRequestsReferences lists open PRs with a closing link only (a plain mention is none); sub-issues stop at 100, shown with a note.
// `refs` finds the branches `<agent>/<number>-…` of the issue: a name filter on one flat list, no nested list.
const issueQuery = subIssues => `query($owner:String!,$name:String!,$number:Int!,$branch:String!){viewer{login} repository(owner:$owner,name:$name){
  refs(refPrefix:"refs/heads/",query:$branch,first:20){nodes{name}}
  issue(number:$number){
  ${issueFields(predecessorFields)} bodyHTML
  closedByPullRequestsReferences(first:100){totalCount nodes{number state repository{nameWithOwner} headRefName}}
  ${subIssues ? `subIssues(first:${subIssues}){totalCount nodes{${issueFields('number state stateReason repository{nameWithOwner}')}}}` : ''}}}}`;
/** Names the issue in failures (a bare "Could not resolve to an Issue" hides which repository was meant). */
const named = (label, read) => {
  try { return read(); } catch (error) { throw new Error(`${label}: ${String(error.stderr || error.message).trim()}`, { cause: error }); }
};
const readIssue = (withSubIssues = false, at = number) => named(`${project.repository}#${at}`, () => {
  for (let first = withSubIssues && 30; ; first = 100) {
    const { viewer, repository } = graphql(issueQuery(first), { owner, name, number: at, branch: `/${at}-` });
    const issue = repository.issue ?? assert.fail('issue not found');
    if (!(issue.subIssues?.totalCount > issue.subIssues?.nodes.length) || first >= 100) return { ...issue, viewer, branches: repository.refs?.nodes ?? [] };
  }
});

/** Reads the PRs that close the predecessors that have none loaded yet, 100 predecessors per query (a lookup by id is any repository). */
function loadDeliveries(predecessors) {
  const missing = predecessors.filter(predecessor => !predecessor.closedByPullRequestsReferences);
  const ids = [...new Set(missing.map(predecessor => predecessor.id))];
  for (let from = 0; from < ids.length; from += 100) {
    const batch = ids.slice(from, from + 100);
    const { nodes } = graphql(`query{nodes(ids:${JSON.stringify(batch)}){...on Issue{${deliveryFields}}}}`);
    // The same predecessor can hold several issues: every object of it gets the list. An unreadable one stays without it,
    // which stackBase reports as unreadable, never as "no PR".
    batch.forEach((id, index) => missing.filter(predecessor => predecessor.id === id)
      .forEach(predecessor => { predecessor.closedByPullRequestsReferences = nodes[index]?.closedByPullRequestsReferences; }));
  }
}
const projectItem = issue => issue.projectItems.nodes.find(item => item.project.id === project.id);

/** Why native predecessors still hold an issue: open, closed without delivery, or unreadable. */
function predecessorReasons({ totalCount, nodes }) {
  const blocked = [], unknown = [], open = [];
  const readable = nodes.filter(Boolean);
  if (readable.length < totalCount) unknown.push(`only ${readable.length} of ${totalCount} predecessors are readable`);
  for (const predecessor of readable) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    if (predecessor.state === 'OPEN') { blocked.push(`blocked by ${label} (open)`); open.push(predecessor); }
    else if (!predecessor.stateReason) unknown.push(`${label} is closed without a readable reason`);
    // Only a completed predecessor delivered; not planned or duplicate needs a recorded decision.
    else if (predecessor.stateReason !== 'COMPLETED') {
      const reason = predecessor.stateReason.toLowerCase().replace('_', ' ');
      blocked.push(`blocked by ${label} (closed as ${reason}; record a decision)`);
    }
  }
  return { blocked, unknown, open };
}

/** The current local PR of an issue, or why linked-PR data cannot safely identify one. */
function currentIssuePr(issue) {
  const linked = issue.closedByPullRequestsReferences;
  if (!Number.isSafeInteger(linked?.totalCount) || linked.totalCount < 0 || !Array.isArray(linked.nodes)
    || linked.nodes.length !== linked.totalCount || linked.nodes.some(pr => !pr)) {
    return { unknown: 'the linked PRs of this issue are not completely readable' };
  }
  const open = [];
  for (const pr of linked.nodes) {
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) return { unknown: 'an issue-linked PR has unreadable state' };
    if (pr.state !== 'OPEN') continue;
    const repository = pr.repository?.nameWithOwner;
    if (typeof repository !== 'string') return { unknown: `the repository of open PR #${pr.number ?? '?'} is unreadable` };
    if (repository.toLowerCase() !== project.repository.toLowerCase()) continue;
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) return { unknown: 'an open issue-linked PR has unreadable number' };
    open.push(pr);
  }
  if (open.length > 1) return { unknown: `the issue has multiple open PRs in ${project.repository}` };
  return { number: open[0]?.number };
}

function readStackPr(prNumber) {
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number state isDraft isCrossRepository headRepository{nameWithOwner} baseRefName headRefName headRefOid}}}`,
  { owner, name, number: prNumber }).repository;
  assert.ok(pr?.number === prNumber && ['OPEN', 'MERGED'].includes(pr.state), `PR #${prNumber} is unreadable`);
  if (pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) {
    return { refused: `PR #${prNumber} comes from a fork or another repository` };
  }
  if (pr.state === 'OPEN' && pr.isDraft !== false) return { refused: `PR #${prNumber} is still Draft` };
  if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') {
    assert.fail(`PR #${prNumber} has incomplete branch data`);
  }
  return { pr: { ...pr, repository: { nameWithOwner: project.repository } } };
}

function stackMembers(stack) {
  assert.ok(Number.isSafeInteger(stack.number) && stack.number > 0 && Array.isArray(stack.pull_requests), 'The native stack is incomplete');
  const members = stack.pull_requests;
  assert.ok(members.length >= 2 && members.every(member => Number.isSafeInteger(member.number) && member.number > 0)
    && new Set(members.map(member => member.number)).size === members.length, 'The native stack members are incomplete or repeated');
  return members;
}

/**
 * Resolve the native base for a dependent issue (docs/CONTRIBUTING.md#stacked-pull-requests). Every open predecessor must
 * be delivered by a local, ready PR. If several blocker PRs exist, a single open native stack must contain them all.
 * New work uses its tip; resuming an issue whose own PR is already in that stack uses the immediately lower member.
 * Incomplete data is `unknown`, never a fallback to the bottom PR. A sole merged delivery stays a plain PR on its trunk.
 */
function stackBase(open, currentPrNumber) {
  loadDeliveries(open);
  const refused = [], unknown = [], prs = new Map();
  for (const predecessor of open) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    const links = predecessor.closedByPullRequestsReferences;
    if (predecessor.repository.nameWithOwner.toLowerCase() !== project.repository.toLowerCase()) refused.push(`${label} is in another repository`);
    else if (!links?.nodes || links.nodes.filter(Boolean).length < links.totalCount) unknown.push(`the pull requests of ${label} are not completely readable`);
    else {
      const delivering = links.nodes.filter(pr => ['OPEN', 'MERGED'].includes(pr.state));
      if (!delivering.length) refused.push(`${label} has no open or merged PR`);
      if (delivering.length > 1) refused.push(`${label} is delivered by ${delivering.length} open or merged PRs, not one`);
      // A closing keyword can also come from a PR of another repository, which is no local branch to stack on.
      for (const pr of delivering) {
        if (pr.repository?.nameWithOwner?.toLowerCase() === project.repository.toLowerCase()) prs.set(pr.number, pr);
        else refused.push(`PR #${pr.number} of ${label} belongs to ${pr.repository?.nameWithOwner ?? 'an unreadable repository'}`);
      }
    }
  }
  if (refused.length || unknown.length || !prs.size) return { refused, unknown };
  const deliveries = [...prs.values()];
  if (deliveries.some(pr => pr.state === 'MERGED')) {
    if (deliveries.length > 1) refused.push(`the predecessors are delivered by ${deliveries.length} PRs (#${[...prs.keys()].join(', #')}), not one open native stack`);
    return { pr: refused.length ? undefined : deliveries[0], refused, unknown };
  }
  for (const pr of deliveries) {
    if (pr.isDraft) refused.push(`PR #${pr.number} is still Draft`);
    if (pr.isCrossRepository) refused.push(`PR #${pr.number} comes from a fork`);
    if (typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string' || typeof pr.baseRefName !== 'string') {
      unknown.push(`PR #${pr.number} has incomplete branch data`);
    }
  }
  if (refused.length || unknown.length) return { refused, unknown };

  try {
    const filterNumber = currentPrNumber ?? deliveries[0].number;
    const stacks = rest(`repos/${project.repository}/stacks?pull_request=${filterNumber}`);
    assert.ok(Array.isArray(stacks), 'The native stack list is unreadable');
    if (!stacks.length) {
      if (currentPrNumber) refused.push(`PR #${currentPrNumber} is not linked in an open native stack`);
      else if (deliveries.length > 1) refused.push('the blocker PRs are not proven members of one native stack');
      else return { pr: deliveries[0], refused, unknown };
    } else {
      assert.equal(stacks.length, 1, `PR #${filterNumber} belongs to an ambiguous number of native stacks`);
      const stack = stacks[0], members = stackMembers(stack), positions = new Map(members.map((member, index) => [member.number, index]));
      if (stack.open !== true) refused.push(`native stack #${stack.number} is closed`);
      else {
        const memberNumber = currentPrNumber ?? deliveries[0].number;
        assert.ok(positions.has(memberNumber), `The native stack response does not contain PR #${memberNumber}`);
        const currentIndex = positions.get(memberNumber);
        if (currentPrNumber) {
          if (currentIndex === 0) refused.push(`PR #${currentPrNumber} has no lower layer in its native stack`);
          for (const pr of deliveries) {
            if (!positions.has(pr.number) || positions.get(pr.number) >= currentIndex) {
              refused.push(`blocker PR #${pr.number} is not below PR #${currentPrNumber} in the same native stack`);
            }
          }
        } else {
          for (const pr of deliveries) if (!positions.has(pr.number)) refused.push(`blocker PR #${pr.number} is not in native stack #${stack.number}`);
        }
        if (!refused.length) {
          const baseIndex = currentPrNumber ? currentIndex - 1 : members.length - 1;
          const member = members[baseIndex];
          const source = prs.get(member.number);
          const resolved = source ? { pr: source } : readStackPr(member.number);
          if (resolved.refused) refused.push(resolved.refused);
          if (!resolved.pr) unknown.push(`PR #${member.number} at the native stack base is unreadable`);
          else {
            const expectedBase = baseIndex === 0 ? stack.base?.ref : members[baseIndex - 1]?.head?.ref;
            if (typeof expectedBase !== 'string' || typeof member.head?.ref !== 'string' || typeof member.head?.sha !== 'string') {
              unknown.push(`PR #${member.number} has incomplete native stack branch data`);
            } else if (resolved.pr.baseRefName !== expectedBase || resolved.pr.headRefName !== member.head.ref || resolved.pr.headRefOid !== member.head.sha) {
              unknown.push(`PR #${member.number} branch data changed while reading native stack #${stack.number}`);
            } else if (resolved.pr.state !== 'OPEN' || resolved.pr.isDraft || resolved.pr.isCrossRepository) {
              refused.push(`PR #${member.number} at the native stack base is not an open, ready PR from this repository`);
            } else return { pr: { ...resolved.pr, stackNumber: stack.number }, refused, unknown };
          }
        }
      }
    }
  } catch (error) {
    unknown.push(`native stack data are unreadable: ${String(error.stderr || error.message).trim()}`);
  }
  return { refused, unknown };
}

/** Git's Regeln für Ref-Namen (git check-ref-format): jeder gültige Tag wird nachgeschlagen, kein ungültiger. */
const validTagName = tag => tag !== '' && !/[\x00-\x1f\x7f ~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/u.test(tag)
  && tag.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));

/**
 * Zeilen `Wartet bis: <Tag | JJJJ-MM-TTThh:mmZ>` im Issue-Text (üblich unter "Abhängigkeiten und Wiederaufnahme"): ein
 * fehlender Tag oder ein künftiger UTC-Zeitpunkt hält das Issue wie ein nativer Blocker; was nicht lesbar ist, zählt als
 * unbekannt, nie als frei. Bewusst ohne Markdown-Abschnittslogik: jede solche Zeile zählt, auch in Code oder unter anderer
 * Überschrift. Ein Fehlgriff blockiert sichtbar (mit Grund), statt eine Bedingung still zu überlesen.
 */
function waitReasons(body) {
  const blocked = [], unknown = [], values = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const strict = /^\s*(?:[-*]\s+)?Wartet bis:(.*)$/i.exec(line);
    // Nur ASCII-Trenner weg: trim() würde ein gültiges Unicode-Leerzeichen am Tagnamen entfernen.
    if (strict) values.push(strict[1].replace(/^[ \t]+|[ \t]+$/g, ''));
    // Formatierte Varianten (**Wartet bis:**, > …, 1. …, - [ ] …) sind keine lesbare Bedingung, aber auch kein Freibrief.
    else if (/^[\s>*_+\-[\]xX\d.#|`~=()]*wartet\s+bis\b/i.test(line)) unknown.push(`unreadable line "${line.trim()}": write it as "Wartet bis: <tag or UTC time>"`);
  }
  for (const wanted of values) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(wanted)) {
      const at = Date.parse(wanted);
      // Ein Datum wie 2026-02-30 rollt über; nur der unveränderte Wert zählt.
      if (!Number.isFinite(at) || `${new Date(at).toISOString().slice(0, 16)}Z` !== wanted) unknown.push(`invalid "Wartet bis: ${wanted}": no such UTC time`);
      else if (Date.now() < at) blocked.push(`waits until ${wanted} (UTC)`);
    } else if (validTagName(wanted)) {
      try {
        // matching-refs liefert Präfix-Treffer (v0.1.1 findet v0.1.10); nur der genaue Tag zählt.
        const tags = rest(`repos/${project.repository}/git/matching-refs/tags/${wanted.split('/').map(encodeURIComponent).join('/')}`);
        if (!tags.some(tag => tag.ref === `refs/tags/${wanted}`)) blocked.push(`waits for tag ${wanted} (not found)`);
      } catch (error) {
        unknown.push(`cannot read tag ${wanted}: ${String(error.stderr || error.message).trim()}`);
      }
    } else unknown.push(`invalid "Wartet bis: ${wanted}": use a tag name or a UTC time such as 2026-10-12T18:51Z`);
  }
  return { blocked, unknown };
}

// Claim comments of the own login carry "Agent: claude|codex, Session: ID"; "Handover: ID" passes the claim to that session.
// The field may stand anywhere in a line (Codex wrote it at the end of a sentence), not quoted in code, and "Agent: codex" alone is
// a claim of an unknown session: it can never be the caller's, so it holds the issue until a handover.
const claimField = /(?<![\w`])Agent:[ \t]*(claude|codex)(?![\w-])(?:[ \t]*,[ \t]*Session:[ \t]*(\w[\w.-]*)(?![\w.-]))?/i;
const handoverField = /^Handover:[ \t]*(\w[\w.-]*)[ \t]*$/im;
// ponytail: sessions are told apart by the id the driver passes, not authenticated; Claude and Codex share one login.
/** Blocks when the newest claim or handover of the own login belongs to another session; claims without the field only note. */
function claimReasons(issue, session) {
  const viewer = issue.viewer ?? graphql('query{viewer{login}}').viewer;
  assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
  let holder, legacy;
  // GitHub lists comments oldest first, so for equal times the later one in order wins.
  for (const comment of restAll(`repos/${project.repository}/issues/${issue.number}/comments`)) {
    if (comment.user?.login?.toLowerCase() !== viewer.login.toLowerCase()) continue;
    const body = comment.body ?? '', claim = claimField.exec(body), handover = handoverField.exec(body);
    if (handover) [holder, legacy] = [{ session: handover[1], comment }, undefined];
    else if (claim) [holder, legacy] = [{ agent: claim[1].toLowerCase(), session: claim[2], comment }, undefined];
    // A claim without the field names no session: it never lifts a known holder, it is only shown.
    else if (/^Claim:/m.test(body)) legacy = comment;
  }
  const notes = [], blocked = [];
  const about = ({ agent, session: id, comment }) => `${agent ? `Agent ${agent}, ` : ''}${id ? `Session ${id}` : 'no session named'}, ${comment.created_at}, ${comment.html_url}`;
  if (holder && session && holder.session !== session) blocked.push(`claimed by another session (${about(holder)}); needs a handover to ${session}`);
  else if (holder && !session) notes.push(`newest claim: ${about(holder)}; pass --session ID to compare it with yours`);
  if (legacy) notes.push(`claim without Agent/Session field, session unknown: ${legacy.html_url}`);
  return { blocked, notes, claim: holder ?? (legacy && { session: undefined, comment: legacy }) };
}

/**
 * Work of someone on the issue that a claim comment may not show: an open PR that closes it (a Draft too) or a branch
 * `<agent>/<number>-…`. Only the newest claim being the caller's own session lifts it, so a driver cannot start in parallel to
 * an agent whose claim is missing, worded differently or posted after its branch.
 */
function workReasons(issue, session) {
  const own = session ? `no claim of session ${session}` : 'pass --session ID to prove it is yours';
  const prs = (issue.closedByPullRequestsReferences?.nodes ?? []).filter(pr => pr?.state === 'OPEN');
  const heads = new Set(prs.map(pr => pr.headRefName));
  const branches = (issue.branches ?? []).map(branch => branch.name).filter(branch => new RegExp(`^[\\w.-]+/${issue.number}-`).test(branch) && !heads.has(branch));
  return [...prs.map(pr => `open PR ${refOf(pr.repository, pr.number)}${pr.headRefName ? ` (branch ${pr.headRefName})` : ''} closes this issue; ${own}`),
    ...branches.map(branch => `branch ${branch} belongs to this issue; ${own}`)];
}

/** Base PR of the issue the last check() judged STACKABLE; handoff compares it with the PR's base branch. */
let stackedOn;

/** True when open predecessors are the only thing holding the issue: a stack may then replace the wait. */
const heldOnlyByOpenPredecessors = (reasons, predecessors) => predecessors.open.length > 0 && reasons.length === predecessors.open.length;

/** STARTABLE and STACKABLE both allow work; check() reports the latter with exit 4, which a successful guarded command must not keep. */
function mayStart(verdict) {
  if (!['STARTABLE', 'STACKABLE'].includes(verdict)) return false;
  process.exitCode = 0;
  return true;
}

/** Verdict inputs of one issue, shared by the issue itself and its sub-issues. */
function issueReasons(issue) {
  const status = projectItem(issue)?.status?.name;
  const blocked = [], unknown = [];
  if (issue.state !== 'OPEN') blocked.push('issue is closed');
  if (!projectItem(issue)) unknown.push(`issue is not on ${project.url}`);
  else if (!status) unknown.push('the Project status is unset');
  else if (['Backlog', 'Done'].includes(status)) blocked.push(`status is ${status}`);
  else if (!['Ready', 'In progress', 'Automated review', 'Human review'].includes(status)) unknown.push(`unknown status ${status}`);
  const predecessors = predecessorReasons(issue.blockedBy);
  blocked.push(...predecessors.blocked);
  unknown.push(...predecessors.unknown);
  const waits = waitReasons(issue.body);
  blocked.push(...waits.blocked);
  unknown.push(...waits.unknown);
  return { status, blocked, unknown, predecessors };
}
const verdictOf = ({ blocked, unknown }) => blocked.length ? 'BLOCKED' : unknown.length ? 'UNKNOWN' : 'STARTABLE';
// #N in the project's repository, OWNER/REPO#N elsewhere: a bare number must never name a same-number issue or PR of another repository.
const refOf = (repository, number) => `${repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase() ? '' : repository.nameWithOwner}#${number}`;
const logins = issue => issue.assignees.nodes.map(assignee => assignee.login).join(', ');
const ago = ms => {
  const minutes = Math.max(0, Math.floor(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

/** Without `claims` (status transitions) only the verdict prints; the `check` command adds claim age, PR and sub-issues. Information only. */
function check(issue = readIssue(), claims, currentPrNumber) {
  let current = currentIssuePr(issue);
  if (currentPrNumber !== undefined && !current.unknown && current.number !== currentPrNumber) {
    current = { unknown: `PR #${currentPrNumber} is not the unique open local PR linked to this issue` };
  }
  const { status, blocked, unknown, predecessors } = issueReasons(issue);
  const notes = [];
  let claim;
  if (claims) try {
    const found = claimReasons(issue, claims.session);
    blocked.push(...found.blocked);
    notes.push(...found.notes);
    claim = found.claim;
    if (!claims.session || claim?.session !== claims.session) blocked.push(...workReasons(issue, claims.session));
  } catch (error) { unknown.push(`claim comments are unreadable: ${String(error.stderr || error.message).trim()}`); }
  // Only open predecessors hold the issue (no other blocker, not even a claim or a status): look for the PR to stack on.
  stackedOn = undefined;
  const heldOnlyByOpen = heldOnlyByOpenPredecessors(blocked, predecessors);
  if (current?.unknown && (currentPrNumber !== undefined || heldOnlyByOpen)) {
    unknown.push(current.unknown);
    if (heldOnlyByOpen) blocked.length = 0;
  }
  if (heldOnlyByOpen && !unknown.length) {
    const stack = stackBase(predecessors.open, current?.number);
    if (stack.pr) {
      stackedOn = stack.pr;
      notes.push(...blocked.map(reason => `${reason}; delivered by PR #${stack.pr.number}`));
      blocked.length = 0;
    } else if (stack.unknown.length && !stack.refused.length) {
      unknown.push(...stack.unknown);
      blocked.length = 0;
    // A definitive refusal stays BLOCKED, whatever else is unreadable: a retry cannot lift it.
    } else notes.push(...stack.refused.map(reason => `not stackable: ${reason}`), ...stack.unknown.map(reason => `unreadable: ${reason}`));
  }
  const plain = verdictOf({ blocked, unknown });
  const verdict = stackedOn && plain === 'STARTABLE' ? 'STACKABLE' : plain;
  console.log(`${project.repository}#${issue.number} ${issue.title}\nstatus: ${status ?? '-'}, assignees: ${logins(issue) || 'none'}\n${verdict}`);
  for (const reason of [...blocked, ...unknown]) console.log(`- ${reason}`);
  if (stackedOn) console.log(stackedOn.state === 'MERGED'
    ? `stack base: PR #${stackedOn.number} is already merged into ${stackedOn.baseRefName}: no stack, work on ${stackedOn.baseRefName}; see docs/CONTRIBUTING.md#stacked-pull-requests`
    : `stack base: PR #${stackedOn.number}${stackedOn.stackNumber ? ` in stack #${stackedOn.stackNumber}` : ''} (branch ${stackedOn.headRefName}, base ${stackedOn.baseRefName}); see docs/CONTRIBUTING.md#stacked-pull-requests`);
  for (const note of notes) console.log(`note: ${note}`);
  if (claim) {
    const linked = issue.closedByPullRequestsReferences;
    const prs = linked?.nodes?.filter(pr => pr.state === 'OPEN').map(pr => refOf(pr.repository, pr.number));
    // A list cut at 100 is never presented as complete.
    const cut = linked?.totalCount > linked?.nodes?.length ? ` (first ${linked.nodes.length} of ${linked.totalCount})` : '';
    console.log(`claim: ${ago(Date.now() - Date.parse(claim.comment.created_at))} ago (Session ${claim.session ?? 'unknown'}), open PR: ${prs ? prs.join(', ') || 'none' : 'unknown'}${cut}`);
  }
  if (claims && issue.subIssues?.nodes?.length) {
    if (issue.subIssues.totalCount > issue.subIssues.nodes.length) console.log(`note: ${issue.subIssues.nodes.length} of ${issue.subIssues.totalCount} sub-issues listed`);
    for (const child of issue.subIssues.nodes) {
      console.log(`${refOf(child.repository, child.number)}  ${projectItem(child)?.status?.name ?? '-'}  ${logins(child) || '-'}  ${verdictOf(issueReasons(child))}`);
    }
  }
  // STACKABLE is not 0: a caller that knows only STARTABLE must not start it without the stack rules.
  process.exitCode = { STARTABLE: 0, BLOCKED: 1, UNKNOWN: 2, STACKABLE: 4 }[verdict];
  return verdict;
}

function next() {
  // Advanced issue search understands -is:blocked (open native predecessors). Separate searches keep blocked issues
  // from crowding unblocked ones out of the 1,000-result search cap; read every page of both before sorting. A page costs by its size, not by its hits
  // (4 lists per issue), so it is short: a repository with few open issues pays one point per search.
  const nodes = [];
  for (const blocking of ['-is:blocked', 'is:blocked']) for (let after, read = 0; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:30,after:$after){
      issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{number title body assignees(first:10){nodes{login}}
      blockedBy(first:100){totalCount nodes{${predecessorFields}}}
      issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}
      projectItems(first:100){nodes{project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}
        priority:fieldValueByName(name:"Priority"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}`,
    { q: `repo:${project.repository} is:issue is:open ${blocking}`, ...(after && { after }) });
    nodes.push(...search.nodes);
    read += search.nodes.length;
    if (!search.pageInfo.hasNextPage) {
      assert.ok(read >= search.issueCount, `Search returned ${read} of ${search.issueCount} ${blocking} issues; the list would be incomplete`);
      break;
    }
    assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
    after = search.pageInfo.endCursor;
  }
  // The Priority field's option order is the ranking, whatever the scale (High/Low, P0/P1, …).
  const rank = selectField('Priority').choices.map(choice => choice.name);
  const order = priority => rank.includes(priority) ? rank.indexOf(priority) : rank.length;
  const ready = nodes.map(issue => ({ ...issue, item: projectItem(issue) }))
    .filter(issue => issue.item?.status?.name === 'Ready')
    .map(issue => {
      const predecessors = predecessorReasons(issue.blockedBy), waits = waitReasons(issue.body);
      return { ...issue, predecessors, reasons: [...predecessors.blocked, ...waits.blocked, ...predecessors.unknown, ...waits.unknown], priority: issue.item.priority?.name
        ?? issue.issueFieldValues.nodes.find(field => field.field?.name === 'Priority')?.name };
    })
    .sort((a, b) => order(a.priority) - order(b.priority) || a.number - b.number);
  const line = issue => `#${issue.number} [${issue.priority ?? 'no priority'}] ${issue.title}`
    + ` (assignees: ${issue.assignees.nodes.map(assignee => assignee.login).join(', ') || 'none'})`;
  const startable = ready.filter(issue => !issue.reasons.length);
  // Held only by open predecessors that one open PR delivers: stackable on that PR.
  const candidates = ready.filter(issue => issue.reasons.length && heldOnlyByOpenPredecessors(issue.reasons, issue.predecessors));
  loadDeliveries(candidates.flatMap(issue => issue.predecessors.open));
  const stackable = candidates.map(issue => ({ ...issue, base: stackBase(issue.predecessors.open).pr })).filter(issue => issue.base);
  const held = ready.filter(issue => issue.reasons.length && !stackable.some(candidate => candidate.number === issue.number));
  for (const issue of startable) console.log(line(issue));
  console.log(startable.length ? 'Run board.mjs check ISSUE --session ID before claiming one.' : 'No Ready issue whose blockers are all completed.');
  if (stackable.length) console.log('\nReady and stackable on an open PR (check ISSUE shows STACKABLE; see docs/CONTRIBUTING.md#stacked-pull-requests):');
  for (const issue of stackable) console.log(`${line(issue)}\n  - base PR #${issue.base.number} (${issue.base.state === 'MERGED' ? `merged into ${issue.base.baseRefName}` : `branch ${issue.base.headRefName}`})`);
  if (held.length) console.log('\nReady but not startable:');
  for (const issue of held) console.log([line(issue), ...issue.reasons.map(reason => `  - ${reason}`)].join('\n'));
}

/** A single-select Project field with its options in configured order. The definitions are read once per run, however many fields are looked up. */
let projectFields;
function selectField(fieldName) {
  projectFields ??= graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:100){nodes{...on ProjectV2SingleSelectField{
    id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: project.id })
    .node.fields.nodes.filter(candidate => candidate.name && candidate.options);
  const fields = projectFields;
  const field = fields.find(candidate => candidate.name === fieldName);
  assert.ok(field, `${project.url} has no single-select ${fieldName} field; use one of: ${fields.map(candidate => candidate.name).join(', ')}`);
  // An empty Project option list means the field mirrors an organization issue field.
  const linked = !field.options.length && field.issueField;
  return { field, linked, choices: linked ? linked.options : field.options };
}

/**
 * Put the issue on the Project. A new issue may already have been added by the Project's own automation: GitHub then
 * refuses with "already exists", which is no failure as long as the item can be read afterwards.
 */
function addToProject(issue) {
  try {
    return graphql(`mutation($project:ID!,$content:ID!){addProjectV2ItemById(
      input:{projectId:$project,contentId:$content}){item{id}}}`, { project: project.id, content: issue.id }).addProjectV2ItemById.item.id;
  } catch (error) {
    if (!/already exists in this project/i.test(String(error.stderr ?? ''))) throw error;
    const id = projectItem(readIssue())?.id;
    assert.ok(id, `GitHub reports #${issue.number} as already on the Project, but its item is unreadable`);
    return id;
  }
}

/** Look up a field and option; nothing is printed or written. */
function resolveOption(fieldName, optionName) {
  const { field, linked, choices } = selectField(fieldName);
  const option = choices.find(choice => choice.name.toLowerCase() === String(optionName).toLowerCase());
  assert.ok(option, `${fieldName}: "${optionName}" is not an option; use one of: ${choices.map(choice => choice.name).join(', ')}`);
  return { fieldName, field, linked, option };
}

/** Guards of a transition; a refusal throws. They print (backlinks), so run them only after every pair is valid. */
function guardOption(issue, { fieldName, option }) {
  if (fieldName === 'Status' && option.name === 'In progress') {
    // Assignment first, so a missing assignment is named even when the issue is also blocked.
    const { viewer } = graphql('query{viewer{login}}');
    assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
    assert.ok(issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase()),
      `Assign yourself first: gh issue edit ${number} --repo ${project.repository} --add-assignee "@me". Verify session ownership before assigning.`);
    // A refusal is an error like the others: its verdict lines become the one ERROR line instead of a second output format.
    const log = console.log, verdict = [];
    console.log = (...parts) => verdict.push(parts.join(' '));
    try { if (!mayStart(check(issue))) throw new Error(verdict.join('; ')); } finally { console.log = log; }
  }
  if (fieldName === 'Status' && option.name === 'Automated review') {
    verifyBacklinks();
    // Only a hint, never a refusal: `handoff` refuses these later, and finding out now saves the round trip.
    if (typeof issue.bodyHTML === 'string') for (const line of openAcceptance(issue.bodyHTML)) console.log(`warning: open acceptance in the issue, handoff will refuse it (check it off, or move it to a follow-up and link that issue): ${line}`);
  }
}

function writeOption(issue, { fieldName, field, linked, option }) {
  if (linked) {
    graphql(`mutation($issue:ID!,$field:ID!,$option:ID!){setIssueFieldValue(input:{issueId:$issue,
      issueFields:[{fieldId:$field,singleSelectOptionId:$option}]}){clientMutationId}}`,
    { issue: issue.id, field: linked.id, option: option.id });
  } else {
    let item = projectItem(issue)?.id;
    if (!item) {
      item = addToProject(issue);
      // Later writes of the same call reuse the item instead of adding it again.
      issue.projectItems.nodes.push({ id: item, project: { id: project.id } });
    }
    graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,
      itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
    { project: project.id, item, field: field.id, option: option.id });
  }
  return `${project.repository}#${issue.number} ${fieldName}: ${option.name}`;
}

/** Write a selected field option; guarded delivery can reject the fresh issue before mutation. */
function set(fieldName, optionName = value, beforeWrite) {
  let issue = readIssue();
  const plan = resolveOption(fieldName, optionName);
  guardOption(issue, plan);
  // A guarded handoff rechecks current ownership/readiness after the potentially lengthy review reads.
  if (beforeWrite) {
    issue = beforeWrite();
    if (!issue) return;
  }
  console.log(writeOption(issue, plan));
  return plan.option.name;
}

/** NAME VALUE pairs after the issue; `Status "Automated review" PR [OTHER_ISSUE...]` keeps its own trailing arguments. */
function fieldPairs() {
  const args = process.argv.slice(4);
  if (args[0].toLowerCase() === 'status' && args[1].toLowerCase() === 'automated review') return [args.slice(0, 2)];
  assert.ok(args.length % 2 === 0, 'field takes NAME VALUE pairs: field ISSUE NAME VALUE [NAME VALUE ...]');
  const pairs = Array.from({ length: args.length / 2 }, (_, index) => args.slice(index * 2, index * 2 + 2));
  return pairs;
}

/** Resolve NAME VALUE pairs against the Project's fields; nothing is written. */
function planFields(pairs) {
  assert.equal(new Set(pairs.map(([fieldName]) => fieldName.toLowerCase())).size, pairs.length, 'Each field may appear once per call');
  return pairs.map(([fieldName, optionName]) => resolveOption(fieldName, optionName));
}

/** Any single-select fields: every pair is validated before the first write, then all are read back together so a silent API no-op cannot pass. */
function setField() {
  const issue = readIssue();
  console.log(applyFields(issue, planFields(fieldPairs())).join('\n'));
}

/** Write resolved plans on the issue and read them all back; returns one confirmation line per plan. */
function applyFields(issue, plans) {
  for (const plan of plans) guardOption(issue, plan);
  // Confirmation lines come after the read-back, so a failed call never shows a write as confirmed.
  const written = plans.map(plan => writeOption(issue, plan));
  const { repository } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    issue(number:$number){projectItems(first:100){nodes{project{id} fieldValues(first:100){nodes{
      ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}
    issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}}`,
  { owner, name, number });
  const values = [...projectItem(repository.issue)?.fieldValues.nodes ?? [], ...repository.issue.issueFieldValues.nodes];
  for (const { fieldName, option } of plans) {
    const stored = values.find(entry => entry?.field?.name === fieldName)?.name;
    assert.equal(stored, option.name, `Read-back of ${fieldName} shows ${stored ?? 'no value'}`);
  }
  return written;
}

/** Flags of `new`; unknown or repeated single flags are errors, never ignored. */
function newOptions(args) {
  const given = {}, single = ['--title', '--body-file', '--milestone', '--priority', '--agent', '--session'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--start') { given[flag] = [true]; continue; }
    assert.ok([...single, '--label', '--field'].includes(flag), `new: unknown option ${flag}`);
    const text = args[++index];
    assert.ok(text !== undefined && !text.startsWith('--'), `new: ${flag} needs a value`);
    (given[flag] ??= []).push(text);
  }
  for (const flag of single) assert.ok((given[flag]?.length ?? 0) <= 1, `new: ${flag} may appear once`);
  const [title, bodyFile, milestone, priority, agent, session] = single.map(flag => given[flag]?.[0]);
  const start = Boolean(given['--start']);
  const fields = (given['--field'] ?? []).map(pair => {
    const split = pair.indexOf('=');
    assert.ok(split > 0 && split < pair.length - 1, `new: --field wants NAME=VALUE, got "${pair}"`);
    return [pair.slice(0, split), pair.slice(split + 1)];
  });
  return { title, bodyFile, milestone, priority, agent, session, start, fields, labels: given['--label'] ?? [] };
}

/**
 * One issue to create, every value checked and resolved before anything exists: body, Project fields (all of them against one read
 * of the field definitions), milestone and labels. `status` is the Status the command sets (Backlog; Ready first with --start).
 */
let repositoryLists;
function planNew({ title, bodyFile, milestone, priority, labels: wanted, fields }, status = 'Backlog') {
  for (const [what, text] of [['title', title], ['body file', bodyFile], ['milestone', milestone], ['priority', priority]]) assert.ok(text, `${what} is required`);
  assert.ok(wanted.length, 'at least one label is required');
  const text = readFileSync(bodyFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  assert.ok(text, `${bodyFile} is empty`);
  assert.ok(!fields.some(([fieldName]) => ['status', 'priority'].includes(fieldName.toLowerCase())), 'Status and Priority are not field values (give the priority; the command sets Status)');
  const pairs = [['Status', status], ['Priority', priority], ...fields];
  for (const required of project.requiredFields ?? []) {
    assert.ok(pairs.some(([fieldName]) => fieldName.toLowerCase() === required.toLowerCase()), `the project requires ${required}: give a value for it`);
  }
  const plans = planFields(pairs);
  repositoryLists ??= { milestones: restAll(`repos/${project.repository}/milestones`), labels: restAll(`repos/${project.repository}/labels`) };
  const exact = (list, name, key) => list.find(item => item[key].toLowerCase() === name.toLowerCase());
  const found = exact(repositoryLists.milestones, milestone, 'title');
  assert.ok(found, `${project.repository} has no open milestone "${milestone}"`);
  // The REST API would silently create an unknown label.
  // A repeated label (any casing) is one label: GitHub stores it once, and the read-back compares exactly.
  const labels = [...new Set(wanted.map(label => exact(repositoryLists.labels, label, 'name')?.name ?? assert.fail(`${project.repository} has no label "${label}"`)))];
  return { title, text, plans, milestone: found, labels };
}

/** The REST call that creates the issue (no GraphQL point). A lost or unreadable answer does not prove that nothing was created. */
function post({ title, text, milestone, labels }, assignees) {
  try {
    const created = JSON.parse(execFileSync(gh.file, ['api', `repos/${project.repository}/issues`, '-X', 'POST', '--input', '-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: JSON.stringify({ title, body: text, milestone: milestone.number, labels, ...assignees && { assignees } }) }));
    assert.ok(Number.isSafeInteger(created?.number) && created.html_url && created.node_id, 'GitHub did not report the new issue');
    return created;
  } catch (error) {
    throw new Error(`creating the issue failed (${String(error.stderr || error.message).trim()}); it may exist anyway: search ${project.repository} for "${title}" before trying again`, { cause: error });
  }
}

/** The milestone, labels and (with `viewer`) assignee GitHub stored. */
function readBackIssue(created, { milestone, labels }, viewer) {
  const stored = rest(`repos/${project.repository}/issues/${created.number}`);
  assert.equal(stored.milestone?.title, milestone.title, `Read-back of the milestone shows ${stored.milestone?.title ?? 'none'}`);
  assert.deepEqual(stored.labels.map(label => label.name).sort(), [...labels].sort(), 'Read-back of the labels differs');
  if (viewer) assert.ok(stored.assignees.some(assignee => assignee.login.toLowerCase() === viewer.toLowerCase()), 'Read-back of the assignee differs');
}

/** The one-line result of `new`. Later plans replace earlier ones of the same field (Status: Ready, then In progress). */
const newLine = (created, { milestone, labels, plans }, ...more) => [`NEW ${created.html_url}`, `milestone: ${milestone.title}`, `labels: ${labels.join(', ')}`,
  ...Object.entries(Object.fromEntries(plans.map(plan => [plan.fieldName, plan.option.name]))).map(([fieldName, value]) => `${fieldName}: ${value}`), ...more].join(' | ');

// GitHub cuts a request off after 10 seconds. Measured on 2026-10-07: 50 aliased Project writes took 2 to 3 seconds, 100 took 3 to 4.
// ponytail: 50 stays well inside that and below any size seen to fail; raise it only when a measured batch needs fewer requests.
const mutationsPerRequest = 50;
// GitHub's ids and field options are plain text: a JSON string is a valid GraphQL string.
const quoted = JSON.stringify;

/**
 * Mutations in as many aliased requests as `mutationsPerRequest` needs; the answers are keyed `m0`, `m1`, … in the order of `calls`.
 * `tolerate`: see graphql().
 */
function mutateAll(calls, tolerate) {
  const results = {};
  for (let from = 0; from < calls.length; from += mutationsPerRequest) {
    const chunk = calls.slice(from, from + mutationsPerRequest).map((call, index) => `m${from + index}:${call}`);
    Object.assign(results, graphql(`mutation{${chunk.join(' ')}}`, {}, tolerate));
  }
  return results;
}

// GitHub also refuses a request by its cost ("Resource limits for this query exceeded"): 13 issues in one request failed on 2026-10-07.
// ponytail: 5 issues per request is a guess below that point; a refused block is halved down to one issue, so raise it only when measured.
const issuesPerRequest = 5;
const resourceLimit = /Resource limits for this query exceeded/i;

/** Run `step` on the rows; GitHub's cost limit halves the block and tries each half again, down to one row, which `refused` names. */
function inBlocks(rows, step, refused, size = issuesPerRequest) {
  for (let from = 0; from < rows.length; from += size) shrink(rows.slice(from, from + size), step, refused);
}
function shrink(block, step, refused) {
  try { step(block); } catch (error) {
    if (!resourceLimit.test(`${error.stderr}${error.stdout}`)) throw error;
    if (block.length === 1) return refused(block[0]);
    const half = Math.ceil(block.length / 2);
    shrink(block.slice(0, half), step, refused);
    shrink(block.slice(half), step, refused);
  }
}

/**
 * Put freshly created issues on the Project and write their fields in blocks of `issuesPerRequest` issues: per block one request
 * to add them, one to write every value, one to read every value back. `rows`: { id: issue node id, number, plans }.
 * An issue whose fields are not all written and read back (even alone GitHub refuses it, or a value differs) is not skipped:
 * the failure lists every such issue with the `field` command that finishes it.
 */
function setFields(rows) {
  const todo = new Map(); // row -> [{ plan, why }]
  const miss = (row, plan, why) => todo.set(row, [...todo.get(row) ?? [], { plan, why }]);
  const refuse = (what, row) => row.plans.forEach(plan => miss(row, plan, `GitHub refuses ${what} of #${row.number} even alone ("Resource limits for this query exceeded")`));
  inBlocks(rows, writeBlock, row => refuse('the write', row));
  inBlocks(rows.filter(row => !todo.has(row)), readBlock(miss), row => refuse('the read-back', row));
  const word = text => /^[^\s"]+$/.test(text) ? text : quoted(text);
  assert.ok(!todo.size, [...todo].map(([row, misses]) => `${[...new Set(misses.map(({ why }) => why))].join('; ')}; finish it with: board.mjs field ${row.number} ${
    [...new Map(misses.map(({ plan }) => [plan.fieldName, plan.option.name]))].flat().map(word).join(' ')}`).join(' | '));
}

/** The Project item and the values of one block of rows. */
function writeBlock(rows) {
  const onProject = rows.filter(row => !row.item && row.plans.some(plan => !plan.linked));
  // The Project's own automation may have added an issue already: GitHub then refuses that one with "already exists", which is
  // no failure as long as its item can be read.
  const added = mutateAll(onProject.map(row => `addProjectV2ItemById(input:{projectId:${quoted(project.id)},contentId:${quoted(row.id)}}){item{id}}`),
    /already exists in this project/i);
  onProject.forEach((row, index) => { row.item = added[`m${index}`]?.item.id; });
  const raced = onProject.filter(row => !row.item);
  if (raced.length) {
    const { nodes } = graphql(`query{nodes(ids:${quoted(raced.map(row => row.id))}){...on Issue{projectItems(first:100){nodes{id project{id}}}}}}`);
    raced.forEach((row, index) => {
      row.item = nodes[index]?.projectItems.nodes.find(item => item.project.id === project.id)?.id;
      assert.ok(row.item, `GitHub reports #${row.number} as already on the Project, but its item is unreadable`);
    });
  }
  mutateAll(rows.flatMap(row => row.plans.map(({ field, linked, option }) => linked
    ? `setIssueFieldValue(input:{issueId:${quoted(row.id)},issueFields:[{fieldId:${quoted(linked.id)},singleSelectOptionId:${quoted(option.id)}}]}){clientMutationId}`
    : `updateProjectV2ItemFieldValue(input:{projectId:${quoted(project.id)},itemId:${quoted(row.item)},fieldId:${quoted(field.id)},value:{singleSelectOptionId:${quoted(option.id)}}}){projectV2Item{id}}`)));
}

/** Read one block back by id, so a silent API no-op cannot pass; a value that differs goes to `miss`. The read costs by the number of ids, not by the 100-value limits of an issue's lists. */
const readBlock = miss => rows => {
  const onProject = rows.filter(row => row.plans.some(plan => !plan.linked));
  const onIssue = rows.filter(row => row.plans.some(plan => plan.linked));
  const read = graphql(`query{
    ${onProject.length ? `items:nodes(ids:${quoted(onProject.map(row => row.item))}){...on ProjectV2Item{fieldValues(first:100){nodes{
      ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}` : ''}
    ${onIssue.length ? `issues:nodes(ids:${quoted(onIssue.map(row => row.id))}){...on Issue{issueFieldValues(first:100){nodes{
      ...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}` : ''}}`);
  for (const row of rows) {
    const values = [...read.items?.[onProject.indexOf(row)]?.fieldValues.nodes ?? [], ...read.issues?.[onIssue.indexOf(row)]?.issueFieldValues.nodes ?? []];
    for (const plan of row.plans) {
      const stored = values.find(entry => entry?.field?.name === plan.fieldName)?.name;
      if (stored !== plan.option.name) miss(row, plan, `Read-back of ${plan.fieldName} on #${row.number} shows ${stored ?? 'no value'}`);
    }
  }
};

/**
 * Create an issue with everything the workflow requires and read every value back. All inputs are checked before the
 * issue exists (Project fields, milestone, labels, start prerequisites); a failure after it names the issue so it is
 * finished by hand, never created twice. `--start` then runs the start steps: Ready, assignee, claim, In progress.
 * `--from FILE` creates a whole list instead (createMany).
 */
function create() {
  const args = process.argv.slice(3);
  if (args[0] === '--from') return createMany(args.slice(1));
  const options = newOptions(args);
  const { agent, session, start } = options;
  if (start) {
    assert.ok(['claude', 'codex'].includes(agent) && /^\w[\w.-]*$/.test(session ?? ''), 'new: --start needs --agent claude|codex and --session ID (the claim comment)');
  } else assert.ok(!agent && !session, 'new: --agent and --session belong to --start');
  // Status is set by the command: Backlog, or Ready then In progress with --start.
  const plan = named('new', () => planNew(options, start ? 'Ready' : 'Backlog'));
  const progress = start ? planFields([['Status', 'In progress']]) : [];
  let viewer;
  if (start) {
    viewer = graphql('query{viewer{login}}').viewer?.login;
    assert.ok(viewer, 'Cannot verify the authenticated GitHub user');
    const waits = waitReasons(plan.text);
    assert.ok(!waits.blocked.length && !waits.unknown.length, `new: the issue would not be startable: ${[...waits.blocked, ...waits.unknown].join('; ')}`);
  }
  const created = post(plan, start && [viewer]);
  number = created.number;
  let step = 'reading it back';
  try {
    readBackIssue(created, plan, viewer);
    step = 'setting the Project fields';
    setFields([{ id: created.node_id, number, plans: plan.plans }]);
    let claim;
    if (start) {
      step = 'posting the claim comment';
      execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${number}/comments`, '-X', 'POST', '-F', 'body=@-'],
        { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: `Agent: ${agent}, Session: ${session}\n` });
      const read = claimReasons({ number }, session);
      assert.ok(!read.blocked.length && read.claim?.session === session, 'Claim comment read-back differs');
      claim = read.claim.comment.html_url;
      step = 'setting In progress';
      applyFields(readIssue(), progress);
    }
    console.log(newLine(created, { ...plan, plans: [...plan.plans, ...progress] }, ...start ? [`assignee: ${viewer}`, `claim: ${claim}`] : []));
  } catch (error) {
    throw new Error(`${created.html_url} was created, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field/status, do not create it again`, { cause: error });
  }
}

// ponytail: 50 issues per file stay far below GitHub's limit for creating content (80 a minute); split a longer list by hand.
const manyLimit = 50;
const entryKeys = ['title', 'bodyFile', 'milestone', 'priority', 'labels', 'fields'];

/**
 * `new --from FILE`: FILE is a JSON list of `{ title, bodyFile, milestone, priority, labels: [..], fields: { NAME: VALUE } }`
 * (the flags of a single `new`; the Status is Backlog). Every entry is checked before the first issue exists, so one bad entry
 * creates nothing. The issues are created over REST, then all of them get their Project fields in blocks of issues
 * (setFields), and one line per issue is printed after everything was read back. Later failures name every issue that exists.
 */
function createMany([file, ...extra]) {
  assert.ok(file && !file.startsWith('--') && !extra.length, 'new --from takes one FILE and no other option');
  const list = named(`new --from: ${file}`, () => JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(Array.isArray(list) && list.length && list.length <= manyLimit, `new --from: ${file} must hold a JSON list of 1 to ${manyLimit} issues`);
  const plans = list.map((entry, index) => named(`new --from: entry ${index + 1}${typeof entry?.title === 'string' ? ` "${entry.title}"` : ''}`, () => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'an entry is an object');
    const unknown = Object.keys(entry).filter(key => !entryKeys.includes(key));
    assert.ok(!unknown.length, `unknown key ${unknown.join(', ')}; the keys are ${entryKeys.join(', ')}`);
    const { labels = [], fields = {} } = entry;
    assert.ok(['title', 'bodyFile', 'milestone', 'priority'].every(key => entry[key] === undefined || typeof entry[key] === 'string'), 'title, bodyFile, milestone and priority are text');
    assert.ok(Array.isArray(labels) && labels.every(label => typeof label === 'string'), 'labels is a list of label names');
    assert.ok(fields && typeof fields === 'object' && !Array.isArray(fields) && Object.values(fields).every(value => typeof value === 'string'), 'fields is an object of NAME: VALUE');
    return planNew({ ...entry, labels, fields: Object.entries(fields) });
  }));
  const made = [];
  const known = () => made.length ? `${made.length} of ${plans.length} issues exist: ${made.map(({ created }) => created.html_url).join(' ')}` : 'none was created';
  try {
    for (const plan of plans) made.push({ plan, created: post(plan) });
  } catch (error) {
    throw new Error(`${error.message}; ${known()}; create only the missing ones, never an existing one again`, { cause: error });
  }
  let step = 'reading them back';
  try {
    for (const { created, plan } of made) readBackIssue(created, plan);
    step = 'setting the Project fields';
    setFields(made.map(({ created, plan }) => ({ id: created.node_id, number: created.number, plans: plan.plans })));
    console.log(made.map(({ created, plan }) => newLine(created, plan)).join('\n'));
  } catch (error) {
    throw new Error(`${known()}, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field/status, do not create them again`, { cause: error });
  }
}

// Reviewers run unreliably, so only traces on the current head count (docs/CONTRIBUTING.md#review-loop).
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number state isDraft createdAt headRefName headRefOid baseRefName mergeStateStatus reviewDecision isCrossRepository headRepository{nameWithOwner}${project.selfReview === undefined ? '' : ' bodyHTML'}
  readyEvents:timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  firstReadyEvents:timelineItems(first:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  convertEvents:timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}
  latestOpinionatedReviews(first:100){totalCount nodes{state author{login}}}
  reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{url}}}}
  commits(last:1){nodes{commit{oid committedDate checkSuites(first:100){totalCount nodes{createdAt status conclusion app{slug} workflowRun{databaseId workflow{id}} checkRuns(first:1){totalCount}}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title detailsUrl checkSuite{databaseId createdAt app{slug} workflowRun{databaseId event workflow{id name}}}}
      ...on StatusContext{context state description creator{login}}}}}}}}
  reviewRequests(first:100){totalCount nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
  requestEvents:timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT]){totalCount nodes{...on ReviewRequestedEvent{createdAt
    requestedReviewer{...on User{login} ...on Bot{login} ...on Team{name}}}}}}}}`;
// ponytail: checks, check suites, review requests and opinionated reviews stop at 100 with ERROR, never a wrong verdict; paginate when a project gets there.

/** Links of unresolved review threads across every page, including findings on earlier heads. */
function unresolvedThreads(prNumber = number, firstPage) {
  const links = [];
  for (let after; ;) {
    const reviewThreads = firstPage ?? graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
        nodes{isResolved comments(first:1){nodes{url}}}}}}}`,
    { owner, name, number: prNumber, ...(after && { after }) }).repository.pullRequest.reviewThreads;
    firstPage = undefined;
    links.push(...reviewThreads.nodes.filter(thread => !thread.isResolved).map(thread => thread.comments.nodes[0]?.url ?? 'unreadable thread'));
    if (!reviewThreads.pageInfo.hasNextPage) return links;
    assert.ok(reviewThreads.pageInfo.endCursor && reviewThreads.pageInfo.endCursor !== after, 'Thread pagination did not advance');
    after = reviewThreads.pageInfo.endCursor;
  }
}
const rest = path => JSON.parse(execFileSync(gh.file, ['api', path], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, stdio: 'pipe' }));
/** Every page, so an early bot summary on a long PR is never cut off. */
function restAll(path, expected) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = rest(`${path}?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch) && batch.length <= 100, 'Unreadable REST page');
    items.push(...batch);
    assert.ok(expected === undefined || items.length <= expected, 'More comments than declared; retry the read');
    if (batch.length < 100) return items;
  }
}

/** Every comment of an open issue, complete and unique, or an exception: a partial list must never read as "no backlink". */
function issueComments(repository, issueNumber) {
  const issue = rest(`repos/${repository}/issues/${issueNumber}`);
  assert.ok(issue?.number === issueNumber && issue.state === 'open' && !issue.pull_request,
    `#${issueNumber} is not an open issue`);
  assert.ok(Number.isSafeInteger(issue.comments) && issue.comments >= 0, 'Issue comment count is unreadable');
  const comments = restAll(`repos/${repository}/issues/${issueNumber}/comments`, issue.comments);
  assert.equal(comments.length, issue.comments, `Not every comment on #${issueNumber} is readable; retry the read`);
  assert.ok(comments.every(comment => Number.isSafeInteger(comment?.id) && typeof comment.body === 'string'), 'Unreadable issue comment');
  assert.equal(new Set(comments.map(comment => comment.id)).size, comments.length, 'Duplicate comment page');
  return comments;
}

/** The comment that `status ... "Automated review"` accepts: it names the PR's full URL, whatever surrounds it. Shared by that guard and `link`. */
const findBacklink = (comments, prUrl) => comments.find(comment => (comment.body.match(/https?:\/\/[^\s<>()[\]`"']+/g) ?? []).some(link => {
  try {
    const target = new URL(link.replace(/[.,;:!?]+$/, ''));
    return target.origin === prUrl.origin && target.pathname.replace(/\/$/, '') === prUrl.pathname;
  } catch { return false; } // An unrelated malformed URL is not a backlink.
}));

/** Explicit scope works with Refs on release branches; native closing links remain a separate proof. */
function verifyBacklinks() {
  const [prRef, ...extraIssues] = process.argv.slice(command === 'field' ? 6 : 5);
  assert.ok(prRef !== undefined, 'Automated review needs the PR number: status ISSUE "Automated review" PR [OTHER_ISSUE...]');
  const positive = ref =>/^\d+$/.test(ref ?? '') && Number.isSafeInteger(Number(ref)) && Number(ref) > 0;
  assert.ok(positive(prRef) && extraIssues.every(ref => validBlocker(ref) && positive(ref.slice(ref.lastIndexOf('#') + 1))),
    'Automated review requires PR [OTHER_ISSUE...]; post and read back every issue backlink first.');
  const prNumber = Number(prRef);
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number url state body}}}`, { owner, name, number: prNumber }).repository;
  assert.ok(pr?.number === prNumber && pr.state === 'OPEN' && typeof pr.body === 'string', 'The declared PR is not open/readable');
  const url = new URL(pr.url);
  assert.equal(url.pathname, `/${project.repository}/pull/${prNumber}`, 'PR belongs to another repository');
  const scope = new Set([`${project.repository}#${number}`, ...extraIssues.map(ref =>
    `${blockerRepository(ref)}#${Number(ref.slice(ref.lastIndexOf('#') + 1))}`)]);
  for (const issueRef of scope) {
    const repository = blockerRepository(issueRef), issueNumber = Number(issueRef.slice(issueRef.lastIndexOf('#') + 1));
    const qualifier = `(?:${RegExp.escape(repository)})${repository === project.repository ? '?' : ''}`;
    const reference = new RegExp(`(?<![\\w/])${qualifier}#${issueNumber}(?!\\w)`, 'i');
    assert.ok(reference.test(pr.body), `PR #${prNumber} does not reference ${issueRef}`);
    let backlink = findBacklink(issueComments(repository, issueNumber), url);
    // An issue of this repository gets what `link` does (native connection and comment, read back); only a failure refuses.
    if (!backlink && repository === project.repository) {
      linkIssue(issueNumber, prNumber);
      backlink = findBacklink(issueComments(repository, issueNumber), url);
    }
    assert.ok(backlink, `Missing backlink to ${pr.url} on #${issueNumber}; post the full URL as a comment and retry`);
    console.log(`backlink ${issueRef}: ${backlink.html_url}`);
  }
}
const login = user => user?.login?.replace(/\[bot\]$/, '');
const isBot = user => user?.type === 'Bot';
// "optionalReviewers" lists bot logins or app slugs whose traces are shown but never awaited, stalled or counted as red
// (a review bot on a free plan that is rate limited most of the time). Their open threads and change requests still block; `handoff` dismisses a change request once all threads are resolved.
const reviewerKey = name => name?.trim().toLowerCase().replace(/^(@|app\/)/, '').replace(/\[bot\]$/, '');
// Read on use, so a malformed list is an ERROR of the review commands, not a crash of every command.
const optionalReviewers = () => {
  const list = project.optionalReviewers === undefined ? [] : project.optionalReviewers; // only a missing field is allowed; null is malformed
  assert.ok(Array.isArray(list) && list.every(name => typeof name === 'string' && name.trim()),
    'optionalReviewers must be a list of non-empty bot logins or app slugs');
  return new Set(list.map(reviewerKey));
};
let optional;
const isOptional = name => (optional ??= optionalReviewers()).has(reviewerKey(name));
const isOptionalCheck = check => isOptional(check.checkSuite?.app?.slug ?? check.creator?.login);
const passed = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const readPr = prNumber => graphql(prQuery, { owner, name, number: prNumber }).repository.pullRequest;
// The token goes only to these hosts, whatever URL a check run names.
const sonarHosts = ['https://sonarcloud.io', 'https://sonarqube.us'];
const sonarListed = 10; // findings printed per analysis; the count says how many more
/**
 * OPEN and CONFIRMED issues of the pull request analysis a SonarCloud check run points at. The anonymous API reports 0
 * for private projects, so a missing token or a failed read throws (never "clean"). Sync like the other reads: the
 * request runs in a child process.
 */
function sonarIssues(detailsUrl, prNumber) {
  const target = new URL(detailsUrl ?? 'invalid:');
  const key = target.searchParams.get('id');
  assert.ok(sonarHosts.includes(target.origin) && key && target.searchParams.get('pullRequest') === String(prNumber),
    `The SonarCloud check does not link PR #${prNumber}'s analysis (${detailsUrl}); open issues are unreadable`);
  assert.ok(process.env.SONAR_TOKEN, 'Set SONAR_TOKEN: without it the Sonar API reports 0 issues for private projects, so open issues are unreadable');
  const api = new URL('/api/issues/search', target.origin);
  api.search = new URLSearchParams({ componentKeys: key, pullRequest: String(prNumber), issueStatuses: 'OPEN,CONFIRMED', ps: String(sonarListed) });
  const body = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const r = await fetch(process.argv[1], { headers: { Authorization: 'Bearer ' + process.env.SONAR_TOKEN } });
     if (!r.ok) throw new Error('Sonar API answered ' + r.status);
     process.stdout.write(await r.text());`, api.href], { encoding: 'utf8', maxBuffer: 16 << 20 });
  const { total, issues } = JSON.parse(body);
  assert.ok(Number.isSafeInteger(total) && total >= 0 && Array.isArray(issues), 'Sonar issue count is unreadable');
  // One line each, so a finding is fixable without a script of its own. The message quotes code of the PR: no control characters.
  const lines = issues.slice(0, sonarListed).map(({ rule, component, line, message }) => {
    const file = String(component ?? '').replace(`${key}:`, '');
    return `sonar: ${rule} ${file}${line ? `:${line}` : ''} ${String(message ?? '').replace(/\p{Cc}+/gu, ' ')}`;
  });
  if (total > lines.length) lines.push(`sonar: … ${total - lines.length} more`);
  return { total, lines };
}

function pushLog(pr) {
  const log = rest(`repos/${project.repository}/activity?ref=${encodeURIComponent(`refs/heads/${pr.headRefName}`)}&per_page=100`);
  assert.ok(Array.isArray(log), 'Push log is unreadable');
  return log;
}

/** Distinct heads pushed after the PR first became ready; the head that set Ready is no correction, a force-push counts as one push. Null while there was no Ready.
 * ponytail: the log is the newest 100 pushes and a PR opened ready that was converted to Draft and readied again counts from its second Ready; replace when the timeline lists pushes. */
function correctionPushes(pr, pushes) {
  const first = pr.firstReadyEvents?.nodes?.[0]?.createdAt ?? (pr.isDraft ? undefined : pr.createdAt);
  if (!first) return null;
  const since = Date.parse(first);
  assert.ok(Number.isFinite(since), 'The first Ready time is unreadable');
  const log = pushes().filter(entry => !/^0+$/.test(entry.after));
  // The head that set Ready is the latest push up to the Ready event; pushing back to it later is no new head.
  const atReady = log.filter(entry => Date.parse(entry.timestamp) <= since).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]?.after;
  return new Set(log.filter(entry => Date.parse(entry.timestamp) > since && entry.after !== atReady).map(entry => entry.after)).size;
}

/** When the branch was set to the head. A commit pushed earlier to another branch has older check suites and commit date, so only the ref's push log dates it. */
function headSetAt(pr, log = pushLog(pr)) {
  // The same commit can be pushed twice (X, Y, X again); the latest push counts, whatever the order.
  const pushes = log.filter(entry => entry.after === pr.headRefOid);
  assert.ok(pushes.length, 'Push time of the head is not readable; retry the read');
  const time = Math.max(...pushes.map(entry => Date.parse(entry.timestamp)));
  assert.ok(Number.isFinite(time), 'Push time of the head is unreadable');
  return time;
}

/** Commits the base gained since the PR's merge-base and the files both sides changed; null while the base has not moved.
 * ponytail: compare lists the first 300 changed files only (GitHub's cap, all on page 1) and renames match by their new name; replace when a miss costs a CI run. */
function baseMovement(pr) {
  assert.ok(pr.baseRefName, 'The PR base is not readable');
  // A branch may contain "#" or "?"; "/" stays a separator. per_page=1 keeps the commit list short, the file list is not paged.
  const ref = pr.baseRefName.split('/').map(encodeURIComponent).join('/');
  const compare = basehead => rest(`repos/${project.repository}/compare/${basehead}?per_page=1`);
  const { behind_by: behind, files: own = [] } = compare(`${ref}...${pr.headRefOid}`);
  assert.ok(Number.isSafeInteger(behind), 'The base comparison is unreadable');
  if (!behind) return null;
  const base = new Set((compare(`${pr.headRefOid}...${ref}`).files ?? []).map(file => file.filename));
  return { behind, shared: own.map(file => file.filename).filter(file => base.has(file)) };
}
const filesText = files => files.slice(0, 10).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');

/** One look at the PR head: done or still waiting, and whether CI failed; read failures throw (`dismissStale`, handoff only, is the one write). `threadsOf` reads the unresolved threads (wait reuses the last answer). */
function reviews(stallMinutes = 20, now = Date.now(), prNumber = number, pr = readPr(prNumber), graceMinutes = graceOption(), threadsOf = current => unresolvedThreads(current.number, current.reviewThreads), dismissStale = false) {
  isOptional(); // a malformed "optionalReviewers" fails here, whatever the head looks like
  const lines = [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`];
  // Closed without merge ends the wait but is never a delivery.
  if (pr.state !== 'OPEN') return { done: true, failed: pr.state === 'CLOSED', lines, pr };
  const { commit } = pr.commits.nodes[0];
  assert.equal(commit.oid, pr.headRefOid, 'Head commit not readable');
  // CI starts on push, so the first check suite dates the push. Before that the commit date is a
  // conservative lower bound: it can only add traces, never hide one.
  assert.equal(commit.checkSuites.nodes.length, commit.checkSuites.totalCount, 'Not every check suite is readable');
  // A bot sees the head through the same push event that opens the suites, so no trace predates them.
  const suites = commit.checkSuites.nodes.map(suite => Date.parse(suite.createdAt));
  const pushed = suites.length ? Math.min(...suites) : Date.parse(commit.committedDate);
  const after = time => Date.parse(time) >= pushed;
  let log;
  const pushes = () => log ??= pushLog(pr);
  const stalled = since => now - since > stallMinutes * 60_000; // false for Infinity
  const waiting = [];
  let failed = false;
  const contexts = commit.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
  assert.equal(contexts.nodes.length, contexts.totalCount, 'Not every check is readable');
  // The usual Draft-then-Ready sequence starts a second workflow run on the same commit and cancels the first, so the
  // first run's jobs are superseded. A job (app, workflow id, name) is superseded only by the same job of a NEWER run,
  // never by another job of its own run: two jobs of one run that share a display name both count, and so does a
  // newest run that is cancelled. The workflow is told apart by its id (two files can share a display name). A check
  // without a run or suite id cannot be ordered and stays as it is.
  const runOf = check => check.checkSuite?.workflowRun?.databaseId ?? check.checkSuite?.databaseId;
  const jobKey = check => JSON.stringify([check.checkSuite?.app?.slug, check.checkSuite?.workflowRun?.workflow?.id, check.name]);
  const orderable = check => check.__typename === 'CheckRun' && Number.isSafeInteger(runOf(check));
  // A SKIPPED run executed nothing, so it proves nothing and replaces nothing: a job's verdict is that of its newest run that
  // is not SKIPPED (a cancelled or failed earlier run stays the verdict, a real retry decides). Only a job whose runs were
  // all SKIPPED counts as skipped, which is how an optional job looks.
  const newestSkipped = new Map(), newestExecuted = new Map();
  for (const check of contexts.nodes.filter(orderable)) {
    const newest = check.conclusion === 'SKIPPED' ? newestSkipped : newestExecuted;
    newest.set(jobKey(check), Math.max(newest.get(jobKey(check)) ?? -Infinity, runOf(check)));
  }
  const decisiveRun = check => newestExecuted.get(jobKey(check)) ?? newestSkipped.get(jobKey(check));
  const current = contexts.nodes.filter(check => !orderable(check) || runOf(check) === decisiveRun(check));
  for (const check of current.filter(check => orderable(check) && newestSkipped.get(jobKey(check)) > runOf(check))) {
    lines.push(`note: ${check.name} was SKIPPED in a newer run, which proves nothing; run ${runOf(check)} decides`);
  }
  for (const check of current) {
    const label = check.name ?? check.context;
    const pending = check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(check.state);
    // An optional reviewer's check is shown and never decides: not awaited, not red.
    if (isOptionalCheck(check)) {
      lines.push(`check ${label}: ${pending ? 'pending' : check.conclusion ?? check.state}${check.title || check.description ? ` (${check.title || check.description})` : ''} [optional reviewer, not awaited]`);
      continue;
    }
    // CI never stalls: a running check is not success however long it takes.
    if (pending) { waiting.push({ text: `check ${label}`, since: Infinity }); continue; }
    const result = check.conclusion ?? check.state;
    if (!passed.has(result)) failed = true;
    // Descriptions carry results such as "Review rate limited" behind a green state.
    lines.push(`check ${label}: ${result}${check.title || check.description ? ` (${check.title || check.description})` : ''}`);
  }
  if (contexts.nodes.every(isOptionalCheck)) waiting.push({ text: 'first CI check', since: Infinity });
  // An Actions suite without runs is a triggered workflow about to report. Other apps (Sonar, CodeRabbit,
  // Renovate …) open a suite on every push and often never run it, so they count only when the project
  // lists them in "awaitApps" (analyzers such as SonarCloud create their run only when finished). Both may stall.
  const awaited = new Set(['github-actions', ...project.awaitApps ?? []].filter(slug => !isOptional(slug)));
  // A suite of a NEWER run of the same workflow replaces an empty one (Draft then Ready cancels the first run before it
  // reports). The replacing suite then answers for the workflow with its own status and conclusion, runs or not: its
  // check runs alone would show only the jobs reported so far. Another workflow or app never replaces it.
  const suiteFlow = suite => JSON.stringify([suite.app?.slug, suite.workflowRun?.workflow?.id]);
  const suiteRun = suite => suite.workflowRun?.databaseId;
  const newestSuiteRun = new Map();
  for (const suite of commit.checkSuites.nodes.filter(suite => Number.isSafeInteger(suiteRun(suite)))) {
    newestSuiteRun.set(suiteFlow(suite), Math.max(newestSuiteRun.get(suiteFlow(suite)) ?? -Infinity, suiteRun(suite)));
  }
  const empty = suite => !suite.checkRuns.totalCount;
  const replaced = suite => Number.isSafeInteger(suiteRun(suite)) && suiteRun(suite) < newestSuiteRun.get(suiteFlow(suite));
  const replacedEmpty = new Set(commit.checkSuites.nodes.filter(suite => awaited.has(suite.app?.slug) && empty(suite) && replaced(suite)).map(suiteFlow));
  for (const suite of commit.checkSuites.nodes.filter(suite => awaited.has(suite.app?.slug) && !replaced(suite) && (empty(suite) || replacedEmpty.has(suiteFlow(suite))))) {
    // A suite with runs is judged by CI that never stalls; an empty one is a workflow that may never report.
    if (suite.status !== 'COMPLETED') waiting.push({ text: `check suite ${suite.app.slug}${empty(suite) ? ' without runs' : ' still running'}`, since: empty(suite) ? Date.parse(suite.createdAt) : Infinity });
    // A workflow that fails to start (STARTUP_FAILURE) completes its suite without any run to show it.
    else if (!passed.has(suite.conclusion)) {
      failed = true;
      lines.push(`check suite ${suite.app.slug}: ${suite.conclusion}`);
    }
  }
  // The review loop stops pushing after two corrections (docs/CONTRIBUTING.md#review-loop); nothing enforces it, so say where the PR stands.
  // It is read before the red verdict, because a red head is when the next correction is weighed.
  try {
    const corrections = correctionPushes(pr, pushes);
    if (corrections !== null) {
      lines.push(`correction pushes after ready: ${corrections}`);
      if (corrections >= 2) lines.push('cap reached: collect non-blocking findings in one follow-up issue');
    }
  } catch (error) {
    // The count is information only: an unreadable one never changes the verdict (neither red into ERROR nor green into ERROR).
    lines.push(`note: correction pushes unreadable (${error.message})`);
  }
  // The base moves whenever other PRs merge; one merge before the next push is cheaper than a red CI run per move. Information only.
  try {
    const moved = baseMovement(pr);
    if (moved) {
      lines.push(`base moved: ${moved.behind} commits since merge-base (${pr.baseRefName}); merge it once before the next push`);
      lines.push(moved.shared.length ? `changed on both sides: ${filesText(moved.shared)}` : 'no file is changed on both sides');
    }
  } catch (error) {
    lines.push(`note: base movement unreadable (${error.message})`);
  }
  // Conflicts start no workflow, so the wait would never end; the fix is merging the base now. A draft is still
  // being worked on, and UNKNOWN (GitHub computes the state late after a push) or BEHIND are no conflict.
  if (pr.mergeStateStatus === 'DIRTY' && !pr.isDraft) {
    failed = true;
    lines.push('blocker: merge conflicts');
  }
  // A known CI failure or conflict is the verdict; later review reads must not turn it into ERROR.
  if (failed) return { done: true, failed, lines, pr };
  // A pull_request run skipped while the PR was still Draft (the usual `!draft` job guard) executed nothing, so it says
  // nothing about the Ready head. Ready normally starts a fresh run; until the workflow has an executed run created after
  // Ready, its path is missing, not green. An executed Draft run does not exempt the workflow (an unguarded job next to a
  // guarded one); a skip after Ready is a real optional skip. GitHub's required flag is no basis: it is false on
  // release branches for checks the project demands. A run triggered by opening as Draft or converting to Draft can land
  // just after a quick Ready, so that window counts as Draft too.
  // Only the latest Draft period counts: a skip from before the latest conversion belongs to an earlier period (a PR opened
  // Ready) and is no Draft skip.
  // ponytail: 10 s window for run creation lag after opening as Draft or a Draft conversion (a skipped Ready run inside it waits for the next push), and a Draft skip of an earlier period stays unseen
  // unless the latest period created a run too; replace both when the run's trigger action and the Draft history are readable.
  // It is judged over every run of the head, not only each job's decisive one: an executed push run of the same job from
  // before Ready must not hide the Draft skip. Only a run since Ready covers it: any run of the job, or an executed run of
  // the workflow.
  const readyEvent = Date.parse(pr.readyEvents?.nodes?.[0]?.createdAt);
  assert.ok(!pr.readyEvents?.nodes?.length || Number.isFinite(readyEvent), 'The Ready event time is unreadable');
  const convertEvent = Date.parse(pr.convertEvents?.nodes?.[0]?.createdAt);
  assert.ok(!pr.convertEvents?.nodes?.length || Number.isFinite(convertEvent), 'The Draft conversion time is unreadable');
  // Without a conversion, a Ready event means the PR was opened as Draft: its creation starts the Draft period like a conversion.
  const draftStart = convertEvent || (Number.isFinite(readyEvent) ? Date.parse(pr.createdAt) : -Infinity);
  assert.ok(!Number.isNaN(draftStart), 'The PR creation time is unreadable');
  const readyBoundary = Math.max(readyEvent, draftStart + 10_000);
  const runs = contexts.nodes.filter(check => orderable(check) && !isOptionalCheck(check));
  const startedAt = check => Date.parse(check.checkSuite?.createdAt);
  const flowOf = check => JSON.stringify([check.checkSuite?.app?.slug, check.checkSuite?.workflowRun?.workflow?.id]);
  // Inside the window only a skip is ambiguous (the Draft guard skips); a run that executed after the Ready event is a Ready run.
  const sinceReady = check => startedAt(check) >= (check.conclusion === 'SKIPPED' ? readyBoundary : readyEvent);
  const readyFlows = new Set(runs.filter(check => check.conclusion !== 'SKIPPED' && sinceReady(check)).map(flowOf));
  const readyJobs = new Set(runs.filter(sinceReady).map(jobKey));
  const draftSkipped = new Set();
  for (const check of runs.filter(check => !pr.isDraft && Number.isFinite(readyEvent) && check.conclusion === 'SKIPPED' && check.checkSuite.workflowRun && !sinceReady(check)
    && !(startedAt(check) < convertEvent))) {
    const { event } = check.checkSuite.workflowRun;
    assert.equal(typeof event, 'string', `The event of skipped check ${check.name} is unreadable`);
    if (!['pull_request', 'pull_request_target'].includes(event)) continue;
    assert.ok(runs.filter(run => flowOf(run) === flowOf(check)).every(run => Number.isFinite(startedAt(run))), `A run of the workflow of skipped check ${check.name} has no readable start time`);
    if (!readyFlows.has(flowOf(check)) && !readyJobs.has(jobKey(check))) draftSkipped.add(check.name);
  }
  // A workflow whose trigger does not fire on Ready (pull_request_target or pull_request without ready_for_review, a path filter) leaves
  // its skip from opening as the only run. Ready starts a run within seconds, so none after this long is not coming: note it, stop waiting.
  // ponytail: fixed 10 minutes for every workflow; replace by the workflow's own trigger types when they are readable.
  for (const label of draftSkipped) {
    const text = `check ${label} was skipped while Draft; no run since Ready`;
    if (now - readyEvent > 10 * 60_000) lines.push(`note: ${text}; its workflow does not start on Ready`);
    else waiting.push({ text, since: Infinity });
  }
  // The quality gate judges new conditions only, so a green SonarCloud check can sit on open issues. Count them once the analysis is final; a skipped check ran no analysis.
  for (const check of current.filter(check => check.checkSuite?.app?.slug === 'sonarqubecloud' && check.status === 'COMPLETED' && check.conclusion !== 'SKIPPED')) {
    const { total: open, lines: found } = sonarIssues(check.detailsUrl, pr.number);
    lines.push(`sonar: ${open} open issue${open === 1 ? '' : 's'}`, ...found);
    if (open) lines.push(`blocker: ${open} open Sonar issue${open === 1 ? '' : 's'} on this head; fix them or justify each as a false positive`);
  }
  const comments = restAll(`repos/${project.repository}/issues/${pr.number}/comments`);
  const reviewList = restAll(`repos/${project.repository}/pulls/${pr.number}/reviews`);
  // Bots acknowledge "@bot review" comments with a reaction on that comment, not on the PR.
  const reactions = [...restAll(`repos/${project.repository}/issues/${pr.number}/reactions`),
    ...comments.filter(comment => after(comment.created_at) && /@[\w-]+(\[bot\])?\s+review\b/i.test(comment.body))
      .flatMap(comment => restAll(`repos/${project.repository}/issues/comments/${comment.id}/reactions`))];
  // Inline review comments and thread replies carry findings too.
  const inline = restAll(`repos/${project.repository}/pulls/${pr.number}/comments`);
  // Results a bot can post: a review of this head, an issue comment, or a final (non-👀) reaction.
  // Codex runs a code and a security review side by side; the security result is its own comment under a
  // "Security Review" heading, so it ends only the security row. A final reaction ends every kind.
  const securityResult = body => /^#{1,6}\s.*Security Review/mi.test(body);
  const results = [...comments.map(comment => [login(comment.user), comment.updated_at, comment.id, securityResult(comment.body) ? 'security' : 'code']),
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at, null, 'code']),
    ...reactions.filter(reaction => reaction.content !== 'eyes').map(reaction => [login(reaction.user), reaction.created_at, null, 'any'])];
  // The summary's own later edits are no result, so its comment id is skipped.
  const answeredAfter = (author, since, own, kind) => results.some(([who, time, id, resultKind]) =>
    who === author && (id === null || id !== own) && Date.parse(time) > since && (resultKind === 'any' || resultKind === kind));
  const short = pr.headRefOid.slice(0, 7);
  for (const comment of comments.filter(comment => isBot(comment.user) && !isOptional(comment.user.login) && after(comment.updated_at))) {
    // Summary comments (Codex) name the head in a table row that says Running until the review completes;
    // a result the same bot posts elsewhere ends it too.
    for (const row of comment.body.split('\n').filter(row => row.includes('Running') && row.includes(short))) {
      const since = row.match(/datetime="([^"]+)"/)?.[1] ?? comment.updated_at;
      if (answeredAfter(login(comment.user), Date.parse(since), comment.id, /Security Review/i.test(row) ? 'security' : 'code')) continue;
      waiting.push({ text: `${login(comment.user)} running since ${since}`, since: Date.parse(since) });
    }
  }
  const activity = [...[...comments, ...inline].map(comment => [login(comment.user), comment.updated_at]),
    // A finishing review of the previous head never answers a trace on this one.
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at]),
    // 👍 is Codex's "no findings"; a later 👀 is its own open trace below.
    ...reactions.map(reaction => [login(reaction.user), reaction.created_at])];
  for (const reaction of reactions.filter(reaction => isBot(reaction.user) && after(reaction.created_at))) {
    // An optional reviewer's 👀 is shown and never awaited.
    if (isOptional(reaction.user.login)) {
      if (reaction.content === 'eyes') lines.push(`reaction ${login(reaction.user)} 👀 [optional reviewer, not awaited]`);
      continue;
    }
    // 👀 announces a review; a later comment, head review or final reaction by the same bot is its result.
    const answered = activity.some(([author, time]) => author === login(reaction.user) && Date.parse(time) > Date.parse(reaction.created_at));
    if (reaction.content === 'eyes' && !answered) waiting.push({ text: `${login(reaction.user)} reacted 👀`, since: Date.parse(reaction.created_at) });
  }
  // GitHub drops a request once the review arrives, so every remaining request is an outstanding review.
  assert.equal(pr.reviewRequests.nodes.length, pr.reviewRequests.totalCount, 'Not every review request is readable');
  const reviewerName = reviewer => reviewer?.login ?? reviewer?.name;
  for (const { requestedReviewer: reviewer } of pr.reviewRequests.nodes.filter(({ requestedReviewer }) => !(requestedReviewer?.__typename === 'Bot' && isOptional(requestedReviewer.login)))) {
    // A request added later starts its own clock.
    const requested = pr.requestEvents.nodes.filter(event => reviewerName(event.requestedReviewer) === reviewerName(reviewer))
      .map(event => Date.parse(event.createdAt));
    // Without its request time a new request would read as stalled; fail closed instead.
    assert.ok(requested.length || pr.requestEvents.nodes.length === pr.requestEvents.totalCount, 'Review request history is incomplete');
    waiting.push({ text: `review requested from ${reviewerName(reviewer) ?? 'an unreadable reviewer'}`, since: Math.max(pushed, ...requested) });
  }
  // Bots that start on "ready for review" (Codex) or on new commits leave their first trace a minute or two
  // later, often after CI is green. Until the grace has passed since the PR became ready or the head was
  // pushed, whichever is later, a missing trace is no answer yet. The grace ends as soon as one required bot has answered
  // for good on this head (a review, a comment other than an unfinished Running summary, a final reaction, or a limit notice
  // such as "usage limit" or "rate limited" in a comment or check): it has started, so more waiting for a silent one is guesswork.
  // ponytail: any one answering bot ends the grace for all of them, and github-actions comments (coverage reports) are no review; replace with a per-bot expectation when one exists.
  const limitNotice = /usage limit|rate.?limit/i;
  const answeredBot = [
    ...[...comments, ...inline].filter(comment => after(comment.updated_at)
      && !(comment.body ?? '').split('\n').some(row => row.includes('Running') && row.includes(short))).map(comment => comment.user),
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => review.user),
    ...reactions.filter(reaction => reaction.content !== 'eyes' && after(reaction.created_at)).map(reaction => reaction.user),
  ].some(user => isBot(user) && login(user) !== 'github-actions' && !isOptional(user.login))
    || current.some(check => !isOptionalCheck(check) && check.checkSuite?.app?.slug !== 'github-actions' && limitNotice.test(`${check.title ?? ''} ${check.description ?? ''}`));
  const readyAt = Math.max(...[pr.createdAt, ...(pr.readyEvents?.nodes ?? []).map(event => event.createdAt)].filter(Boolean).map(Date.parse));
  if (!pr.isDraft && graceMinutes > 0 && !answeredBot) {
    const graceFrom = Math.max(readyAt, pushed, headSetAt(pr, pushes()));
    if (now - graceFrom < graceMinutes * 60_000) {
      waiting.push({ text: `reviewers may still start until ${new Date(graceFrom + graceMinutes * 60_000).toISOString()}`, since: Infinity });
    }
  }
  for (const review of reviewList.filter(review => review.commit_id === pr.headRefOid)) lines.push(`review ${login(review.user)} ${review.state} ${review.html_url}`);
  for (const comment of comments.filter(comment => after(comment.updated_at))) lines.push(`comment ${login(comment.user)} ${comment.html_url}`);
  for (const comment of inline.filter(comment => after(comment.updated_at))) lines.push(`inline ${login(comment.user)} ${comment.html_url}`);
  const threads = threadsOf(pr);
  lines.push(`unresolved threads: ${threads.length}`, ...threads.map(link => `thread ${link}`));
  // Mergeable is not merge-ready: a standing change request, a ruleset or conflicts still block the human.
  lines.push(`merge: ${pr.mergeStateStatus}, review decision: ${pr.reviewDecision ?? 'none'}`);
  assert.equal(pr.latestOpinionatedReviews.nodes.length, pr.latestOpinionatedReviews.totalCount, 'Not every review decision is readable');
  for (const review of pr.latestOpinionatedReviews.nodes.filter(review => review.state === 'CHANGES_REQUESTED')) {
    // GitHub's ruleset blocks the merge on a standing change request, so an optional reviewer's answered one (all threads resolved)
    // is dismissed here, on handoff only; it is never re-requested. The review id comes from the REST list read above.
    const latest = dismissStale && !threads.length && isOptional(review.author?.login)
      && reviewList.findLast(item => login(item.user) === login(review.author) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state));
    if (latest?.state === 'CHANGES_REQUESTED') {
      execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${pr.number}/reviews/${latest.id}/dismissals`, '-X', 'PUT', '-f',
        `message=All review threads are resolved on head ${short}; the change request is stale.`], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
      lines.push(`dismissed stale change request by ${login(review.author)}: all threads are resolved`);
    } else lines.push(`blocker: changes requested by ${login(review.author)}`);
  }
  if (pr.mergeStateStatus === 'DIRTY') lines.push('blocker: merge conflicts'); // a non-draft PR returned above
  // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
  for (const entry of waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
  const pending = waiting.filter(entry => !stalled(entry.since));
  for (const entry of pending) lines.push(`waiting: ${entry.text}`);
  // A known failure ends the wait at once: the fix starts now, whatever else is still running.
  return { done: failed || !pending.length, failed, lines, pr, comments, threads };
}

/** Native PR connections, including manual links on a non-default base; refs and branches do not count. */
function connectedIssues(pr, draftAllowed = false) {
  const ids = new Set();
  for (let after; ;) {
    const current = graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){state isDraft headRefOid closingIssuesReferences(first:100,after:$after){totalCount
        pageInfo{hasNextPage endCursor} nodes{id}}}}}`, { owner, name, number: pr.number, ...(after && { after }) })
      .repository.pullRequest;
    assert.ok(current?.state === 'OPEN' && (draftAllowed || current.isDraft === false) && current.headRefOid === pr.headRefOid,
      'PR changed after the review check; read the current head again');
    const links = current.closingIssuesReferences;
    assert.ok(links?.nodes && links.pageInfo, 'Native issue links are unreadable');
    for (const issue of links.nodes) {
      assert.ok(issue?.id && !ids.has(issue.id), 'Native issue links are incomplete or repeated');
      ids.add(issue.id);
    }
    if (!links.pageInfo.hasNextPage) {
      assert.equal(ids.size, links.totalCount, 'Not every native issue link is readable');
      return ids;
    }
    assert.ok(links.pageInfo.endCursor && links.pageInfo.endCursor !== after, 'Issue-link pagination did not advance');
    after = links.pageInfo.endCursor;
  }
}

/** The changed region of two texts as `-`/`+` lines (common start and end cut off): enough to show a person what differs. */
function diffText(before, after) {
  const [old, now] = [before, after].map(text => text.split('\n'));
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let [endOld, endNow] = [old.length, now.length];
  while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) { endOld--; endNow--; }
  return [...old.slice(start, endOld).map(line => `- ${line}`), ...now.slice(start, endNow).map(line => `+ ${line}`)].join('\n');
}

const lines = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd();

/**
 * Replace an issue body only if it still is the one the change is based on, and prove the write afterwards.
 * GitHub has no conditional write for issue bodies: the window between the read and the write stays, which the
 * read-back closes for every overwrite that happens before it. Another session's change is reported, never lost silently.
 * `change(before, refuse)` turns the body just read into the new one; it returns undefined after calling `refuse`.
 */
function writeBody(change) {
  const current = () => {
    const issue = rest(`repos/${project.repository}/issues/${number}`);
    // The Issues API also serves pull requests under their number; a PR description is no issue body to replace.
    assert.ok(issue?.number === number && !issue.pull_request, `#${number} is not an issue of ${project.repository}`);
    return String(issue.body ?? '').replaceAll('\r\n', '\n').trimEnd();
  };
  const refuse = (reason, diff) => {
    console.log(['FAILED', `blocker: ${reason}`, diff.trimEnd()].filter(Boolean).join('\n'));
    process.exitCode = 1;
  };
  const before = current();
  const fresh = change(before, refuse);
  if (fresh === undefined) return;
  if (before === fresh) return console.log(`BODY #${number} already has this text`);
  // The text already read and compared goes over stdin: gh would take a file named "-" for stdin and write an empty body.
  execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${number}`, '-X', 'PATCH', '-F', 'body=@-'],
    { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: fresh });
  const after = current();
  if (after !== fresh) return refuse(`the body of #${number} is not what was written: another session overwrote it meanwhile (diff: what you wrote, then the current body); read it, merge, write again`, diffText(fresh, after));
  console.log(`BODY #${number} written and read back`);
}

function body() {
  const [fresh, base] = [value, process.argv[5]].map(lines);
  writeBody((before, refuse) => before === base ? fresh
    : refuse(`the body of #${number} changed since you read it (diff: your base, then the current body); read it again, merge, write again`, diffText(base, before)));
}

/** Replace exactly one occurrence of the --from text with the --to text; the body just read is the base. No regular expressions. */
function bodyReplace() {
  const [from, to] = [process.argv[5], process.argv[7]].map(lines);
  assert.ok(from !== '', 'The --from text is empty');
  writeBody((before, refuse) => {
    // Every start position counts, so "aa" in "aaa" is two matches, not one.
    const starts = [];
    for (let at = before.indexOf(from); at !== -1; at = before.indexOf(from, at + 1)) starts.push(at);
    if (starts.length === 1) return before.slice(0, starts[0]) + to + before.slice(starts[0] + from.length);
    const lineOf = at => before.slice(0, at).split('\n').length;
    return refuse(starts.length === 0
      ? `the --from text is not in the body of #${number}; read the body again`
      : `the --from text occurs ${starts.length} times in the body of #${number} (from line ${starts.map(lineOf).join(', from line ')}); take more surrounding text so it matches once`, '');
  });
}

/** Connect the issue natively to the PR (what a closing keyword does only on the default branch), post the backlink comment `status` requires, and read both back. */
const link = () => linkIssue(number, Number(value));
function linkIssue(issueNumber, prNumber) {
  const issue = readIssue(false, issueNumber);
  assert.ok(issue?.id, 'Issue identity is unreadable');
  // The backlink comment belongs on an open issue (the guard requires one); refuse before any write instead of half-way.
  assert.equal(issue.state, 'OPEN', `#${issueNumber} is not an open issue`);
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){id number state url headRefOid}}}`, { owner, name, number: prNumber }).repository;
  assert.ok(pr?.id && pr.number === prNumber && pr.state === 'OPEN', `#${prNumber} is not an open pull request of ${project.repository}`);
  // Already connected is a success without a write; a Draft PR can be connected too.
  if (!connectedIssues(pr, true).has(issue.id)) {
    graphql('mutation($issue:ID!,$pr:ID!){addCloseIssueReferences(input:{issueId:$issue,pullRequestIds:[$pr]}){clientMutationId}}',
      { issue: issue.id, pr: pr.id });
    // GitHub shows the new connection with a delay (seen live: the first read-back right after the write was empty).
    // Read back a few times; the write is never repeated.
    for (let attempt = 1; !connectedIssues(pr, true).has(issue.id); attempt++) {
      assert.ok(attempt < 5, `Native link read-back differs: PR #${prNumber} does not close issue #${issueNumber}`);
      sleep(1);
    }
  }
  console.log(`#${issueNumber} is natively linked to PR #${prNumber}`);
  // An existing comment is a success without a write. The text goes over stdin, like in `body`; the guard's reader proves it.
  const prUrl = new URL(pr.url);
  let backlink = findBacklink(issueComments(project.repository, issueNumber), prUrl);
  if (!backlink) {
    execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${issueNumber}/comments`, '-X', 'POST', '-F', 'body=@-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: `PR: ${pr.url}\n` });
    backlink = findBacklink(issueComments(project.repository, issueNumber), prUrl);
    assert.ok(backlink, `Backlink read-back differs: the comment with ${pr.url} is not readable on #${issueNumber}; read the comments before writing again`);
  }
  console.log(`backlink #${issueNumber}: ${backlink.html_url}`);
}

/**
 * Open task-list items of the issue body, as GitHub renders it, that name no issue: acceptance that is neither done nor
 * moved to a follow-up. GitHub's rendering decides what a task, a code block and an issue reference ("#N", "OWNER/REPO#N",
 * an issue URL) are, so no Markdown is parsed here.
 */
// ponytail: relies on GitHub's task-list markup (task-list-item-checkbox, issue-link); replace when GitHub changes it.
function openAcceptance(bodyHtml) {
  assert.equal(typeof bodyHtml, 'string', 'The rendered issue body is unreadable');
  const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return [...bodyHtml.matchAll(/(<input type="checkbox"[^>]*>)([\s\S]*?)(?=<\/li>|<[uo]l[\s>]|<li[\s>]|<input type="checkbox")/g)]
    .filter(([, box, text]) => box.includes('task-list-item-checkbox') && !/\schecked[\s=>]/.test(box) && !text.includes('class="issue-link'))
    .map(([, , text]) => decode(text.replace(/<[^>]*>/g, '')).trim());
}

/**
 * Everything the issue side of the handoff still lacks (readiness, review status, assignment, open acceptance) on the
 * supplied issue snapshot, or undefined when check() already printed its verdict and stopped.
 * `reviewedHead`: the PR head the proof was gathered for; a stacked layer must still be that head when this reads it.
 */
function handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber) {
  if (!mayStart(check(issue, undefined, currentPrNumber))) return;
  assert.ok(issue.id, 'Issue identity is unreadable');
  const status = projectItem(issue)?.status?.name;
  const reasons = [];
  // An upper layer may be handed off before the base is merged, but only as a layer on that base.
  // A merged base leaves a plain PR on the trunk; it still has to come from this repository and target that trunk.
  if (stackedOn) {
    const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){baseRefName headRefOid isCrossRepository headRepository{nameWithOwner}}}}`, { owner, name, number: Number(value) }).repository;
    if (reviewedHead && pr?.headRefOid !== reviewedHead) reasons.push(`PR #${value} changed its head from ${reviewedHead.slice(0, 7)} during handoff; read it again`);
    if (pr?.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) reasons.push(`PR #${value} comes from a fork or another repository: stacks stay inside ${project.repository}`);
    if (stackedOn.state === 'MERGED') {
      if (pr?.baseRefName !== stackedOn.baseRefName) reasons.push(`PR #${stackedOn.number} is merged into ${stackedOn.baseRefName}: PR #${value} must target it, not ${pr?.baseRefName}`);
    } else {
      // An aligned branch chain is no stack: GitHub must list both PRs in one open stack (the read-back of the docs, step 2).
      const stacks = rest(`repos/${project.repository}/stacks?pull_request=${Number(value)}`);
      // The base PR may sit anywhere below this PR; the head and target checks below concern the layer directly under it.
      const base = { number: stackedOn.number, ref: stackedOn.headRefName, sha: stackedOn.headRefOid };
      let lower; // {number, ref, sha} of the layer directly under this PR; the base PR itself keeps its own read
      if (Array.isArray(stacks) && stacks.length === 1 && stacks[0].open === true && Array.isArray(stacks[0].pull_requests)) {
        const members = stacks[0].pull_requests;
        const baseIndex = members.findIndex(member => member.number === stackedOn.number);
        const ownIndex = members.findIndex(member => member.number === Number(value));
        const under = members[ownIndex - 1];
        if (baseIndex >= 0 && ownIndex > baseIndex) {
          if (under.number === base.number) lower = base;
          else if (typeof under.head?.ref === 'string' && typeof under.head.sha === 'string') lower = { number: under.number, ref: under.head.ref, sha: under.head.sha };
        }
      }
      if (!lower) {
        reasons.push(`PR #${value} is not above PR #${stackedOn.number} in one open native stack (GET repos/${project.repository}/stacks?pull_request=${value}); link it (docs/CONTRIBUTING.md#stacked-pull-requests) or stop`);
      }
      const { number: lowerNumber, ref: lowerRef, sha: lowerSha } = lower ?? base;
      // Proof of the upper head only counts when that head contains the lower PR's current head (a later push below leaves the branch name unchanged).
      if (!reasons.length && pr?.baseRefName === lowerRef) {
        const { status } = rest(`repos/${project.repository}/compare/${lowerSha}...${pr.headRefOid}`);
        if (!['ahead', 'identical'].includes(status)) reasons.push(`PR #${value} does not contain the current head ${lowerSha.slice(0, 7)} of PR #${lowerNumber} (compare says ${status}): rebase onto it and push with the lease`);
      }
      if (pr?.baseRefName !== lowerRef) reasons.push(`the open predecessor PR #${lowerNumber} is not merged: PR #${value} must target its branch ${lowerRef}, not ${pr?.baseRefName}`);
    }
  }
  if (!['Automated review', 'Human review'].includes(status)) reasons.push(`status is ${status ?? 'unset'}: when the work is done, run board.mjs status ISSUE "Automated review" PR, then post a new handoff comment for the current head`);
  if (!issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase())) {
    reasons.push('the issue is not assigned to the authenticated driver');
  }
  for (const line of openAcceptance(issue.bodyHTML)) reasons.push(`open acceptance without an issue reference (check it off, or move it to a follow-up and link that issue): ${line}`);
  return reasons;
}

/** The recheck before the write: true when the issue side holds, otherwise the verdict is printed. */
function handoffIssue(issue, viewer, reviewedHead, currentPrNumber) {
  const reasons = handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber);
  if (reasons?.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
  }
  return reasons?.length === 0;
}

/**
 * The driver's handoff comment: a "## Übergabe" heading and a "Head: <SHA>" line in a PR comment by the authenticated
 * user. The comment names the head it is about, so a new head asks for a new comment however (and whenever) the push
 * happened, which no timestamp reliably tells. Of its content only the retro section is judged, see `retroReasons`;
 * with several matching comments the newest counts.
 */
const findHandoffComment = (comments, viewer, headRefOid) => comments.findLast(comment => comment.user?.login?.toLowerCase() === viewer.login.toLowerCase()
  && /^## Übergabe\s*$/m.test(comment.body ?? '') && new RegExp(`^Head:\\s*${headRefOid.slice(0, 7)}`, 'im').test(comment.body ?? ''));

// ponytail: relies on GitHub's markup (h1-h6, li, issue-link); replace when GitHub changes it.
const text = html => html.replace(/<\/?(?:br|p|div|li|h[1-6]|ul|ol|blockquote)\b[^>]*>/gi, ' ')
  .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const headingText = part => text(part.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/)?.[1] ?? '');
/** A quoted template is no section: drop quotes (innermost first, so nesting works) before searching. */
function withoutQuotes(html) {
  let unquoted = html;
  for (let previous; previous !== unquoted;) { previous = unquoted; unquoted = unquoted.replace(/<blockquote[\s>](?:(?!<blockquote[\s>])[\s\S])*?<\/blockquote>/g, ''); }
  return unquoted;
}

/**
 * Why the PR body, as GitHub renders it, does not carry the self-review the project asks for: the project file's
 * "selfReview" lists the checks (for example "ponytail-review", "code-review") that the section "Selbstprüfung" (a heading of
 * any level; its sub-headings belong to it) must name. Whether a check was good is not judged. Without the field nothing is asked.
 */
// ponytail: a name counts when the section mentions it, the section is not proof the check ran; replace when a check leaves a trace.
function selfReviewChecks() {
  const checks = project.selfReview === undefined ? [] : project.selfReview; // only a missing field is allowed; null is malformed
  assert.ok(Array.isArray(checks) && checks.every(check => typeof check === 'string' && check.trim()), 'selfReview must be a list of non-empty check names');
  return checks;
}
function selfReviewReasons(bodyHtml, checks) {
  if (!checks.length) return [];
  assert.equal(typeof bodyHtml, 'string', 'The rendered PR body is unreadable');
  const parts = withoutQuotes(bodyHtml).split(/(?=<h[1-6][\s>])/), level = part => Number(/^<h([1-6])[\s>]/.exec(part)?.[1]);
  const start = parts.findIndex(part => level(part) && headingText(part) === 'Selbstprüfung');
  if (start < 0) return [`the PR body needs a "## Selbstprüfung" section that names ${checks.join(', ')} (docs/CONTRIBUTING.md#review-loop, step 1)`];
  let end = start + 1;
  while (end < parts.length && level(parts[end]) > level(parts[start])) end++;
  const section = text(parts.slice(start, end).join(''));
  const missing = checks.filter(check => !new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_-])${RegExp.escape(check.trim())}(?![\\p{L}\\p{M}\\p{N}_-])`, 'iu').test(section));
  return missing.length ? [`the "Selbstprüfung" section of the PR body does not name: ${missing.join(', ')}`] : [];
}

/**
 * Why the retro section of the handoff comment, as GitHub renders it, does not pass: a heading "Retro" with one list
 * line per finding, each ending with its resolution (an issue link, "behoben in <SHA>", "persönlich gemeldet" or
 * "kein Handlungsbedarf: <Grund>"), or the single line "Keine Funde". Whether a finding is justified is not judged.
 * GitHub's rendering decides what a heading, a list line and an issue reference are, so no Markdown is parsed here.
 */
function retroReasons(bodyHtml) {
  assert.equal(typeof bodyHtml, 'string', 'The rendered handoff comment is unreadable');
  const unquoted = withoutQuotes(bodyHtml);
  const section = unquoted.split(/(?=<h[1-6][\s>])/).find(part => /^<h[1-6][\s>]/.test(part) && headingText(part) === 'Retro');
  const lines = [...(section ?? '').matchAll(/<li[^>]*>([\s\S]*?)(?=<\/li>|<[uo]l[\s>]|<li[\s>])/g)].map(([, line]) => [line, text(line)]);
  if (!lines.length) return ['the handoff comment needs a "Retro" section with one list line per finding, each ending with its resolution, or the single line "Keine Funde" (README: Handoff comment)'];
  if (lines.length === 1 && /^keine funde\.?$/i.test(lines[0][1])) return [];
  // The last element must be an issue link (GitHub renders a pull request reference the same way, but with /pull/N); a loose list wraps the line in <p>.
  // Closing punctuation and spaces after the resolution (`… #230.`) do not hide it.
  const endsWithIssue = html => { const anchor = html.match(/(<a [^>]*>)[^<]*<\/a>[\s.,;]*(?:<\/p>\s*)?$/)?.[1] ?? ''; return anchor.includes('class="issue-link') && /href="[^"]*\/issues\/\d+"/.test(anchor); };
  return lines.filter(([html, line]) => !(endsWithIssue(html) || /\bbehoben in [0-9a-f]{7,40}[\s.,;]*$/i.test(line)
    || /persönlich gemeldet[\s.,;]*$/i.test(line) || /\bkein Handlungsbedarf: \S/i.test(line)))
    .map(([, line]) => `retro line without a resolution (end it with an issue link, "behoben in <SHA>", "persönlich gemeldet" or "kein Handlungsbedarf: <Grund>"): ${line}`);
}

/**
 * The PR gate handoff and merge share: an open non-draft PR whose CI and every traced review have finished, without
 * blockers or open threads, and with a determined merge state. Prints the verdict and sets the exit code; returns the
 * review result only when it holds. Its own reasons include the self-review section of the PR body ("selfReview" of the project file).
 * `extra` adds the caller's own further reasons (it runs only once the shared gate holds).
 * `prior` are reasons the caller found before (the issue side of handoff): they are listed with the PR's, in one run.
 * GitHub computes the merge state late: an undetermined one is read again a few times (`--interval` seconds apart, at
 * 1 point each) before it counts as waiting.
 */
const mergeStates = ['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'], mergeReads = 4;
function finishedPr(prNumber, action, expectedHead, extra = () => [], prior = []) {
  const checks = selfReviewChecks();
  const pr = readPr(prNumber);
  if (checks.length) assert.equal(typeof pr.bodyHTML, 'string', 'The rendered PR body is unreadable');
  assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
  const blockers = reasons => reasons.map(reason => `blocker: ${reason}`);
  if (pr.state !== 'OPEN' || pr.isDraft) {
    console.log(['FAILED', ...blockers([...prior, `${action} needs an open non-draft PR`])].join('\n'));
    process.exitCode = 1;
    return;
  }
  const result = reviews(stallOption(), Date.now(), prNumber, pr, undefined, undefined, action === 'handoff');
  console.log(result.lines.join('\n'));
  if (!result.done || result.failed) {
    process.exitCode = result.failed || prior.length ? 1 : 3;
    console.log([result.failed || prior.length ? 'FAILED' : 'WAITING', ...blockers(prior)].join('\n'));
    return;
  }
  if (expectedHead) assert.equal(result.pr.headRefOid, expectedHead, `PR head changed during ${action}`);
  const reasons = [...prior];
  if (result.lines.some(line => line.startsWith('blocker:') || /^unresolved threads: [1-9]/.test(line))) {
    reasons.push(`resolve review blockers and threads before ${action}`);
  }
  reasons.push(...selfReviewReasons(result.pr.bodyHTML, checks), ...extra(result));
  const undetermined = state => !state || state === 'UNKNOWN';
  let state = result.pr.mergeStateStatus;
  for (let read = 1; undetermined(state) && read < mergeReads; read++) {
    sleep(numberOption('--interval', 3));
    const fresh = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){headRefOid mergeStateStatus}}}`, { owner, name, number: prNumber }).repository.pullRequest;
    assert.equal(fresh?.headRefOid, result.pr.headRefOid, `PR head changed during ${action}`);
    state = fresh.mergeStateStatus;
  }
  // The snapshot's own DIRTY is already a blocker line of reviews(); a DIRTY that GitHub computed during the re-reads is new.
  if (state === 'DIRTY' && result.pr.mergeStateStatus !== 'DIRTY') reasons.push('merge conflicts: resolve them before ' + action);
  if (!mergeStates.includes(state)) {
    if (!reasons.length) {
      console.log('WAITING\nwaiting: PR mergeability is not determined');
      process.exitCode = 3;
      return;
    }
    if (undetermined(state)) reasons.push('PR mergeability is not determined (GitHub is still computing it): run again in a minute');
  }
  if (reasons.length) {
    console.log(['FAILED', ...blockers(reasons)].join('\n'));
    process.exitCode = 1;
    return;
  }
  return result;
}

/** Read all PR gates and native links, optionally requiring the previously checked head; `prior`: see finishedPr. */
function handoffPr(issueId, viewer, expectedHead, prior) {
  const result = finishedPr(Number(value), 'handoff', expectedHead, ({ comments, pr }) => {
    const reasons = [];
    const comment = findHandoffComment(comments, viewer, pr.headRefOid);
    if (!comment) reasons.push(`post the handoff comment on PR #${value} for the current head: a "## Übergabe" heading, a "Head: ${pr.headRefOid.slice(0, 7)}" line and the "Retro" section (README: Handoff comment)`);
    else {
      // The list endpoint renders no HTML unless asked, and then it omits the raw body: one more read for the rendered comment.
      const rendered = JSON.parse(execFileSync(gh.file, ['api', `repos/${project.repository}/issues/comments/${comment.id}`, '-H', 'Accept: application/vnd.github.html+json'],
        { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 }));
      reasons.push(...retroReasons(rendered.body_html));
    }
    if (!connectedIssues(pr).has(issueId)) reasons.push(`PR #${value} is not natively linked to issue #${number}`);
    return reasons;
  }, prior);
  return result?.pr;
}

/** Guard the Human review write with current PR proof followed by current issue prerequisites. */
function handoff() {
  const issue = readIssue();
  const { viewer } = graphql('query{viewer{login}}');
  assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
  // The issue side's reasons wait for the PR side's, so one run names everything that is missing.
  const currentPrNumber = Number(value);
  const prior = handoffIssueReasons(issue, viewer, undefined, currentPrNumber);
  if (!prior) return;
  const pr = handoffPr(issue.id, viewer, undefined, prior);
  if (!pr) return;
  if (!set('Status', 'Human review', () => {
    if (!handoffPr(issue.id, viewer, pr.headRefOid)) return;
    const current = readIssue();
    assert.equal(current?.id, issue.id, 'Issue identity changed during handoff');
    return handoffIssue(current, viewer, pr.headRefOid, currentPrNumber) ? current : undefined;
  })) return;
  assert.equal(projectItem(readIssue())?.status?.name, 'Human review', 'Human review status read-back differs');
  console.log(`HANDOFF #${number} PR #${value} head ${pr.headRefOid}`);
}

/** The merge gate: handoff's PR gate plus the stack rule. Merging an upper layer of a stack merges every open layer below it too
 * (GitHub: "merge the top pull request, every pull request below it comes with it"), so the lower layer goes first, by itself.
 * No Stacks API (404) means no stack. */
const mergeGate = () => finishedPr(number, 'merge', undefined, () => {
  let stacks;
  try { stacks = rest(`repos/${project.repository}/stacks?pull_request=${number}`); } catch (error) {
    if (!/\b404\b|Not Found/.test(String(error.stderr))) throw error;
    stacks = [];
  }
  assert.ok(Array.isArray(stacks), 'The stack membership is unreadable');
  return stacks.flatMap(({ pull_requests: members = [] }) => members.slice(0, Math.max(0, members.findIndex(member => member.number === number)))
    .filter(member => member.state === 'open').map(member => `PR #${member.number} below it in its stack is still open: merge it first, merging this layer would merge it too`));
});

/**
 * Merge the moved base into the PR branch (update-branch, only if the head is still `head`), then wait until the PR shows the new head.
 * GitHub answers 403 for a PR with stacked children (#321): that ends the run with the manual way (nobody pushes for the caller) and returns nothing.
 */
function updateBranch(head, base) {
  try {
    execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${number}/update-branch`, '-X', 'PUT', '-f', `expected_head_sha=${head}`], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // stdio 'pipe': without it execFileSync copies gh's raw refusal to stderr, and a caller that reads the last line sees that, not the instruction (#332).
    if (!/\b403\b|stacked PR's branch/.test(`${error.stderr}${error.stdout}`)) throw error;
    console.log(['FAILED', `blocker: GitHub refuses the branch update with 403 (typical for a PR with stacked children): run \`git merge origin/${base}\` in the PR's worktree, push once, then run \`board.mjs merge ${number}\` again`].join('\n'));
    process.exitCode = 1;
    return;
  }
  // update-branch answers 202 before the new head exists, and the PR reports the previous head for a moment.
  for (let read = 1; ; read++) {
    const fresh = graphql(readyQuery, { owner, name, number }).repository.pullRequest.headRefOid;
    if (fresh !== head) return fresh;
    assert.ok(read < 10, `PR #${number} still shows head ${head.slice(0, 7)} after the branch update; run merge again`);
    sleep(numberOption('--interval', 3));
  }
}

/**
 * Delete the merged head branch, unless the repository does it itself (`delete_branch_on_merge`) or it is not ours to delete: another repository's, the default branch (a sync PR from
 * `main` has it as head), or the base of an open PR (a stack: GitHub would close that PR). Returns the line to print.
 * ponytail: check and delete are two calls, a PR opened on the branch in between is closed by the delete; replace when GitHub offers a conditional delete.
 */
function deleteHeadBranch(pr) {
  const branch = pr.headRefName;
  if (pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) return `branch kept: ${branch} is not a branch of ${project.repository}`;
  const repository = rest(`repos/${project.repository}`);
  // With "Automatically delete head branches" GitHub deletes it itself, and a manual delete would answer 422.
  if (repository.delete_branch_on_merge) return `branch kept: ${project.repository} deletes merged head branches itself`;
  if (branch === repository.default_branch) return `branch kept: ${branch} is the default branch`;
  const dependents = rest(`repos/${project.repository}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`);
  assert.ok(Array.isArray(dependents), 'The open PRs on the branch are unreadable');
  if (dependents.length) return `branch kept: ${branch} is the base of open PR ${dependents.map(({ number: dependent }) => `#${dependent}`).join(', ')}`;
  try {
    execFileSync(gh.file, ['api', `repos/${project.repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, '-X', 'DELETE'], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // A branch that is already gone (the repository deletes merged branches itself) is no failure.
    if (!/\b(404|422)\b|Reference does not exist|Not Found/.test(`${error.stderr}${error.stdout}`)) throw error;
    return `branch gone: ${branch}`;
  }
  return `branch deleted: ${branch}`;
}

/**
 * Merge for agents with merge authority: the same gate as handoff (CI, every traced review finished, no blocker or open
 * thread). When the base moved under files the PR changes too (#190), the base is merged into the PR branch first and the
 * gate runs again on the new head after its CI; a base that moved without overlap does not hold the merge. Then exactly the
 * checked head: `--match-head-commit` needs the full object id, and it also refuses a push that lands after the check, so
 * no recheck window is left to close. Never repeated: a refusal by gh ends as ERROR, except the stack refusal of a PR with stacked children (#321),
 * which goes once to merge-async with the same head and is read back until merged. Afterwards the head branch goes (see deleteHeadBranch).
 */
async function merge() {
  let result = mergeGate();
  if (!result) return;
  const { baseRefName, headRefOid: before } = result.pr;
  assert.match(before, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
  const moved = baseMovement(result.pr);
  if (moved?.shared.length) {
    console.log(`update: ${baseRefName} gained ${moved.behind} commits that change ${filesText(moved.shared)} like this PR; merging it into the PR branch first`);
    const updated = updateBranch(before, baseRefName);
    if (!updated) return;
    console.log(`updated: head ${before.slice(0, 7)} -> ${updated.slice(0, 7)}; waiting for CI`);
    // The new head's CI (and any reviewer that answers the push) decides, so the gate runs again; one update per run.
    if (!await poll(() => reviews(stallOption()))) return;
    result = mergeGate();
    if (!result) return;
  }
  const { headRefOid } = result.pr;
  let asynchronous = false;
  try {
    execFileSync(gh.file, ['pr', 'merge', String(number), '--repo', project.repository, '--merge', '--match-head-commit', headRefOid],
      { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // A PR with stacked children (#321) is refused, but accepted by merge-async: same merge, same head, the answer is 202 and the merge follows in the background.
    // GitHub's GraphQL text is "part of a stack and must be merged using the asynchronous merge REST API"; a REST merge answers HTTP 403.
    // ponytail: a bare HTTP 403 (e.g. a token without permission) also tries merge-async once, which then ends as ERROR; add a stack qualifier when a real 403 text is captured.
    const text = `${error.stderr}${error.stdout}`;
    if (!/part of a stack|asynchronous merge REST API|HTTP 403/i.test(text)) throw error;
    console.log(`note: gh pr merge was refused (${/HTTP 403/i.test(text) ? 'HTTP 403' : 'part of a stack'}); merging the same head with merge-async`);
    execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${number}/merge-async`, '-X', 'PUT', '-f', 'merge_action=direct_merge', '-f', 'merge_method=merge', '-f', `sha=${headRefOid}`],
      { encoding: 'utf8', env: gh.env });
    asynchronous = true;
  }
  let merged;
  for (let read = 1; ; read++) {
    merged = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){state mergeCommit{oid}}}}`, { owner, name, number }).repository.pullRequest;
    if (!asynchronous || merged.state === 'MERGED' || read >= 10) break;
    sleep(numberOption('--interval', 3));
  }
  const { state, mergeCommit } = merged;
  assert.equal(state, 'MERGED', `Merge read-back shows #${number} as ${state}${asynchronous ? '; merge-async was accepted and may still land: read the PR before merging again' : ''}`);
  console.log(`MERGED #${number} head ${headRefOid} merge commit ${mergeCommit?.oid}`);
  // The merge is done and read back: nothing about the branch may turn it into an ERROR.
  try { console.log(deleteHeadBranch(result.pr)); } catch (error) {
    console.log(`note: branch ${result.pr.headRefName} not deleted (${String(error.stderr || error.message).trim()})`);
  }
}

const numberOption = (flag, fallback) => process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback;
const stallOption = () => numberOption('--stall', 20);
// "reviewerGraceMinutes" in the project file is the default of --grace; 0 turns the grace off. Only a missing field is allowed.
const projectGrace = project.reviewerGraceMinutes === undefined ? 3 : project.reviewerGraceMinutes;
const graceOption = () => numberOption('--grace', projectGrace);
const headOption = () => process.argv.includes('--head') ? process.argv[process.argv.indexOf('--head') + 1] ?? '' : undefined;
const sessionOption = () => process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : undefined;

/** Metadata that can still describe the previous push right after it: identity, branch, state, draft, head. */
const readyQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id number state isDraft isCrossRepository headRefOid headRepository{nameWithOwner}}}}`;
const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
/**
 * Polling must end: a few reads, finite pauses, at most half an hour of waiting in total (also keeps seconds * 1000
 * finite). `ready` waits in two loops (stale head before the write, read-back after it), each sleeping up to
 * (attempts - 1) times, so both count.
 */
function readyOptionsBounded() {
  const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= 100 && Number.isFinite(interval) && interval >= 0
    && 2 * attempts * interval <= 1800;
}

/** Mark a Draft PR ready only for the explicitly expected pushed commit; stale metadata is waited out, never trusted. */
function ready() {
  const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
  const read = () => {
    const pr = graphql(readyQuery, { owner, name, number }).repository.pullRequest;
    assert.ok(pr?.id && pr.number === number, 'The PR is unreadable');
    assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
    return pr;
  };
  const refuse = (...reasons) => {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
  };
  let pr;
  for (let attempt = 1; ; attempt++) {
    pr = read();
    if (pr.state !== 'OPEN') return refuse(`PR #${number} is ${pr.state.toLowerCase()}`);
    // A fork's or another repository's branch is not ours to mark ready.
    // GitHub reports the canonical spelling; the configured OWNER/REPO may differ in case.
    if (pr.isCrossRepository || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) return refuse(`PR #${number} does not come from a branch of ${project.repository}`);
    if (!pr.isDraft) {
      if (!pr.headRefOid.startsWith(value.toLowerCase())) return refuse(`PR #${number} is already ready with head ${pr.headRefOid.slice(0, 7)}, not ${value.slice(0, 7)}`);
      return console.log(`READY #${number} head ${pr.headRefOid} (already ready)`);
    }
    if (pr.headRefOid.startsWith(value.toLowerCase())) break;
    if (attempt >= attempts) return refuse(`PR #${number} still reports head ${pr.headRefOid.slice(0, 7)} after ${attempts} reads; expected ${value.slice(0, 7)}`);
    sleep(interval);
  }
  // One more read narrows the window in which a new push could slip between check and mutation.
  const current = read();
  if (current.state !== 'OPEN' || !current.isDraft || current.headRefOid !== pr.headRefOid) return refuse('the PR changed after the check; read it again');
  graphql('mutation($pr:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pr}){pullRequest{number}}}', { pr: pr.id });
  // A write only counts once the read-back shows the expected head ready.
  for (let attempt = 1; ; attempt++) {
    const done = read();
    if (done.state === 'OPEN' && !done.isDraft && done.headRefOid === pr.headRefOid) break;
    assert.ok(attempt < attempts, `Ready read-back differs: draft ${done.isDraft}, head ${done.headRefOid.slice(0, 7)}`);
    sleep(interval);
  }
  console.log(`READY #${number} head ${pr.headRefOid}`);
}
// Waiting is over either way; FAILED keeps a red head from reading as a finished review.
const outcome = ({ failed }) => failed ? ['FAILED', 1] : ['DONE', 0];

/** Print one review snapshot with the same verdict and exit status as the background wait. */
function reviewsOnce() {
  const result = reviews(stallOption());
  const [word, code] = result.done ? outcome(result) : ['WAITING', 3];
  console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
  process.exitCode = code;
}

/** Waiting for the human merge is the other recurring wait; it ends when the PR is no longer open. REST, so it costs no GraphQL points. */
function mergeState() {
  const pull = rest(`repos/${project.repository}/pulls/${number}`);
  const open = pull.state === 'open';
  // Closed without merge is the end of the wait, but never a delivery.
  return { done: !open, failed: !open && !pull.merged, lines: [`#${pull.number} ${open ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'}`, ...open ? ['waiting: human merge'] : []] };
}

/** What the last query cost and what is left, so a driver sees the shared quota without a command of its own. */
const quotaLine = () => quota && `quota: ${quota.remaining} left, ${spent} points used by this run, resets ${quota.resetAt}`;

/**
 * Right after a push GitHub still reports the previous head, so a plain `wait` can end DONE for it. With `--head SHA`
 * (the id just pushed, 7 to 40 characters, compared as a prefix) an open PR keeps waiting until it shows that head.
 * ponytail: a head that never matches (wrong id, someone else pushed on top) waits on; stop it by hand.
 */
function lookAtHead(pr, threads) {
  const expected = headOption()?.toLowerCase();
  if (!expected || pr.state !== 'OPEN' || pr.headRefOid.startsWith(expected)) return reviews(stallOption(), Date.now(), number, pr, undefined, threads ?? (current => unresolvedThreads(current.number, current.reviewThreads)));
  return { done: false, lines: [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`,
    `waiting: PR still shows head ${pr.headRefOid.slice(0, 7)}, expected ${expected.slice(0, 7)}`] };
}

/**
 * What GraphQL shows of the PR changes only when REST shows a change too (head, state, draft, merge state, update time, check runs,
 * check suites, commit statuses), so a round that finds the same marker reads GraphQL no more: comments, reviews and reactions are
 * REST reads anyway and the clock is the current one. `head` is the commit the marker names; `pull`, `runs` and `statuses` are what
 * REST answered (pausedRound shows them). Undefined when REST cannot say.
 * ponytail: checks stop at 100 like the GraphQL query; replace when that query paginates.
 */
function changeMarker() {
  try {
    const pull = rest(`repos/${project.repository}/pulls/${number}`), commit = `repos/${project.repository}/commits/${pull.head.sha}`;
    const listed = (path, key) => rest(`${commit}/${path}?per_page=100`)[key];
    const [runs, suites, statuses] = [listed('check-runs', 'check_runs'), listed('check-suites', 'check_suites'), listed('status', 'statuses')];
    return { head: pull.head.sha, pull, runs, statuses, text: JSON.stringify([pull.head.sha, pull.updated_at, pull.state, pull.draft, pull.mergeable_state,
      runs.map(run => [run.id, run.status, run.conclusion]), suites.map(suite => [suite.id, suite.status, suite.conclusion]),
      statuses.map(status => [status.context, status.state, status.description])]) };
  } catch { return undefined; } // a failed marker read is a full read, never a verdict
}

/**
 * The GraphQL quota is used up until `resetAt`: `wait` keeps looking over REST (PR state and checks) instead of sleeping, and the
 * full read (threads, verdict) follows after the reset. It never ends the wait: REST lists every run of the head, so an older run
 * that a newer one cancelled looks failed, and only the full read knows which run decides.
 * ponytail: counts only, no verdict from REST; replace when the decisive run per job can be told apart over REST.
 */
function pausedRound(resetAt, marker) {
  const lines = [];
  let text = `GitHub quota used up until ${untilText(resetAt)}; threads and the verdict are read after it`;
  if (marker) {
    const checks = [...marker.runs.filter(run => !isOptional(run.app?.slug)).map(run => run.status === 'completed' ? run.conclusion : 'pending'),
      ...marker.statuses.map(status => status.state)];
    const count = names => checks.filter(result => names.includes(result)).length;
    text += `; checks over REST: ${count(['pending'])} pending, ${count(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])} failed or cancelled, ${count(['success', 'neutral', 'skipped'])} passed`;
    lines.unshift(`#${marker.pull.number} ${marker.pull.state.toUpperCase()} head ${marker.head.slice(0, 7)}`);
  }
  return { done: false, lines: [...lines, `waiting: ${text}`], pausedUntil: resetAt };
}

// The last full read of this wait: the marker REST showed before it, the PR and the unresolved threads.
let lastRead;
// A full read is repeated after this long even without a change, so a GraphQL answer that lagged behind REST heals.
const fullReadEvery = 5 * 60_000;

/**
 * One round of `wait`. An unchanged marker answers from the last full read, brought up to date by the REST reads and the clock, and only
 * while it still says "waiting": every end (DONE, FAILED, a closed PR) is confirmed by a full read, whose result is what is printed.
 * Review thread resolutions leave no mark in REST, which is why no end is taken from the cache.
 */
function reviewsForHead() {
  const marker = changeMarker(), started = Date.now();
  try {
    if (marker && lastRead?.marker.text === marker.text && started - lastRead.at < fullReadEvery) {
      const result = lookAtHead(lastRead.pr, () => lastRead.threads);
      if (!result.done) return result;
    }
    const pr = readPr(number), result = lookAtHead(pr);
    // A PR that shows another head than REST is still catching up, and a result that ended early has no threads: read both again next round.
    lastRead = marker && pr.headRefOid === marker.head && result.threads && { marker, pr, threads: result.threads, at: started };
    return result;
  } catch (error) {
    if (error instanceof QuotaPause) return pausedRound(error.resetAt, marker);
    throw error;
  }
}

/** Looks again and again until `look` is done and returns that result; returns nothing after printing "still waiting" (exit 4). */
async function poll(look) {
  const maxMinutes = numberOption('--max-minutes', 9);
  if (maxMinutes > 0) deadline = Date.now() + maxMinutes * 60_000;
  let shown, quiet = 0;
  // Exit 4: not finished, call the command again (a driver's tool call must end before its 10-minute limit).
  const stillWaiting = resetAt => {
    process.exitCode = 4;
    const quotaReset = resetAt ?? (command === 'wait' && quota?.remaining < sleepers.wait ? quota.resetAt : undefined);
    console.log(['WAITING', shown, `still waiting: call ${command} again${quotaReset ? ` after ${quotaReset} (GitHub quota pause)` : ''}`, quotaLine()].filter(Boolean).join('\n'));
  };
  try {
    for (;;) {
      const result = look(), { done, lines } = result;
      if (done) return result;
      // Interim output names what is still awaited, once per change, so a background run is never silent.
      const waiting = lines.filter(line => line.startsWith('waiting:')).join('\n');
      if (waiting !== shown) {
        console.log(['WAITING', shown = waiting, quotaLine()].filter(Boolean).join('\n'));
        quiet = 0;
      }
      if (Date.now() >= deadline) return stillWaiting(result.pausedUntil);
      // Little quota lengthens the pause, but not while REST is read in place of GraphQL.
      const pause = command === 'wait' && process.argv.includes('--interval') ? numberOption('--interval', 0) : waitInterval(quiet++, result.pausedUntil ? undefined : quota?.remaining);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * pause, deadline - Date.now())));
    }
  } catch (error) {
    if (!(error instanceof StillWaiting)) throw error;
    stillWaiting(error.resetAt);
  }
}

async function wait() {
  const result = await poll(process.argv.includes('--merged') ? mergeState : reviewsForHead);
  if (!result) return;
  const [word, code] = outcome(result);
  process.exitCode = code;
  console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
}

/**
 * Returns once the GraphQL quota has as many points as `wait` needs (300), so a driver never builds its own loop around `gh`: a
 * refused `gh api graphql` prints the error and may still exit 0. The reset comes from the headers of the answer; after --max-minutes
 * the command ends "still waiting" (exit 4) with the reset time, like `wait`.
 */
async function quotaWait() {
  const result = await poll(() => {
    for (;;) {
      graphql('query{viewer{login}}'); // sleeps first while the last answer showed too few points, and again when a refusal comes
      if (!(quota?.remaining < sleepers[command])) return { done: true }; // an answer without headers is an answer
      sleepUntilReset(quota.resetAt);
    }
  });
  if (result) console.log(['DONE', quotaLine()].join('\n'));
}

// OWNER/REPO#N names a blocker in another repository; N or #N one in this project's repository.
const blockerRepository = reference => reference.includes('/') ? reference.slice(0, reference.lastIndexOf('#')) : project.repository;
const validBlocker = reference => /^\d+$/.test(reference.slice(reference.lastIndexOf('#') + 1))
  && /^[\w.-]+\/[\w.-]+$/.test(blockerRepository(reference));

function block() {
  const [blockerOwner, blockerName] = blockerRepository(value).split('/');
  const blockerNumber = value.slice(value.lastIndexOf('#') + 1);
  const { id } = named(`${blockerOwner}/${blockerName}#${blockerNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
    { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue ?? assert.fail('issue not found'));
  graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
    { issue: readIssue().id, blocker: id });
  console.log(`${project.repository}#${number} is blocked by ${blockerOwner}/${blockerName}#${blockerNumber}`);
}

// Attaches CHILD as a native sub-issue of ISSUE and reads the parent link back; an existing link is a success.
function sub() {
  const [childOwner, childName] = blockerRepository(value).split('/');
  const childNumber = Number(value.slice(value.lastIndexOf('#') + 1));
  const read = () => named(`${childOwner}/${childName}#${childNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id parent{number repository{nameWithOwner}}}}}`,
    { owner: childOwner, name: childName, number: childNumber }).repository.issue ?? assert.fail('issue not found'));
  const underParent = ({ parent }) => parent?.number === number && parent.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase();
  const child = read();
  // Without replaceParent GitHub refuses a child that already has another parent; that error is left to surface.
  if (!underParent(child)) graphql(`mutation($issue:ID!,$sub:ID!){addSubIssue(input:{issueId:$issue,subIssueId:$sub}){issue{number}}}`,
    { issue: readIssue().id, sub: child.id });
  assert.ok(underParent(read()), `#${number} did not take ${value} as sub-issue (read-back shows another parent)`);
  console.log(`${project.repository}#${number} has sub-issue ${childOwner}/${childName}#${childNumber}`);
}

const commands = { next, check: () => check(readIssue(true), { session: sessionOption() }), block, sub, status: () => set('Status'), priority: () => set('Priority'), field: setField, new: create,
  reviews: reviewsOnce, wait, 'quota-wait': quotaWait, handoff, merge, ready, link, body, 'body-replace': bodyReplace };
const usage = 'Usage: board.mjs [--cwd PROJECT_DIR] next | check ISSUE [--session ID] | status ISSUE "In progress" | priority ISSUE High | field ISSUE NAME VALUE [NAME VALUE ...]'
  + ' | new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--field NAME=VALUE ...] [--start --agent claude|codex --session ID]'
  + ' | new --from FILE'
  + ' | status ISSUE "Automated review" PR [OTHER_ISSUE...] | field ISSUE Status "Automated review" PR [OTHER_ISSUE...]'
  + ' | block ISSUE BLOCKER | sub PARENT CHILD | reviews PR [--stall MINUTES] [--grace MINUTES] | wait PR [--stall MINUTES] [--grace MINUTES] [--head SHA] [--max-minutes N] [--interval SECONDS] | wait PR --merged [--max-minutes N]'
  + ' | quota-wait [--max-minutes N]'
  + ' | handoff ISSUE PR [--stall MINUTES] [--grace MINUTES] [--interval SECONDS]'
  + ' | merge PR [--stall MINUTES] [--grace MINUTES] [--interval SECONDS] [--max-minutes N]'
  + ' | ready PR SHA|--local [--attempts N] [--interval SECONDS]'
  + ' | link ISSUE PR | body ISSUE FILE BASE_FILE | body-replace ISSUE --from FILE --to FILE';
// --help (-h) is the one flag that never writes: usage on stdout, success.
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(usage);
  process.exit(0);
}
// A writing command takes only its own flags (value 1: followed by a value) and as many plain words as it names (the issue or PR
// included); any other argument is a mistake that must not reach a write. `field` and `status ISSUE "Automated review"` check their own trailing words.
const writeArgs = { status: { words: 2 }, priority: { words: 2 }, field: { words: Infinity }, block: { words: 2 }, sub: { words: 2 }, link: { words: 2 },
  body: { words: 3 }, 'body-replace': { words: 1, flags: { '--from': 1, '--to': 1 } },
  new: { words: 0, flags: { '--title': 1, '--body-file': 1, '--milestone': 1, '--label': 1, '--priority': 1, '--field': 1, '--start': 0, '--agent': 1, '--session': 1, '--from': 1 } },
  ready: { words: 2, flags: { '--local': 0, '--attempts': 1, '--interval': 1 } }, handoff: { words: 2, flags: { '--stall': 1, '--grace': 1, '--interval': 1 } },
  merge: { words: 1, flags: { '--stall': 1, '--grace': 1, '--interval': 1, '--max-minutes': 1 } } };
function refusesArguments() {
  const { words, flags = {} } = writeArgs[command], args = process.argv.slice(3);
  let given = 0;
  for (let index = 0; index < args.length; index++) {
    if (Object.hasOwn(flags, args[index])) index += flags[args[index]];
    else if (/^-./.test(args[index])) return true; // a lone "-" is a file name (`body ISSUE - BASE`), not a flag
    else given++;
  }
  const allowed = command === 'status' && /^automated review$/i.test(value ?? '') ? Infinity : words - (args.includes('--local') ? 1 : 0);
  return given > allowed;
}
if (Object.hasOwn(writeArgs, command) && refusesArguments()) {
  console.error(usage);
  process.exit(2);
}
if (['reviews', 'wait', 'handoff', 'merge'].includes(command) && !(Number.isFinite(projectGrace) && projectGrace >= 0)) {
  console.error('reviewerGraceMinutes in .github/workflow-project.json must be a number of minutes, 0 or more (0 turns the grace off); omit the field for the default');
  process.exit(2);
}
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (command === 'ready' && Number.isSafeInteger(number) && !/^[0-9a-f]{7,40}$/i.test(value ?? '')) {
    console.error(`ready needs a commit id of 7 to 40 characters (git rev-parse HEAD) or --local, not ${value ? `"${value}"` : 'nothing'}`);
  process.exit(2);
}
if (command === 'wait' && Number.isSafeInteger(number) && value !== '--merged' && headOption() !== undefined && !/^[0-9a-f]{7,40}$/i.test(headOption())) {
  console.error(`wait --head needs a commit id of 7 to 40 characters (git rev-parse HEAD), not ${headOption() ? `"${headOption()}"` : 'nothing'}`);
  process.exit(2);
}
if (!commands[command] || (!['next', 'new', 'quota-wait'].includes(command) && !Number.isSafeInteger(number))
  || (['status', 'priority'].includes(command) && !/^[\w -]+$/.test(value ?? ''))
  // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
  || (command === 'field' && !(process.argv.length > 5 && process.argv.slice(4).every(text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text))))
  // A misspelled flag must not silently turn the session check off.
  || (command === 'check' && process.argv.length > 4 && !(process.argv.length === 6 && process.argv[4] === '--session' && /^\w[\w.-]*$/.test(process.argv[5])))
  || (['reviews', 'wait', 'handoff', 'merge'].includes(command) && !(stallOption() > 0 && graceOption() >= 0 && Number.isFinite(graceOption())))
  // sleep(NaN) would wait forever.
  || (['handoff', 'merge'].includes(command) && !(numberOption('--interval', 3) >= 0 && numberOption('--interval', 3) <= 60))
  // wait: a fixed pause between reads instead of the growing one (60 to 300 s).
  || (command === 'wait' && !(numberOption('--interval', 60) >= 0 && numberOption('--interval', 60) <= 300))
  // --head is the id of the pushed commit (git rev-parse HEAD, 7 to 40 characters), as for ready; a missing one would wait on a head that never matches.
  || (headOption() !== undefined && (command !== 'wait' || value === '--merged' || !/^[0-9a-f]{7,40}$/i.test(headOption())))
  // 0 = no limit; a missing or non-numeric value must not silently mean that.
  || (process.argv.includes('--max-minutes') && (!['wait', 'merge', 'quota-wait'].includes(command) ||!(numberOption('--max-minutes', 9) >= 0 && Number.isFinite(numberOption('--max-minutes', 9)))))
  || (['handoff', 'link'].includes(command) && (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
  || (command === 'ready' && (!/^[0-9a-f]{7,40}$/i.test(value ?? '') || !readyOptionsBounded()))
  || (command === 'body' && !(value && process.argv[5]))
  || (command === 'body-replace' && !(process.argv.length === 8 && value === '--from' && process.argv[6] === '--to' && process.argv[5] && process.argv[7]))
  || (['block', 'sub'].includes(command) && !validBlocker(value ?? ''))) {
  console.error(usage);
  process.exit(2);
}
// field, status, priority and new report a failure as one "ERROR - reason" line: their output (verdicts, backlinks, confirmations)
// is held until the command succeeds, so no failed call shows a write or a check as confirmed. The other commands keep ERROR
// with "- reason" below it.
const oneLine = ['field', 'status', 'priority', 'new'].includes(command), print = console.log, held = [];
if (oneLine) console.log = (...parts) => held.push(parts.join(' '));
try {
  await commands[command]();
  console.log = print;
  for (const line of held) print(line);
} catch (error) {
  console.log = print;
  // A failed read is never "no blockers" and never a finished review.
  if (!['check', 'reviews', 'wait', 'quota-wait', 'handoff', 'merge', 'ready', 'link', 'body', 'body-replace', 'field', 'status', 'priority', 'new'].includes(command)) throw error;
  const message = String(error.stderr || error.message).trim();
  console.log(oneLine ? `ERROR - ${message.replace(/\s*\n\s*/g, ' ')}` : `${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${message}`);
  process.exitCode = 2;
}
