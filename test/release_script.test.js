import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  bumpVersion,
  tagFromVersion,
  countManifestTools,
  parseTestCount,
  refreshReadmeNumbers,
  formatReleaseNotes,
  buildGhArgs,
  formatGhCommand,
} from "../scripts/release.mjs";

// FBMCPF-160 — release automation (pure-helper unit tests)

test("parseArgs reads flags and the --themes value", () => {
  const a = parseArgs(["--dry-run", "--patch", "--skip-tests", "--allow-dirty", "--themes", "docs + tests"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.patch, true);
  assert.equal(a.skipTests, true);
  assert.equal(a.allowDirty, true);
  assert.equal(a.themes, "docs + tests");
});

test("parseArgs supports --themes= form and defaults", () => {
  const a = parseArgs(["--themes=release automation"]);
  assert.equal(a.themes, "release automation");
  assert.equal(a.dryRun, false);
  assert.equal(a.patch, false);
});

test("bumpVersion bumps minor by default and resets patch", () => {
  assert.equal(bumpVersion("0.5.0"), "0.6.0");
  assert.equal(bumpVersion("0.5.7"), "0.6.0");
});

test("bumpVersion bumps patch when requested", () => {
  assert.equal(bumpVersion("0.5.1", { patch: true }), "0.5.2");
  assert.equal(bumpVersion("0.5.0", { patch: true }), "0.5.1");
});

test("bumpVersion rejects non-semver input", () => {
  assert.throws(() => bumpVersion("0.5"), /semver/);
  assert.throws(() => bumpVersion("not-a-version"), /semver/);
});

test("tagFromVersion: minor releases drop the patch, patch releases keep it", () => {
  // .0 releases use the repo's minor-only tag style …
  assert.equal(tagFromVersion("0.6.0"), "v0.6");
  assert.equal(tagFromVersion("1.2.0"), "v1.2");
  // … but a patch release carries the full tag so it can't collide with the
  // minor tag that already exists (e.g. v0.7 from 0.7.0 → v0.7.1 for 0.7.1).
  assert.equal(tagFromVersion("0.7.1"), "v0.7.1");
  assert.equal(tagFromVersion("1.2.9"), "v1.2.9");
});

test("countManifestTools counts the tools array from an object or raw JSON text", () => {
  const obj = { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] };
  assert.equal(countManifestTools(obj), 3);
  assert.equal(countManifestTools(JSON.stringify(obj)), 3);
  assert.equal(countManifestTools({}), 0);
});

test("parseTestCount reads the passing count from node --test TAP output", () => {
  const out = "# tests 189\n# pass 189\n# fail 0\n# skipped 0\n";
  assert.equal(parseTestCount(out), 189);
});

test("parseTestCount returns null when nothing parses", () => {
  assert.equal(parseTestCount("no summary here"), null);
});

test("refreshReadmeNumbers rewrites the tool-count, tool-surface, mcpb filename, and test-count claims without touching surrounding prose", () => {
  const readme = [
    "What you get is ~130 tools spanning the entire product surface: board and churn loop.",
    "",
    "> for a clean start. Turn that off in the extension settings to expose the full ~130-tool",
    "> surface (CRM, media, and more).",
    "",
    "1. Install the extension: double-click `featureboard-0.3.2.mcpb`, or Claude Desktop.",
    "",
    "node --test                       # unit tests (158)",
  ].join("\n");

  const out = refreshReadmeNumbers(readme, { tools: 189, tests: 520, version: "0.6.0" });

  assert.match(out, /~189 tools spanning the entire product surface/);
  assert.match(out, /full ~189-tool/);
  assert.match(out, /featureboard-0\.6\.0\.mcpb/);
  assert.match(out, /# unit tests \(520\)/);
  // Prose around the numbers must survive untouched.
  assert.match(out, /board and churn loop\./);
  assert.match(out, /CRM, media, and more\)\./);
});

test("refreshReadmeNumbers leaves a claim untouched when its replacement value is null", () => {
  const readme = "node --test                       # unit tests (158)";
  const out = refreshReadmeNumbers(readme, { tools: null, tests: null, version: null });
  assert.equal(out, readme);
});

test("formatReleaseNotes matches the established one-line shape", () => {
  const notes = formatReleaseNotes({
    commitCount: 9, prevTag: "v0.5", toolsPrev: 161, toolsNow: 189,
    testsPrev: 270, testsNow: 520, themes: "release automation, README auto-refresh",
  });
  assert.equal(
    notes,
    "full release notes: 9 commits since v0.5, 161→189 tools, 270→520 tests, organized as release automation, README auto-refresh."
  );
});

test("formatReleaseNotes refuses to invent themes", () => {
  assert.throws(
    () => formatReleaseNotes({ commitCount: 1, prevTag: "v0.5", toolsPrev: 1, toolsNow: 2, testsPrev: 1, testsNow: 2, themes: "" }),
    /themes/
  );
  assert.throws(
    () => formatReleaseNotes({ commitCount: 1, prevTag: "v0.5", toolsPrev: 1, toolsNow: 2, testsPrev: 1, testsNow: 2 }),
    /themes/
  );
});

test("formatReleaseNotes falls back to \"?\" for unknown prev/now counts", () => {
  const notes = formatReleaseNotes({
    commitCount: 3, prevTag: "(none)", toolsPrev: null, toolsNow: 189,
    testsPrev: null, testsNow: 520, themes: "first release",
  });
  assert.equal(notes, "full release notes: 3 commits since (none), ?→189 tools, ?→520 tests, organized as first release.");
});

test("buildGhArgs + formatGhCommand build the exact gh release create invocation", () => {
  const args = buildGhArgs({
    tag: "v0.6", mcpbPath: "/repo/featureboard-0.6.0.mcpb",
    title: "FeatureBoard 0.6.0", notes: "full release notes: 9 commits since v0.5, 161→189 tools, 270→520 tests, organized as release automation.",
  });
  assert.deepEqual(args, [
    "release", "create", "v0.6", "/repo/featureboard-0.6.0.mcpb",
    "--title", "FeatureBoard 0.6.0",
    "--notes", "full release notes: 9 commits since v0.5, 161→189 tools, 270→520 tests, organized as release automation.",
  ]);
  const cmd = formatGhCommand(args);
  assert.match(cmd, /^gh release create v0\.6 /);
  assert.match(cmd, /--title "FeatureBoard 0\.6\.0"/);
});
