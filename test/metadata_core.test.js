import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import {
  getProjectConfig,
  setProjectConfig,
  addProduct,
  removeProduct,
  getScratchpad,
  setScratchpad,
  appendScratchpad,
  parseWorkLog,
  velocity,
  ticketMetrics,
  logWork,
  readWorkLog,
  logTestRun,
  readTestRuns,
  testSummary,
  computeHealth,
} from "../server/metadata.js";

// FBMCPF-225 — dedicated coverage for the parts of server/metadata.js that
// only had incidental coverage via other test files: legacy/managed config
// merge, scratchpad round-trips, parseWorkLog edge cases, velocity rollup
// math, ticketMetrics, the test-run log, and computeHealth's full breakdown
// (tokenCoverage alone is covered by test/token_coverage.test.js).

function fakeBoard(prefix = "fb-meta-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, board: { projectDir: () => dir } };
}

function realBoard(prefix = "fb-meta-real-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Project config: legacy/managed merge
// ---------------------------------------------------------------------------

test("getProjectConfig: fresh project has empty defaults, no legacy or managed file present", () => {
  const { board } = fakeBoard();
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.project, "P");
  assert.deepEqual(cfg.products, []);
  assert.equal(cfg.codeLocation, undefined);
});

test("getProjectConfig: legacy project_config.json alone supplies values when no managed config exists", () => {
  const { dir, board } = fakeBoard();
  fs.writeFileSync(
    path.join(dir, "project_config.json"),
    JSON.stringify({ codeLocation: "/legacy/path", agentModel: "opus", products: ["Widgets"] })
  );
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.codeLocation, "/legacy/path");
  assert.equal(cfg.agentModel, "opus");
  assert.deepEqual(cfg.products, ["Widgets"]);
});

test("setProjectConfig: managed config overrides legacy for the same key, without touching the legacy file", () => {
  const { dir, board } = fakeBoard();
  fs.writeFileSync(path.join(dir, "project_config.json"), JSON.stringify({ codeLocation: "/legacy/path" }));
  setProjectConfig(board, "P", { codeLocation: "/managed/path" });
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.codeLocation, "/managed/path");
  const legacyRaw = JSON.parse(fs.readFileSync(path.join(dir, "project_config.json"), "utf8"));
  assert.equal(legacyRaw.codeLocation, "/legacy/path"); // legacy file is read-only to this module
});

test("setProjectConfig: managed and legacy values merge when keys don't overlap", () => {
  const { dir, board } = fakeBoard();
  fs.writeFileSync(path.join(dir, "project_config.json"), JSON.stringify({ codeLocation: "/legacy/path" }));
  setProjectConfig(board, "P", { agentModel: "sonnet" });
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.codeLocation, "/legacy/path"); // from legacy
  assert.equal(cfg.agentModel, "sonnet"); // from managed
});

test("getProjectConfig: malformed legacy JSON is swallowed, managed config still works", () => {
  const { dir, board } = fakeBoard();
  fs.writeFileSync(path.join(dir, "project_config.json"), "{ not valid json");
  setProjectConfig(board, "P", { agentModel: "haiku" });
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.agentModel, "haiku");
  assert.deepEqual(cfg.products, []);
});

test("setProjectConfig: keys outside the managed allow-list are silently dropped", () => {
  const { board } = fakeBoard();
  setProjectConfig(board, "P", { agentModel: "opus", notARealKey: "sneaky" });
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.agentModel, "opus");
  assert.equal(cfg.notARealKey, undefined);
});

test("addProduct/removeProduct: case-insensitive de-dupe and removal", () => {
  const { board } = fakeBoard();
  addProduct(board, "P", "Widgets");
  addProduct(board, "P", "widgets"); // dupe by case, should not add a second entry
  addProduct(board, "P", "Gadgets");
  assert.deepEqual(getProjectConfig(board, "P").products, ["Widgets", "Gadgets"]);
  removeProduct(board, "P", "WIDGETS");
  assert.deepEqual(getProjectConfig(board, "P").products, ["Gadgets"]);
});

