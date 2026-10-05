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

/** Write a selected field option; guarded delivery can reject the fresh issue before mutation. */
function set(fieldName, optionName = value, beforeWrite) {
  let issue = readIssue();
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
  if (fieldName === 'Status' && option.name === 'Automated review') verifyBacklinks();
  // A guarded handoff rechecks current ownership/readiness after the potentially lengthy review reads.
  if (beforeWrite) {
    issue = beforeWrite();
    if (!issue) return;
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
  number state isDraft headRefOid mergeStateStatus reviewDecision
  latestOpinionatedReviews(first:100){totalCount nodes{state author{login}}}
  commits(last:1){nodes{commit{oid committedDate checkSuites(first:100){totalCount nodes{createdAt status conclusion app{slug} checkRuns(first:1){totalCount}}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title} ...on StatusContext{context state description}}}}}}}
  reviewRequests(first:100){totalCount nodes{requestedReviewer{...on User{login} ...on Bot{login} ...on Team{name}}}}
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
    const issue = rest(`repos/${repository}/issues/${issueNumber}`);
    assert.ok(issue?.number === issueNumber && issue.state === 'open' && !issue.pull_request,
      `#${issueNumber} is not an open issue`);
    assert.ok(Number.isSafeInteger(issue.comments) && issue.comments >= 0, 'Issue comment count is unreadable');
    const comments = restAll(`repos/${repository}/issues/${issueNumber}/comments`, issue.comments);
    assert.equal(comments.length, issue.comments, `Not every comment on #${issueNumber} is readable; retry the read`);
    assert.ok(comments.every(comment => Number.isSafeInteger(comment?.id) && typeof comment.body === 'string'), 'Unreadable issue comment');
    assert.equal(new Set(comments.map(comment => comment.id)).size, comments.length, 'Duplicate comment page');
    const backlink = comments.find(comment => (comment.body.match(/https?:\/\/[^\s<>()[\]`"']+/g) ?? []).some(link => {
      try {
        const target = new URL(link.replace(/[.,;:!?]+$/, ''));
        return target.origin === url.origin && target.pathname.replace(/\/$/, '') === url.pathname;
      } catch { return false; } // An unrelated malformed URL is not a backlink.
    }));
    assert.ok(backlink, `Missing backlink to ${pr.url} on #${issueNumber}; post the full URL and retry`);
    console.log(`backlink ${issueRef}: ${backlink.html_url}`);
  }
}
const login = user => user?.login?.replace(/\[bot\]$/, '');
const isBot = user => user?.type === 'Bot';
const passed = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const readPr = prNumber => graphql(prQuery, { owner, name, number: prNumber }).repository.pullRequest;
/** One look at the PR head: done or still waiting, and whether CI failed; read failures throw. */
function reviews(stallMinutes = 20, now = Date.now(), prNumber = number, pr = readPr(prNumber)) {
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
  const stalled = since => now - since > stallMinutes * 60_000; // false for Infinity
  const waiting = [];
  let failed = false;
  const contexts = commit.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
  assert.equal(contexts.nodes.length, contexts.totalCount, 'Not every check is readable');
  for (const check of contexts.nodes) {
    const label = check.name ?? check.context;
    const pending = check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(check.state);
    // CI never stalls: a running check is not success however long it takes.
    if (pending) { waiting.push({ text: `check ${label}`, since: Infinity }); continue; }
    const result = check.conclusion ?? check.state;
    if (!passed.has(result)) failed = true;
    // Descriptions carry results such as "Review rate limited" behind a green state.
    lines.push(`check ${label}: ${result}${check.title || check.description ? ` (${check.title || check.description})` : ''}`);
  }
  if (!contexts.nodes.length) waiting.push({ text: 'first CI check', since: Infinity });
  // An Actions suite without runs is a triggered workflow about to report. Other apps (Sonar, CodeRabbit,
  // Renovate …) open a suite on every push and often never run it, so they count only when the project
  // lists them in "awaitApps" (analyzers such as SonarCloud create their run only when finished). Both may stall.
  const awaited = new Set(['github-actions', ...project.awaitApps ?? []]);
  for (const suite of commit.checkSuites.nodes.filter(suite => awaited.has(suite.app?.slug) && !suite.checkRuns.totalCount)) {
    if (suite.status !== 'COMPLETED') waiting.push({ text: `check suite ${suite.app.slug} without runs`, since: Date.parse(suite.createdAt) });
    // A workflow that fails to start (STARTUP_FAILURE) completes its suite without any run to show it.
    else if (!passed.has(suite.conclusion)) {
      failed = true;
      lines.push(`check suite ${suite.app.slug}: ${suite.conclusion}`);
    }
  }
  // A known CI failure is the verdict; later review reads must not turn it into ERROR.
  if (failed) return { done: true, failed, lines, pr };
  const comments = restAll(`repos/${project.repository}/issues/${pr.number}/comments`);
  const reviewList = restAll(`repos/${project.repository}/pulls/${pr.number}/reviews`);
  // Bots acknowledge "@bot review" comments with a reaction on that comment, not on the PR.
  const reactions = [...restAll(`repos/${project.repository}/issues/${pr.number}/reactions`),
    ...comments.filter(comment => after(comment.created_at) && /@[\w-]+(\[bot\])?\s+review\b/i.test(comment.body))
      .flatMap(comment => restAll(`repos/${project.repository}/issues/comments/${comment.id}/reactions`))];
  // Inline review comments and thread replies carry findings too.
  const inline = restAll(`repos/${project.repository}/pulls/${pr.number}/comments`);
  // Results a bot can post: a review of this head, an issue comment, or a final (non-👀) reaction.
  const results = [...comments.map(comment => [login(comment.user), comment.updated_at, comment.id]),
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at, null]),
    ...reactions.filter(reaction => reaction.content !== 'eyes').map(reaction => [login(reaction.user), reaction.created_at, null])];
  // The summary's own later edits are no result, so its comment id is skipped.
  const answeredAfter = (author, since, own) => results.some(([who, time, id]) => who === author && (id === null || id !== own) && Date.parse(time) > since);
  const short = pr.headRefOid.slice(0, 7);
  for (const comment of comments.filter(comment => isBot(comment.user) && after(comment.updated_at))) {
    // Summary comments (Codex) name the head in a table row that says Running until the review completes;
    // a result the same bot posts elsewhere ends it too.
    for (const row of comment.body.split('\n').filter(row => row.includes('Running') && row.includes(short))) {
      const since = row.match(/datetime="([^"]+)"/)?.[1] ?? comment.updated_at;
      if (answeredAfter(login(comment.user), Date.parse(since), comment.id)) continue;
      waiting.push({ text: `${login(comment.user)} running since ${since}`, since: Date.parse(since) });
    }
  }
  const activity = [...[...comments, ...inline].map(comment => [login(comment.user), comment.updated_at]),
    // A finishing review of the previous head never answers a trace on this one.
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at]),
    // 👍 is Codex's "no findings"; a later 👀 is its own open trace below.
    ...reactions.map(reaction => [login(reaction.user), reaction.created_at])];
  for (const reaction of reactions.filter(reaction => isBot(reaction.user) && after(reaction.created_at))) {
    // 👀 announces a review; a later comment, head review or final reaction by the same bot is its result.
    const answered = activity.some(([author, time]) => author === login(reaction.user) && Date.parse(time) > Date.parse(reaction.created_at));
    if (reaction.content === 'eyes' && !answered) waiting.push({ text: `${login(reaction.user)} reacted 👀`, since: Date.parse(reaction.created_at) });
  }
  // GitHub drops a request once the review arrives, so every remaining request is an outstanding review.
  assert.equal(pr.reviewRequests.nodes.length, pr.reviewRequests.totalCount, 'Not every review request is readable');
  const reviewerName = reviewer => reviewer?.login ?? reviewer?.name;
  for (const { requestedReviewer: reviewer } of pr.reviewRequests.nodes) {
    // A request added later starts its own clock.
    const requested = pr.requestEvents.nodes.filter(event => reviewerName(event.requestedReviewer) === reviewerName(reviewer))
      .map(event => Date.parse(event.createdAt));
    // Without its request time a new request would read as stalled; fail closed instead.
    assert.ok(requested.length || pr.requestEvents.nodes.length === pr.requestEvents.totalCount, 'Review request history is incomplete');
    waiting.push({ text: `review requested from ${reviewerName(reviewer) ?? 'an unreadable reviewer'}`, since: Math.max(pushed, ...requested) });
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
  if (pr.mergeStateStatus === 'DIRTY') lines.push('blocker: merge conflicts');
  // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
  for (const entry of waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
  const pending = waiting.filter(entry => !stalled(entry.since));
  for (const entry of pending) lines.push(`waiting: ${entry.text}`);
  // A known failure ends the wait at once: the fix starts now, whatever else is still running.
  return { done: failed || !pending.length, failed, lines, pr };
}

/** Native PR connections, including manual links on a non-default base; refs and branches do not count. */
function connectedIssues(pr) {
  const ids = new Set();
  for (let after; ;) {
    const current = graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){state isDraft headRefOid closingIssuesReferences(first:100,after:$after){totalCount
        pageInfo{hasNextPage endCursor} nodes{id}}}}}`, { owner, name, number: pr.number, ...(after && { after }) })
      .repository.pullRequest;
    assert.ok(current?.state === 'OPEN' && current.isDraft === false && current.headRefOid === pr.headRefOid,
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

/** Revalidate active readiness, review status and assignment on the supplied issue snapshot. */
function handoffIssue(issue, viewer) {
  if (check(issue) !== 'STARTABLE') return false;
  assert.ok(issue.id, 'Issue identity is unreadable');
  const status = projectItem(issue)?.status?.name;
  const reasons = [];
  if (!['Automated review', 'Human review'].includes(status)) reasons.push('finish implementation and Automated review first');
  if (!issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase())) {
    reasons.push('the issue is not assigned to the authenticated driver');
  }
  if (reasons.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Read all PR gates and native links, optionally requiring the previously checked head. */
function handoffPr(issueId, expectedHead) {
  const reasons = [];
  const pr = readPr(Number(value));
  assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
  if (pr.state !== 'OPEN' || pr.isDraft) {
    console.log('FAILED\nblocker: handoff needs an open non-draft PR');
    process.exitCode = 1;
    return;
  }
  const result = reviews(stallOption(), Date.now(), Number(value), pr);
  console.log(result.lines.join('\n'));
  if (!result.done || result.failed) {
    process.exitCode = result.failed ? 1 : 3;
    console.log(result.failed ? 'FAILED' : 'WAITING');
    return;
  }
  if (expectedHead) assert.equal(result.pr.headRefOid, expectedHead, 'PR head changed during handoff');
  if (result.lines.some(line => line.startsWith('blocker:') || /^unresolved threads: [1-9]/.test(line))) {
    reasons.push('resolve review blockers and threads before handoff');
  }
  if (!reasons.length && !['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(result.pr.mergeStateStatus)) {
    console.log('WAITING\nwaiting: PR mergeability is not determined');
    process.exitCode = 3;
    return;
  }
  if (!reasons.length && !connectedIssues(result.pr).has(issueId)) reasons.push(`PR #${value} is not natively linked to issue #${number}`);
  if (reasons.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
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
  const pr = handoffPr(issue.id);
  if (!pr) return;
  if (!set('Status', 'Human review', () => {
    if (!handoffPr(issue.id, pr.headRefOid)) return;
    const current = readIssue();
    assert.equal(current?.id, issue.id, 'Issue identity changed during handoff');
    return handoffIssue(current, viewer) ? current : undefined;
  })) return;
  assert.equal(projectItem(readIssue())?.status?.name, 'Human review', 'Human review status read-back differs');
  console.log(`HANDOFF #${number} PR #${value} head ${pr.headRefOid}`);
}

