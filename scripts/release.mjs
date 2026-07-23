#!/usr/bin/env node
/**
 * release.mjs (FBMCPF-160) — one command for a FeatureBoard MCP release.
 *
 * Preflight (git clean, `npm test` green) -> refresh drifting numeric claims in
 * README.md (tool count from manifest.json, test count from the fresh run,
 * version from package.json) -> bump the version (minor by default, --patch
 * for a patch release) -> regenerate docs/manifest -> pack the .mcpb the same
 * way `npm run build && npm run bundle` already does it -> format release notes
 * in the established "N commits since vPREV, T1->T2 tools, ..." shape -> commit,
 * tag (vX.Y, matching the existing tag style), and `gh release create`.
 *
 * Usage:
 *   node scripts/release.mjs --themes "..." [--dry-run] [--patch] [--skip-tests] [--allow-dirty]
 *
 * --dry-run     Print the full plan (including the exact `gh` command) and make
 *               NO changes: no file writes, no docs regen, no pack, no commit/tag/
 *               release. Reads current repo state and simulates the bump.
 * --patch       Bump the patch version instead of the minor (0.5.1 -> 0.5.2).
 * --skip-tests  Skip the `npm test` preflight gate (escape hatch). The README's
 *               test-count claim is left untouched when tests are skipped, since
 *               there's no fresh count to refresh it with.
 * --allow-dirty Testing-only escape hatch: skip the dirty-tree refusal so the
 *               happy path can be exercised against an uncommitted worktree.
 *               Never use this for a real release.
 * --themes      Required (unless --dry-run is only being used to check the
 *               dirty-tree/test gates). One-line theme summary for the release
 *               notes, e.g. "release automation, README auto-refresh". Never
 *               invented by this script — pass what the release actually shipped.
 *
 * Pure helpers are exported for unit testing; execution only happens when this
 * file is run directly (see the import.meta guard at the bottom).
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTapSummary } from "./run-nightly-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(root, p);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse CLI args into an options object. */
export function parseArgs(argv = []) {
  const opts = {
    dryRun: false,
    patch: false,
    skipTests: false,
    allowDirty: false,
    themes: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--patch") opts.patch = true;
    else if (a === "--skip-tests") opts.skipTests = true;
    else if (a === "--allow-dirty") opts.allowDirty = true;
    else if (a === "--themes") opts.themes = argv[++i] ?? null;
    else if (a.startsWith("--themes=")) opts.themes = a.slice("--themes=".length);
  }
  return opts;
}

/** Bump a semver "X.Y.Z" string. Minor bump by default, patch bump if requested. */
export function bumpVersion(current, { patch = false } = {}) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current).trim());
  if (!m) throw new Error(`Not a plain semver "X.Y.Z": ${current}`);
  const M = Number(m[1]), N = Number(m[2]), P = Number(m[3]);
  return patch ? `${M}.${N}.${P + 1}` : `${M}.${N + 1}.0`;
}

/** "0.6.0" -> "v0.6" — matches the repo's existing minor-only tag style. */
export function tagFromVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`Not a plain semver "X.Y.Z": ${version}`);
  // Minor releases keep the repo's minor-only tag style (v0.6, v0.7); a patch
  // release carries the full tag (v0.7.1) so it never collides with the minor
  // tag that already exists from the .0 release.
  return m[3] === "0" ? `v${m[1]}.${m[2]}` : `v${m[1]}.${m[2]}.${m[3]}`;
}

/** Count entries in manifest.json's tools array (accepts parsed object or raw text). */
export function countManifestTools(manifest) {
  const obj = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
  if (!obj || !Array.isArray(obj.tools)) return 0;
  return obj.tools.length;
}

/** Parse the passing-test count out of `node --test` TAP-ish output. Reuses the
 * same summary parser the nightly runner already relies on. */
export function parseTestCount(output = "") {
  const summary = parseTapSummary(output);
  return summary.parsed ? summary.passed : null;
}

/**
 * Refresh the numeric claims in README.md against current sources of truth.
 * Anchored to specific known phrasings so surrounding prose is never touched:
 *   - "~130 tools spanning the entire product surface"
 *   - "the full ~130-tool\n> surface"
 *   - "featureboard-0.3.2.mcpb" (quickstart install filename)
 *   - "# unit tests (158)"
 * Any claim whose replacement value is null/undefined is left as-is.
 */
