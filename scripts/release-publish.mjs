#!/usr/bin/env node
/**
 * FBMCPF-325 — the release/publish TAIL, one idempotent command.
 *
 * Run AFTER scripts/release.mjs has bumped the version and built the artifacts
 * (or standalone to repair a half-finished release). Steps, each idempotent,
 * each reported:
 *
 *   1. sync    — server.json version + package identifier + fileSha256 are
 *                derived from package.json and the built releases/featureboard.plugin.
 *                The identifier is the VERSIONED GitHub release asset URL
 *                (releases/download/v<ver>/featureboard.plugin) so the pinned
 *                sha stays true forever (ADR-1: GitHub release = source of truth;
 *                the old featureboard.ai/downloads/* host is dead).
 *   2. release — `gh release view` first; create with assets only if missing.
 *   3. publish — `mcp-publisher publish` against server.json (skipped with a
 *                clear reason if the CLI isn't installed/authenticated).
 *   4. verify  — GET api.github.com/.../releases/latest and assert the tag
 *                matches package.json (replaces the retired latest.json check).
 *
 * Usage:
 *   node scripts/release-publish.mjs            # do it
 *   node scripts/release-publish.mjs --dry-run  # print what would happen
 *
 * Helpers are exported and side-effect-free (or injectable) for tests.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "valentil/featureboard-mcp";

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function tagFor(version) {
  // Matches release.mjs tagFromVersion: minors keep vX.Y, patches carry vX.Y.Z.
  const parts = String(version).split(".");
  return parts[2] === "0" || parts.length < 3 ? `v${parts[0]}.${parts[1]}` : `v${version}`;
}

export function versionedAssetUrl(version, asset) {
  return `https://github.com/${REPO}/releases/download/${tagFor(version)}/${asset}`;
}

/**
 * Compute the server.json patch for a version + built plugin. Pure: takes the
 * current parsed server.json, returns { next, changed[] } without writing.
 */
export function planServerJsonSync(serverJson, { version, pluginSha }) {
  const next = JSON.parse(JSON.stringify(serverJson));
  const changed = [];
  if (next.version !== version) {
    changed.push(`version ${next.version} -> ${version}`);
    next.version = version;
  }
  const pkg = (next.packages || [])[0];
  if (pkg) {
    const wantId = versionedAssetUrl(version, "featureboard.plugin");
    if (pkg.identifier !== wantId) {
      changed.push(`identifier -> ${wantId}`);
      pkg.identifier = wantId;
    }
    if (pluginSha && pkg.fileSha256 !== pluginSha) {
      changed.push(`fileSha256 -> ${pluginSha.slice(0, 12)}…`);
      pkg.fileSha256 = pluginSha;
    }
  }
  return { next, changed };
}

function defaultExec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/** Step 2: create the GitHub release iff it doesn't already exist. */
export function ensureGhRelease({ tag, assets, notes, exec = defaultExec, dryRun = false }) {
  const view = exec("gh", ["release", "view", tag, "--json", "tagName"]);
  if (view.status === 0) return { step: "release", did: false, reason: `release ${tag} already exists` };
  if (view.error && view.error.code === "ENOENT") return { step: "release", did: false, error: "gh CLI not installed" };
  const files = assets.filter((a) => fs.existsSync(a));
  if (!files.length) return { step: "release", did: false, error: "no built assets found — run scripts/release.mjs first" };
  const args = ["release", "create", tag, ...files, "--title", tag, "--notes", notes || `FeatureBoard ${tag}`];
  if (dryRun) return { step: "release", did: false, dryRun: true, wouldRun: `gh ${args.join(" ")}` };
  const r = exec("gh", args);
  return r.status === 0
    ? { step: "release", did: true, tag, assets: files.map((f) => path.basename(f)) }
    : { step: "release", did: false, error: (r.stderr || "gh release create failed").trim() };
}

/** Step 3: publish server.json to the MCP registry. */
export function publishRegistry({ exec = defaultExec, dryRun = false }) {
  if (dryRun) return { step: "publish", did: false, dryRun: true, wouldRun: "mcp-publisher publish" };
  const r = exec("mcp-publisher", ["publish"]);
  if (r.error && r.error.code === "ENOENT") {
    const hint =
      process.platform === "win32"
        ? "PowerShell: $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }; Invoke-WebRequest -Uri \"https://github.com/modelcontextprotocol/registry/releases/download/v1.1.0/mcp-publisher_1.1.0_windows_$arch.tar.gz\" -OutFile mcp-publisher.tar.gz; tar xf mcp-publisher.tar.gz mcp-publisher.exe — then put mcp-publisher.exe on PATH"
        : "`brew install mcp-publisher` (macOS/Linux/WSL) or grab a binary from github.com/modelcontextprotocol/registry/releases";
    return { step: "publish", did: false, error: `mcp-publisher CLI not installed — ${hint} — then re-run (idempotent)` };
  }
  return r.status === 0
    ? { step: "publish", did: true }
    : { step: "publish", did: false, error: (r.stderr || r.stdout || "mcp-publisher failed").trim() };
}

/** Step 4: the releases API must serve the tag for this version. */
export async function verifyLatest({ version, fetchImpl = globalThis.fetch }) {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "featureboard-release-publish", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { step: "verify", ok: false, error: `releases API HTTP ${res.status}` };
    const j = await res.json();
    const got = String(j.tag_name || "");
    const want = tagFor(version);
    return got === want
      ? { step: "verify", ok: true, tag: got }
      : { step: "verify", ok: false, error: `latest release is ${got || "(none)"}, expected ${want}` };
  } catch (e) {
    return { step: "verify", ok: false, error: String((e && e.message) || e) };
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const version = readJson(path.join(ROOT, "package.json")).version;
  const tag = tagFor(version);
  const report = { version, tag, dryRun, steps: [] };

  // 1. sync server.json
  const serverJsonPath = path.join(ROOT, "server.json");
  const pluginPath = path.join(ROOT, "releases", "featureboard.plugin");
  const pluginSha = fs.existsSync(pluginPath) ? sha256File(pluginPath) : null;
  const { next, changed } = planServerJsonSync(readJson(serverJsonPath), { version, pluginSha });
  if (changed.length && !dryRun) fs.writeFileSync(serverJsonPath, JSON.stringify(next, null, 2) + "\n");
  report.steps.push({ step: "sync", did: changed.length > 0 && !dryRun, changed, ...(pluginSha ? {} : { warning: "releases/featureboard.plugin not built — sha unchanged; run scripts/release.mjs first" }) });

  // 2. GitHub release
  const assets = [
    path.join(ROOT, `featureboard-${version}.mcpb`),
    pluginPath,
    path.join(ROOT, "releases", "featureboard-mcp.zip"),
    path.join(ROOT, "releases", "latest.json"),
  ];
  report.steps.push(ensureGhRelease({ tag, assets, dryRun }));

  // 3. registry publish
  report.steps.push(publishRegistry({ dryRun }));

  // 4. verify
  if (!dryRun) report.steps.push(await verifyLatest({ version }));

  console.log(JSON.stringify(report, null, 2));
  const failed = report.steps.some((s) => s.error || s.ok === false);
  // Do NOT process.exit() here: on Windows, exiting immediately after spawnSync
  // trips a libuv teardown assertion (win/async.c UV_HANDLE_CLOSING). Setting
  // exitCode lets the event loop drain and the process exit cleanly.
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
