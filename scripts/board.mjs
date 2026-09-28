// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs next | check ISSUE | status ISSUE "In progress" | priority ISSUE High | block ISSUE BLOCKER
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { externalTool } from './checkout-root.mjs';

const [command, ref, value] = process.argv.slice(2);
const project = JSON.parse(readFileSync('.github/workflow-project.json', 'utf8'));
const [owner, name] = project.repository.split('/');
const number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd());
const rank = ['Urgent', 'High', 'Medium', 'Low'];

function graphql(query, variables = {}) {
  // Organization-linked Priority fields live on the issue and need this preview header.
  const args = ['api', 'graphql', '-H', 'GraphQL-Features: issue_fields', '-f', `query=${query}`];
  for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
  return JSON.parse(execFileSync(gh.file, args, { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20 })).data;
}

const issueQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
  id number title state assignees(first:10){nodes{login}}
  projectItems(first:20){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
  blockedBy(first:100){totalCount nodes{number state stateReason repository{nameWithOwner}}}}}}`;
const readIssue = () => graphql(issueQuery, { owner, name, number }).repository.issue;
const projectItem = issue => issue.projectItems.nodes.find(item => item.project.id === project.id);

function check() {
  const issue = readIssue();
  const status = projectItem(issue)?.status?.name;
  const blocked = [], unknown = [];
  if (issue.state !== 'OPEN') blocked.push('issue is closed');
  if (!projectItem(issue)) unknown.push(`issue is not on ${project.url}`);
  else if (!status || ['Backlog', 'Done'].includes(status)) blocked.push(`status is ${status ?? 'unset'}`);
  const { totalCount, nodes } = issue.blockedBy;
  const readable = nodes.filter(Boolean);
  if (readable.length < totalCount) unknown.push(`only ${readable.length} of ${totalCount} predecessors are readable`);
  for (const predecessor of readable) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    if (predecessor.state === 'OPEN') blocked.push(`blocked by ${label} (open)`);
    // Only a completed predecessor delivered; not planned or duplicate needs a recorded decision.
    else if (predecessor.stateReason !== 'COMPLETED') {
      const reason = (predecessor.stateReason ?? 'unknown reason').toLowerCase().replace('_', ' ');
      blocked.push(`blocked by ${label} (closed as ${reason}; record a decision)`);
    }
  }
  const verdict = blocked.length ? 'BLOCKED' : unknown.length ? 'UNKNOWN' : 'STARTABLE';
  const assignees = issue.assignees.nodes.map(assignee => assignee.login).join(', ') || 'none';
  console.log(`#${issue.number} ${issue.title}\nstatus: ${status ?? '-'}, assignees: ${assignees}\n${verdict}`);
  for (const reason of [...blocked, ...unknown]) console.log(`- ${reason}`);
  process.exitCode = { STARTABLE: 0, BLOCKED: 1, UNKNOWN: 2 }[verdict];
}

function next() {
  // Advanced issue search understands -is:blocked (open native predecessors).
  const { issueCount, nodes } = graphql(`query($q:String!){search(query:$q,type:ISSUE_ADVANCED,first:100){issueCount nodes{...on Issue{
    number title issueFieldValues(first:20){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}
    projectItems(first:20){nodes{project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}
      priority:fieldValueByName(name:"Priority"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}`,
  { q: `repo:${project.repository} is:issue is:open -is:blocked` }).search;
  const order = priority => rank.includes(priority) ? rank.indexOf(priority) : rank.length;
  const ready = nodes.map(issue => ({ ...issue, item: projectItem(issue) }))
    .filter(issue => issue.item?.status?.name === 'Ready')
    .map(issue => ({ ...issue, priority: issue.item.priority?.name
      ?? issue.issueFieldValues.nodes.find(field => field.field?.name === 'Priority')?.name }))
    .sort((a, b) => order(a.priority) - order(b.priority) || a.number - b.number);
  for (const issue of ready) console.log(`#${issue.number} [${issue.priority ?? 'no priority'}] ${issue.title}`);
  console.log(ready.length ? 'Run board.mjs check ISSUE before claiming one.' : 'No Ready issue without open blockers.');
  if (issueCount > nodes.length) console.log(`Only the first ${nodes.length} of ${issueCount} unblocked open issues were read.`);
}

function set(fieldName) {
  const issue = readIssue();
  const field = graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:50){nodes{...on ProjectV2SingleSelectField{
    id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: project.id })
    .node.fields.nodes.find(candidate => candidate.name === fieldName);
  assert.ok(field, `${project.url} has no single-select ${fieldName} field`);
  // An empty Project option list means the field mirrors an organization issue field.
  const linked = !field.options.length && field.issueField;
  const choices = linked ? linked.options : field.options;
  const option = choices.find(choice => choice.name.toLowerCase() === String(value).toLowerCase());
  assert.ok(option, `Use one of: ${choices.map(choice => choice.name).join(', ')}`);
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
}

function block() {
  // The blocker may live in another repository: N or OWNER/REPO#N.
  const [, blockerOwner = owner, blockerName = name, blockerNumber] = /^(?:([\w.-]+)\/([\w.-]+))?#?(\d+)$/.exec(value);
  const { id } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
    { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue;
  graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
    { issue: readIssue().id, blocker: id });
  console.log(`#${number} is blocked by ${value}`);
}

const commands = { next, check, block, status: () => set('Status'), priority: () => set('Priority') };
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (!commands[command] || (command !== 'next' && !Number.isSafeInteger(number))
  || (['status', 'priority'].includes(command) && !/^[\w -]+$/.test(value ?? ''))
  || (command === 'block' && !/^(?:[\w.-]+\/[\w.-]+)?#?\d+$/.test(value ?? ''))) {
  console.error('Usage: board.mjs next | check ISSUE | status ISSUE "In progress" | priority ISSUE High | block ISSUE BLOCKER');
  process.exit(2);
}
try {
  commands[command]();
} catch (error) {
  // A failed read is never "no blockers".
  if (command !== 'check') throw error;
  console.log(`UNKNOWN\n- ${String(error.stderr || error.message).trim()}`);
  process.exitCode = 2;
}
