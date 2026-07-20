import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Board, isBlocked } from "../server/storage.js";
import { appendEvent } from "../server/events.js";
import * as meta from "../server/metadata.js";
import { estimateTicketMinutes } from "../server/predictive.js";
import { autoAssignSprintFields } from "../server/sprints.js";
import { computeWaves } from "../server/planchain.js";
import { withOrchestrationLabels } from "../server/orchestration.js";
import { suggestModel } from "../server/budget.js";
import { ticketsWithUnresolvedReviews } from "../server/reviews.js";
import { getGitConfig, getHistoryMap, suggestHistoricalFiles } from "../server/git.js";
import { registerBoardTools } from "../server/register/board.js";
import { registerAnalyticsTools } from "../server/register/analytics.js";

// FBMCPF-269 — "ETA hints": when work will take more than a moment, the human
// should be told how long up front. Config toggle etaHints (default ON).
//
// index.js can't be imported directly (main() connects a stdio transport as a
// side effect of module load — see test/board_tools_parity.test.js), so this
// exercises the real register/board.js + register/analytics.js handlers via a
// minimal in-memory harness (same trick as test/voice_wiring.test.js): a fake
// server.registerTool that captures handlers, and a ctx built from the real
// modules those two handlers actually call. Registration-time code in these
// files only touches ctx.z for schema-building, so any other
// destructured-but-unused ctx field is safely left undefined.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-eta-hints-"));
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
    registerPrompt() {},
  };
}

/** Build the next_task/plan_work/get_work_packet handler map for a given board. */
function buildTools(board) {
  const ctx = {
    getBoard: () => board,
    StatusEnum: z.enum(["Todo", "In Progress", "Review", "Done"]),
    isBlocked,
    meta,
    estimateTicketMinutes,
    autoAssignSprintFields,
    computeWaves,
    withOrchestrationLabels,
    suggestModel,
    ticketsWithUnresolvedReviews,
    getGitConfig,
    getHistoryMap,
    suggestHistoricalFiles,
    fullView: (t) => { const { _raw, source, ...rest } = t; return rest; },
    compactView: (t) => t,
    tryTool,
    writeTool,
    z,
  };
  const server = makeFakeServer();
  registerBoardTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  return server.tools;
}

async function call(handler, args) {
  const res = await handler(args);
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** Fabricate a Done ticket with a controlled In Progress -> Done wall-clock
 *  duration (minutes), by appending audit events AFTER the real setStatus
 *  calls so the fabricated ts wins as "most recent" (same trick
 *  test/agent_monitor_v2.test.js and test/timeline.test.js use). */
function seedDoneTicket(board, project, { effort, startTs, minutes, title }) {
  const t = board.addTask(project, "feature", { title: title || "History sample", labels: [`effort:${effort}`] });
  board.setStatus(project, t.ticketNumber, "In Progress");
  appendEvent(board, project, { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: startTs });
  board.setStatus(project, t.ticketNumber, "Done", "done");
  const endTs = new Date(new Date(startTs).getTime() + minutes * 60000).toISOString();
  appendEvent(board, project, { ticket: t.ticketNumber, field: "status", from: "In Progress", to: "Done", source: "set_status", ts: endTs });
  return t;
}

function assertSaneRange(eta) {
  assert.ok(eta && eta.estimatedMinutes, "eta.estimatedMinutes must be present");
  assert.equal(typeof eta.estimatedMinutes.low, "number");
  assert.equal(typeof eta.estimatedMinutes.high, "number");
  assert.ok(eta.estimatedMinutes.low > 0, "low must be positive");
  assert.ok(eta.estimatedMinutes.high >= eta.estimatedMinutes.low, "high must be >= low");
  assert.equal(typeof eta.basis, "string");
}

// ---------------------------------------------------------------------------
// (a) default on: next_task / get_work_packet include eta with a sane range + basis
// ---------------------------------------------------------------------------

test("next_task: etaHints default ON -> eta present with sane range + default basis", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  board.addTask("Proj", "feature", { title: "Do the thing", labels: ["effort:medium"] });

  const out = await call(tools.get("next_task"), { project: "Proj" });
  assert.ok(out.next, "expected a next ticket");
  assertSaneRange(out.eta);
  assert.equal(out.eta.basis, "default", "thin history (0 samples) must fall back to the default basis");
  assert.deepEqual(out.eta.estimatedMinutes, { low: 10, high: 20 }, "medium default band");
  assert.match(out.dispatch.instruction, /etaHints is on/i, "dispatch instruction should carry the eta-hint sentence");
  assert.match(out.dispatch.instruction, /exceed ~2 minutes/i);
});

test("get_work_packet: etaHints default ON -> eta present with sane range + default basis", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  const t = board.addTask("Proj", "feature", { title: "Ship it", labels: ["effort:low"] });

  const out = await call(tools.get("get_work_packet"), { project: "Proj", ticket: t.ticketNumber });
  assertSaneRange(out.eta);
  assert.equal(out.eta.basis, "default");
  assert.deepEqual(out.eta.estimatedMinutes, { low: 5, high: 10 }, "low default band");
  assert.match(out.dispatch.instruction, /etaHints is on/i);
});

