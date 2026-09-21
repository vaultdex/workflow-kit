import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repo = process.argv[2];
assert.match(repo ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Usage: node setup-github.mjs OWNER/REPO [PROJECT_NUMBER]');
const [owner, name] = repo.split('/');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const marker = resolve('.github/workflow-project.json');
const saved = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
if (saved) assert.equal(saved.repository, repo, 'Recorded project belongs to another repository');
const meta = JSON.parse(gh('repo', 'view', repo, '--json', 'viewerPermission,url'));
assert.ok(['ADMIN', 'MAINTAIN', 'WRITE'].includes(meta.viewerPermission), 'Repository write permission required');
let number = saved?.number ?? process.argv[3];
if (number) assert.match(String(number), /^\d+$/, 'Project number must be numeric');
const project = number
  ? JSON.parse(gh('project', 'view', String(number), '--owner', owner, '--format', 'json'))
  : JSON.parse(gh('project', 'copy', '5', '--source-owner', 'vaultdex', '--target-owner', owner, '--title', name, '--format', 'json'));
// Persist immediately: a later failed label/link operation must not create another board.
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, JSON.stringify({ repository: repo, owner, number: project.number, id: project.id, url: project.url }, null, 2) + '\n');
gh('project', 'link', String(project.number), '--owner', owner, '--repo', repo);
const labels = new Set(JSON.parse(gh('api', `repos/${repo}/labels?per_page=100`, '--paginate', '--slurp')).flat().map(l => l.name));
for (const [label, color] of [['ci', '1d76db'], ['documentation', '0075ca'], ['testing', '5319e7'], ['security', 'b60205'], ['dependencies', '0366d6']])
  if (!labels.has(label)) gh('label', 'create', label, '--repo', repo, '--color', color);
const fields = JSON.parse(gh('project', 'field-list', String(project.number), '--owner', owner, '--format', 'json'));
const status = fields.fields.find(f => f.name === 'Status');
for (const required of ['Backlog', 'Ready', 'In progress', 'In review', 'Done'])
  assert.ok(status?.options?.some(o => o.name === required), `Existing board lacks ${required}; configure it explicitly without deleting foreign fields`);
console.log(`Project linked: ${project.url}\nLabels configured; existing labels preserved.\n`
  + `Remaining account settings: authorize CodeRabbit; enable Codex automatic review; configure Project Auto-add for repo:${repo} is:issue.\n`
  + 'Verify native automation, permissions and required checks in GitHub; configuration is not proof of an active integration.');
