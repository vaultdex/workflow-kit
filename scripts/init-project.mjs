// Zweck: Verwaltete Projektdateien und Hooks aus den Kit-Vorlagen aktualisieren.
// Aufruf: Bei Einrichtung oder Kit-Updates; --check schreibt nichts.
// Nutzen: Gemeinsame Logik bleibt im Kit; Migrationen erhalten fremde Dateien und Handler.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? kit);
const existing = process.argv.includes('--existing');
const check = process.argv.includes('--check');
const hash = value => createHash('sha256').update(value).digest('hex');
const fragments = group => group.hooks ? group.hooks.map(hook => ({ ...group, hooks: [hook] })) : [group];
const fingerprint = group => hash(JSON.stringify(group));
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const present = p => lstatSync(p, { throwIfNoEntry: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isHooks = name => /^(?:\.(?:codex|cursor)\/hooks\.json|\.claude\/settings\.json|\.github\/hooks\/[A-Za-z0-9_.-]+\.json)$/.test(name);
const managedFile = name => ['AGENTS.md', 'CONTRIBUTING.md', '.coderabbit.yaml', '.github/PULL_REQUEST_TEMPLATE.md', '.github/dependabot.yml'].includes(name)
  || /^\.github\/ISSUE_TEMPLATE\/[A-Za-z0-9_.-]+$/.test(name)
  || /^scripts\/(?:setup-skills|check-skills|install-ponytail-hooks|install-impeccable-hooks)\.mjs$/.test(name);
assert.ok(existsSync(root), 'Initialize the target Git checkout first');
assert.ok(existsSync(join(root, '.git')), 'Target must be a Git repository/worktree');
const receipt = '.github/workflow-kit.json';
const prior = existsSync(safe(receipt)) ? JSON.parse(text(safe(receipt))) : { files: {}, hooks: {} };
for (const name of Object.keys(prior.files)) assert.ok(managedFile(name), `Invalid managed file in receipt: ${name}`);
for (const name of [...Object.keys(prior.hooks), ...Object.keys(prior.hookMetadata ?? {})])
  assert.ok(isHooks(name), `Invalid managed hook path: ${name}`);
const files = {}, hooks = {}, hookMetadata = {}, pending = {}, removed = new Set();
if (check) {
  assert.ok(existsSync(safe(receipt)), 'Initialize Workflow Kit before checking it');
  for (const [name, digest] of Object.entries(prior.files))
    assert.ok(existsSync(safe(name)) && hash(text(safe(name))) === digest, `Managed file edited or missing: ${name}`);
}

function safe(file) {
  assert.ok(typeof file === 'string' && file && !file.includes('\\') && !file.includes('\0')
    && !file.startsWith('/') && !file.includes(':') && file.split('/').every(p => p && p !== '.' && p !== '..'), `Invalid managed path: ${file}`);
  const target = join(root, file);
  let p = target;
  while (!present(p)) p = dirname(p);
  const actual = realpathSync(p);
  assert.ok(actual === realpathSync(root) || actual.startsWith(realpathSync(root) + sep), `Target leaves checkout: ${file}`);
  assert.ok(!present(target) || present(target).isFile(), `Refusing non-file target: ${file}`);
  return target;
}

// Plan all changes before writing. Legacy receipts may adopt identical metadata,
// but cannot prove that a conflicting schema version belongs to the kit.
function migrateHooks(name, incoming) {
  const target = safe(name);
  const current = existsSync(target) ? JSON.parse(text(target)) : {};
  const old = prior.hooks[name] ?? {};
  current.hooks ??= {};
  for (const event of new Set([...Object.keys(old), ...Object.keys(incoming?.hooks ?? {})])) {
    assert.match(event, /^[A-Za-z][A-Za-z0-9]*$/, 'Invalid hook event');
    const groups = current.hooks[event] ?? [];
    for (const digest of old[event] ?? []) assert.ok(groups.flatMap(fragments).some(group => fingerprint(group) === digest),
      `Managed hook edited or disabled; preserved without replacement: ${name}/${event}`);
    const retained = groups.flatMap(group => {
      if (!group.hooks) return (old[event] ?? []).includes(fingerprint(group)) ? [] : [group];
      const remaining = group.hooks.filter(hook => !(old[event] ?? []).includes(fingerprint({ ...group, hooks: [hook] })));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    for (const group of incoming?.hooks[event] ?? []) {
      for (const part of fragments(group)) {
        if (retained.flatMap(fragments).some(x => fingerprint(x) === fingerprint(part))) continue;
        const { hooks: handlers, ...metadata } = part;
        const matching = handlers && retained.find(x => {
          const { hooks: _, ...other } = x;
          return x.hooks && same(other, metadata);
        });
        if (matching) matching.hooks.push(...handlers);
        else retained.push(part);
      }
    }
    if (retained.length) current.hooks[event] = retained;
    else delete current.hooks[event];
  }
  const oldMetadata = prior.hookMetadata?.[name] ?? {};
  const newMetadata = Object.fromEntries(Object.entries(incoming ?? {}).filter(([key]) => key !== 'hooks'));
  for (const key of new Set([...Object.keys(oldMetadata), ...Object.keys(newMetadata)])) {
    assert.ok(!['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid hook metadata key');
    if (Object.hasOwn(newMetadata, key)) {
      assert.ok(current[key] === undefined || same(current[key], newMetadata[key])
        || (Object.hasOwn(oldMetadata, key) && same(current[key], oldMetadata[key])),
      `Hook metadata edited or unowned; preserved: ${name}/${key}`);
      current[key] = newMetadata[key];
    } else if (!incoming && (Object.keys(current.hooks).length || !same(current[key], oldMetadata[key]))) {
      // A surviving foreign handler still needs its schema envelope. Edited metadata is foreign too.
      continue;
    } else {
      assert.ok(current[key] === undefined || same(current[key], oldMetadata[key]), `Retired hook metadata edited; preserved: ${name}/${key}`);
      delete current[key];
    }
  }
  if (incoming) {
    hooks[name] = Object.fromEntries(Object.entries(incoming.hooks).map(([event, groups]) => [event, groups.flatMap(fragments).map(fingerprint)]));
    hookMetadata[name] = newMetadata;
  }
  if (!incoming && !Object.keys(current.hooks).length) delete current.hooks;
  if (Object.keys(current).length) pending[name] = JSON.stringify(current, null, 2) + '\n';
  else if (existsSync(target)) removed.add(name);
}

for (const file of readdirSync(join(kit, 'templates'), { recursive: true })) {
  const source = join(kit, 'templates', file);
  if (!lstatSync(source).isFile()) continue;
  const name = file.split(sep).join('/');
  if (existing && !isHooks(name) && !prior.files[name]) continue;
  const target = safe(name);
  const value = text(source);
  if (isHooks(name)) migrateHooks(name, JSON.parse(value));
  else {
    assert.ok(managedFile(name), `Unsupported managed template: ${name}`);
    assert.ok(!existsSync(target) || text(target) === value || hash(text(target)) === prior.files[name], `Existing file left untouched: ${name}`);
    files[name] = hash(value);
    pending[name] = value;
  }
}
for (const name of Object.keys(prior.hooks)) if (!Object.hasOwn(hooks, name)) migrateHooks(name, null);
if (root !== kit) assert.equal(relative(root, kit).split(sep).join('/'), '.vendor/workflow-kit', 'Install the kit at .vendor/workflow-kit in the target');
// No consumer scripts are generated. All setup/check/install calls target the kit.
const ignore = safe('.gitignore');
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const legacy = ['/.agents/hooks/', ...providers.map(p => `/${p}/skills/ponytail*/`)];
const patterns = ['/.workflow-kit/', '/.impeccable/vendor/', '/.impeccable/setup-*/', '/.agents/hooks',
  ...providers.flatMap(p => [`/${p}/skills/ponytail*`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/'];
const currentIgnore = (existsSync(ignore) ? text(ignore) : '').split('\n').filter(line => !legacy.includes(line)).join('\n');
const additions = patterns.filter(p => !currentIgnore.split('\n').includes(p));
pending['.gitignore'] = currentIgnore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n';
for (const file of Object.keys(prior.files).filter(file => !Object.hasOwn(files, file))) {
  const target = safe(file);
  assert.ok(!existsSync(target) || hash(text(target)) === prior.files[file], `Retired managed file edited; preserved: ${file}`);
  removed.add(file);
}
const sorted = values => Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]]));
pending[receipt] = JSON.stringify({ files: sorted(files), hooks: sorted(hooks), hookMetadata: sorted(hookMetadata) }, null, 2) + '\n';
if (check) {
  assert.equal(removed.size, 0, 'Retired managed outputs; run init-project and review removal');
  for (const [file, value] of Object.entries(pending))
    assert.ok(existsSync(safe(file)) && text(safe(file)) === value, `Managed output is stale; run init-project and review changes: ${file}`);
} else {
  for (const [file, value] of Object.entries(pending)) {
    if (file === receipt) continue;
    const target = safe(file);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || text(target) !== value) writeFileSync(target, value);
  }
  for (const file of removed) if (existsSync(safe(file))) unlinkSync(safe(file));
  // Retain the old receipt until every planned migration succeeded.
  mkdirSync(dirname(safe(receipt)), { recursive: true });
  if (!existsSync(safe(receipt)) || text(safe(receipt)) !== pending[receipt]) writeFileSync(safe(receipt), pending[receipt]);
}
console.log(check ? 'Managed files and hook snapshots match the pinned kit; no files written.'
  : 'Project files configured. Run the kit setup-skills script with this project path; install/review hooks explicitly.');
