import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const repo = process.argv[2];
assert.match(repo ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Usage: node setup-github.mjs OWNER/REPO [PROJECT_NUMBER]');
const [owner, name] = repo.split('/');
const root = realpathSync(process.cwd());
const outside = path => path !== root && !path.startsWith(root + sep);
const searchPath = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  .filter(path => existsSync(path) && outside(realpathSync(path)));
const binary = searchPath.map(path => join(path, process.platform === 'win32' ? 'gh.exe' : 'gh'))
  .find(path => existsSync(path) && outside(realpathSync(path)));
assert.ok(binary, 'Install GitHub CLI in an absolute PATH directory outside this checkout');
const gh = (...args) => execFileSync(realpathSync(binary), args, { encoding: 'utf8',
  env: { ...process.env, PATH: searchPath.join(delimiter), NoDefaultCurrentDirectoryInExePath: '1' } }).trim();
const marker = resolve('.github/workflow-project.json');
const saved = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
if (saved) assert.equal(saved.repository, repo, 'Recorded project belongs to another repository');
const meta = JSON.parse(gh('repo', 'view', repo, '--json', 'viewerPermission,url'));
assert.ok(['ADMIN', 'MAINTAIN', 'WRITE'].includes(meta.viewerPermission), 'Repository write permission required');
const number = process.argv[3] ?? saved?.number;
if (number) assert.match(String(number), /^\d+$/, 'Project number must be numeric');
const project = number
  ? JSON.parse(gh('project', 'view', String(number), '--owner', owner, '--format', 'json'))
  : JSON.parse(gh('project', 'copy', '5', '--source-owner', 'vaultdex', '--target-owner', owner, '--title', name, '--format', 'json'));
const saveProject = () => {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ repository: repo, owner, number: project.number, id: project.id, url: project.url }, null, 2) + '\n');
};
// Retain newly copied boards on failure so retry cannot create duplicates.
if (!number) saveProject();
gh('project', 'link', String(project.number), '--owner', owner, '--repo', repo);
const labels = new Set(JSON.parse(gh('api', `repos/${repo}/labels?per_page=100`, '--paginate', '--slurp')).flat().map(l => l.name));
for (const [label, color] of [['ci', '1d76db'], ['documentation', '0075ca'], ['testing', '5319e7'], ['security', 'b60205'], ['dependencies', '0366d6']])
  if (!labels.has(label)) gh('label', 'create', label, '--repo', repo, '--color', color);
const fields = JSON.parse(gh('project', 'field-list', String(project.number), '--owner', owner, '--format', 'json', '--limit', '100'));
const status = fields.fields.find(f => f.name === 'Status');
for (const required of ['Backlog', 'Ready', 'In progress', 'Automated review', 'Human review', 'Done'])
  assert.ok(status?.options?.some(o => o.name === required), `Existing board lacks ${required}; configure it explicitly without deleting foreign fields`);
const priority = fields.fields.find(f => f.name === 'Priority');
assert.ok(priority, 'Existing board lacks Priority; add a usable priority scale without replacing foreign fields');
// Organization issue fields expose their choices on issueField rather than Project options.
const priorityOptions = priority.options?.length ? priority.options : JSON.parse(gh('api', 'graphql',
  '-f', 'query=query($id:ID!) { node(id:$id) { ... on ProjectV2SingleSelectField { issueField { ... on IssueFieldSingleSelect { options { name } } } } } }',
  '-f', `id=${priority.id}`)).data?.node?.issueField?.options;
assert.ok(priorityOptions?.length >= 2, 'Priority needs a usable explicit scale; configure/verify its choices before completing setup');
saveProject();
console.log(`Project linked: ${project.url}\nLabels configured; existing labels preserved.\n`
  + `Remaining account settings: authorize CodeRabbit; enable Codex automatic review; configure Project Auto-add for repo:${repo} is:issue.\n`
  + 'Verify native automation, permissions and required checks in GitHub; configuration is not proof of an active integration.');
