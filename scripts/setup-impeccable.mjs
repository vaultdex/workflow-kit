import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { externalTool, projectRoot } from "./checkout-root.mjs";
import { link, localDirectory, moveAside, rename } from "./provider-links.mjs";

// Explicit setup from a reviewed checkout, never an install/agent/Git hook.
const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = projectRoot();
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

/** Build one provider package from the pinned upstream. */
function generateSkill(skill, to) {
  // Ignored local binaries/caches must never enter the pinned installation.
  copyTracked(skill, to);
  // Release archives add these root attribution files to every provider package.
  for (const file of ["LICENSE", "NOTICE.md"])
    writeFileSync(join(to, file), text(join(source, file)));
  // Git for Windows may check upstream out as CRLF; the POSIX launcher needs LF.
  writeFileSync(join(to, "scripts/impeccable"), text(join(to, "scripts/impeccable")));
  chmodSync(join(to, "scripts/impeccable"), 0o755);
}

localDirectory(root, state);
assert.ok(!present(bundle)?.isSymbolicLink(), "Generated bundle must not be a link");
git("-C", kit, "submodule", "update", "--init", "--", ".vendor/impeccable");
assert.equal(git("-C", source, "status", "--porcelain", "--untracked-files=all").trim(), "",
  "Impeccable submodule has local changes; preserve/review them before setup");
// assume-unchanged (lowercase tag) or skip-worktree (S) would hide edits from the status check above.
assert.ok(!/^(?:[a-z]|S) /m.test(git("-C", source, "ls-files", "-v")), "Impeccable source hides local changes from git status");
// submodule.<name>.update=none skips the checkout above; only the kit's pin may be packaged.
assert.equal(git("-C", source, "rev-parse", "HEAD").trim(), git("-C", kit, "rev-parse", ":.vendor/impeccable").trim(),
  "Impeccable source is not at the kit pin");
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
  // Copilot skill and the impeccable* agents/commands are generated and replaced; files upstream no longer
  // ships (or the project's own) move to .workflow-kit/replaced/.
  // A link or file at the Copilot skill directory moves aside first; enumerating through it would reach its target.
  const copilot = join(root, ".github/skills/impeccable");
  if (present(copilot) && !present(copilot).isDirectory()) moveAside(root, copilot);
  // Check every output directory before the swap, so a linked one stops setup with nothing replaced.
  const fresh = companionFiles(next), stale = companionFiles(root).filter((file) => !fresh.includes(file));
  for (const file of [...linkedSkills, ...stale, ...fresh]) localDirectory(root, dirname(join(root, file)));
  // A directory where a companion file belongs can't be replaced by a file copy; keep it aside.
  for (const file of fresh) if (present(join(root, file))?.isDirectory()) moveAside(root, join(root, file));
  if (existsSync(bundle)) rename(bundle, previous);
  try { rename(next, bundle); }
  catch (error) {
    if (existsSync(previous)) rename(previous, bundle);
    throw error;
  }
  for (const skill of linkedSkills) link(root, join(root, skill), join(bundle, skill));
  for (const file of stale) moveAside(root, join(root, file));
  for (const file of fresh) {
    // Drop whatever is left at the destination first: copying onto a link would write through it.
    rmSync(join(root, file), { force: true });
    copyFileSync(join(bundle, file), join(root, file));
  }
  published = true;
  console.log(`Impeccable ${revision.slice(0, 7)}: five providers linked; tracked Copilot assets and companions refreshed.\n`
    + "Hook engine and trust unchanged; install the engine with install-impeccable-hooks.mjs.");
} finally {
  // Only this invocation's generated staging/previous bundle, confined to state.
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  if (published || !existsSync(previous)) rmSync(stage, { recursive: true, force: true });
  else console.error(`Setup incomplete; previous generated installation preserved at ${previous}`);
}