test("plan_work: etaHints default ON -> per-ticket eta + totalEta roll-up", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);

  const out = await call(tools.get("plan_work"), {
    project: "Proj",
    createProject: true,
    features: [
      { title: "Feature one", labels: ["effort:low"] },
      { title: "Feature two", labels: ["effort:high"] },
    ],
    bugs: [{ title: "Bug one", labels: ["effort:medium"] }],
  });

  assert.equal(out.features.length, 2);
  assert.equal(out.bugs.length, 1);
  for (const t of [...out.features, ...out.bugs]) assertSaneRange(t.eta);

  assert.ok(out.totalEta, "expected a totalEta roll-up");
  assert.equal(out.totalEta.ticketCount, 3);
  const expectedLow = out.features[0].eta.estimatedMinutes.low + out.features[1].eta.estimatedMinutes.low + out.bugs[0].eta.estimatedMinutes.low;
  const expectedHigh = out.features[0].eta.estimatedMinutes.high + out.features[1].eta.estimatedMinutes.high + out.bugs[0].eta.estimatedMinutes.high;
  assert.equal(out.totalEta.estimatedMinutes.low, expectedLow);
  assert.equal(out.totalEta.estimatedMinutes.high, expectedHigh);
});

// ---------------------------------------------------------------------------
// (b) etaHints:false -> no eta key anywhere, and no appended dispatch sentence
// ---------------------------------------------------------------------------

test("next_task: etaHints:false -> no eta key, dispatch instruction unchanged", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { etaHints: false });
  const tools = buildTools(board);
  board.addTask("Proj", "feature", { title: "Do the thing" });

  const out = await call(tools.get("next_task"), { project: "Proj" });
  assert.equal("eta" in out, false, "eta key must be absent when etaHints is off");
  assert.doesNotMatch(out.dispatch.instruction, /etaHints is on/i);
});

test("get_work_packet: etaHints:false -> no eta key", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { etaHints: false });
  const tools = buildTools(board);
  const t = board.addTask("Proj", "feature", { title: "Ship it" });

  const out = await call(tools.get("get_work_packet"), { project: "Proj", ticket: t.ticketNumber });
  assert.equal("eta" in out, false);
  assert.doesNotMatch(out.dispatch.instruction, /etaHints is on/i);
});

test("plan_work: etaHints:false -> no per-ticket eta and no totalEta", async () => {
  const board = tmpBoard();
  meta.setProjectConfig(board, "Proj", { etaHints: false });
  const tools = buildTools(board);

  const out = await call(tools.get("plan_work"), {
    project: "Proj",
    createProject: true,
    features: [{ title: "Feature one" }],
    bugs: [],
  });
  assert.equal("eta" in out.features[0], false);
  assert.equal("totalEta" in out, false);
});

// ---------------------------------------------------------------------------
// (c) effort-label mapping: high > medium > low defaults (unit-level, direct
// against estimateTicketMinutes so the ordering assertion is unambiguous).
// ---------------------------------------------------------------------------

test("estimateTicketMinutes: default bands order high > medium > low, each internally sane", () => {
  const board = tmpBoard();
  const low = board.addTask("Proj", "feature", { title: "L", labels: ["effort:low"] });
  const medium = board.addTask("Proj", "feature", { title: "M", labels: ["effort:medium"] });
  const high = board.addTask("Proj", "feature", { title: "H", labels: ["effort:high"] });

  const etaLow = estimateTicketMinutes(board, "Proj", low.ticketNumber);
  const etaMedium = estimateTicketMinutes(board, "Proj", medium.ticketNumber);
  const etaHigh = estimateTicketMinutes(board, "Proj", high.ticketNumber);

  for (const e of [etaLow, etaMedium, etaHigh]) {
    assertSaneRange(e);
    assert.equal(e.basis, "default");
  }
  assert.ok(etaLow.estimatedMinutes.high <= etaMedium.estimatedMinutes.low || etaLow.estimatedMinutes.high < etaMedium.estimatedMinutes.high);
  assert.ok(etaLow.estimatedMinutes.high < etaHigh.estimatedMinutes.low);
  assert.ok(etaMedium.estimatedMinutes.high < etaHigh.estimatedMinutes.high);
  assert.ok(etaMedium.estimatedMinutes.low >= etaLow.estimatedMinutes.low);
  assert.ok(etaHigh.estimatedMinutes.low >= etaMedium.estimatedMinutes.low);

  // exact documented defaults (low ~5-10, medium ~10-20, high ~20-40)
  assert.deepEqual(etaLow.estimatedMinutes, { low: 5, high: 10 });
  assert.deepEqual(etaMedium.estimatedMinutes, { low: 10, high: 20 });
  assert.deepEqual(etaHigh.estimatedMinutes, { low: 20, high: 40 });
});

test("estimateTicketMinutes: a ticket with no effort label is treated as medium", () => {
  const board = tmpBoard();
  const t = board.addTask("Proj", "feature", { title: "No label" });
  const eta = estimateTicketMinutes(board, "Proj", t.ticketNumber);
  assert.deepEqual(eta.estimatedMinutes, { low: 10, high: 20 });
  assert.equal(eta.basis, "default");
});

