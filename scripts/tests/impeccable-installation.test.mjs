import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import test from "node:test";

test("Copilot discovery assets were generated for the pinned submodule and setup", () => {
  const root = realpathSync(process.cwd());
  const outside = p => p !== root && !p.startsWith(root + sep);
  const binary = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)
    .filter(p => existsSync(p) && outside(realpathSync(p)))
    .map(path => join(path, process.platform === "win32" ? "git.exe" : "git"))
    .find(p => existsSync(p) && outside(realpathSync(p)));
  assert.ok(binary, "Install Git outside the checkout on an absolute PATH");
  const git = realpathSync(binary);
  const revision = execFileSync(git, ["rev-parse", "HEAD:.vendor/impeccable"], { encoding: "utf8" }).trim();
  const files = ["scripts/setup-impeccable.mjs", "scripts/impeccable/launchers.patch",
    "scripts/impeccable/SHA256SUMS", "scripts/impeccable/VERSION"];
  const inputs = createHash("sha256").update(files.map((file) => readFileSync(file, "utf8")
    .replaceAll("\r\n", "\n")).join("\0")).digest("hex");
  const receipt = JSON.parse(readFileSync(".github/skills/impeccable/.vaultdex-source.json", "utf8"));
  assert.deepEqual({ revision: receipt.revision, inputs: receipt.inputs }, { revision, inputs },
    "Run node scripts/setup-impeccable.mjs and commit refreshed .github assets with the update");
  // A fresh clone contains committed discovery assets, not generated local companions.
  for (const [file, digest] of Object.entries(receipt.files).filter(([file]) => file.startsWith(".github/")))
    assert.equal(createHash("sha256").update(readFileSync(file, "utf8").replaceAll("\r\n", "\n")).digest("hex"), digest,
      `Regenerate ${file}: generated ownership hash differs`);
  assert.ok(existsSync(".vendor/impeccable/.git"),
    "Initialize the pinned source: git submodule update --init --depth 1 -- .vendor/impeccable");
  for (const file of [".github/skills/impeccable/SKILL.md", ...[
    "asset-producer", "documenter", "finish-reviewer", "manual-edit-applier",
  ].map((name) => `.github/agents/impeccable-${name}.agent.md`)]) {
    const actual = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    assert.match(actual, /^---\n/, "Copilot must discover assets before setup");
    // Setup only copies these discovery files and normalizes line endings.
    // Read committed blobs, never a potentially edited submodule working tree.
    const expected = execFileSync(git, ["-C", ".vendor/impeccable", "show", `${revision}:${file}`],
      { encoding: "utf8" }).replaceAll("\r\n", "\n");
    assert.equal(actual, expected, `Regenerate ${file} from the pinned source with node scripts/setup-impeccable.mjs`);
  }
});
