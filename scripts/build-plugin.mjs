#!/usr/bin/env node
/**
 * build-plugin.mjs (FBMCPF-244) — package FeatureBoard as a Cowork plugin.
 *
 * A Cowork plugin is a zip (extension .plugin) carrying a manifest, an MCP
 * server config, and skills — one install gives the user the FeatureBoard
 * tools AND the behaviors (featureboarding auto-boarding/churn, daily-plan
 * dispatch). This assembles dist/plugin/ from the repo and zips it to
 * releases/featureboard.plugin:
 *
 *   .claude-plugin/plugin.json   manifest (name/version from package.json)
 *   .mcp.json                    launches server/index.js via ${CLAUDE_PLUGIN_ROOT}
 *   server/  artifact/           the MCP server + board UI it serves
 *   node_modules/  package.json  runtime deps (all prod: mcp sdk + zod)
 *   skills/featureboarding/      auto-board substantive dev requests, churn loop
 *   skills/daily-plan/           plan + dispatch today's tickets across models
 *   README.md  LICENSE.md  icon.png
 *
 * The server needs no user_config here (unlike the .mcpb flow): index.js
 * defaults FEATUREBOARD_DATA_DIR to ~/FeatureBoard when unset.
 *
 * Usage: node scripts/build-plugin.mjs   (or `npm run plugin`)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(root, p);
const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));

// FEATUREBOARD_PLUGIN_STAGE overrides the staging dir (useful when the repo
// sits on a slow/synced mount — stage on local disk, only the zip lands here).
const stage = process.env.FEATUREBOARD_PLUGIN_STAGE
  ? path.resolve(process.env.FEATUREBOARD_PLUGIN_STAGE)
  : rel(path.join("dist", "plugin"));
const outDir = rel("releases");
const outFile = path.join(outDir, "featureboard.plugin");

// --- stage the plugin tree --------------------------------------------------
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, ".claude-plugin"), { recursive: true });

fs.writeFileSync(
  path.join(stage, ".claude-plugin", "plugin.json"),
  `${JSON.stringify(
    {
      name: "featureboard",
      version: pkg.version,
      description:
        "FeatureBoard in one install: the MCP task-board server plus the featureboarding skill (auto-board substantive dev requests and churn them with sub-agent dispatch) and the daily-plan skill (budget, label, and dispatch today's tickets across models).",
      author: { name: pkg.author || "Lewis Valentine" },
      license: pkg.license,
      keywords: ["featureboard", "task board", "kanban", "mcp", "orchestration"],
    },
    null,
    2
  )}\n`
);

fs.writeFileSync(
  path.join(stage, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        FeatureBoard: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/server/index.js"],
        },
      },
    },
    null,
    2
  )}\n`
);

// FBMCPB-60: stage ONLY the production dependency closure, never the whole
// node_modules. Since the optional embedding/PDF deps landed locally,
// node_modules carries ~385MB of multi-platform binaries and a cached ONNX
// model with pathologically deep paths — blanket fs.cpSync of it aborts
// outright on Windows/Node 24 (0xC0000409), and even succeeding it would
// ship the closure FBMCPB-59 just excluded from the .mcpb. BFS from
// package.json `dependencies` through each dep's own `dependencies`
// (dev/optional omitted — same shape as `npm i --omit=dev --omit=optional`,
// which is exactly what every release through 0.7.0 effectively shipped).
function prodDepNames() {
  const seen = new Set();
  const queue = Object.keys(pkg.dependencies || {});
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const pj = rel(path.join("node_modules", name, "package.json"));
    if (!fs.existsSync(pj)) {
      console.error(`✗ prod dep ${name} missing from node_modules — run npm install`);
      process.exit(1);
    }
    seen.add(name);
    const dp = JSON.parse(fs.readFileSync(pj, "utf8"));
    for (const d of Object.keys(dp.dependencies || {})) queue.push(d);
  }
  return [...seen].sort();
}

// Copies: the server and everything it resolves at runtime, plus skills.
const copies = [
  ["server", "server"],
  ["artifact", "artifact"], // BOARD_HTML_PATH resolves ../artifact/board.html
  ["package.json", "package.json"], // "type": "module" — required for ESM resolution
  ["skills/featureboarding", "skills/featureboarding"],
  ["skills/daily-plan", "skills/daily-plan"],
  ["LICENSE.md", "LICENSE.md"],
  ["icon.png", "icon.png"],
];
const depNames = prodDepNames();
for (const name of depNames) {
  copies.push([path.join("node_modules", name), path.join("node_modules", name)]);
}
console.log(`staging ${depNames.length} prod deps (optional/dev omitted)`);
for (const [src, dst] of copies) {
  const from = rel(src);
  if (!fs.existsSync(from)) {
    console.error(`✗ missing ${src} — cannot build the plugin without it`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(stage, dst), { recursive: true });
}

fs.writeFileSync(
  path.join(stage, "README.md"),
  [
    `# FeatureBoard (Cowork plugin) v${pkg.version}`,
    "",
    "A markdown-backed feature/bug board Claude manages for you — tools and behavior in one install.",
    "",
    "**What you get:**",
    "",
    "- The full FeatureBoard MCP server (boards, tickets, sprints, CRM, website, metrics …).",
    "- `featureboarding` skill: substantive dev requests are boarded automatically and churned ticket-by-ticket with sub-agent dispatch.",
    "- `daily-plan` skill: budget, model-label, and dispatch today's tickets across parallel/sequential model tiers.",
    "",
    "Boards are stored in `~/FeatureBoard` (override with the `FEATUREBOARD_DATA_DIR` environment variable).",
    "Requires Node.js >= 18 on PATH.",
    "",
    "License: see LICENSE.md.",
    "",
  ].join("\n")
);

// --- zip it -----------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outFile, { force: true });

// Zip into the OS temp dir first, then copy into releases/ — synced/mounted
// folders often refuse zip's in-place tempfile+rename dance.
function zipTo(dest) {
  // FBMCPB-61: the temp name MUST end in .zip — Windows PowerShell's
  // Compress-Archive hard-rejects any other destination extension
  // ("'.tmpzip' is not a supported archive file format"). POSIX zip never
  // cared, which is why the old .tmpzip name only broke the Windows path.
  const tmpZip = path.join(os.tmpdir(), `${path.basename(dest)}.${process.pid}.zip`);
  fs.rmSync(tmpZip, { force: true });
  let ok;
  if (process.platform === "win32") {
    // FBMCPB-61: prefer tar.exe (bsdtar, ships with Windows 10+) — it writes
    // standard forward-slash zip entries and includes dotfiles via ".".
    // Compress-Archive stays as the fallback, but note its 5.1 version emits
    // BACKSLASH entry names, which macOS/Linux extractors treat as literal
    // filename characters — a problem for the IDE zip's non-Windows users.
    let r = spawnSync("tar", ["-a", "-c", "-f", tmpZip, "."], { cwd: stage, stdio: "inherit" });
    if (r.status !== 0 || r.error) {
      console.error("tar.exe zip failed — falling back to Compress-Archive (entry names may use backslashes)");
      r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${tmpZip}' -Force`],
        { stdio: "inherit" }
      );
    }
    ok = r.status === 0;
  } else {
    const r = spawnSync("zip", ["-qr", tmpZip, "."], { cwd: stage, stdio: "inherit" });
    ok = r.status === 0;
  }
  if (!ok) {
    console.error("✗ zip failed — is `zip` (POSIX) or PowerShell (Windows) available?");
    process.exit(1);
  }
  fs.copyFileSync(tmpZip, dest);
  fs.rmSync(tmpZip, { force: true });
}

zipTo(outFile);

// --- IDE variant (FBMCPF-259): same server + deps, minus Claude-only bits ---
// featureboard-mcp.zip is for Cursor / Grok Build / any MCP client: strip the
// Claude plugin manifest + skills, swap .mcp.json to a plain relative config,
// and ship an IDE-oriented README. Same code, different wrapper.
const ideOut = path.join(outDir, "featureboard-mcp.zip");
fs.rmSync(ideOut, { force: true });
fs.rmSync(path.join(stage, ".claude-plugin"), { recursive: true, force: true });
fs.rmSync(path.join(stage, "skills"), { recursive: true, force: true });
fs.rmSync(path.join(stage, "icon.png"), { force: true });
fs.writeFileSync(
  path.join(stage, ".mcp.json"),
  `${JSON.stringify({ mcpServers: { FeatureBoard: { command: "node", args: ["server/index.js"], env: { FEATUREBOARD_CORE_ONLY: "1", FEATUREBOARD_CLIENT_NEUTRAL: "1" } } } }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(stage, "README.md"),
  [
    `# FeatureBoard MCP server v${pkg.version} — IDE release`,
    "",
    "For Cursor, Grok Build, and any MCP client. Dependencies included — no npm needed.",
    "",
    "Launch command (stdio): `node /absolute/path/to/this/folder/server/index.js`",
    "",
    "- Cursor: add the command to `.cursor/mcp.json` with env `FEATUREBOARD_CORE_ONLY=1` (67 core tools — Cursor caps active tools) and `FEATUREBOARD_CLIENT_NEUTRAL=1`.",
    "- Grok Build: `grok mcp add featureboard -- node .../server/index.js`, or open this folder — Grok auto-loads the bundled `.mcp.json`.",
    "- Boards live in `~/FeatureBoard` (override: `FEATUREBOARD_DATA_DIR`). Node.js >= 18.",
    "",
    "Full instructions: https://featureboard.ai/install.html · https://github.com/valentil/featureboard-mcp",
    "Licensing: free for personal & public work; commercial use US$99.99/seat/yr (or US$9.99/mo) — https://featureboard.ai/buy.html. See LICENSE.md.",
    "",
  ].join("\n")
);
zipTo(ideOut);
const ideMb = (fs.statSync(ideOut).size / (1024 * 1024)).toFixed(1);
console.log(`✓ built ${path.relative(root, ideOut)} (${ideMb} MB) — IDE release (Cursor/Grok/any MCP client)`);

const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
console.log(`✓ built ${path.relative(root, outFile)} (${mb} MB, v${pkg.version})`);
console.log("  install: open the .plugin file in Cowork, or attach it in chat and press Save.");

// --- update manifest (FBMCPF-260) --------------------------------------------
// latest.json is what the check_updates tool polls (only when a user/agent
// explicitly calls it — see server/updates.js / server/register/licensing.js)
// to learn a newer release exists. Publishing it to the live site is the same
// manual copy-to-featureboard.ai step as the two artifacts above; this script
// only ever writes the local releases/ copy.
const manifest = {
  name: "featureboard",
  version: pkg.version,
  releasedAt: new Date().toISOString(),
  artifacts: {
    // FBMCPF-373: mcpb is the Cowork/Desktop install and leads the list; the
    // stable name is what makes the latest/download URL durable (release.mjs
    // copies featureboard-<ver>.mcpb to releases/featureboard.mcpb). plugin
    // stays published for anyone already pointing at it.
    mcpb: "https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard.mcpb",
    plugin: "https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard.plugin",
    mcpZip: "https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard-mcp.zip",
  },
  notes: "",
};
const manifestPath = path.join(outDir, "latest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ wrote ${path.relative(root, manifestPath)} (v${pkg.version})`);
