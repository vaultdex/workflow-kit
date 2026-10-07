// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs next | check | status | priority | field | new | block | sub | reviews | wait | merge (see usage below).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { externalTool } from './checkout-root.mjs';

const [command, ref, value] = process.argv.slice(2);
const project = JSON.parse(readFileSync('.github/workflow-project.json', 'utf8'));
const [owner, name] = project.repository.split('/');
// `new` has no issue yet and assigns the number it creates.
let number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd());

function graphql(query, variables = {}) {
  // Organization-linked Priority fields live on the issue and need this preview header.
  const args = ['api', 'graphql', '-H', 'GraphQL-Features: issue_fields', '-f', `query=${query}`];
  for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
  return JSON.parse(execFileSync(gh.file, args, { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 })).data;
}

// A predecessor with the PRs that close it (closed ones included, so a merged one stays visible; stackBase keeps open and merged): the base of a stack is found through the native closing links (manual ones included).
const predecessorFields = `number state stateReason repository{nameWithOwner}
  closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number state isDraft isCrossRepository repository{nameWithOwner} baseRefName headRefName headRefOid}}`;
// Everything the verdict reads; sub-issues carry the same fields, so their verdict needs no further query. Only the issue
// itself reads the PRs of its predecessors (to find a stack base); the sub-issues' verdicts stay without them.
const issueFields = predecessor => `id number title state body repository{nameWithOwner} assignees(first:10){nodes{login}}
  projectItems(first:100){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
  blockedBy(first:100){totalCount nodes{${predecessor}}}`;
// ponytail: closedByPullRequestsReferences lists open PRs with a closing link only (a plain mention is none); sub-issues stop at 100, shown with a note.
const issueQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
  ${issueFields(predecessorFields)} bodyHTML
  closedByPullRequestsReferences(first:100){totalCount nodes{number state repository{nameWithOwner}}}
  subIssues(first:100){totalCount nodes{${issueFields('number state stateReason repository{nameWithOwner}')}}}}}}`;
/** Names the issue in failures (a bare "Could not resolve to an Issue" hides which repository was meant). */
const named = (label, read) => {
  try { return read(); } catch (error) { throw new Error(`${label}: ${String(error.stderr || error.message).trim()}`, { cause: error }); }
};
const readIssue = () => named(`${project.repository}#${number}`,
  () => graphql(issueQuery, { owner, name, number }).repository.issue ?? assert.fail('issue not found'));
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

/**
 * The one PR a dependent issue can be stacked on (docs/CONTRIBUTING.md#stacked-pull-requests): every open predecessor
 * lives in this repository and is delivered by the same single open, ready PR from a branch of this repository. Anything else
 * says why not (`refused`); incomplete PR data is `unknown`, never "no PR". A delivering PR that is already merged (into a
 * release branch, where the predecessor issue stays open until the release) is the base too: the layer above it is then a plain
 * PR on the trunk, `pr.state` says MERGED.
 */