// ---------------------------------------------------------------------------
// Scratchpad
// ---------------------------------------------------------------------------

test("scratchpad: empty by default, then set/get round-trips exactly", () => {
  const { board } = fakeBoard();
  const empty = getScratchpad(board, "P");
  assert.equal(empty.exists, false);
  assert.equal(empty.bytes, 0);
  setScratchpad(board, "P", "hello world");
  const after = getScratchpad(board, "P");
  assert.equal(after.content, "hello world");
  assert.equal(after.exists, true);
  assert.equal(after.bytes, Buffer.byteLength("hello world", "utf8"));
});

test("appendScratchpad: on empty pad just writes the addition; on non-empty pad appends a new line", () => {
  const { board } = fakeBoard();
  appendScratchpad(board, "P", "first line");
  assert.equal(getScratchpad(board, "P").content, "first line\n");
  appendScratchpad(board, "P", "second line");
  assert.equal(getScratchpad(board, "P").content, "first line\nsecond line\n");
});

// ---------------------------------------------------------------------------
// parseWorkLog
// ---------------------------------------------------------------------------

test("parseWorkLog: skips malformed lines (no leading timestamp) and section headers", () => {
  const content = [
    "## [2020-01-01]",
    "not a valid log line at all",
    "2020-01-01 10:00:00, old entry, Task: FBF-1, Add: 5, Del: 1, tokens: 1000, inputTokens: 800, outputTokens: 200, model: opus",
  ].join("\n");
  const entries = parseWorkLog(content);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.date, "2020-01-01");
  assert.equal(e.time, "10:00:00");
  assert.equal(e.ticket, "FBF-1");
  assert.equal(e.additions, 5);
  assert.equal(e.deletions, 1);
  assert.equal(e.tokens, 1000);
  assert.equal(e.inputTokens, 800);
  assert.equal(e.outputTokens, 200);
  assert.equal(e.model, "opus");
  assert.equal(e.text, "old entry");
});

test("parseWorkLog: entries missing ticket/tokens/model default to null, text keeps the raw summary", () => {
  const content = "2021-06-15 09:05:00, just a note with no metadata";
  const [e] = parseWorkLog(content);
  assert.equal(e.ticket, null);
  assert.equal(e.tokens, null);
  assert.equal(e.inputTokens, null);
  assert.equal(e.outputTokens, null);
  assert.equal(e.model, null);
  assert.equal(e.text, "just a note with no metadata");
});

test("parseWorkLog: empty/null content returns an empty array", () => {
  assert.deepEqual(parseWorkLog(""), []);
  assert.deepEqual(parseWorkLog(null), []);
});

test("parseWorkLog: parses a commit hash tag", () => {
  const content = "2022-02-02 12:00:00, shipped it, Task: FBF-9, commit:deadbeef";
  const [e] = parseWorkLog(content);
  assert.equal(e.ticket, "FBF-9");
  assert.equal(e.hash, "deadbeef");
});

// ---------------------------------------------------------------------------
// velocity rollups
// ---------------------------------------------------------------------------

test("velocity: byDate/byTicket totals and last-seen model are hand-computable", () => {
  const today = todayStr();
  const content = [
    `2020-01-01 10:00:00, old entry, Task: FBF-1, Add: 5, Del: 1, tokens: 1000, model: opus`,
    `${today} 09:00:00, recent entry, Task: FBF-1, Add: 3, Del: 0, tokens: 500, model: sonnet`,
    `${today} 09:05:00, no ticket or tokens here`,
  ].join("\n");
  const entries = parseWorkLog(content);
  assert.equal(entries.length, 3);
  const v = velocity(entries);

  assert.equal(v.totals.tokens, 1500);
  assert.equal(v.totals.additions, 8);
  assert.equal(v.totals.deletions, 1);
  assert.equal(v.totals.events, 3);
  assert.equal(v.totals.activeDays, 2);

  assert.deepEqual(v.byDate["2020-01-01"], { tokens: 1000, additions: 5, deletions: 1, events: 1 });
  assert.deepEqual(v.byDate[today], { tokens: 500, additions: 3, deletions: 0, events: 2 });

  assert.equal(v.byTicket["FBF-1"].tokens, 1500);
  assert.equal(v.byTicket["FBF-1"].additions, 8);
  assert.equal(v.byTicket["FBF-1"].events, 2);
  assert.equal(v.byTicket["FBF-1"].model, "sonnet"); // last entry wins
  assert.equal(v.byTicket["FBF-1"].deletions, 1);
});

