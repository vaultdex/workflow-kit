import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit setup from a reviewed checkout, never an install/agent/Git hook.
const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? kit);
const source = join(kit, ".vendor/impeccable");
const state = join(root, ".impeccable");
const bundle = join(state, "vendor");
const security = join(kit, "scripts/impeccable");
const providers = [".agent", ".agents", ".claude", ".github", ".opencode", ".pi"];
const skills = providers.map((provider) => `${provider}/skills/impeccable`);
const linkedSkills = skills.filter((skill) => !skill.startsWith(".github/"));
const text = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
// Resolve installed Git once; neither it nor child commands may come from checkout/PATH-relative entries.
const checkouts = [root, kit, process.cwd()].map(path => realpathSync(path));
const outside = path => checkouts.every(base => path !== base && !path.startsWith(base + sep));
const searchPath = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)
  .filter((path) => existsSync(path) && outside(realpathSync(path)));
const gitBinary = searchPath.map((path) => join(path, process.platform === "win32" ? "git.exe" : "git"))
  .filter(existsSync).map(path => realpathSync(path)).find(outside);
assert.ok(gitBinary, "Install Git in an absolute PATH directory outside this checkout");
const git = (...args) => execFileSync(gitBinary, args, { cwd: root, encoding: "utf8",
  env: { ...process.env, PATH: searchPath.join(delimiter), NoDefaultCurrentDirectoryInExePath: "1" } });
const present = (path) => lstatSync(path, { throwIfNoEntry: false });
const digest = path => createHash("sha256").update(text(path)).digest("hex");

// Never traverse a harness/state directory redirected outside this checkout.
function localDirectory(path) {
  let ancestor = path;
  while (!present(ancestor)) ancestor = dirname(ancestor);
  const existing = realpathSync(ancestor);
  assert.ok(existing === realpathSync(root) || existing.startsWith(realpathSync(root) + sep),
    `Directory leaves checkout: ${path}`);
  mkdirSync(path, { recursive: true });
  const actual = realpathSync(path);
  assert.ok(actual.startsWith(realpathSync(root) + sep), `Directory leaves checkout: ${path}`);
}

function companionFiles(base) {
  const copilot = ".github/skills/impeccable";
  const copilotFiles = existsSync(join(base, copilot))
    ? readdirSync(join(base, copilot), { recursive: true })
      .filter((name) => lstatSync(join(base, copilot, name)).isFile())
      .map((name) => `${copilot}/${name.split(sep).join("/")}`) : [];
  return copilotFiles.concat([".claude/agents", ".github/agents", ".codex/agents", ".opencode/commands"]
    .flatMap((directory) => existsSync(join(base, directory))
      ? readdirSync(join(base, directory)).filter((name) => /^impeccable[-_.][\w.-]+$/.test(name))
        .map((name) => `${directory}/${name}`) : []));
}

