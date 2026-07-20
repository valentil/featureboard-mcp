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

// Copies: the server and everything it resolves at runtime, plus skills.
const copies = [
  ["server", "server"],
  ["artifact", "artifact"], // BOARD_HTML_PATH resolves ../artifact/board.html
  ["node_modules", "node_modules"], // all-prod deps (@modelcontextprotocol/sdk, zod)
  ["package.json", "package.json"], // "type": "module" — required for ESM resolution
  ["skills/featureboarding", "skills/featureboarding"],
  ["skills/daily-plan", "skills/daily-plan"],
  ["LICENSE.md", "LICENSE.md"],
  ["icon.png", "icon.png"],
];
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
  const tmpZip = path.join(os.tmpdir(), path.basename(dest) + ".tmpzip");
  fs.rmSync(tmpZip, { force: true });
  let ok;
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${tmpZip}' -Force`],
      { stdio: "inherit" }
    );
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
    "Licensing: free for personal & public work; commercial use US$119/seat/yr — https://featureboard.ai/buy.html. See LICENSE.md.",
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
    plugin: "https://featureboard.ai/downloads/featureboard.plugin",
    mcpZip: "https://featureboard.ai/downloads/featureboard-mcp.zip",
  },
  notes: "",
};
const manifestPath = path.join(outDir, "latest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ wrote ${path.relative(root, manifestPath)} (v${pkg.version})`);