test("velocity: tokensLast7Days/30Days only count buckets within the cutoff window", () => {
  const today = todayStr();
  const content = [
    `2015-01-01 10:00:00, ancient, tokens: 9999`,
    `${today} 09:00:00, recent, tokens: 500`,
  ].join("\n");
  const v = velocity(parseWorkLog(content));
  assert.equal(v.tokensLast7Days, 500);
  assert.equal(v.tokensLast30Days, 500);
});

test("velocity: empty entry list produces all-zero totals and no dates", () => {
  const v = velocity([]);
  assert.deepEqual(v.totals, { tokens: 0, additions: 0, deletions: 0, events: 0, activeDays: 0 });
  assert.equal(v.tokensLast7Days, 0);
  assert.deepEqual(v.byDate, {});
  assert.deepEqual(v.byTicket, {});
});

// ---------------------------------------------------------------------------
// ticketMetrics
// ---------------------------------------------------------------------------

test("ticketMetrics: aggregates only the named ticket's work-log entries", () => {
  const b = realBoard();
  logWork(b, "Proj", { ticket: "FBF-1", summary: "a", additions: 10, deletions: 1, tokens: 100 });
  logWork(b, "Proj", { ticket: "FBF-1", summary: "b", additions: 5, deletions: 0, tokens: 50 });
  logWork(b, "Proj", { ticket: "FBF-2", summary: "unrelated", additions: 999, deletions: 999, tokens: 999 });
  const m = ticketMetrics(b, "Proj", "FBF-1");
  assert.equal(m.additions, 15);
  assert.equal(m.deletions, 1);
  assert.equal(m.tokens, 150);
  assert.equal(m.events, 2);
});

test("ticketMetrics: a ticket with no work-log entries returns null", () => {
  const b = realBoard();
  logWork(b, "Proj", { ticket: "FBF-1", summary: "a", additions: 1 });
  assert.equal(ticketMetrics(b, "Proj", "FBF-999"), null);
});

// ---------------------------------------------------------------------------
// Test-run log (logTestRun / readTestRuns / testSummary)
// ---------------------------------------------------------------------------

test("logTestRun + readTestRuns: round-trips passed/failed/skipped/suite/ticket", () => {
  const { board } = fakeBoard();
  logTestRun(board, "P", { passed: 5, failed: 1, skipped: 2, suite: "unit", ticket: "FBF-3", summary: "flaky one" });
  const runs = readTestRuns(board, "P");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].passed, 5);
  assert.equal(runs[0].failed, 1);
  assert.equal(runs[0].skipped, 2);
  assert.equal(runs[0].suite, "unit");
  assert.equal(runs[0].ticket, "FBF-3");
});

test("readTestRuns: malformed lines are ignored, well-formed lines still parse", () => {
  const { dir, board } = fakeBoard();
  const content = [
    "# Test Runs",
    "garbage line, not a run",
    "2026-01-01 10:00:00, passed: 3, failed: 0",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "test_runs.md"), content);
  const runs = readTestRuns(board, "P");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].passed, 3);
});

test("testSummary: latest run + pass/fail totals across the whole log", () => {
  const { board } = fakeBoard();
  logTestRun(board, "P", { passed: 5, failed: 1 });
  logTestRun(board, "P", { passed: 3, failed: 0 });
  const s = testSummary(board, "P");
  assert.equal(s.runs, 2);
  assert.equal(s.totalPassed, 8);
  assert.equal(s.totalFailed, 1);
  assert.equal(s.passing, true); // latest run had 0 failures
  assert.equal(s.latest.passed, 3);
});

