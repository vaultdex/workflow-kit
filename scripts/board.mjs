// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs next | check | status | priority | field | block | reviews | wait (see usage below).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { externalTool } from './checkout-root.mjs';

const [command, ref, value] = process.argv.slice(2);
const project = JSON.parse(readFileSync('.github/workflow-project.json', 'utf8'));
const [owner, name] = project.repository.split('/');
const number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd());

function graphql(query, variables = {}) {
  // Organization-linked Priority fields live on the issue and need this preview header.
  const args = ['api', 'graphql', '-H', 'GraphQL-Features: issue_fields', '-f', `query=${query}`];
  for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
  return JSON.parse(execFileSync(gh.file, args, { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 })).data;
}

const issueQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
  id number title state assignees(first:10){nodes{login}}
  projectItems(first:100){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
  blockedBy(first:100){totalCount nodes{number state stateReason repository{nameWithOwner}}}}}}`;
const readIssue = () => graphql(issueQuery, { owner, name, number }).repository.issue;
const projectItem = issue => issue.projectItems.nodes.find(item => item.project.id === project.id);

/** Why native predecessors still hold an issue: open, closed without delivery, or unreadable. */
function predecessorReasons({ totalCount, nodes }) {
  const blocked = [], unknown = [];
  const readable = nodes.filter(Boolean);
  if (readable.length < totalCount) unknown.push(`only ${readable.length} of ${totalCount} predecessors are readable`);
  for (const predecessor of readable) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    if (predecessor.state === 'OPEN') blocked.push(`blocked by ${label} (open)`);
    else if (!predecessor.stateReason) unknown.push(`${label} is closed without a readable reason`);
    // Only a completed predecessor delivered; not planned or duplicate needs a recorded decision.
    else if (predecessor.stateReason !== 'COMPLETED') {
      const reason = predecessor.stateReason.toLowerCase().replace('_', ' ');
      blocked.push(`blocked by ${label} (closed as ${reason}; record a decision)`);
    }
  }
  return { blocked, unknown };
}

function check(issue = readIssue()) {
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
  let verdict = 'STARTABLE';
  if (unknown.length) verdict = 'UNKNOWN';
  if (blocked.length) verdict = 'BLOCKED';
  const assignees = issue.assignees.nodes.map(assignee => assignee.login).join(', ') || 'none';
  console.log(`#${issue.number} ${issue.title}\nstatus: ${status ?? '-'}, assignees: ${assignees}\n${verdict}`);
  for (const reason of [...blocked, ...unknown]) console.log(`- ${reason}`);
  process.exitCode = { STARTABLE: 0, BLOCKED: 1, UNKNOWN: 2 }[verdict];
  return verdict;
}

function next() {
  // Advanced issue search understands -is:blocked (open native predecessors). Separate searches keep blocked issues
  // from crowding unblocked ones out of the 1,000-result search cap; read every page of both before sorting.
  const nodes = [];
  for (const blocking of ['-is:blocked', 'is:blocked']) for (let after, read = 0; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:100,after:$after){
      issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{number title assignees(first:10){nodes{login}}
      blockedBy(first:100){totalCount nodes{number state stateReason repository{nameWithOwner}}}
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
      const { blocked, unknown } = predecessorReasons(issue.blockedBy);
      return { ...issue, reasons: [...blocked, ...unknown], priority: issue.item.priority?.name
        ?? issue.issueFieldValues.nodes.find(field => field.field?.name === 'Priority')?.name };
    })
    .sort((a, b) => order(a.priority) - order(b.priority) || a.number - b.number);
  const line = issue => `#${issue.number} [${issue.priority ?? 'no priority'}] ${issue.title}`
    + ` (assignees: ${issue.assignees.nodes.map(assignee => assignee.login).join(', ') || 'none'})`;
  const held = ready.filter(issue => issue.reasons.length);
  const startable = ready.filter(issue => !issue.reasons.length);
  for (const issue of startable) console.log(line(issue));
  console.log(startable.length ? 'Run board.mjs check ISSUE before claiming one.' : 'No Ready issue whose blockers are all completed.');
  if (held.length) console.log('\nReady but not startable:');
  for (const issue of held) console.log([line(issue), ...issue.reasons.map(reason => `  - ${reason}`)].join('\n'));
}