export function refreshReadmeNumbers(text, { tools, tests, version } = {}) {
  let out = text;
  if (tools != null) {
    out = out.replace(/~\d+ tools spanning the entire product surface/, `~${tools} tools spanning the entire product surface`);
    out = out.replace(/~\d+-tool\b/, `~${tools}-tool`);
  }
  if (tests != null) {
    out = out.replace(/# unit tests \(\d+\)/, `# unit tests (${tests})`);
  }
  if (version != null) {
    out = out.replace(/featureboard-\d+\.\d+\.\d+\.mcpb/g, `featureboard-${version}.mcpb`);
  }
  return out;
}

/**
 * Format release notes in the established one-line shape:
 * "full release notes: N commits since vPREV, T1->T2 tools, S1->S2 tests, organized as <themes>."
 */
export function formatReleaseNotes({ commitCount, prevTag, toolsPrev, toolsNow, testsPrev, testsNow, themes }) {
  if (!themes || !String(themes).trim()) {
    throw new Error("formatReleaseNotes requires non-empty themes (pass --themes, never invented)");
  }
  const tp = toolsPrev == null ? "?" : toolsPrev;
  const tn = toolsNow == null ? "?" : toolsNow;
  const sp = testsPrev == null ? "?" : testsPrev;
  const sn = testsNow == null ? "?" : testsNow;
  return `full release notes: ${commitCount} commits since ${prevTag}, ${tp}→${tn} tools, ${sp}→${sn} tests, organized as ${themes}.`;
}

/** Build the exact `gh release create` argv (used both to print and to run it). */
export function buildGhArgs({ tag, assets, mcpbPath, title, notes }) {
  // Accept a list of asset paths (stable-named .plugin/.zip/latest.json + the
  // versioned .mcpb) so the release carries durable `releases/latest/download`
  // URLs. Back-compat: a single mcpbPath still works.
  const files = (assets && assets.length ? assets : [mcpbPath]).filter(Boolean);
  return ["release", "create", tag, ...files, "--title", title, "--notes", notes];
}

/** Quote a single argv entry for human-readable command printing (display only). */
function quoteForDisplay(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

export function formatGhCommand(ghArgs) {
  return ["gh", ...ghArgs.map(quoteForDisplay)].join(" ");
}

/** Locate the latest vX.Y[.Z] tag by version order (repo's release-tag convention). */
export function latestVersionTag(execFn = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" })) {
  const raw = execFn("git tag --list \"v*\" --sort=-v:refname");
  const candidates = raw.split("\n").map((s) => s.trim()).filter((s) => /^v\d+\.\d+(\.\d+)?$/.test(s));
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// Execution (only when invoked directly)
// ---------------------------------------------------------------------------

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("FeatureBoard MCP — release\n");

  // 1. Preflight: git tree must be clean.
  const dirty = sh("git status --porcelain").trim();
  if (dirty && !opts.allowDirty) {
    console.error("Refusing: git working tree is not clean:\n" + dirty);
    process.exit(1);
  }
  if (dirty && opts.allowDirty) {
    console.warn("--allow-dirty set: proceeding with a dirty tree (TESTING ONLY, never for a real release).");
  }

  // 1b. Preflight: `npm test` must pass, unless --skip-tests.
  let testCount = null;
  if (!opts.skipTests) {
    console.log("Running npm test...");
    let out = "";
    let failed = false;
    try {
      out = execSync("npm test", { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      out = `${e.stdout || ""}\n${e.stderr || ""}`;
      failed = true;
    }
    const summary = parseTapSummary(out);
    testCount = summary.parsed ? summary.passed : null;
    if (failed || summary.failed > 0) {
      console.error(`Refusing: npm test failed (${summary.failed} failing, ${summary.passed} passing). Use --skip-tests to override.`);
      process.exit(1);
    }
    console.log(`npm test passed (${testCount ?? "?"} tests).`);
  } else {
    console.warn("--skip-tests set: skipping the test gate. README's test-count claim will be left untouched.");
  }

  // 2. Current state.
  const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, { patch: opts.patch });
  const tag = tagFromVersion(newVersion);
  const readmePath = rel("README.md");
  const manifestPath = rel("manifest.json");

  const prevTag = latestVersionTag();
  let commitCount = null, toolsPrev = null, testsPrev = null;
  if (prevTag) {
    commitCount = sh(`git rev-list ${prevTag}..HEAD --count`).trim();
    try {
      toolsPrev = countManifestTools(sh(`git show ${prevTag}:manifest.json`));
    } catch { /* previous tag may predate manifest tools array */ }
    try {
      const prevReadme = sh(`git show ${prevTag}:README.md`);
      const m = /# unit tests \((\d+)\)/.exec(prevReadme);
      testsPrev = m ? Number(m[1]) : null;
    } catch { /* ignore */ }
  } else {
    console.warn("No existing v* tag found; release-notes deltas will show as \"?\".");
  }

  console.log(`Version: ${currentVersion} -> ${newVersion} (tag ${tag})`);

  if (opts.dryRun) {
    // Simulate without writing anything.
    const manifestNow = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const toolsNow = countManifestTools(manifestNow); // docs regen would refresh this from server/index.js in a real run
    const testsNow = testCount;
    const readmeNow = fs.readFileSync(readmePath, "utf8");
    const readmeRefreshed = refreshReadmeNumbers(readmeNow, { tools: toolsNow, tests: testsNow, version: newVersion });
    const changed = readmeRefreshed !== readmeNow;

    console.log("\n--dry-run: no files written, nothing committed/tagged/released.\n");
    console.log(`README.md numeric claims would change: ${changed}`);
    console.log(`manifest.json/package.json version would become: ${newVersion}`);
    console.log("Would run: npm run docs (if present), then npm run build && npm run bundle && npm run plugin");
    const mcpbPath = rel(`featureboard-${newVersion}.mcpb`);

    if (!opts.themes) {
      console.log("\n(--themes not provided — release notes cannot be generated; this is as far as --dry-run can go.)");
    } else {
      const notes = formatReleaseNotes({
        commitCount: commitCount ?? "?", prevTag: prevTag ?? "(none)",
        toolsPrev, toolsNow, testsPrev, testsNow, themes: opts.themes,
      });
      const title = `FeatureBoard ${newVersion}`;
      const assets = [mcpbPath, rel("releases/featureboard.plugin"), rel("releases/featureboard-mcp.zip"), rel("releases/latest.json")];
      const ghArgs = buildGhArgs({ tag, assets, title, notes });
      console.log(`\nCommit message: release: v${newVersion} — ${opts.themes}`);
      console.log(`Tag: ${tag}`);
      console.log(`Release notes: ${notes}`);
      console.log(`\nExact command:\n${formatGhCommand(ghArgs)}`);
    }
    process.exit(0);
  }

  if (!opts.themes) {
    console.error("Refusing: --themes is required for a real release (never invented by this script).");
    process.exit(1);
  }

  // 3. Version bump: write package.json + manifest.json.
  pkg.version = newVersion;
  fs.writeFileSync(rel("package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Wrote version ${newVersion} to package.json + manifest.json.`);

  // Regenerate docs (also re-syncs manifest.json's tools array from server/index.js).
  if (fs.existsSync(rel("scripts/gen-docs.mjs"))) {
    sh("npm run docs");
    console.log("Regenerated docs/TOOLS.md + manifest.json tools.");
  }

  const manifestAfterDocs = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const toolsNow = countManifestTools(manifestAfterDocs);
  const testsNow = opts.skipTests ? null : testCount;

  // 2 (README refresh, using fresh sources of truth).
  const readmeText = fs.readFileSync(readmePath, "utf8");
  const refreshed = refreshReadmeNumbers(readmeText, { tools: toolsNow, tests: testsNow, version: newVersion });
  fs.writeFileSync(readmePath, refreshed, "utf8");
  console.log("Refreshed README.md numeric claims.");

  // 4. Pack the .mcpb the same way the existing scripts do it.
  sh("npm run build");
  sh("npm run bundle");
  const mcpbPath = rel(`featureboard-${newVersion}.mcpb`);
  if (!fs.existsSync(mcpbPath)) {
    console.error(`Expected packed bundle not found: ${mcpbPath}`);
    process.exit(1);
  }
  console.log(`Packed ${path.basename(mcpbPath)}.`);

  // 4b. Build the stable-named Cowork plugin + IDE zip + latest.json so the
  // GitHub release carries durable `releases/latest/download/<name>` URLs.
  sh("npm run plugin");
  const pluginPath = rel("releases/featureboard.plugin");
  const ideZipPath = rel("releases/featureboard-mcp.zip");
  const latestManifestPath = rel("releases/latest.json");

  // 5. Release notes.
  const notes = formatReleaseNotes({
    commitCount: commitCount ?? "0", prevTag: prevTag ?? "(none)",
    toolsPrev, toolsNow, testsPrev, testsNow, themes: opts.themes,
  });
  const title = `FeatureBoard ${newVersion}`;
  console.log(`Release notes: ${notes}`);

  // 6. Commit, tag, release.
  const commitMsg = `release: v${newVersion} — ${opts.themes}`;
  sh("git add -A");
  execFileSync("git", ["commit", "-m", commitMsg], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["tag", tag], { cwd: root, stdio: "inherit" });
  console.log(`Committed and tagged ${tag}.`);

  // Stamp the published manifest with this version + notes, then attach the
  // stable-named assets alongside the versioned .mcpb.
  try {
    const lm = JSON.parse(fs.readFileSync(latestManifestPath, "utf8"));
    lm.version = newVersion;
    lm.notes = notes;
    fs.writeFileSync(latestManifestPath, JSON.stringify(lm, null, 2) + "\n", "utf8");
  } catch { /* manifest stamp is best-effort */ }
  const assets = [mcpbPath, pluginPath, ideZipPath, latestManifestPath].filter((f) => fs.existsSync(f));
  const ghArgs = buildGhArgs({ tag, assets, title, notes });
  console.log(`Running: ${formatGhCommand(ghArgs)}`);
  execFileSync("gh", ghArgs, { cwd: root, stdio: "inherit" });
  console.log(`\nReleased ${tag}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