test("testSummary: no runs yet returns a zeroed summary, not a throw", () => {
  const { board } = fakeBoard();
  const s = testSummary(board, "P");
  assert.deepEqual(s, { runs: 0, latest: null, totalPassed: 0, totalFailed: 0 });
});

// ---------------------------------------------------------------------------
// computeHealth
// ---------------------------------------------------------------------------

function backdateTicket(board, project, file, ticket, daysAgo) {
  const p = path.join(board.projectDir(project), file);
  const content = fs.readFileSync(p, "utf8");
  const old = new Date(Date.now() - daysAgo * 86400000);
  const oldStr = todayStr(old);
  const lines = content.split(/\r?\n/).map((line) => {
    if (!line.includes(`[${ticket}]`)) return line;
    return line.replace(/\[Created:\s*\d{4}-\d{2}-\d{2}/, `[Created: ${oldStr}`);
  });
  fs.writeFileSync(p, lines.join("\n"));
}

test("computeHealth: bugPressure and progress scores match hand-computed ratios", () => {
  const b = realBoard();
  const f1 = b.addTask("Proj", "feature", { title: "done one" });
  b.setStatus("Proj", f1.ticketNumber, "Done", "shipped");
  b.addTask("Proj", "feature", { title: "still open" }); // open feature
  b.addTask("Proj", "bug", { title: "open bug" }); // open bug
  logWork(b, "Proj", { ticket: f1.ticketNumber, summary: "work", tokens: 100 }); // momentum=100

  const health = computeHealth(b, "Proj");
  // openFeatures=1, openBugs=1 -> bugRatio=0.5 -> bugScore=50
  assert.equal(health.breakdown.bugPressure.score, 50);
  assert.equal(health.breakdown.bugPressure.openBugs, 1);
  assert.equal(health.breakdown.bugPressure.openFeatures, 1);
  // doneFeatures=1 of 2 total features -> progressScore=50
  assert.equal(health.breakdown.progress.score, 50);
  assert.equal(health.breakdown.progress.doneFeatures, 1);
  assert.equal(health.breakdown.progress.totalFeatures, 2);
  // momentum: tokens logged today -> full momentum
  assert.equal(health.breakdown.momentum.score, 100);
});

test("computeHealth: no open tickets -> staleness defaults to 100 (nothing aging)", () => {
  const b = realBoard();
  const f1 = b.addTask("Proj", "feature", { title: "done" });
  b.setStatus("Proj", f1.ticketNumber, "Done", "shipped");
  const health = computeHealth(b, "Proj");
  assert.equal(health.breakdown.freshness.score, 100);
});

test("computeHealth: an open ticket far past the 180-day cap floors staleness at 0, and the weighted score/grade follow", () => {
  const b = realBoard();
  const doneFeature = b.addTask("Proj", "feature", { title: "done one" });
  b.setStatus("Proj", doneFeature.ticketNumber, "Done", "shipped");
  const openFeature = b.addTask("Proj", "feature", { title: "ancient open feature" });
  backdateTicket(b, "Proj", "featurelist.md", openFeature.ticketNumber, 400); // well past the 180-day cap
  b.addTask("Proj", "bug", { title: "open bug" });
  logWork(b, "Proj", { ticket: doneFeature.ticketNumber, summary: "work", tokens: 50 }); // momentum=100

  const health = computeHealth(b, "Proj");
  assert.equal(health.breakdown.freshness.score, 0);
  // bugScore=50 (1 open bug / 2 open total), progressScore=50 (1/2 done),
  // momentumScore=100, stalenessScore=0
  // weighted = round(50*0.3 + 50*0.25 + 100*0.25 + 0*0.2) = round(52.5) = 53
  assert.equal(health.score, 53);
  assert.equal(health.grade, "D"); // 40 <= 53 < 55
});

test("computeHealth: momentum is 20 with no work-log activity at all", () => {
  const b = realBoard();
  const f1 = b.addTask("Proj", "feature", { title: "no logged work" });
  b.setStatus("Proj", f1.ticketNumber, "Done", "shipped");
  const health = computeHealth(b, "Proj");
  assert.equal(health.breakdown.momentum.score, 20);
});