function copyTracked(from, to) {
  const files = git("-C", source, "ls-files", "-z", "--", from).split("\0").filter(Boolean);
  assert.ok(files.length, `Missing upstream files: ${from}`);
  for (const file of files) {
    assert.ok(file.startsWith(`${from}/`) && lstatSync(join(source, file)).isFile(),
      `Unexpected upstream path/link: ${file}`);
    const target = join(to, file.slice(from.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
    // Copilot's committed text follows this repository's LF policy.
    if (file.startsWith(".github/") && /(?:\.(?:md|json|js|toml|cmd)|\/(?:LICENSE|VERSION|impeccable))$/.test(file)) {
      let content = text(target);
      if (/\/reference\/(?:extract|harden|optimize)\.md$/.test(file))
        content = content.split("\n").map((line) => line.trimEnd()).join("\n").trimEnd() + "\n";
      writeFileSync(target, content);
    }
  }
}

localDirectory(state);
assert.ok(!present(bundle)?.isSymbolicLink(), "Generated bundle must not be a link");
if (existsSync(bundle)) {
  const owner = join(bundle, ".owner");
  assert.ok(present(owner)?.isFile() && text(owner).trim() === "vaultdex-impeccable",
    "Refusing to replace an unknown .impeccable/vendor directory");
}
const receipt = ".github/skills/impeccable/.vaultdex-source.json";
localDirectory(dirname(join(root, receipt)));
assert.ok(!present(join(root, receipt)) || present(join(root, receipt)).isFile(),
  "Receipt must be a regular file");
git("-C", kit, "submodule", "update", "--init", "--", ".vendor/impeccable");
assert.equal(git("-C", source, "status", "--porcelain", "--untracked-files=all").trim(), "",
  "Impeccable submodule has local changes; preserve/review them before setup");
const version = text(join(security, "VERSION")).trim();
const stage = mkdtempSync(join(state, "setup-"));
const next = join(stage, "next");
const previous = join(stage, "previous");
let published = false;
// ponytail: one explicit setup per checkout; add a lock if setup becomes automated.
try {
  for (const skill of skills) {
    assert.equal(text(join(source, skill, "scripts/VERSION")).trim(), version,
      "Upstream engine changed: review VERSION, SHA256SUMS and fixed hook definitions together");
    // Ignored local binaries/caches must never enter the pinned installation.
    copyTracked(skill, join(next, skill));
    // Release archives add these root attribution files to every provider package.
    for (const file of ["LICENSE", "NOTICE.md"])
      writeFileSync(join(next, skill, file), text(join(source, file)));
    // Git for Windows may check upstream out as CRLF. Shell scripts need LF.
    for (const name of ["impeccable", "impeccable.cmd"])
      writeFileSync(join(next, skill, "scripts", name), text(join(next, skill, "scripts", name)));
    git("apply", "--whitespace=error-all", `--directory=${relative(root, join(next, skill)).split(sep).join("/")}`,
      join(security, "launchers.patch"));
    copyFileSync(join(security, "SHA256SUMS"), join(next, skill, "scripts/SHA256SUMS"));
    chmodSync(join(next, skill, "scripts/impeccable"), 0o755);
  }
  for (const directory of [".claude/agents", ".github/agents", ".opencode/commands"])
    copyTracked(directory, join(next, directory));
  copyTracked(".agents/skills/impeccable/agents", join(next, ".codex/agents"));
  const revision = git("-C", source, "rev-parse", "HEAD").trim();
  const inputFiles = ["scripts/setup-impeccable.mjs", "scripts/impeccable/launchers.patch",
    "scripts/impeccable/SHA256SUMS", "scripts/impeccable/VERSION"];
  const inputs = createHash("sha256").update(inputFiles.map((file) => text(join(kit, file))).join("\0")).digest("hex");
  const recorded = existsSync(join(root, receipt)) ? JSON.parse(text(join(root, receipt))) : null;
  const files = Object.fromEntries(companionFiles(next).sort().map(file => [file, digest(join(next, file))]));
  writeFileSync(join(next, receipt), JSON.stringify({ revision, inputs, files }, null, 2) + "\n");
  writeFileSync(join(next, ".owner"), "vaultdex-impeccable\n");
  const oldFiles = companionFiles(bundle);
  const newFiles = companionFiles(next);
  const trackedCopilot = new Set(git("ls-files", "-z", "--", ".github/skills/impeccable",
    ".github/agents/impeccable*").split("\0").filter(Boolean));
  // Preflight every destination before replacing any working installation.
  for (const skill of linkedSkills) {
    const target = join(root, skill);
    localDirectory(dirname(target));
    if (present(target)) {
      assert.ok(lstatSync(target).isSymbolicLink(), `Existing skill left untouched: ${target}`);
      assert.equal(resolve(dirname(target), readlinkSync(target)), join(bundle, skill),
        `Foreign skill link left untouched: ${target}`);
    }
  }
  for (const file of new Set([...oldFiles, ...newFiles, ...trackedCopilot])) {
    const target = join(root, file);
    localDirectory(dirname(target));
    if (!present(target)) continue;
    assert.ok(lstatSync(target).isFile() && (
      (oldFiles.includes(file) && readFileSync(target).equals(readFileSync(join(bundle, file))))
      || (file !== receipt && recorded?.files?.[file] === digest(target))
      || (file !== receipt && newFiles.includes(file) && digest(target) === digest(join(next, file)))
      // Legacy receipts had only source/input pins; other assets must still match known bytes.
      || (file === receipt && (recorded?.files || recorded?.revision === revision)
        && /^[a-f0-9]{40}$/.test(recorded?.revision) && /^[a-f0-9]{64}$/.test(recorded.inputs)
        && Object.keys(recorded).every(key => ["revision", "inputs", "files"].includes(key)))),
    `Existing or edited companion left untouched: ${target}`);
  }
  if (existsSync(bundle)) renameSync(bundle, previous);
  try { renameSync(next, bundle); }
  catch (error) {
    if (existsSync(previous)) renameSync(previous, bundle);
    throw error;
  }
  for (const skill of linkedSkills) {
    const target = join(root, skill);
    if (!present(target)) symlinkSync(process.platform === "win32" ? join(bundle, skill)
      : relative(dirname(target), join(bundle, skill)), target, process.platform === "win32" ? "junction" : "dir");
  }
  for (const file of new Set([...oldFiles, ...trackedCopilot].filter((file) => !newFiles.includes(file))))
    if (present(join(root, file))) unlinkSync(join(root, file));
  for (const file of newFiles) copyFileSync(join(bundle, file), join(root, file));
  published = true;
  console.log(`Impeccable ${revision.slice(0, 7)}: five providers linked; tracked Copilot assets and companions refreshed.\n`
    + "Hook engine/trust unchanged. From the product root: node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs .; inside the kit: node scripts/install-impeccable-hooks.mjs .");
} finally {
  // Only this invocation's generated staging/previous bundle, confined to state.
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  if (published || !existsSync(previous)) rmSync(stage, { recursive: true, force: true });
  else console.error(`Setup incomplete; previous generated installation preserved at ${previous}`);
}
