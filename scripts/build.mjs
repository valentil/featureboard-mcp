#!/usr/bin/env node
/**
 * build.mjs (FBMCPF-54) — packaging preflight for the .mcpb bundle.
 * Verifies version parity, required files, and server syntax, regenerates docs,
 * then prints the bundle command. Run: `npm run build`, then `npm run bundle`.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(root, p);
let failed = 0;
const fail = (m) => { console.error("  ✗ " + m); failed++; };
const okmsg = (m) => console.log("  ✓ " + m);

console.log("FeatureBoard MCP — build preflight\n");

// 1. version parity: package.json vs manifest.json
const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(rel("manifest.json"), "utf8"));
console.log("Versions:");
if (pkg.version === manifest.version) okmsg(`package.json and manifest.json agree (${pkg.version})`);
else fail(`version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);

// 2. required files present
console.log("Required files:");
for (const f of ["server/index.js", "manifest.json", "icon.png", "README.md", "LICENSE.md"]) {
  if (fs.existsSync(rel(f))) okmsg(f);
  else fail("missing " + f);
}

// 3. server syntax
console.log("Syntax check:");
for (const f of ["server/index.js", "server/storage.js", "server/metadata.js", "server/license.js"]) {
  try { execSync(`node --check "${rel(f)}"`, { stdio: "pipe" }); okmsg(f); }
  catch (e) { fail(`${f}: ${String(e.stderr || e.message).split("\n")[0]}`); }
}

// 4. regenerate docs + manifest tools
console.log("Docs:");
try { execSync(`node "${rel("scripts/gen-docs.mjs")}"`, { stdio: "pipe" }); okmsg("docs/TOOLS.md + manifest tools regenerated"); }
catch (e) { fail("doc generation: " + String(e.message).split("\n")[0]); }

console.log("");
if (failed) { console.error(`Preflight FAILED (${failed} issue${failed === 1 ? "" : "s"}).`); process.exit(1); }
console.log("Preflight passed. Bundle with:  npm run bundle   (requires the mcpb CLI)");