function stackBase(open) {
  const refused = [], unknown = [], prs = new Map();
  for (const predecessor of open) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    const links = predecessor.closedByPullRequestsReferences;
    if (predecessor.repository.nameWithOwner.toLowerCase() !== project.repository.toLowerCase()) refused.push(`${label} is in another repository`);
    else if (!links?.nodes || links.nodes.filter(Boolean).length < links.totalCount) unknown.push(`the pull requests of ${label} are not completely readable`);
    else {
      const delivering = links.nodes.filter(pr => ['OPEN', 'MERGED'].includes(pr.state));
      if (!delivering.length) refused.push(`${label} has no open or merged PR`);
      // A closing keyword can also come from a PR of another repository, which is no local branch to stack on.
      for (const pr of delivering) {
        if (pr.repository?.nameWithOwner?.toLowerCase() === project.repository.toLowerCase()) prs.set(pr.number, pr);
        else refused.push(`PR #${pr.number} of ${label} belongs to ${pr.repository?.nameWithOwner ?? 'an unreadable repository'}`);
      }
    }
  }
  if (!refused.length && !unknown.length && prs.size > 1) refused.push(`the predecessors are delivered by ${prs.size} PRs (#${[...prs.keys()].join(', #')}), not one`);
  const [pr] = prs.values();
  if (!refused.length && !unknown.length && pr.state === 'OPEN') {
    if (pr.isDraft) refused.push(`PR #${pr.number} is still Draft`);
    if (pr.isCrossRepository) refused.push(`PR #${pr.number} comes from a fork`);
  }
  return { pr: refused.length || unknown.length ? undefined : pr, refused, unknown };
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
const claimField = /^Agent:[ \t]*(claude|codex)[ \t]*,[ \t]*Session:[ \t]*(\w[\w.-]*)(?![\w.-])/im;
const handoverField = /^Handover:[ \t]*(\w[\w.-]*)[ \t]*$/im;
// ponytail: sessions are told apart by the id the driver passes, not authenticated; Claude and Codex share one login.
/** Blocks when the newest claim or handover of the own login belongs to another session; claims without the field only note. */
function claimReasons(issue, session) {
  const { viewer } = graphql('query{viewer{login}}');
  assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
  let holder, legacy;
  // GitHub lists comments oldest first, so for equal times the later one in order wins.
  for (const comment of restAll(`repos/${project.repository}/issues/${issue.number}/comments`)) {
    if (comment.user?.login?.toLowerCase() !== viewer.login.toLowerCase()) continue;
    const body = comment.body ?? '', claim = claimField.exec(body), handover = handoverField.exec(body);
    if (handover) [holder, legacy] = [{ session: handover[1], comment }, undefined];
    else if (claim) [holder, legacy] = [{ agent: claim[1], session: claim[2], comment }, undefined];
    // A claim without the field names no session: it never lifts a known holder, it is only shown.
    else if (/^Claim:/m.test(body)) legacy = comment;
  }
  const notes = [], blocked = [];
  const about = ({ agent, session: id, comment }) => `${agent ? `Agent ${agent}, ` : ''}Session ${id}, ${comment.created_at}, ${comment.html_url}`;
  if (holder && session && holder.session !== session) blocked.push(`claimed by another session (${about(holder)}); needs a handover to ${session}`);
  else if (holder && !session) notes.push(`newest claim: ${about(holder)}; pass --session ID to compare it with yours`);
  if (legacy) notes.push(`claim without Agent/Session field, session unknown: ${legacy.html_url}`);
  return { blocked, notes, claim: holder ?? (legacy && { session: undefined, comment: legacy }) };
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
function check(issue = readIssue(), claims) {
  const { status, blocked, unknown, predecessors } = issueReasons(issue);
  const notes = [];
  let claim;
  if (claims) try {
    const found = claimReasons(issue, claims.session);
    blocked.push(...found.blocked);
    notes.push(...found.notes);
    claim = found.claim;
  } catch (error) { unknown.push(`claim comments are unreadable: ${String(error.stderr || error.message).trim()}`); }
  // Only open predecessors hold the issue (no other blocker, not even a claim or a status): look for the PR to stack on.
  stackedOn = undefined;
  if (heldOnlyByOpenPredecessors(blocked, predecessors) && !unknown.length) {
    const stack = stackBase(predecessors.open);
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
    : `stack base: PR #${stackedOn.number} (branch ${stackedOn.headRefName}, base ${stackedOn.baseRefName}); see docs/CONTRIBUTING.md#stacked-pull-requests`);
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
  // from crowding unblocked ones out of the 1,000-result search cap; read every page of both before sorting.
  const nodes = [];
  for (const blocking of ['-is:blocked', 'is:blocked']) for (let after, read = 0; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:100,after:$after){
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
  const stackable = ready.filter(issue => issue.reasons.length && heldOnlyByOpenPredecessors(issue.reasons, issue.predecessors))
    .map(issue => ({ ...issue, base: stackBase(issue.predecessors.open).pr })).filter(issue => issue.base);
  const held = ready.filter(issue => issue.reasons.length && !stackable.some(candidate => candidate.number === issue.number));
  for (const issue of startable) console.log(line(issue));
  console.log(startable.length ? 'Run board.mjs check ISSUE --session ID before claiming one.' : 'No Ready issue whose blockers are all completed.');
  if (stackable.length) console.log('\nReady and stackable on an open PR (check ISSUE shows STACKABLE; see docs/CONTRIBUTING.md#stacked-pull-requests):');
  for (const issue of stackable) console.log(`${line(issue)}\n  - base PR #${issue.base.number} (${issue.base.state === 'MERGED' ? `merged into ${issue.base.baseRefName}` : `branch ${issue.base.headRefName}`})`);
  if (held.length) console.log('\nReady but not startable:');
  for (const issue of held) console.log([line(issue), ...issue.reasons.map(reason => `  - ${reason}`)].join('\n'));
}

/** A single-select Project field with its options in configured order. */
function selectField(fieldName) {
  const fields = graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:100){nodes{...on ProjectV2SingleSelectField{
    id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: project.id })
    .node.fields.nodes.filter(candidate => candidate.name && candidate.options);
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
  if (fieldName === 'Status' && option.name === 'Automated review') verifyBacklinks();
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
 * Create an issue with everything the workflow requires and read every value back. All inputs are checked before the
 * issue exists (Project fields, milestone, labels, start prerequisites); a failure after it names the issue so it is
 * finished by hand, never created twice. `--start` then runs the start steps: Ready, assignee, claim, In progress.
 */
function create() {
  const options = newOptions(process.argv.slice(3));
  const { title, bodyFile, milestone, priority, agent, session, start } = options;
  for (const [flag, text] of [['--title', title], ['--body-file', bodyFile], ['--milestone', milestone], ['--priority', priority]]) assert.ok(text, `new: ${flag} is required`);
  assert.ok(options.labels.length, 'new: at least one --label is required');
  if (start) {
    assert.ok(['claude', 'codex'].includes(agent) && /^\w[\w.-]*$/.test(session ?? ''), 'new: --start needs --agent claude|codex and --session ID (the claim comment)');
  } else assert.ok(!agent && !session, 'new: --agent and --session belong to --start');
  const text = readFileSync(bodyFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  assert.ok(text, `new: ${bodyFile} is empty`);
  // Status is set by the command: Backlog, or Ready then In progress with --start.
  const pairs = [['Status', start ? 'Ready' : 'Backlog'], ['Priority', priority], ...options.fields];
  assert.ok(!options.fields.some(([fieldName]) => ['status', 'priority'].includes(fieldName.toLowerCase())), 'new: Status and Priority are not --field values (use --priority; --start sets Status)');
  for (const required of project.requiredFields ?? []) {
    assert.ok(pairs.some(([fieldName]) => fieldName.toLowerCase() === required.toLowerCase()), `new: the project requires ${required}: add --field ${required}=VALUE`);
  }
  const plans = planFields(pairs), progress = start ? planFields([['Status', 'In progress']]) : [];
  const exact = (list, wanted, key) => list.find(item => item[key].toLowerCase() === wanted.toLowerCase());
  const found = exact(restAll(`repos/${project.repository}/milestones`), milestone, 'title');
  assert.ok(found, `new: ${project.repository} has no open milestone "${milestone}"`);
  const known = restAll(`repos/${project.repository}/labels`);
  // The REST API would silently create an unknown label.
  // A repeated label (any casing) is one label: GitHub stores it once, and the read-back compares exactly.
  const labels = [...new Set(options.labels.map(label => exact(known, label, 'name')?.name ?? assert.fail(`new: ${project.repository} has no label "${label}"`)))];
  let viewer;
  if (start) {
    viewer = graphql('query{viewer{login}}').viewer?.login;
    assert.ok(viewer, 'Cannot verify the authenticated GitHub user');
    const waits = waitReasons(text);
    assert.ok(!waits.blocked.length && !waits.unknown.length, `new: the issue would not be startable: ${[...waits.blocked, ...waits.unknown].join('; ')}`);
  }
  let created;
  try {
    created = JSON.parse(execFileSync(gh.file, ['api', `repos/${project.repository}/issues`, '-X', 'POST', '--input', '-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: JSON.stringify({ title, body: text, milestone: found.number, labels, ...start && { assignees: [viewer] } }) }));
    assert.ok(Number.isSafeInteger(created?.number) && created.html_url, 'GitHub did not report the new issue');
  } catch (error) {
    // A lost or unreadable answer does not prove that nothing was created.
    throw new Error(`creating the issue failed (${String(error.stderr || error.message).trim()}); it may exist anyway: search ${project.repository} for "${title}" before trying again`, { cause: error });
  }
  number = created.number;
  let step = 'reading it back';
  try {
    const stored = rest(`repos/${project.repository}/issues/${number}`);
    assert.equal(stored.milestone?.title, found.title, `Read-back of the milestone shows ${stored.milestone?.title ?? 'none'}`);
    assert.deepEqual(stored.labels.map(label => label.name).sort(), [...labels].sort(), 'Read-back of the labels differs');
    if (start) assert.ok(stored.assignees.some(assignee => assignee.login.toLowerCase() === viewer.toLowerCase()), 'Read-back of the assignee differs');
    step = 'setting the Project fields';
    applyFields(readIssue(), plans);
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
    // Later plans replace earlier ones of the same field (Status: Ready, then In progress).
    const values = Object.entries(Object.fromEntries([...plans, ...progress].map(plan => [plan.fieldName, plan.option.name])));
    console.log([`NEW ${created.html_url}`, `milestone: ${found.title}`, `labels: ${labels.join(', ')}`,
      ...values.map(([fieldName, value]) => `${fieldName}: ${value}`), ...start ? [`assignee: ${viewer}`, `claim: ${claim}`] : []].join(' | '));
  } catch (error) {
    throw new Error(`${created.html_url} was created, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field/status, do not create it again`, { cause: error });
  }
}

// Reviewers run unreliably, so only traces on the current head count (docs/CONTRIBUTING.md#review-loop).
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number state isDraft createdAt headRefName headRefOid baseRefName mergeStateStatus reviewDecision
  readyEvents:timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  firstReadyEvents:timelineItems(first:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  convertEvents:timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}
  latestOpinionatedReviews(first:100){totalCount nodes{state author{login}}}
  commits(last:1){nodes{commit{oid committedDate checkSuites(first:100){totalCount nodes{createdAt status conclusion app{slug} workflowRun{databaseId workflow{id}} checkRuns(first:1){totalCount}}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title detailsUrl checkSuite{databaseId createdAt app{slug} workflowRun{databaseId event workflow{id name}}}}
      ...on StatusContext{context state description creator{login}}}}}}}}
  reviewRequests(first:100){totalCount nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
  requestEvents:timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT]){totalCount nodes{...on ReviewRequestedEvent{createdAt
    requestedReviewer{...on User{login} ...on Bot{login} ...on Team{name}}}}}}}}`;
// ponytail: checks, check suites, review requests and opinionated reviews stop at 100 with ERROR, never a wrong verdict; paginate when a project gets there.

/** Links of unresolved review threads across every page, including findings on earlier heads. */
function unresolvedThreads(prNumber = number) {
  const links = [];
  for (let after; ;) {
    const { reviewThreads } = graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
        nodes{isResolved comments(first:1){nodes{url}}}}}}}`,
    { owner, name, number: prNumber, ...(after && { after }) }).repository.pullRequest;
    links.push(...reviewThreads.nodes.filter(thread => !thread.isResolved).map(thread => thread.comments.nodes[0]?.url ?? 'unreadable thread'));
    if (!reviewThreads.pageInfo.hasNextPage) return links;
    assert.ok(reviewThreads.pageInfo.endCursor && reviewThreads.pageInfo.endCursor !== after, 'Thread pagination did not advance');
    after = reviewThreads.pageInfo.endCursor;
  }
}
const rest = path => JSON.parse(execFileSync(gh.file, ['api', path], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 }));
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
  const positive = ref => /^\d+$/.test(ref ?? '') && Number.isSafeInteger(Number(ref)) && Number(ref) > 0;
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
    const backlink = findBacklink(issueComments(repository, issueNumber), url);
    assert.ok(backlink, `Missing backlink to ${pr.url} on #${issueNumber}; ${repository === project.repository
      ? `run board.mjs link ${issueNumber} ${prNumber}` : 'post the full URL as a comment'} and retry`);
    console.log(`backlink ${issueRef}: ${backlink.html_url}`);
  }
}
const login = user => user?.login?.replace(/\[bot\]$/, '');
const isBot = user => user?.type === 'Bot';
// "optionalReviewers" lists bot logins or app slugs whose traces are shown but never awaited, stalled or counted as red
// (a review bot on a free plan that is rate limited most of the time). Their open threads and change requests still block.
const reviewerKey = name => name?.trim().toLowerCase().replace(/^(@|app\/)/, '').replace(/\[bot\]$/, '');
// Read on use, so a malformed list is an ERROR of the review commands, not a crash of every command.
const optionalReviewers = () => {
  const list = project.optionalReviewers ?? [];
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
  api.search = new URLSearchParams({ componentKeys: key, pullRequest: String(prNumber), issueStatuses: 'OPEN,CONFIRMED', ps: '1' });
  const body = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const r = await fetch(process.argv[1], { headers: { Authorization: 'Bearer ' + process.env.SONAR_TOKEN } });
     if (!r.ok) throw new Error('Sonar API answered ' + r.status);
     process.stdout.write(await r.text());`, api.href], { encoding: 'utf8', maxBuffer: 16 << 20 });
  const { total } = JSON.parse(body);
  assert.ok(Number.isSafeInteger(total) && total >= 0, 'Sonar issue count is unreadable');
  return total;
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

/** One look at the PR head: done or still waiting, and whether CI failed; read failures throw. */
function reviews(stallMinutes = 20, now = Date.now(), prNumber = number, pr = readPr(prNumber), graceMinutes = graceOption()) {
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
      const shown = moved.shared.slice(0, 10).join(', ') + (moved.shared.length > 10 ? `, and ${moved.shared.length - 10} more` : '');
      lines.push(moved.shared.length ? `changed on both sides: ${shown}` : 'no file is changed on both sides');
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
  // ponytail: 10 s window for run creation lag after opening as Draft or a Draft conversion (a real Ready run inside it waits for the next push), and a Draft skip of an earlier period stays unseen
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
  const sinceReady = check => startedAt(check) >= readyBoundary;
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
  for (const label of draftSkipped) waiting.push({ text: `check ${label} was skipped while Draft; no run since Ready`, since: Infinity });
  // The quality gate judges new conditions only, so a green SonarCloud check can sit on open issues. Count them once the analysis is final; a skipped check ran no analysis.
  for (const check of current.filter(check => check.checkSuite?.app?.slug === 'sonarqubecloud' && check.status === 'COMPLETED' && check.conclusion !== 'SKIPPED')) {
    const open = sonarIssues(check.detailsUrl, pr.number);
    lines.push(`sonar: ${open} open issue${open === 1 ? '' : 's'}`);
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
  for (const reaction of reactions.filter(reaction => isBot(reaction.user) && !isOptional(reaction.user.login) && after(reaction.created_at))) {
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
  // pushed, whichever is later, a missing trace is no answer yet.
  const readyAt = Math.max(...[pr.createdAt, ...(pr.readyEvents?.nodes ?? []).map(event => event.createdAt)].filter(Boolean).map(Date.parse));
  if (!pr.isDraft && graceMinutes > 0) {
    const graceFrom = Math.max(readyAt, pushed, headSetAt(pr, pushes()));
    if (now - graceFrom < graceMinutes * 60_000) {
      waiting.push({ text: `reviewers may still start until ${new Date(graceFrom + graceMinutes * 60_000).toISOString()}`, since: Infinity });
    }
  }
  for (const review of reviewList.filter(review => review.commit_id === pr.headRefOid)) lines.push(`review ${login(review.user)} ${review.state} ${review.html_url}`);
  for (const comment of comments.filter(comment => after(comment.updated_at))) lines.push(`comment ${login(comment.user)} ${comment.html_url}`);
  for (const comment of inline.filter(comment => after(comment.updated_at))) lines.push(`inline ${login(comment.user)} ${comment.html_url}`);
  const threads = unresolvedThreads(pr.number);
  lines.push(`unresolved threads: ${threads.length}`, ...threads.map(link => `thread ${link}`));
  // Mergeable is not merge-ready: a standing change request, a ruleset or conflicts still block the human.
  lines.push(`merge: ${pr.mergeStateStatus}, review decision: ${pr.reviewDecision ?? 'none'}`);
  assert.equal(pr.latestOpinionatedReviews.nodes.length, pr.latestOpinionatedReviews.totalCount, 'Not every review decision is readable');
  for (const review of pr.latestOpinionatedReviews.nodes.filter(review => review.state === 'CHANGES_REQUESTED')) {
    lines.push(`blocker: changes requested by ${login(review.author)}`);
  }
  if (pr.mergeStateStatus === 'DIRTY') lines.push('blocker: merge conflicts'); // a non-draft PR returned above
  // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
  for (const entry of waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
  const pending = waiting.filter(entry => !stalled(entry.since));
  for (const entry of pending) lines.push(`waiting: ${entry.text}`);
  // A known failure ends the wait at once: the fix starts now, whatever else is still running.
  return { done: failed || !pending.length, failed, lines, pr, comments };
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
function link() {
  const prNumber = Number(value);
  const issue = readIssue();
  assert.ok(issue?.id, 'Issue identity is unreadable');
  // The backlink comment belongs on an open issue (the guard requires one); refuse before any write instead of half-way.
  assert.equal(issue.state, 'OPEN', `#${number} is not an open issue`);
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){id number state url headRefOid}}}`, { owner, name, number: prNumber }).repository;
  assert.ok(pr?.id && pr.number === prNumber && pr.state === 'OPEN', `#${value} is not an open pull request of ${project.repository}`);
  // Already connected is a success without a write; a Draft PR can be connected too.
  if (!connectedIssues(pr, true).has(issue.id)) {
    graphql('mutation($issue:ID!,$pr:ID!){addCloseIssueReferences(input:{issueId:$issue,pullRequestIds:[$pr]}){clientMutationId}}',
      { issue: issue.id, pr: pr.id });
    // GitHub shows the new connection with a delay (seen live: the first read-back right after the write was empty).
    // Read back a few times; the write is never repeated.
    for (let attempt = 1; !connectedIssues(pr, true).has(issue.id); attempt++) {
      assert.ok(attempt < 5, `Native link read-back differs: PR #${value} does not close issue #${number}`);
      sleep(1);
    }
  }
  console.log(`#${number} is natively linked to PR #${value}`);
  // An existing comment is a success without a write. The text goes over stdin, like in `body`; the guard's reader proves it.
  const prUrl = new URL(pr.url);
  let backlink = findBacklink(issueComments(project.repository, number), prUrl);
  if (!backlink) {
    execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${number}/comments`, '-X', 'POST', '-F', 'body=@-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: `PR: ${pr.url}\n` });
    backlink = findBacklink(issueComments(project.repository, number), prUrl);
    assert.ok(backlink, `Backlink read-back differs: the comment with ${pr.url} is not readable on #${number}; read the comments before writing again`);
  }
  console.log(`backlink #${number}: ${backlink.html_url}`);
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

