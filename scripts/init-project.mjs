// Zweck: Verwaltete Projektdateien und Hook-Konfiguration aus den Kit-Vorlagen aktualisieren.
// Aufruf: Bei Einrichtung oder Kit-Updates; --check prueft ohne zu schreiben.
// Nutzen: Ein gemeinsamer, wiederholbarer Updatepfad mit Schutz fuer fremde und bearbeitete Dateien.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? kit);
const existing = process.argv.includes('--existing');
const check = process.argv.includes('--check');
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
if (check) {
  assert.ok(existsSync(safe(receipt)), 'Initialize Workflow Kit before checking it');
  for (const [name, digest] of Object.entries(prior.files))
    assert.ok(existsSync(safe(name)) && hash(text(safe(name))) === digest, `Managed file edited or missing: ${name}`);
}

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
  // Keep only the bootstrap contract and installer paths used by the hook recovery messages.
  // Checks run directly from the kit: node .vendor/workflow-kit/scripts/check-skills.mjs .
  const purposes = {
    'setup-skills': 'Richtet die gepinnten Skills ein; gemeinsamer Einstieg fuer Menschen und Workspace-Bootstrap.',
    'install-ponytail-hooks': 'Installiert den geprueften Ponytail-Hook-Snapshot; Einstieg der Hook-Fehlerhinweise.',
    'install-impeccable-hooks': 'Installiert die gepruefte Impeccable-Engine; Einstieg der Hook-Fehlerhinweise.',
  };
  for (const [name, purpose] of Object.entries(purposes)) {
    const file = `scripts/${name}.mjs`;
    const target = safe(file);
    const value = `// Zweck: ${purpose}\n// Nutzen: Uebergibt immer dieses Projekt als Ziel, auch bei anderem Arbeitsverzeichnis.\n// Die Logik liegt nur im Workflow Kit. Bewusst aufrufen; keine automatische Hook-Freigabe.\nimport { execFileSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nexecFileSync(process.execPath, [fileURLToPath(new URL('../.vendor/workflow-kit/scripts/${name}.mjs', import.meta.url)), fileURLToPath(new URL('../', import.meta.url))], { stdio: 'inherit' });\n`;
    assert.ok(!existsSync(target) || text(target) === value || hash(text(target)) === prior.files[file], `Existing entry point left untouched: ${file}`);
    files[file] = hash(value);
    pending[file] = value;
  }
}
const ignore = safe('.gitignore');
// Generated provider entries are symlinks: a trailing slash would match directories only.
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const legacy = ['/.agents/hooks/', ...providers.map(p => `/${p}/skills/ponytail*/`)];
const patterns = ['/.workflow-kit/', '/.impeccable/vendor/', '/.impeccable/setup-*/', '/.agents/hooks',
  ...providers.flatMap(p => [`/${p}/skills/ponytail*`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/'];
const currentIgnore = (existsSync(ignore) ? text(ignore) : '').split('\n').filter(line => !legacy.includes(line)).join('\n');
const additions = patterns.filter(p => !currentIgnore.split('\n').includes(p));
pending['.gitignore'] = currentIgnore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n';
safe(receipt);
const retired = Object.keys(prior.files).filter(file => !(file in files));
for (const file of retired) {
  const target = safe(file);
  assert.ok(!existsSync(target) || hash(text(target)) === prior.files[file], `Retired managed file edited; preserved: ${file}`);
  assert.ok(!check, `Retired managed file; run init-project and review removal: ${file}`);
}
const sorted = values => Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]]));
pending[receipt] = JSON.stringify({ files: sorted(files), hooks: sorted(hooks) }, null, 2) + '\n';
for (const [file, value] of Object.entries(pending)) {
  const target = safe(file);
  if (check) assert.ok(existsSync(target) && text(target) === value, `Managed output is stale; run init-project and review changes: ${file}`);
  else {
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || text(target) !== value) writeFileSync(target, value);
  }
}
for (const file of retired) if (existsSync(safe(file))) unlinkSync(safe(file));
console.log(check ? 'Managed files and hook snapshots match the pinned kit; no files written.'
  : 'Project files configured. Review the diff, run setup-skills, then install/review hooks explicitly.');
