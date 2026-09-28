// Zweck: Kit-Hooks und .gitignore in das Projekt übernehmen; neue Projekte erhalten die Vorlagen.
// Aufruf: Bei Einrichtung oder Kit-Updates; --existing lässt die Vorlagen weg.
// Nutzen: Kit-Handler werden am Befehl erkannt und ersetzt; fremde Hooks und Einstellungen bleiben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './checkout-root.mjs';

const kit = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const requestedRoot = projectRoot();
// The installed kit owns only itself or the checkout it is vendored into.
const root = requestedRoot === kit ? kit : resolve(kit, '../..');
assert.equal(requestedRoot, root, 'Run init-project inside the project that vendors this kit at .vendor/workflow-kit');
if (root !== kit) assert.equal(relative(root, kit).split(sep).join('/'), '.vendor/workflow-kit', 'Install the kit at .vendor/workflow-kit in the target');
const existing = process.argv.includes('--existing');
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const present = p => lstatSync(p, { throwIfNoEntry: false });
// Kit handlers call the personal snapshots under ~/.ponytail/vaultdex or ~/.impeccable/vaultdex.
const ours = handler => /\.(?:ponytail|impeccable)[\\/]+vaultdex[\\/]/.test(JSON.stringify(handler));
const isHooks = name => /^(?:\.(?:codex|cursor)\/hooks\.json|\.claude\/settings\.json|\.github\/hooks\/[\w.-]+\.json)$/.test(name);

/** A project file that must stay inside the checkout and must not be a directory or link target elsewhere. */
function safe(file) {
  const target = join(root, file);
  let p = target;
  while (!present(p)) p = dirname(p);
  const actual = realpathSync(p);
  assert.ok(actual === realpathSync(root) || actual.startsWith(realpathSync(root) + sep), `Target leaves checkout: ${file}`);
  assert.ok(!present(target) || present(target).isFile(), `Refusing non-file target: ${file}`);
  return target;
}

function write(file, value) {
  const target = safe(file);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || text(target) !== value) writeFileSync(target, value);
}

/** Replace the kit's handlers in a hook file; foreign handlers, groups and settings stay. */
function mergeHooks(name, template) {
  const target = safe(name);
  const current = existsSync(target) ? JSON.parse(text(target)) : {};
  const hooks = {};
  for (const [event, groups] of Object.entries(current.hooks ?? {})) {
    const kept = groups.flatMap(group => {
      if (!group.hooks) return ours(group) ? [] : [group];
      const handlers = group.hooks.filter(handler => !ours(handler));
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(template?.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...groups];
  const merged = { ...template, ...current, hooks };
  // A file that held only kit handlers and schema metadata goes when its template is retired.
  if (!template && !Object.keys(hooks).length && Object.keys(merged).every(key => ['hooks', 'version', 'description'].includes(key))) {
    if (existsSync(target)) unlinkSync(target);
  } else if (existsSync(target) || template) write(name, JSON.stringify(merged, null, 2) + '\n');
}

const templates = readdirSync(join(kit, 'templates'), { recursive: true })
  .filter(file => lstatSync(join(kit, 'templates', file)).isFile()).map(file => file.split(sep).join('/'));
for (const name of templates.filter(name => !isHooks(name))) {
  // Templates start new projects; afterwards they belong to the project and are never overwritten.
  if (!existing && !existsSync(safe(name))) write(name, text(join(kit, 'templates', name)));
}
const hookTemplates = new Map(templates.filter(isHooks).map(name => [name, JSON.parse(text(join(kit, 'templates', name)))]));
const githubHooks = existsSync(join(root, '.github/hooks')) ? readdirSync(join(root, '.github/hooks')).map(file => `.github/hooks/${file}`) : [];
for (const name of new Set([...hookTemplates.keys(), '.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', ...githubHooks]))
  if (isHooks(name) && (hookTemplates.has(name) || existsSync(safe(name)))) mergeHooks(name, hookTemplates.get(name));

const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
const legacy = new Set(['/.agents/hooks/', ...providers.map(p => `/${p}/skills/ponytail*/`)]);
const patterns = ['/.workflow-kit/', '/.impeccable/vendor/', '/.impeccable/setup-*/', '/.agents/hooks',
  ...providers.flatMap(p => [`/${p}/skills/ponytail*`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/'];
const ignore = existsSync(safe('.gitignore')) ? text(safe('.gitignore')).split('\n').filter(line => !legacy.has(line)).join('\n') : '';
const additions = patterns.filter(p => !ignore.split('\n').includes(p));
write('.gitignore', ignore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n');
// Earlier kit versions tracked ownership in a receipt; handlers are now recognized by their commands.
if (existsSync(safe('.github/workflow-kit.json'))) unlinkSync(safe('.github/workflow-kit.json'));
console.log('Project files configured. Run setup-skills next; install and trust the hooks explicitly.');