/** Revalidate active readiness, review status and assignment on the supplied issue snapshot. */
/** `reviewedHead`: the PR head the proof was gathered for; a stacked layer must still be that head when this reads it. */
function handoffIssue(issue, viewer, reviewedHead) {
  if (!mayStart(check(issue))) return false;
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
      if (!Array.isArray(stacks) || !stacks.some(stack => stack.open !== false && [stackedOn.number, Number(value)].every(prNumber => stack.pull_requests?.some(member => member.number === prNumber)))) {
        reasons.push(`PR #${value} and PR #${stackedOn.number} are not linked as a stack on GitHub (GET repos/${project.repository}/stacks?pull_request=${value} lists none): link them (docs/CONTRIBUTING.md#stacked-pull-requests) or stop`);
      }
      // Proof of the upper head only counts when that head contains the base PR's current head (a later push below leaves the branch name unchanged).
      if (!reasons.length && pr?.baseRefName === stackedOn.headRefName) {
        const { status } = rest(`repos/${project.repository}/compare/${stackedOn.headRefOid}...${pr.headRefOid}`);
        if (!['ahead', 'identical'].includes(status)) reasons.push(`PR #${value} does not contain the current head ${stackedOn.headRefOid.slice(0, 7)} of PR #${stackedOn.number} (compare says ${status}): rebase onto it and push with the lease`);
      }
      if (pr?.baseRefName !== stackedOn.headRefName) reasons.push(`the open predecessor PR #${stackedOn.number} is not merged: PR #${value} must target its branch ${stackedOn.headRefName}, not ${pr?.baseRefName}`);
    }
  }
  if (!['Automated review', 'Human review'].includes(status)) reasons.push('finish implementation and Automated review first');
  if (!issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase())) {
    reasons.push('the issue is not assigned to the authenticated driver');
  }
  for (const line of openAcceptance(issue.bodyHTML)) reasons.push(`open acceptance without an issue reference (check it off, or move it to a follow-up and link that issue): ${line}`);
  if (reasons.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * The driver's handoff comment: a "## Übergabe" heading and a "Head: <SHA>" line in a PR comment by the authenticated
 * user. The comment names the head it is about, so a new head asks for a new comment however (and whenever) the push
 * happened, which no timestamp reliably tells. Of its content only the retro section is judged, see `retroReasons`;
 * with several matching comments the newest counts.
 */
const findHandoffComment = (comments, viewer, headRefOid) => comments.findLast(comment => comment.user?.login?.toLowerCase() === viewer.login.toLowerCase()
  && /^## Übergabe\s*$/m.test(comment.body ?? '') && new RegExp(`^Head:\\s*${headRefOid.slice(0, 7)}`, 'im').test(comment.body ?? ''));

/**
 * Why the retro section of the handoff comment, as GitHub renders it, does not pass: a heading "Retro" with one list
 * line per finding, each ending with its resolution (an issue link, "behoben in <SHA>", "persönlich gemeldet" or
 * "kein Handlungsbedarf: <Grund>"), or the single line "Keine Funde". Whether a finding is justified is not judged.
 * GitHub's rendering decides what a heading, a list line and an issue reference are, so no Markdown is parsed here.
 */
// ponytail: relies on GitHub's markup (h1-h6, li, issue-link); replace when GitHub changes it.
function retroReasons(bodyHtml) {
  assert.equal(typeof bodyHtml, 'string', 'The rendered handoff comment is unreadable');
  const text = html => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
  const section = bodyHtml.split(/(?=<h[1-6][\s>])/).find(part => /^<h[1-6][\s>]/.test(part) && text(part.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/)?.[1] ?? '') === 'Retro');
  const lines = [...(section ?? '').matchAll(/<li[^>]*>([\s\S]*?)(?=<\/li>|<[uo]l[\s>]|<li[\s>])/g)].map(([, line]) => [line, text(line)]);
  if (!lines.length) return ['the handoff comment needs a "Retro" section with one list line per finding, each ending with its resolution, or the single line "Keine Funde" (README: Handoff comment)'];
  if (lines.length === 1 && /^keine funde\.?$/i.test(lines[0][1])) return [];
  // The last element must be an issue link (GitHub renders a pull request reference the same way, but with /pull/N); a loose list wraps the line in <p>.
  const endsWithIssue = html => { const anchor = html.match(/(<a [^>]*>)[^<]*<\/a>\s*(?:<\/p>\s*)?$/)?.[1] ?? ''; return anchor.includes('class="issue-link') && /href="[^"]*\/issues\/\d+"/.test(anchor); };
  return lines.filter(([html, line]) => !(endsWithIssue(html) || /\bbehoben in [0-9a-f]{7,40}$/i.test(line)
    || /persönlich gemeldet$/i.test(line) || /\bkein Handlungsbedarf: \S/i.test(line)))
    .map(([, line]) => `retro line without a resolution (end it with an issue link, "behoben in <SHA>", "persönlich gemeldet" or "kein Handlungsbedarf: <Grund>"): ${line}`);
}

/**
 * The PR gate handoff and merge share: an open non-draft PR whose CI and every traced review have finished, without
 * blockers or open threads, and with a determined merge state. Prints the verdict and sets the exit code; returns the
 * review result only when it holds. `extra` adds the caller's own reasons (it runs only once the shared gate holds).
 */
function finishedPr(prNumber, action, expectedHead, extra = () => []) {
  const pr = readPr(prNumber);
  assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
  if (pr.state !== 'OPEN' || pr.isDraft) {
    console.log(`FAILED\nblocker: ${action} needs an open non-draft PR`);
    process.exitCode = 1;
    return;
  }
  const result = reviews(stallOption(), Date.now(), prNumber, pr);
  console.log(result.lines.join('\n'));
  if (!result.done || result.failed) {
    process.exitCode = result.failed ? 1 : 3;
    console.log(result.failed ? 'FAILED' : 'WAITING');
    return;
  }
  if (expectedHead) assert.equal(result.pr.headRefOid, expectedHead, `PR head changed during ${action}`);
  const reasons = [];
  if (result.lines.some(line => line.startsWith('blocker:') || /^unresolved threads: [1-9]/.test(line))) {
    reasons.push(`resolve review blockers and threads before ${action}`);
  }
  reasons.push(...extra(result));
  if (!reasons.length && !['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(result.pr.mergeStateStatus)) {
    console.log('WAITING\nwaiting: PR mergeability is not determined');
    process.exitCode = 3;
    return;
  }
  if (reasons.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
    return;
  }
  return result;
}

/** Read all PR gates and native links, optionally requiring the previously checked head. */
function handoffPr(issueId, viewer, expectedHead) {
  const result = finishedPr(Number(value), 'handoff', expectedHead, ({ comments, pr }) => {
    const comment = findHandoffComment(comments, viewer, pr.headRefOid);
    if (!comment) return [`post the handoff comment on PR #${value} for the current head: a "## Übergabe" heading, a "Head: ${pr.headRefOid.slice(0, 7)}" line and the "Retro" section (README: Handoff comment)`];
    // The list endpoint renders no HTML unless asked, and then it omits the raw body: one more read for the rendered comment.
    const rendered = JSON.parse(execFileSync(gh.file, ['api', `repos/${project.repository}/issues/comments/${comment.id}`, '-H', 'Accept: application/vnd.github.html+json'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 }));
    return retroReasons(rendered.body_html);
  });
  if (!result) return;
  if (!connectedIssues(result.pr).has(issueId)) {
    console.log(`FAILED\nblocker: PR #${value} is not natively linked to issue #${number}`);
    process.exitCode = 1;
    return;
  }
  return result.pr;
}

/** Guard the Human review write with current PR proof followed by current issue prerequisites. */
function handoff() {
  const issue = readIssue();
  const { viewer } = graphql('query{viewer{login}}');
  assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
  if (!handoffIssue(issue, viewer)) return;
  const pr = handoffPr(issue.id, viewer);
  if (!pr) return;
  if (!set('Status', 'Human review', () => {
    if (!handoffPr(issue.id, viewer, pr.headRefOid)) return;
    const current = readIssue();
    assert.equal(current?.id, issue.id, 'Issue identity changed during handoff');
    return handoffIssue(current, viewer, pr.headRefOid) ? current : undefined;
  })) return;
  assert.equal(projectItem(readIssue())?.status?.name, 'Human review', 'Human review status read-back differs');
  console.log(`HANDOFF #${number} PR #${value} head ${pr.headRefOid}`);
}

/**
 * Merge for agents with merge authority: the same gate as handoff (CI, every traced review finished, no blocker or open
 * thread), then exactly the checked head. `--match-head-commit` needs the full object id, and it also refuses a push that
 * lands after the check, so no recheck window is left to close. Never repeated: a refusal by gh ends as ERROR.
 */
function merge() {
  // Merging an upper layer of a stack merges every open layer below it too (GitHub: "merge the top pull request, every pull
  // request below it comes with it"), so the lower layer goes first, by itself. No Stacks API (404) means no stack.
  const result = finishedPr(number, 'merge', undefined, () => {
    let stacks;
    try { stacks = rest(`repos/${project.repository}/stacks?pull_request=${number}`); } catch (error) {
      if (!/\b404\b|Not Found/.test(String(error.stderr))) throw error;
      stacks = [];
    }
    assert.ok(Array.isArray(stacks), 'The stack membership is unreadable');
    return stacks.flatMap(({ pull_requests: members = [] }) => members.slice(0, Math.max(0, members.findIndex(member => member.number === number)))
      .filter(member => member.state === 'open').map(member => `PR #${member.number} below it in its stack is still open: merge it first, merging this layer would merge it too`));
  });
  if (!result) return;
  const { headRefOid } = result.pr;
  assert.match(headRefOid, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
  execFileSync(gh.file, ['pr', 'merge', String(number), '--repo', project.repository, '--merge', '--match-head-commit', headRefOid],
    { encoding: 'utf8', env: gh.env });
  const { state, mergeCommit } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){state mergeCommit{oid}}}}`, { owner, name, number }).repository.pullRequest;
  assert.equal(state, 'MERGED', `Merge read-back shows #${number} as ${state}`);
  console.log(`MERGED #${number} head ${headRefOid} merge commit ${mergeCommit?.oid}`);
}

