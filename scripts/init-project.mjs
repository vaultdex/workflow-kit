import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? kit);
const existing = process.argv.includes('--existing');
const hash = text => createHash('sha256').update(text).digest('hex');
const fragments = group => group.hooks ? group.hooks.map(hook => ({ ...group, hooks: [hook] })) : [group];
const fingerprint = group => hash(JSON.stringify(group));
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const present = p => lstatSync(p, { throwIfNoEntry: false });
assert.ok(existsSync(root), 'Initialize the target Git checkout first');
assert.ok(existsSync(join(root, '.git')), 'Target must be a Git repository/worktree');
const receipt = '.github/workflow-kit.json';
const prior = existsSync(safe(receipt)) ? JSON.parse(text(join(root, receipt))) : { files: {}, hooks: {} };
const files = {};
const hooks = {};
const pending = {};

function safe(file) {
  const target = join(root, file);
  let p = target;
  while (!present(p)) p = dirname(p);
  const actual = realpathSync(p);
  assert.ok(actual === realpathSync(root) || actual.startsWith(realpathSync(root) + sep), `Target leaves checkout: ${file}`);
  assert.ok(!present(target) || present(target).isFile(), `Refusing non-file target: ${file}`);
  return target;
}

for (const file of readdirSync(join(kit, 'templates'), { recursive: true })) {
  const source = join(kit, 'templates', file);
  if (!lstatSync(source).isFile()) continue;
  const name = file.split(sep).join('/');
  const isHooks = name.endsWith('hooks.json') || name === '.claude/settings.json' || name.startsWith('.github/hooks/');
  if (existing && !isHooks && !prior.files[name]) continue;
  const target = safe(name);
  const value = text(source);
  if (isHooks) {
    const incoming = JSON.parse(value);
    const current = existsSync(target) ? JSON.parse(text(target)) : {};
    const old = prior.hooks[name] ?? {};
    current.hooks ??= {};
    for (const event of new Set([...Object.keys(old), ...Object.keys(incoming.hooks)])) {
      const currentGroups = current.hooks[event] ?? [];
      for (const digest of old[event] ?? []) assert.ok(currentGroups.flatMap(fragments).some(group => fingerprint(group) === digest),
        `Managed hook edited or disabled; preserved without replacement: ${name}/${event}`);
      const retained = currentGroups.flatMap(group => {
        if (!group.hooks) return (old[event] ?? []).includes(fingerprint(group)) ? [] : [group];
        const remaining = group.hooks.filter(hook => !(old[event] ?? []).includes(fingerprint({ ...group, hooks: [hook] })));
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
      });
      for (const group of incoming.hooks[event] ?? []) {
        for (const part of fragments(group)) {
          if (retained.flatMap(fragments).some(x => fingerprint(x) === fingerprint(part))) continue;
          const { hooks: handlers, ...metadata } = part;
          const matching = handlers && retained.find(x => {
            const { hooks: _, ...other } = x;
            return x.hooks && JSON.stringify(other) === JSON.stringify(metadata);
          });
          if (matching) matching.hooks.push(...handlers);
          else retained.push(part);
        }
      }
      if (retained.length) current.hooks[event] = retained;
      else delete current.hooks[event];
    }
    for (const [key, val] of Object.entries(incoming)) if (key !== 'hooks' && current[key] === undefined) current[key] = val;
    hooks[name] = Object.fromEntries(Object.entries(incoming.hooks).map(([event, groups]) => [event, groups.flatMap(fragments).map(fingerprint)]));
    pending[name] = JSON.stringify(current, null, 2) + '\n';
  } else {
    assert.ok(!existsSync(target) || text(target) === value || hash(text(target)) === prior.files[name], `Existing file left untouched: ${name}`);
    files[name] = hash(value);
    pending[name] = value;
  }
}
if (root !== kit) {
  const kitRelative = relative(root, kit).split(sep).join('/');
  assert.equal(kitRelative, '.vendor/workflow-kit', 'Install the kit at .vendor/workflow-kit in the target');
  for (const name of ['setup-skills', 'install-ponytail-hooks', 'install-impeccable-hooks', 'check-skills']) {
    const file = `scripts/${name}.mjs`;
    const target = safe(file);
    const value = `import { execFileSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nexecFileSync(process.execPath, [fileURLToPath(new URL('../.vendor/workflow-kit/scripts/${name}.mjs', import.meta.url)), fileURLToPath(new URL('../', import.meta.url))], { stdio: 'inherit' });\n`;
    assert.ok(!existsSync(target) || text(target) === value || hash(text(target)) === prior.files[file], `Existing entry point left untouched: ${file}`);
    files[file] = hash(value);
    pending[file] = value;
  }
}
const ignore = safe('.gitignore');
const patterns = ['/.workflow-kit/', '/.impeccable/vendor/', '/.impeccable/setup-*/', '/.agents/hooks/',
  ...['.agent', '.agents', '.claude', '.opencode', '.pi'].flatMap(p => [`/${p}/skills/ponytail*/`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/'];
const currentIgnore = existsSync(ignore) ? text(ignore) : '';
const additions = patterns.filter(p => !currentIgnore.split('\n').includes(p));
pending['.gitignore'] = currentIgnore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n';
safe(receipt);
pending[receipt] = JSON.stringify({ files: { ...prior.files, ...files }, hooks }, null, 2) + '\n';
for (const [file, value] of Object.entries(pending)) {
  const target = safe(file);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || text(target) !== value) writeFileSync(target, value);
}
console.log('Project files configured. Review the diff, run setup-skills, then install/review hooks explicitly.');
