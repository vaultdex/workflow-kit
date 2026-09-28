import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { externalTool } from "./checkout-root.mjs";
import { link, localDirectory } from "./provider-links.mjs";

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
const gitTool = externalTool("git", root, kit, process.cwd());
const git = (...args) => execFileSync(gitTool.file, args, { cwd: root, env: gitTool.env, encoding: "utf8" });
const present = (path) => lstatSync(path, { throwIfNoEntry: false });
const digest = path => createHash("sha256").update(text(path)).digest("hex");

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

/** Build one provider package from the pinned upstream plus the reviewed patches. */
function generateSkill(skill, to) {
  // Ignored local binaries/caches must never enter the pinned installation.
  copyTracked(skill, to);
  // Release archives add these root attribution files to every provider package.
  for (const file of ["LICENSE", "NOTICE.md"])
    writeFileSync(join(to, file), text(join(source, file)));
  // Git for Windows may check upstream out as CRLF. Shell scripts and the LF patches need LF.
  for (const name of ["impeccable", "impeccable.cmd", "live-browser-ignores.js"])
    writeFileSync(join(to, "scripts", name), text(join(to, "scripts", name)));
  for (const patch of ["launchers.patch", "maintainability.patch"])
    git("apply", "--whitespace=error-all", `--directory=${relative(root, to).split(sep).join("/")}`, join(security, patch));
  copyFileSync(join(security, "SHA256SUMS"), join(to, "scripts/SHA256SUMS"));
  chmodSync(join(to, "scripts/impeccable"), 0o755);
}

localDirectory(root, state);
assert.ok(!present(bundle)?.isSymbolicLink(), "Generated bundle must not be a link");
const receipt = ".github/skills/impeccable/.vaultdex-source.json";
localDirectory(root, dirname(join(root, receipt)));
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
    generateSkill(skill, join(next, skill));
  }
  for (const directory of [".claude/agents", ".github/agents", ".opencode/commands"])
    copyTracked(directory, join(next, directory));
  copyTracked(".agents/skills/impeccable/agents", join(next, ".codex/agents"));
  const revision = git("-C", source, "rev-parse", "HEAD").trim();
  const recorded = existsSync(join(root, receipt)) ? JSON.parse(text(join(root, receipt))) : null;
  const files = Object.fromEntries(companionFiles(next).sort().map(file => [file, digest(join(next, file))]));
  writeFileSync(join(next, receipt), JSON.stringify({ revision, files }, null, 2) + "\n");
  const oldFiles = companionFiles(bundle);
  const newFiles = companionFiles(next);
  const trackedCopilot = new Set(git("ls-files", "-z", "--", ".github/skills/impeccable",
    ".github/agents/impeccable*").split("\0").filter(Boolean));
  // Companions outside the bundle are replaced or removed only while they match a known generated state.
  for (const file of new Set([...oldFiles, ...newFiles, ...trackedCopilot])) {
    const target = join(root, file);
    localDirectory(root, dirname(target));
    if (!present(target)) continue;
    assert.ok(lstatSync(target).isFile() && (file === receipt
      || recorded?.files?.[file] === digest(target)
      || (newFiles.includes(file) && digest(target) === digest(join(next, file)))
      || (oldFiles.includes(file) && readFileSync(target).equals(readFileSync(join(bundle, file))))),
    `Existing or edited companion left untouched: ${target}`);
  }
  if (existsSync(bundle)) renameSync(bundle, previous);
  try { renameSync(next, bundle); }
  catch (error) {
    if (existsSync(previous)) renameSync(previous, bundle);
    throw error;
  }
  for (const skill of linkedSkills) link(root, join(root, skill), join(bundle, skill));
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
