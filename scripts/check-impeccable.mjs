import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Real first-use proof: no npm install, vendored binary, or existing engine cache.
const temporary = mkdtempSync(join(tmpdir(), "vaultdex-impeccable-"));
const checkout = join(temporary, "checkout with spaces");
const env = { ...process.env, IMPECCABLE_HOME: join(temporary, "engine-cache"),
  USERPROFILE: join(temporary, "user"), HOME: join(temporary, "user") };
for (const key of ["IMPECCABLE_BIN", "IMPECCABLE_SELF", "IMPECCABLE_SKILL_DIR",
  "IMPECCABLE_LAUNCHER_PROBE", "IMPECCABLE_HOOK_DISABLED", "IMPECCABLE_HOOK_QUIET",
  "NoDefaultCurrentDirectoryInExePath", "IMPECCABLE_DOWNLOAD_BASE"])
  delete env[key];
const windows = process.platform === "win32";
const shell = windows ? join(process.env.SystemRoot, "System32/cmd.exe") : "/bin/sh";
const powershell = windows ? join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : null;
// Resolve developer-installed Git once; never search the checkout/current directory.
const git = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)
  .map((directory) => join(directory, windows ? "git.exe" : "git")).find(existsSync);
assert.ok(git, "Git must be installed in an absolute PATH directory");
const bash = windows ? resolve(dirname(git), "../bin/bash.exe") : null;
const json = (path) => JSON.parse(readFileSync(join(checkout, path), "utf8"));
let server;