/** A single-select Project field with its options in configured order. */
function selectField(fieldName) {
  const field = graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:100){nodes{...on ProjectV2SingleSelectField{
    id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: project.id })
    .node.fields.nodes.find(candidate => candidate.name === fieldName);
  assert.ok(field, `${project.url} has no single-select ${fieldName} field`);
  // An empty Project option list means the field mirrors an organization issue field.
  const linked = !field.options.length && field.issueField;
  return { field, linked, choices: linked ? linked.options : field.options };
}

function set(fieldName, optionName = value) {
  const issue = readIssue();
  const { field, linked, choices } = selectField(fieldName);
  const option = choices.find(choice => choice.name.toLowerCase() === String(optionName).toLowerCase());
  assert.ok(option, `Use one of: ${choices.map(choice => choice.name).join(', ')}`);
  if (fieldName === 'Status' && option.name === 'In progress') {
    if (check(issue) !== 'STARTABLE') return;
    const { viewer } = graphql('query{viewer{login}}');
    assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
    assert.ok(issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase()),
      `Assign yourself first: gh issue edit ${number} --repo ${project.repository} --add-assignee "@me". Verify session ownership before assigning.`);
  }
  if (linked) {
    graphql(`mutation($issue:ID!,$field:ID!,$option:ID!){setIssueFieldValue(input:{issueId:$issue,
      issueFields:[{fieldId:$field,singleSelectOptionId:$option}]}){clientMutationId}}`,
    { issue: issue.id, field: linked.id, option: option.id });
  } else {
    const item = projectItem(issue)?.id ?? graphql(`mutation($project:ID!,$content:ID!){addProjectV2ItemById(
      input:{projectId:$project,contentId:$content}){item{id}}}`, { project: project.id, content: issue.id }).addProjectV2ItemById.item.id;
    graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,
      itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
    { project: project.id, item, field: field.id, option: option.id });
  }
  console.log(`#${issue.number} ${fieldName}: ${option.name}`);
  return option.name;
}

/** Any single-select field, read back after writing so a silent API no-op cannot pass. */
function setField() {
  const fieldName = value, wanted = set(fieldName, process.argv[5]);
  if (!wanted) return;
  const { repository } = graphql(`query($owner:String!,$name:String!,$number:Int!,$field:String!){repository(owner:$owner,name:$name){
    issue(number:$number){projectItems(first:100){nodes{project{id} value:fieldValueByName(name:$field){
      ...on ProjectV2ItemFieldSingleSelectValue{name}}}}
    issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}}`,
  { owner, name, number, field: fieldName });
  const stored = projectItem(repository.issue)?.value?.name
    ?? repository.issue.issueFieldValues.nodes.find(field => field.field?.name === fieldName)?.name;
  assert.equal(stored, wanted, `Read-back of ${fieldName} shows ${stored ?? 'no value'}`);
}

