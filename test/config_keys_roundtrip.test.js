import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Board } from "../server/storage.js";
import * as meta from "../server/metadata.js";
import { registerAnalyticsTools } from "../server/register/analytics.js";

// FBMCPB-29 — set_project_config's zod input schema was missing voiceLint,
// voiceLintMin, voiceProfile, and etaHints even though they've been in
// CONFIG_KEYS (server/metadata.js) since FBMCPF-267/268, so an MCP caller
// could never actually set them (zod silently strips unknown keys before
// the handler's ...patch spread ever sees them). This exercises the real
// set_project_config / get_project_config handlers (via the same fake-
// registerTool harness test/voice_wiring.test.js uses) end to end, so a
// schema regression here would fail loudly instead of silently dropping
// fields again.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-configkeys-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function ok(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function tryTool(fn) {
  return async (args) => {
    try { return ok(await fn(args)); } catch (e) { return fail(e.message); }
  };
}
function writeTool(fn) {
  return async (args) => {
    try { return ok(await fn(args)); } catch (e) { return fail(e.message); }
  };
}

function makeFakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, _meta, handler) { tools.set(name, handler); },
    registerPrompt() { /* not exercised by this ticket */ },
  };
}

/** Build the register/*.js handler map for a given board, wired through the real modules. */
function buildTools(board) {
  const ctx = {
    getBoard: () => board,
    meta,
    tryTool,
    writeTool,
    z,
  };
  const server = makeFakeServer();
  registerAnalyticsTools(server, ctx);
  return server.tools;
}

/** Invoke a captured handler and return the parsed JSON payload (throws the tool's Error message on failure). */
async function call(handler, args) {
  const res = await handler(args);
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

test("set_project_config: voiceLint, voiceLintMin, etaHints, and voiceProfile (incl. nested fields) round-trip through get_project_config", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);

  const voiceProfile = {
    extraBannedPhrases: ["delve into", "in today's fast-paced world"],
    allowedTells: ["leverage"],
    samplesNote: "Plain-spoken, short sentences, no marketing fluff.",
  };

  const setResult = await call(tools.get("set_project_config"), {
    project: "Proj",
    voiceLint: true,
    voiceLintMin: 42,
    etaHints: false,
    voiceProfile,
  });

  // set_project_config returns the merged config directly (meta.setProjectConfig -> getProjectConfig).
  assert.equal(setResult.voiceLint, true);
  assert.equal(setResult.voiceLintMin, 42);
  assert.equal(setResult.etaHints, false);
  assert.deepEqual(setResult.voiceProfile, voiceProfile);

  // Independently re-read via get_project_config to confirm persistence, not just the echo.
  const getResult = await call(tools.get("get_project_config"), { project: "Proj" });
  assert.equal(getResult.voiceLint, true, "voiceLint should round-trip");
  assert.equal(getResult.voiceLintMin, 42, "voiceLintMin should round-trip");
  assert.equal(getResult.etaHints, false, "etaHints should round-trip");
  assert.ok(getResult.voiceProfile, "voiceProfile should round-trip");
  assert.deepEqual(
    getResult.voiceProfile.extraBannedPhrases,
    voiceProfile.extraBannedPhrases,
    "voiceProfile.extraBannedPhrases should round-trip"
  );
  assert.deepEqual(
    getResult.voiceProfile.allowedTells,
    voiceProfile.allowedTells,
    "voiceProfile.allowedTells should round-trip"
  );
  assert.equal(
    getResult.voiceProfile.samplesNote,
    voiceProfile.samplesNote,
    "voiceProfile.samplesNote should round-trip"
  );
});

test("set_project_config: partial voiceProfile (single field) round-trips without requiring the others", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);

  await call(tools.get("set_project_config"), {
    project: "Proj",
    voiceProfile: { samplesNote: "Terse, technical, no hedging." },
  });

  const getResult = await call(tools.get("get_project_config"), { project: "Proj" });
  assert.equal(getResult.voiceProfile.samplesNote, "Terse, technical, no hedging.");
  assert.equal(getResult.voiceProfile.extraBannedPhrases, undefined);
  assert.equal(getResult.voiceProfile.allowedTells, undefined);
});
