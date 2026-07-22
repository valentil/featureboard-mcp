// FBMCPF-245 — the server ships two instruction strings: the default one is
// written for Claude Cowork (artifacts, create_artifact/update_artifact,
// orchestrator/sub-agent dispatch conventions), and FEATUREBOARD_CLIENT_NEUTRAL=1
// swaps in IDE-neutral guidance for other MCP hosts (Cursor, Grok Build, any
// generic stdio client) that drops the Cowork-specific machinery. This test
// spawns the real server over stdio in both modes — exactly what any MCP
// client does — and asserts on the `instructions` field of the initialize
// response. It deliberately uses a raw JSON-RPC exchange with a non-Claude
// clientInfo name so the whole path is client-agnostic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Spawn server/index.js with extra env, run a bare JSON-RPC initialize
 * (clientInfo "cursor-test" — no Claude branding anywhere), and return the
 * initialize result. Rejects on timeout so a hung server fails the test
 * instead of stalling the runner.
 */
function initialize(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-neutral-"));
    const child = spawn(process.execPath, [path.join(root, "server", "index.js")], {
      cwd: root,
      env: { ...process.env, FEATUREBOARD_DATA_DIR: dataDir, ...extraEnv },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const cleanup = () => {
      try { child.kill(); } catch {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for initialize response"));
    }, 15000);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          clearTimeout(timer);
          cleanup();
          if (msg.error) reject(new Error("initialize failed: " + JSON.stringify(msg.error)));
          else resolve(msg.result);
          return;
        }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); cleanup(); reject(err); });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-test", version: "1.0.0" },
      },
    }) + "\n");
  });
}

test("default instructions are the Cowork-flavoured ones (flag off)", async () => {
  const result = await initialize();
  const ins = result.instructions;
  assert.equal(typeof ins, "string", "initialize result carries an instructions string");
  assert.match(ins, /Cowork/, "default instructions mention Cowork artifacts");
  assert.match(ins, /create_artifact/, "default instructions reference create_artifact");
  assert.match(ins, /sub-agent/, "default instructions keep the sub-agent dispatch conventions");
  assert.match(ins, /STANDING DIRECTIVE/, "default instructions carry the proactive standing directive (FBMCPB-41)");
  assert.match(ins, /on your own initiative/, "default instructions tell the agent to board without being pointed at the tools");
});

test("FEATUREBOARD_CLIENT_NEUTRAL=1 swaps in IDE-neutral instructions", async () => {
  const [def, neutral] = await Promise.all([
    initialize(),
    initialize({ FEATUREBOARD_CLIENT_NEUTRAL: "1" }),
  ]);
  const ins = neutral.instructions;
  assert.equal(typeof ins, "string", "neutral mode still ships instructions");
  assert.ok(ins.length > 500, "neutral instructions are substantive, not a stub");
  assert.notEqual(ins, def.instructions, "the two modes serve different instructions");

  // The whole point: no Claude/Cowork-specific conventions in neutral mode.
  assert.doesNotMatch(ins, /cowork/i, "neutral instructions must not mention Cowork");
  assert.doesNotMatch(ins, /create_artifact|update_artifact/, "no Cowork artifact API references");
  assert.doesNotMatch(ins, /sub-agent|subagent/i, "no Claude sub-agent dispatch conventions");

  // Core board guidance survives, and get_board is described as an HTML file
  // the IDE can open rather than a Cowork artifact.
  assert.match(ins, /plan_work/, "boarding guidance survives in neutral mode");
  assert.match(ins, /STANDING DIRECTIVE/, "the proactive standing directive survives in neutral mode (FBMCPB-41)");
  assert.match(ins, /get_board/, "get_board is still documented");
  assert.match(ins, /HTML/, "get_board described as HTML the host can open");
});

test("neutral flag does not change the tool surface, only the instructions", async () => {
  // Guard against the flag accidentally being wired into tool gating: the
  // neutral server must still expose the same protocol surface (serverInfo
  // and capabilities identical to the default run).
  const [def, neutral] = await Promise.all([
    initialize(),
    initialize({ FEATUREBOARD_CLIENT_NEUTRAL: "1" }),
  ]);
  assert.deepEqual(neutral.serverInfo, def.serverInfo);
  assert.deepEqual(neutral.capabilities, def.capabilities);
});