// Reviewers run unreliably, so only traces on the current head count (docs/CONTRIBUTING.md#review-loop).
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number state headRefOid commits(last:1){nodes{commit{oid committedDate checkSuites(first:100){nodes{createdAt}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title} ...on StatusContext{context state description}}}}}}}
  reviews(last:100){nodes{author{__typename login} state submittedAt url commit{oid}}}
  comments(last:100){nodes{author{__typename login} body createdAt updatedAt url}}
  reviewThreads(first:100){totalCount nodes{isResolved}}}}}`;
const rest = path => JSON.parse(execFileSync(gh.file, ['api', path], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 }));

/** One look at the PR head: done (0), still waiting (3); read failures throw. */
function reviews(stallMinutes = 20, now = Date.now()) {
  const pr = graphql(prQuery, { owner, name, number }).repository.pullRequest;
  const lines = [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`];
  if (pr.state !== 'OPEN') return { done: true, lines };
  const { commit } = pr.commits.nodes[0];
  assert.equal(commit.oid, pr.headRefOid, 'Head commit not readable');
  // CI starts on push, so the first check suite dates the push; the commit date is the fallback.
  const suites = commit.checkSuites.nodes.map(suite => Date.parse(suite.createdAt));
  const pushed = suites.length ? Math.min(...suites) : Date.parse(commit.committedDate);
  const after = time => Date.parse(time) >= pushed;
  const stalled = since => now - since > stallMinutes * 60_000; // false for Infinity
  const waiting = [];
  const contexts = commit.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
  assert.equal(contexts.nodes.length, contexts.totalCount, 'Not every check is readable');
  for (const check of contexts.nodes) {
    const label = check.name ?? check.context;
    const pending = check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(check.state);
    // CI never stalls: a running check is not success however long it takes.
    if (pending) waiting.push({ text: `check ${label}`, since: Infinity });
    // Descriptions carry results such as "Review rate limited" behind a green state.
    else lines.push(`check ${label}: ${check.conclusion ?? check.state}${check.title || check.description ? ` (${check.title || check.description})` : ''}`);
  }
  if (!contexts.nodes.length) waiting.push({ text: 'first CI check', since: pushed });
  const bots = pr.comments.nodes.filter(comment => comment.author?.__typename === 'Bot');
  const short = pr.headRefOid.slice(0, 7);
  for (const comment of bots.filter(comment => after(comment.updatedAt))) {
    // Summary comments (Codex) name the head in a table row that says Running until the review completes.
    for (const row of comment.body.split('\n').filter(row => row.includes('Running') && row.includes(short))) {
      const since = row.match(/datetime="([^"]+)"/)?.[1] ?? comment.updatedAt;
      waiting.push({ text: `${comment.author.login} running since ${since}`, since: Date.parse(since) });
    }
  }
  const reactions = rest(`repos/${project.repository}/issues/${number}/reactions?per_page=100`);
  assert.ok(reactions.length < 100, 'Too many reactions to read completely');
  for (const reaction of reactions.filter(reaction => reaction.user?.type === 'Bot' && after(reaction.created_at))) {
    const login = reaction.user.login.replace(/\[bot\]$/, '');
    const later = [...bots.map(comment => [comment.author.login, comment.updatedAt]),
      ...pr.reviews.nodes.map(review => [review.author?.login, review.submittedAt]),
      ...reactions.filter(other => other !== reaction).map(other => [other.user?.login?.replace(/\[bot\]$/, ''), other.created_at])]
      .some(([author, time]) => author === login && Date.parse(time) > Date.parse(reaction.created_at));
    // 👀 announces a review; any later comment, review or reaction by the same bot is its result.
    if (reaction.content === 'eyes' && !later) waiting.push({ text: `${login} reacted 👀`, since: Date.parse(reaction.created_at) });
  }
  for (const review of pr.reviews.nodes.filter(review => review.commit?.oid === pr.headRefOid)) lines.push(`review ${review.author?.login} ${review.state} ${review.url}`);
  for (const comment of pr.comments.nodes.filter(comment => after(comment.updatedAt))) lines.push(`comment ${comment.author?.login} ${comment.url}`);
  assert.equal(pr.reviewThreads.nodes.length, pr.reviewThreads.totalCount, 'Not every review thread is readable');
  lines.push(`unresolved threads: ${pr.reviewThreads.nodes.filter(thread => !thread.isResolved).length}`);
  // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
  for (const entry of waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
  const pending = waiting.filter(entry => !stalled(entry.since));
  for (const entry of pending) lines.push(`waiting: ${entry.text}`);
  return { done: !pending.length, lines };
}

const stallOption = () => process.argv.includes('--stall') ? Number(process.argv[process.argv.indexOf('--stall') + 1]) : 20;

function reviewsOnce() {
  const { done, lines } = reviews(stallOption());
  console.log([done ? 'DONE' : 'WAITING', ...lines].join('\n'));
  process.exitCode = done ? 0 : 3;
}

async function wait() {
  for (;;) {
    const { done, lines } = reviews(stallOption());
    if (done) return console.log(['DONE', ...lines].join('\n'));
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
  const { id } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
    { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue;
  graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
    { issue: readIssue().id, blocker: id });
  console.log(`#${number} is blocked by ${value}`);
}

const commands = { next, check, block, status: () => set('Status'), priority: () => set('Priority'), field: setField,
  reviews: reviewsOnce, wait };
const usage = 'Usage: board.mjs next | check ISSUE | status ISSUE "In progress" | priority ISSUE High | field ISSUE NAME VALUE'
  + ' | block ISSUE BLOCKER | reviews PR [--stall MINUTES] | wait PR [--stall MINUTES]';
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (!commands[command] || (command !== 'next' && !Number.isSafeInteger(number))
  || (['status', 'priority'].includes(command) && !/^[\w -]+$/.test(value ?? ''))
  || (command === 'field' && !(/^[\w -]+$/.test(value ?? '') && /^[\w .-]+$/.test(process.argv[5] ?? '')))
  || (['reviews', 'wait'].includes(command) && !(stallOption() > 0))
  || (command === 'block' && !validBlocker(value ?? ''))) {
  console.error(usage);
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  // A failed read is never "no blockers" and never a finished review.
  if (!['check', 'reviews', 'wait'].includes(command)) throw error;
  console.log(`${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${String(error.stderr || error.message).trim()}`);
  process.exitCode = 2;
}
