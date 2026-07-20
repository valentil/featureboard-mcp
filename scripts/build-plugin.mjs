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
const tmpZip = path.join(os.tmpdir(), "featureboard.plugin.zip");
fs.rmSync(tmpZip, { force: true });

function zip() {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${tmpZip}' -Force`],
      { stdio: "inherit" }
    );
    return r.status === 0;
  }
  const r = spawnSync("zip", ["-qr", tmpZip, "."], { cwd: stage, stdio: "inherit" });
  return r.status === 0;
}

if (!zip()) {
  console.error("✗ zip failed — is `zip` (POSIX) or PowerShell (Windows) available?");
  process.exit(1);
}
fs.copyFileSync(tmpZip, outFile);
fs.rmSync(tmpZip, { force: true });

const mb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
console.log(`✓ built ${path.relative(root, outFile)} (${mb} MB, v${pkg.version})`);
console.log("  install: open the .plugin file in Cowork, or attach it in chat and press Save.");
