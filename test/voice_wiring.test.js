import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Board } from "../server/storage.js";
import * as meta from "../server/metadata.js";
import { draftShare } from "../server/social.js";
import { postProjectUpdate } from "../server/updates.js";
import { maybeLint } from "../server/voice.js";
import { registerMediaTools } from "../server/register/media.js";
import { registerAnalyticsTools } from "../server/register/analytics.js";

// FBMCPF-268 — voiceLint auto-wiring: when a project turns on the voiceLint
// config flag, outbound/content-drafting tools run their draft text through
// maybeLint() (server/voice.js, wrapping lintVoice from FBMCPF-267) and
// attach the result under a `voice` key on the tool's response, so a drafting
// agent can self-correct BEFORE a human sees AI-sounding copy. Warn-only:
// never blocks the tool's normal action, never alters existing response
// fields.
//
// index.js can't be imported directly (main() connects a stdio transport as
// a side effect of module load — see test/board_tools_parity.test.js), so
// this exercises the real register/*.js handlers via a minimal in-memory
// harness: a fake `server.registerTool` that captures handlers, and a `ctx`
// built from the real modules the handlers actually call (draftShare,
// postProjectUpdate, maybeLint, meta, getBoard). Registration-time code in
// these two files only ever touches ctx.z for schema-building, so any other
// destructured-but-unused ctx field is safely left undefined.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-voicewire-"));
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
// Local stand-ins for index.js's tryTool/writeTool — same ok/fail wrapping,
// minus the license gate (irrelevant to this ticket's wiring).
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
    draftShare,
    postProjectUpdate,
    maybeLint,
    meta,
    tryTool,
    writeTool,
    z,
  };
  const server = makeFakeServer();
  registerMediaTools(server, ctx);
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

// Nine sentences of near-identical length plus a tricolon, a contrastive
// pivot, "delve", and em-dashes — the same composite AI-sounding fixture
// voice_lint.test.js uses, well over the 40-word floor and scoring aiScore
// >= 50 against the default ruleset (comfortably above voiceLintMin's
// default of 25).
const AI_DRAFT =
  "This tool will delve into the archives to find data. " +
  "This tool will scan through the folders to find files. " +
  "This tool will check across the systems to find flaws. " +
  "This tool will search within the records to find gaps. " +
  "This tool will parse across the outputs to find trends. " +
  "This tool will review across the reports to find risks. " +
  "The plan is fast, reliable, and secure. " +
  "It's not just fast, but incredibly efficient. " +
  "This works well — arguably better — than others.";

// Clean, under the 40-word floor: maybeLint should bail out on word count
// alone, before it even looks at content.
const SHORT_CLEAN = "Shipped the update to staging. Everything looks good so far.";

test("draft_share: voiceLint off (default) -> no voice key on the response", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  const out = await call(tools.get("draft_share"), { project: "Proj", platform: "linkedin", text: AI_DRAFT });
  assert.ok(out.share, "draft_share's normal response shape must be untouched");
  assert.equal(out.share.text, AI_DRAFT);
  assert.equal("voice" in out, false, "voice key must be absent when voiceLint is off");
});

test("draft_share: voiceLint on + AI-sounding draft -> voice.voiceScore > 0 with a warning above threshold", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { voiceLint: true });
  const tools = buildTools(board);
  const out = await call(tools.get("draft_share"), { project: "Proj", platform: "linkedin", text: AI_DRAFT });
  assert.ok(out.share, "existing response fields must be preserved");
  assert.ok(out.voice, "voice key should be attached when voiceLint is on and the draft is long enough");
  assert.ok(out.voice.voiceScore > 0, `expected voiceScore > 0, got ${out.voice.voiceScore}`);
  assert.ok(out.voice.voiceScore > 25, "default voiceLintMin is 25 — this fixture should exceed it");
  assert.ok(out.voice.warning, "a warning should be attached once voiceScore exceeds voiceLintMin");
  assert.match(out.voice.warning, /rewrite/i);
  assert.ok(Array.isArray(out.voice.topFindings) && out.voice.topFindings.length > 0);
  assert.ok(out.voice.topFindings.length <= 5, "topFindings is capped at 5");
  for (const f of out.voice.topFindings) {
    assert.ok(f.id && f.suggestion, "each topFinding must carry id + suggestion");
  }
  assert.ok(out.voice.verdict, "verdict summary should be present");
});

test("draft_share: voiceLint on + clean short (<40 word) text -> voice absent", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { voiceLint: true });
  const tools = buildTools(board);
  const out = await call(tools.get("draft_share"), { project: "Proj", platform: "x", text: SHORT_CLEAN });
  assert.ok(out.share);
  assert.equal("voice" in out, false, "short drafts stay below the 40-word floor and get no voice key");
});

test("draft_share: voiceLintMin raises the bar — a score under the custom min gets no warning", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { voiceLint: true, voiceLintMin: 95 });
  const tools = buildTools(board);
  const out = await call(tools.get("draft_share"), { project: "Proj", platform: "linkedin", text: AI_DRAFT });
  assert.ok(out.voice, "voice key still attached (voiceLint is on and text clears the word floor)");
  assert.ok(out.voice.voiceScore < 95, "fixture score should stay below an intentionally high custom min");
  assert.equal(out.voice.warning, undefined, "no warning below the custom voiceLintMin");
});

test("post_project_update: voiceLint off (default) -> no voice key on the response", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  const out = await call(tools.get("post_project_update"), { project: "Proj", health: "on-track", narrative: AI_DRAFT });
  assert.equal(out.narrative, AI_DRAFT, "existing response fields must be preserved");
  assert.equal("voice" in out, false);
});

test("post_project_update: voiceLint on + AI-sounding narrative -> voice.voiceScore > 0 with warning", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { voiceLint: true });
  const tools = buildTools(board);
  const out = await call(tools.get("post_project_update"), { project: "Proj", health: "at-risk", narrative: AI_DRAFT });
  assert.equal(out.health, "at-risk", "existing response fields must be preserved");
  assert.ok(out.voice);
  assert.ok(out.voice.voiceScore > 0);
  assert.ok(out.voice.warning);
});

test("post_project_update: voiceLint on + clean short narrative -> voice absent", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { voiceLint: true });
  const tools = buildTools(board);
  const out = await call(tools.get("post_project_update"), { project: "Proj", health: "on-track", narrative: SHORT_CLEAN });
  assert.equal("voice" in out, false);
});

test("maybeLint (unit): off/empty/short all return null; on + long AI text returns the compact shape", () => {
  const board = tmpBoard();
  assert.equal(maybeLint(board, "Proj", AI_DRAFT), null, "voiceLint off -> null even for a long AI draft");

  meta.setProjectConfig(board, "Proj", { voiceLint: true });
  assert.equal(maybeLint(board, "Proj", ""), null, "empty text -> null");
  assert.equal(maybeLint(board, "Proj", "too short"), null, "under 40 words -> null");

  const r = maybeLint(board, "Proj", AI_DRAFT);
  assert.ok(r);
  assert.ok(r.voiceScore > 0);
  assert.ok(Array.isArray(r.topFindings));
  assert.ok(r.topFindings.length <= 5);
  assert.ok(r.verdict);
  assert.ok(r.warning);
});