const numberOption = (flag, fallback) => process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback;
const stallOption = () => numberOption('--stall', 20);
const graceOption = () => numberOption('--grace', 3);
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
      if (pr.headRefOid !== value.toLowerCase()) return refuse(`PR #${number} is already ready with head ${pr.headRefOid.slice(0, 7)}, not ${value.slice(0, 7)}`);
      return console.log(`READY #${number} head ${pr.headRefOid} (already ready)`);
    }
    if (pr.headRefOid === value.toLowerCase()) break;
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
  console.log([word, ...result.lines].join('\n'));
  process.exitCode = code;
}

/** Waiting for the human merge is the other recurring wait; it ends when the PR is no longer open. */
function mergeState() {
  const { pullRequest } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number state}}}`, { owner, name, number }).repository;
  const open = pullRequest.state === 'OPEN';
  // Closed without merge is the end of the wait, but never a delivery.
  return { done: !open, failed: pullRequest.state === 'CLOSED', lines: [`#${pullRequest.number} ${pullRequest.state}`, ...open ? ['waiting: human merge'] : []] };
}

async function wait() {
  const look = process.argv.includes('--merged') ? mergeState : () => reviews(stallOption());
  let shown;
  for (;;) {
    const result = look(), { done, lines } = result;
    if (done) {
      const [word, code] = outcome(result);
      process.exitCode = code;
      return console.log([word, ...lines].join('\n'));
    }
    // Interim output names what is still awaited, once per change, so a background run is never silent.
    const waiting = lines.filter(line => line.startsWith('waiting:')).join('\n');
    if (waiting !== shown) console.log(`WAITING\n${shown = waiting}`);
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
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

const commands = { next, check: () => check(undefined, { session: sessionOption() }), block, sub, status: () => set('Status'), priority: () => set('Priority'), field: setField, new: create,
  reviews: reviewsOnce, wait, handoff, merge, ready, link, body, 'body-replace': bodyReplace };
const usage = 'Usage: board.mjs next | check ISSUE [--session ID] | status ISSUE "In progress" | priority ISSUE High | field ISSUE NAME VALUE [NAME VALUE ...]'
  + ' | new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--field NAME=VALUE ...] [--start --agent claude|codex --session ID]'
  + ' | status ISSUE "Automated review" PR [OTHER_ISSUE...] | field ISSUE Status "Automated review" PR [OTHER_ISSUE...]'
  + ' | block ISSUE BLOCKER | sub PARENT CHILD | reviews PR [--stall MINUTES] [--grace MINUTES] | wait PR [--stall MINUTES] [--grace MINUTES] | wait PR --merged'
  + ' | handoff ISSUE PR [--stall MINUTES] [--grace MINUTES]'
  + ' | merge PR [--stall MINUTES] [--grace MINUTES]'
  + ' | ready PR SHA [--attempts N] [--interval SECONDS]'
  + ' | link ISSUE PR | body ISSUE FILE BASE_FILE | body-replace ISSUE --from FILE --to FILE';
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (!commands[command] || (!['next', 'new'].includes(command) && !Number.isSafeInteger(number))
  || (['status', 'priority'].includes(command) && !/^[\w -]+$/.test(value ?? ''))
  // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
  || (command === 'field' && !(process.argv.length > 5 && process.argv.slice(4).every(text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text))))
  // A misspelled flag must not silently turn the session check off.
  || (command === 'check' && process.argv.length > 4 && !(process.argv.length === 6 && process.argv[4] === '--session' && /^\w[\w.-]*$/.test(process.argv[5])))
  || (['reviews', 'wait', 'handoff', 'merge'].includes(command) && !(stallOption() > 0 && graceOption() >= 0 && Number.isFinite(graceOption())))
  || (['handoff', 'link'].includes(command) && (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
  || (command === 'merge' && value && !value.startsWith('--'))
  || (command === 'ready' && (!/^[0-9a-f]{40}$/i.test(value ?? '') || !readyOptionsBounded()))
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
  if (!['check', 'reviews', 'wait', 'handoff', 'merge', 'ready', 'link', 'body', 'body-replace', 'field', 'status', 'priority', 'new'].includes(command)) throw error;
  const message = String(error.stderr || error.message).trim();
  console.log(oneLine ? `ERROR - ${message.replace(/\s*\n\s*/g, ' ')}` : `${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${message}`);
  process.exitCode = 2;
}