const numberOption = (flag, fallback) => process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback;
const stallOption = () => numberOption('--stall', 20);

/** Metadata that can still describe the previous push right after it: identity, branch, state, draft, head. */
const readyQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id number state isDraft isCrossRepository headRefOid headRepository{nameWithOwner}}}}`;
const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

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
  const { id } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
    { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue;
  graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
    { issue: readIssue().id, blocker: id });
  console.log(`#${number} is blocked by ${value}`);
}

const commands = { next, check, block, status: () => set('Status'), priority: () => set('Priority'), field: setField,
  reviews: reviewsOnce, wait, handoff, ready };
const usage = 'Usage: board.mjs next | check ISSUE | status ISSUE "In progress" | priority ISSUE High | field ISSUE NAME VALUE'
  + ' | status ISSUE "Automated review" PR [OTHER_ISSUE...] | field ISSUE Status "Automated review" PR [OTHER_ISSUE...]'
  + ' | block ISSUE BLOCKER | reviews PR [--stall MINUTES] | wait PR [--stall MINUTES | --merged] | handoff ISSUE PR [--stall MINUTES]'
  + ' | ready PR SHA [--attempts N] [--interval SECONDS]';
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (!commands[command] || (command !== 'next' && !Number.isSafeInteger(number))
  || (['status', 'priority'].includes(command) && !/^[\w -]+$/.test(value ?? ''))
  // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
  || (command === 'field' && ![value, process.argv[5]].every(text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text ?? '')))
  || (['reviews', 'wait', 'handoff'].includes(command) && !(stallOption() > 0))
  || (command === 'handoff' && (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
  || (command === 'ready' && (!/^[0-9a-f]{40}$/i.test(value ?? '') || !Number.isInteger(numberOption('--attempts', 6)) || !(numberOption('--attempts', 6) > 0)
    || !(Number.isFinite(numberOption('--interval', 5)) && numberOption('--interval', 5) >= 0)))
  || (command === 'block' && !validBlocker(value ?? ''))) {
  console.error(usage);
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  // A failed read is never "no blockers" and never a finished review.
  if (!['check', 'reviews', 'wait', 'handoff', 'ready'].includes(command)) throw error;
  console.log(`${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${String(error.stderr || error.message).trim()}`);
  process.exitCode = 2;
}