// ---------------------------------------------------------------------------
// (d) history path: seed >=3 Done same-effort-label samples with a fabricated
// event trail (ticket_events.jsonl entries with controlled ts, appended after
// the real setStatus calls so they win as "most recent" — the same
// established trick as test/agent_monitor_v2.test.js / test/timeline.test.js).
// This DOES trigger the "history (n=...)" basis; not a fallback-only test.
// ---------------------------------------------------------------------------

test("estimateTicketMinutes: >=3 Done same-effort samples -> history basis with a percentile-band range", () => {
  const board = tmpBoard();
  // Three effort:high Done tickets, actual measured durations 20 / 25 / 30 minutes.
  seedDoneTicket(board, "Proj", { effort: "high", startTs: "2030-01-01T09:00:00.000Z", minutes: 20, title: "H1" });
  seedDoneTicket(board, "Proj", { effort: "high", startTs: "2030-01-02T09:00:00.000Z", minutes: 25, title: "H2" });
  seedDoneTicket(board, "Proj", { effort: "high", startTs: "2030-01-03T09:00:00.000Z", minutes: 30, title: "H3" });
  // A same-project effort:low ticket must NOT bleed into the "high" bucket.
  seedDoneTicket(board, "Proj", { effort: "low", startTs: "2030-01-04T09:00:00.000Z", minutes: 6, title: "L1" });

  const newHigh = board.addTask("Proj", "feature", { title: "New high-effort ticket", labels: ["effort:high"] });
  const eta = estimateTicketMinutes(board, "Proj", newHigh.ticketNumber);

  assert.equal(eta.basis, "history (n=3)", `expected a history basis with 3 samples, got ${eta.basis}`);
  assertSaneRange(eta);
  // 20/25/30's 25th-75th percentile band should land within the observed spread.
  assert.ok(eta.estimatedMinutes.low >= 20 && eta.estimatedMinutes.low <= 25, `low=${eta.estimatedMinutes.low} should be near the sample floor`);
  assert.ok(eta.estimatedMinutes.high >= 25 && eta.estimatedMinutes.high <= 30, `high=${eta.estimatedMinutes.high} should be near the sample ceiling`);
});

test("estimateTicketMinutes: only 2 same-effort Done samples -> still falls back to default (below MIN_SAMPLES)", () => {
  const board = tmpBoard();
  seedDoneTicket(board, "Proj", { effort: "high", startTs: "2030-01-01T09:00:00.000Z", minutes: 20, title: "H1" });
  seedDoneTicket(board, "Proj", { effort: "high", startTs: "2030-01-02T09:00:00.000Z", minutes: 30, title: "H2" });

  const newHigh = board.addTask("Proj", "feature", { title: "New high-effort ticket", labels: ["effort:high"] });
  const eta = estimateTicketMinutes(board, "Proj", newHigh.ticketNumber);
  assert.equal(eta.basis, "default", "2 samples is below the 3-sample floor — must not claim a history basis");
  assert.deepEqual(eta.estimatedMinutes, { low: 20, high: 40 });
});

test("estimateTicketMinutes: history basis is scoped per-project (a different project's history never bleeds in)", () => {
  const board = tmpBoard();
  fs.mkdirSync(path.join(board.projectDir("Other")), { recursive: true });
  fs.writeFileSync(path.join(board.projectDir("Other"), "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(board.projectDir("Other"), "buglist.md"), "# Bug List\n");
  seedDoneTicket(board, "Other", { effort: "high", startTs: "2030-01-01T09:00:00.000Z", minutes: 20, title: "OH1" });
  seedDoneTicket(board, "Other", { effort: "high", startTs: "2030-01-02T09:00:00.000Z", minutes: 25, title: "OH2" });
  seedDoneTicket(board, "Other", { effort: "high", startTs: "2030-01-03T09:00:00.000Z", minutes: 30, title: "OH3" });

  const t = board.addTask("Proj", "feature", { title: "Proj ticket", labels: ["effort:high"] });
  const eta = estimateTicketMinutes(board, "Proj", t.ticketNumber);
  assert.equal(eta.basis, "default", "Proj has no history of its own — Other's history must not leak in");
});

test("get_work_packet surfaces a history-basis eta once a project has enough same-effort Done samples", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  seedDoneTicket(board, "Proj", { effort: "medium", startTs: "2030-01-01T09:00:00.000Z", minutes: 12, title: "M1" });
  seedDoneTicket(board, "Proj", { effort: "medium", startTs: "2030-01-02T09:00:00.000Z", minutes: 15, title: "M2" });
  seedDoneTicket(board, "Proj", { effort: "medium", startTs: "2030-01-03T09:00:00.000Z", minutes: 18, title: "M3" });
  const t = board.addTask("Proj", "feature", { title: "Next medium ticket", labels: ["effort:medium"] });

  const out = await call(tools.get("get_work_packet"), { project: "Proj", ticket: t.ticketNumber });
  assert.equal(out.eta.basis, "history (n=3)");
  assertSaneRange(out.eta);
});