function run(command, cwd = checkout, input = "{}") {
  const result = spawnSync(command, { shell, cwd, env, input, encoding: "utf8", timeout: 120_000 });
  if (windows && env.IMPECCABLE_TEST_MARKER)
    assert.ok(!existsSync(env.IMPECCABLE_TEST_MARKER), "Checkout-controlled executable was invoked");
  assert.equal(result.status, 0, `${command}\n${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  execFileSync(git, ["clone", "--quiet", "--no-hardlinks", "--local", resolve("."), checkout]);
  const provenance = () => spawnSync(process.execPath, ["--test", "scripts/tests/impeccable-installation.test.mjs"],
    { cwd: checkout, env, encoding: "utf8" });
  const missingSource = provenance();
  assert.equal(missingSource.status, 1);
  assert.match(missingSource.stdout, /Initialize the pinned source/);
  // Use the actual pinned submodule via a local file transport, not another download.
  execFileSync(git, ["-C", checkout, "config", "submodule..vendor/impeccable.url",
    pathToFileURL(resolve(".vendor/impeccable")).href]);
  execFileSync(git, ["-c", "protocol.file.allow=always", "-C", checkout,
    "submodule", "update", "--init", "--depth", "1", "--", ".vendor/impeccable"]);
  assert.equal(provenance().status, 0);
  for (const file of [".github/skills/impeccable/SKILL.md", ...[
    "asset-producer", "documenter", "finish-reviewer", "manual-edit-applier",
  ].map((name) => `.github/agents/impeccable-${name}.agent.md`)]) {
    const target = join(checkout, file);
    const source = join(checkout, ".vendor/impeccable", file);
    const original = readFileSync(target);
    const upstreamOriginal = readFileSync(source);
    writeFileSync(target, `${original}\nUnregenerated discovery mutation.\n`);
    const changed = provenance();
    assert.equal(changed.status, 1, file);
    assert.ok(changed.stdout.includes(`Regenerate ${file}`), changed.stdout);
    // Editing both copies must not substitute a working tree for the pinned blobs.
    copyFileSync(target, source);
    assert.equal(provenance().status, 1, file);
    writeFileSync(source, upstreamOriginal);
    writeFileSync(target, original.toString().replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
    assert.equal(provenance().status, 0, `CRLF: ${file}`);
    writeFileSync(target, original);
  }
  execFileSync(process.execPath, [join(checkout, "scripts/init-project.mjs"), checkout, "--existing"], { env });
  for (const app of ["frontend", "apps/mobile"]) {
    mkdirSync(join(checkout, app, "src"), { recursive: true });
    mkdirSync(join(checkout, app, ".impeccable"), { recursive: true });
    writeFileSync(join(checkout, app, ".impeccable/config.json"), '{"buildPath":"code"}');
  }
  mkdirSync(join(checkout, ".impeccable"), { recursive: true });
  writeFileSync(join(checkout, ".impeccable/config.json"), '{"hook":{"enabled":true}}');
  writeFileSync(join(checkout, "PRODUCT.md"), '# Test product\n\n<!-- impeccable:product-schema 1 -->\n\n## Platform\n\nweb\n');
  writeFileSync(join(checkout, "apps/mobile/PRODUCT.md"), '# Test mobile product\n\n<!-- impeccable:product-schema 1 -->\n\n## Platform\n\nadaptive\n');
  const setup = join(checkout, "scripts/setup-impeccable.mjs");
  const foreignSkill = join(checkout, ".agents/skills/impeccable");
  mkdirSync(foreignSkill, { recursive: true });
  writeFileSync(join(foreignSkill, "custom.txt"), "preserve this skill");
  const refused = spawnSync(process.execPath, [setup], { cwd: checkout, env, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Existing skill left untouched/);
  assert.equal(readFileSync(join(foreignSkill, "custom.txt"), "utf8"), "preserve this skill");
  rmSync(foreignSkill, { recursive: true }); // Only the fixture created above.
  const ignoredBinary = ".agents/skills/impeccable/scripts/bin/local-engine";
  mkdirSync(dirname(join(checkout, ".vendor/impeccable", ignoredBinary)), { recursive: true });
  writeFileSync(join(checkout, ".vendor/impeccable", ignoredBinary), "must not be installed");
  execFileSync(process.execPath, [setup], { cwd: checkout, env });
  execFileSync(process.execPath, [setup], { cwd: join(checkout, "frontend"), env });
  assert.equal(provenance().status, 0, "Regenerated discovery must match the pinned source");
  assert.ok(!existsSync(join(checkout, ignoredBinary)), "Ignored upstream binaries must not be copied");
  const companion = join(checkout, ".codex/agents/impeccable_documenter.toml");
  const originalCompanion = readFileSync(companion);
  writeFileSync(companion, "user edit");
  const edited = spawnSync(process.execPath, [setup], { cwd: checkout, env, encoding: "utf8" });
  assert.notEqual(edited.status, 0);
  assert.match(edited.stderr, /Existing or edited companion left untouched/);
  assert.equal(readFileSync(companion, "utf8"), "user edit");
  writeFileSync(companion, originalCompanion);
  assert.equal(execFileSync(git, ["-C", join(checkout, ".vendor/impeccable"), "status", "--porcelain"],
    { encoding: "utf8" }).trim(), "", "Setup must leave upstream clean");
  const upstream = join(checkout, ".vendor/impeccable");
  const upstreamGit = (...args) => execFileSync(git, ["-C", upstream, ...args], { encoding: "utf8" }).trim();
  const baseline = upstreamGit("rev-parse", "HEAD");
  const pinFixture = () => {
    upstreamGit("add", ".");
    upstreamGit("-c", "user.name=Setup test", "-c", "user.email=setup@example.invalid",
      "commit", "--quiet", "-m", "Local disposable update fixture");
    execFileSync(git, ["-C", checkout, "add", ".vendor/impeccable"]);
  };
  const commitPin = () => execFileSync(git, ["-C", checkout, "-c", "user.name=Setup test",
    "-c", "user.email=setup@example.invalid", "commit", "--quiet", "-m", "Pin disposable source fixture",
    "--", ".vendor/impeccable"]);
  const updateFile = ".github/skills/impeccable/reference/update-probe.md";
  const updateAgent = ".github/agents/impeccable-update-probe.agent.md";
  const eol = windows ? "\r\n" : "\n";
  writeFileSync(join(upstream, updateFile), `new release content${eol}`);
  writeFileSync(join(upstream, updateAgent), `new companion${eol}`);
  const skill = join(upstream, ".github/skills/impeccable/SKILL.md");
  writeFileSync(skill, `${readFileSync(skill, "utf8")}${eol}Updated release instructions.${eol}`);
  pinFixture();
  commitPin();
  assert.equal(provenance().status, 1, "New pin without regeneration must fail");
  execFileSync(process.execPath, [setup], { cwd: checkout, env });
  assert.equal(provenance().status, 0, "Regenerated release instructions must pass");
  assert.equal(readFileSync(join(checkout, updateFile), "utf8"), "new release content\n");
  assert.equal(readFileSync(join(checkout, updateAgent), "utf8"), "new companion\n");
  // A new engine must not reuse old pins/hook definitions or displace working skills.
  writeFileSync(join(upstream, ".agent/skills/impeccable/scripts/VERSION"), `99.0.0${eol}`);
  pinFixture();
  const incompatible = spawnSync(process.execPath, [setup], { cwd: checkout, env, encoding: "utf8" });
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Upstream engine changed/);
  assert.equal(readFileSync(join(checkout, updateFile), "utf8"), "new release content\n");
  upstreamGit("checkout", "--quiet", "--detach", baseline);
  execFileSync(git, ["-C", checkout, "add", ".vendor/impeccable"]);
  commitPin();
  execFileSync(process.execPath, [setup], { cwd: checkout, env });
  assert.equal(provenance().status, 0, "Restored release must pass after regeneration");
  assert.ok(!existsSync(join(checkout, updateFile)), "Removed upstream skill files must disappear");
  assert.ok(!existsSync(join(checkout, updateAgent)), "Removed upstream companions must disappear");
  const roots = [".agent", ".agents", ".claude", ".github", ".opencode", ".pi"];
  for (const root of roots) {
    assert.ok(!existsSync(join(checkout, root, "skills/impeccable/scripts/bin")));
    for (const file of ["LICENSE", "NOTICE.md"])
      assert.equal(readFileSync(join(checkout, root, "skills/impeccable", file), "utf8"),
        readFileSync(join(upstream, file), "utf8").replaceAll("\r\n", "\n"));
    for (const file of ["impeccable", "impeccable.cmd", "SHA256SUMS"])
      assert.equal(readFileSync(join(checkout, root, "skills/impeccable/scripts", file), "utf8"),
        readFileSync(join(checkout, ".agents/skills/impeccable/scripts", file), "utf8"));
  }
  assert.ok(!existsSync(join(checkout, ".impeccable/config.local.json")));
  assert.ok(!existsSync(join(checkout, ".claude/settings.local.json")));
  for (const name of ["asset_producer", "documenter", "finish_reviewer", "manual_edit_applier"]) {
    const filename = `impeccable_${name}.toml`;
    assert.equal(readFileSync(join(checkout, ".codex/agents", filename), "utf8"),
      readFileSync(join(checkout, ".agents/skills/impeccable/agents", filename), "utf8"));
  }

  const codex = json(".codex/hooks.json").hooks;
  const postEdit = codex.PostToolUse[0].hooks[0];
  if (windows) {
    // Real executables catch implicit cmd.exe lookup even for explicit .exe names.
    env.IMPECCABLE_TEST_MARKER = join(temporary, "hijacked");
    env.IMPECCABLE_TEST_SHIM = join(temporary, "shim.exe");
    execFileSync(powershell, ["-NoProfile", "-Command", `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:IMPECCABLE_TEST_SHIM -TypeDefinition '
      public class Shim { public static void Main() {
        System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("IMPECCABLE_TEST_MARKER"), "executed");
        System.Console.WriteLine("impeccable-engine 0.1.5");
      } }'`], { env });
    for (const directory of [checkout, join(checkout, "frontend"), join(checkout, "apps/mobile")]) {
      for (const tool of ["where", "git", "curl", "certutil", "findstr"])
        copyFileSync(env.IMPECCABLE_TEST_SHIM, join(directory, `${tool}.exe`));
      writeFileSync(join(directory, "impeccable.cmd"), '@echo off\r\necho executed>"%IMPECCABLE_TEST_MARKER%"\r\n');
    }
  }
  // Setup must also reject checkout executables, including an explicit PATH entry.
  if (!windows) {
    writeFileSync(join(checkout, "git"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
  execFileSync(process.execPath, [setup], { cwd: checkout,
    env: { ...env, PATH: `${checkout}${delimiter}.${delimiter}${process.env.PATH}` } });
  if (windows) assert.ok(!existsSync(env.IMPECCABLE_TEST_MARKER), "Setup ran checkout-controlled Git");
  const version = readFileSync(join(checkout, ".agents/skills/impeccable/scripts/VERSION"), "utf8").trim();
  const missing = spawnSync(windows ? postEdit.commandWindows : postEdit.command,
    { shell, cwd: join(checkout, "frontend"), env, input: "{}", encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /node scripts\/install-impeccable-hooks.mjs/);
  assert.ok(!existsSync(env.IMPECCABLE_HOME), "A hook must not auto-install checkout code");
  const installer = join(checkout, "scripts/install-impeccable-hooks.mjs");
  execFileSync(process.execPath, [installer], { env });
  execFileSync(process.execPath, [installer], { env }); // Existing install verifies, never overwrites.
  const installed = join(env.USERPROFILE, ".impeccable/vaultdex", `engine-${version}`,
    windows ? "impeccable.exe" : "impeccable");

  // A local release server serves either valid bytes or substituted bytes AND their matching sidecar.
  // It runs in another process because the launcher checks below use synchronous child processes.
  const substituted = join(temporary, "substituted");
  writeFileSync(substituted, "not the reviewed engine");
  server = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const good = readFileSync(process.argv[1]), bad = readFileSync(process.argv[2]);
    const server = createServer((req, res) => {
      const body = req.url.startsWith('/tampered/') ? bad : good;
      if (req.url.endsWith('.sha256')) return res.end(createHash('sha256').update(body).digest('hex'));
      res.write(body.subarray(0, body.length / 2));
      setTimeout(() => res.end(body.subarray(body.length / 2)), 100);
    });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `, installed, substituted], { stdio: ["ignore", "pipe", "inherit"] });
  const [address] = await once(server.stdout, "data");
  const base = address.toString().trim();
  const primary = join(checkout, ".agents/skills/impeccable/scripts", windows ? "impeccable.cmd" : "impeccable");
  env.IMPECCABLE_DOWNLOAD_BASE = `${base}/tampered`;
  const rejected = spawnSync(`"${primary}" engine-probe`, { shell, cwd: checkout, env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(env.IMPECCABLE_HOME, "bin", version, windows ? "impeccable.exe" : "impeccable")));
  const rejectedInstall = spawnSync(process.execPath, [installer], {
    env: { ...env, USERPROFILE: join(temporary, "bad-user"), HOME: join(temporary, "bad-user") }, encoding: "utf8" });
  assert.notEqual(rejectedInstall.status, 0);
  assert.match(rejectedInstall.stderr, /does not match repository SHA256SUMS/);

  env.IMPECCABLE_DOWNLOAD_BASE = `${base}/valid`;
  // Force overlapping cold starts against one cache, with delayed fixture responses.
  const concurrent = await Promise.allSettled(roots.map((root) => new Promise((resolve, reject) => {
    const launcher = join(checkout, root, "skills/impeccable/scripts", windows ? "impeccable.cmd" : "impeccable");
    const child = spawn(`"${launcher}" engine-probe`, { shell, cwd: checkout, env, timeout: 120_000 });
    let output = "", errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || output.trim() !== `impeccable-engine ${version}`) reject(new Error(`${code}: ${errors}\n${output}`));
      else resolve();
    });
  })));
  for (const result of concurrent) assert.equal(result.status, "fulfilled", result.reason?.message);
  assert.deepEqual(readdirSync(join(env.IMPECCABLE_HOME, "bin", version)), [windows ? "impeccable.exe" : "impeccable"]);

  if (windows) {
    if (existsSync(bash)) {
      const posix = join(checkout, ".agents/skills/impeccable/scripts/impeccable");
      const posixEnv = { ...env, IMPECCABLE_HOME: join(temporary, "posix-cache"), IMPECCABLE_DOWNLOAD_BASE: `${base}/tampered` };
      const bad = spawnSync(bash, [posix, "engine-probe"], { cwd: checkout, env: posixEnv, encoding: "utf8" });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /checksum mismatch/);
      const good = spawnSync(bash, [posix, "engine-probe"], { cwd: checkout,
        env: { ...posixEnv, IMPECCABLE_DOWNLOAD_BASE: `${base}/valid` }, encoding: "utf8" });
      assert.equal(good.status, 0, good.stderr);
      assert.equal(good.stdout.trim(), `impeccable-engine ${version}`);
    } else console.log("Git Bash unavailable: POSIX launcher check skipped on Windows");
  }

  for (const root of roots) {
    const launcher = join(checkout, root, "skills/impeccable/scripts", windows ? "impeccable.cmd" : "impeccable");
    assert.equal(run(`"${launcher}" engine-probe`).trim(), `impeccable-engine ${version}`);
  }
  if (windows) {
    // Exercise the unversioned engine handshake (findstr) with hostile siblings too.
    const homeBin = join(env.USERPROFILE, ".impeccable/bin/impeccable.exe");
    mkdirSync(join(env.USERPROFILE, ".impeccable/bin"), { recursive: true });
    copyFileSync(join(env.IMPECCABLE_HOME, "bin", version, "impeccable.exe"), homeBin);
    assert.equal(run(`"${join(checkout, ".agents/skills/impeccable/scripts/impeccable.cmd")}" engine-probe`).trim(),
      `impeccable-engine ${version}`);
  }
  for (const app of ["frontend", "apps/mobile"]) {
    const launcher = join(checkout, ".agents/skills/impeccable/scripts", windows ? "impeccable.cmd" : "impeccable");
    const context = run(`"${launcher}" context`, join(checkout, app));
    assert.ok(!context.includes("NO_PRODUCT_MD") && context.includes("RESOLVED_CONTEXT"), context);
    assert.match(context, app === "frontend" ? /"platform":\s*"web"/ : /"platform":\s*"adaptive"/);
    assert.equal(json(`${app}/.impeccable/config.json`).buildPath, "code");
  }
  // Simulate a contributor changing every transitive checkout target after hook consent.
  env.IMPECCABLE_TEST_MARKER ??= join(temporary, "hijacked");
  for (const root of roots) {
    const directory = join(checkout, root, "skills/impeccable/scripts");
    writeFileSync(join(directory, "impeccable"), '#!/bin/sh\necho executed > "$IMPECCABLE_TEST_MARKER"\n');
    writeFileSync(join(directory, "impeccable.cmd"), '@echo off\r\necho executed>"%IMPECCABLE_TEST_MARKER%"\r\n');
    if (windows) {
      mkdirSync(join(directory, "bin/windows-x64"), { recursive: true });
      copyFileSync(env.IMPECCABLE_TEST_SHIM, join(directory, "bin/windows-x64/impeccable.exe"));
    }
  }
  writeFileSync(installer, 'throw new Error("Checkout installer executed by hook");');
  // Consent is simulated only inside this disposable clone; verify actual detector output.
  writeFileSync(join(checkout, ".impeccable/config.local.json"), JSON.stringify({ hook: { consent: "accepted" } }));
  const probeCss = join(checkout, "frontend/src/security-hook-probe.css");
  writeFileSync(probeCss, ".sample { border-left: 4px solid #234567; border-radius: 8px; }\n");
  const event = { hook_event_name: "PostToolUse", session_id: "security-probe", cwd: join(checkout, "frontend"),
    tool_name: "Edit", tool_input: { file_path: probeCss } };
  run(windows ? postEdit.commandWindows : postEdit.command, event.cwd, JSON.stringify(event));
  const stop = codex.Stop[0].hooks[0];
  const findings = run(windows ? stop.commandWindows : stop.command, event.cwd,
    JSON.stringify({ ...event, hook_event_name: "Stop" }));
  assert.match(findings, /\[side-tab\]/, "Installed engine must report real UI findings after checkout mutation");
  for (const event of ["PostToolUse", "Stop"]) {
    const handler = codex[event][0].hooks[0];
    run(windows ? handler.commandWindows : handler.command, join(checkout, "apps/mobile"),
      JSON.stringify({ hook_event_name: event, session_id: "checkout-smoke", cwd: join(checkout, "apps/mobile") }));
  }
  const copilot = json(".github/hooks/impeccable.json").hooks.postToolUse[0];
  if (windows) {
    const result = spawnSync(powershell, ["-NoProfile", "-Command", copilot.powershell],
      { cwd: join(checkout, "frontend"), env, input: "{}", encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(env.IMPECCABLE_TEST_MARKER), "Checkout-controlled executable was invoked");
    if (existsSync(bash)) {
      for (const command of [postEdit.command, copilot.bash,
        ...["PostToolUse", "Stop"].map((event) => json(".claude/settings.json").hooks[event][0].hooks[0].command)]) {
        const result = spawnSync(bash, ["-c", command],
          { cwd: join(checkout, "frontend"), env, input: "{}", encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
    }
  } else {
    run(copilot.bash, join(checkout, "frontend"));
    for (const event of ["PostToolUse", "Stop"])
      run(json(".claude/settings.json").hooks[event][0].hooks[0].command, join(checkout, "frontend"));
  }
  assert.ok(!existsSync(env.IMPECCABLE_TEST_MARKER), "Hook executed a mutable checkout target");
  console.log(`${process.platform}: fresh/repeated setup, release updates/removals, incompatible engine refusal, foreign file preservation, pinned downloads, concurrent cold starts, explicit hook install, hostile checkout and app contexts passed`);
} finally {
  if (server) { server.kill(); await once(server, "exit"); }
  // Only the directory created by this check, including its clone and engine cache.
  rmSync(temporary, { recursive: true, force: true });
}
