// FBMCPF-351: routing scorecard — measured per-tier outcomes, with an honest
// "insufficient data" path so thin history never produces a confident verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";
import {
  median,
  resolveTier,
  cycleMinutes,
  isRework,
  summarizeRows,
  recommendTier,
  routingScorecard,
} from "../server/routingscore.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-rs-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

const row = (over = {}) => ({
  ticket: "T-1", tier: "sonnet", effort: "medium",
  tokens: 50000, cost: 1, cycleMinutes: 10, rework: false, ...over,
});

test("median: even, odd, empty, and non-numeric noise", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median(undefined), null);
  assert.equal(median([1, null, NaN, 3]), 2);
});

test("resolveTier prefers the work log, weighted by tokens", () => {
  const task = { labels: ["model:fable"] };
  const work = [
    { model: "sonnet", tokens: 1000 },
    { model: "opus", tokens: 90000 },
  ];
  assert.equal(resolveTier(task, work, []), "opus");
});

test("resolveTier falls back to dispatch events, then the label, then null", () => {
  const task = { labels: ["model:haiku"] };
  assert.equal(
    resolveTier(task, [], [{ model: "sonnet" }, { model: "opus" }]),
    "opus", // newest dispatch wins
  );
  assert.equal(resolveTier(task, [], []), "haiku");
  assert.equal(resolveTier({ labels: [] }, [], []), null);
  // an unrecognizable model in the log doesn't outvote a usable label
  assert.equal(resolveTier(task, [{ model: "gpt-9", tokens: 999999 }], []), "haiku");
});

test("cycleMinutes: first In Progress to last Done, null when either end is missing", () => {
  const evs = [
    { field: "status", ts: "2026-07-20T10:00:00Z", to: "In Progress" },
    { field: "status", ts: "2026-07-20T10:20:00Z", to: "Review" },
    { field: "status", ts: "2026-07-20T11:00:00Z", to: "Done" },
  ];
  assert.equal(cycleMinutes(evs), 60);
  assert.equal(cycleMinutes([{ field: "status", ts: "2026-07-20T10:00:00Z", to: "Done" }]), null);
  assert.equal(cycleMinutes([]), null);
  // a non-status event never anchors the span
  assert.equal(cycleMinutes([{ field: "dispatch", ts: "2026-07-20T10:00:00Z", to: "sub-agent" }]), null);
});

test("isRework: reopened tickets and follow-up bugs both count", () => {
  const task = { completionDate: "2026-07-20" };
  assert.equal(isRework(task, [], []), false);
  assert.equal(
    isRework(task, [{ field: "status", from: "Done", to: "In Progress" }], []),
    true,
  );
  assert.equal(isRework(task, [], [{ createdDate: "2026-07-22" }]), true);
  // a bug filed BEFORE close-out is not rework caused by this ticket
  assert.equal(isRework(task, [], [{ createdDate: "2026-07-01" }]), false);
});

test("summarizeRows: per-tier medians, rework rate, cost per CLEAN ticket", () => {
  const rows = [
    row({ ticket: "A", tier: "opus", cost: 2, tokens: 10000, cycleMinutes: 10 }),
    row({ ticket: "B", tier: "opus", cost: 4, tokens: 30000, cycleMinutes: 30 }),
    row({ ticket: "C", tier: "opus", cost: 6, tokens: 20000, cycleMinutes: 20, rework: true }),
    row({ ticket: "D", tier: "sonnet", cost: 5, tokens: 50000, cycleMinutes: 50 }),
  ];
  const s = summarizeRows(rows, { minSamples: 3 });
  assert.equal(s.opus.n, 3);
  assert.equal(s.opus.reworkTickets, 1);
  assert.equal(s.opus.cleanTickets, 2);
  assert.equal(s.opus.reworkRate, 0.33);
  assert.equal(s.opus.medianTokens, 20000);
  assert.equal(s.opus.medianCycleMinutes, 20);
  assert.equal(s.opus.totalCost, 12);
  assert.equal(s.opus.costPerCleanTicket, 6); // 12 spent / 2 that stayed closed
  assert.equal(s.opus.sufficient, true);
  assert.equal(s.opus.dispatchable, true);
  assert.equal(s.sonnet.n, 1);
  assert.equal(s.sonnet.sufficient, false);
});

test("summarizeRows: a tier that closed nothing cleanly reports null, not Infinity", () => {
  const s = summarizeRows([row({ tier: "haiku", cost: 3, rework: true })]);
  assert.equal(s.haiku.cleanTickets, 0);
  assert.equal(s.haiku.costPerCleanTicket, null);
});

test("summarizeRows buckets an unresolved tier as unknown, not as the default", () => {
  const s = summarizeRows([row({ tier: null })]);
  assert.ok(s.unknown);
  assert.equal(s.sonnet, undefined);
});

test("recommendTier: cheapest per clean ticket wins, with the margin shown", () => {
  const stats = summarizeRows(
    [
      row({ ticket: "A", tier: "opus", cost: 2 }),
      row({ ticket: "B", tier: "opus", cost: 2 }),
      row({ ticket: "C", tier: "opus", cost: 2 }),
      row({ ticket: "D", tier: "sonnet", cost: 4 }),
      row({ ticket: "E", tier: "sonnet", cost: 4 }),
      row({ ticket: "F", tier: "sonnet", cost: 4 }),
    ],
    { minSamples: 3 },
  );
  const r = recommendTier(stats, { minSamples: 3 });
  assert.equal(r.verdict, "prefer");
  assert.equal(r.tier, "opus");
  assert.equal(r.costPerCleanTicket, 2);
  assert.equal(r.runnerUp.tier, "sonnet");
  assert.equal(r.marginVsRunnerUp, 0.5);
});

test("recommendTier: thin history yields insufficient data, never a guess", () => {
  const stats = summarizeRows([row({ tier: "opus", cost: 2 }), row({ tier: "sonnet", cost: 9 })]);
  const r = recommendTier(stats, { minSamples: 3 });
  assert.equal(r.verdict, "insufficient data");
  assert.equal(r.tier, undefined);
  assert.deepEqual(r.samples, { opus: 1, sonnet: 1 });
  assert.match(r.note, /routing\.js heuristics/);
});

test("recommendTier ignores the unknown bucket even when it has samples", () => {
  const stats = summarizeRows(
    [1, 2, 3, 4].map((i) => row({ ticket: `U${i}`, tier: null, cost: 0.01 })),
    { minSamples: 3 },
  );
  assert.equal(recommendTier(stats, { minSamples: 3 }).verdict, "insufficient data");
});

test("routingScorecard: empty board says so instead of returning a neutral verdict", () => {
  const b = tmpBoard();
  const sc = routingScorecard(b, "Proj");
  assert.equal(sc.ticketsScored, 0);
  assert.equal(sc.recommendations.overall.verdict, "insufficient data");
  assert.match(sc.summary, /unavailable, not neutral/);
});

test("routingScorecard end-to-end: tiers, effort cross-cut, rework, advisory", () => {
  const b = tmpBoard();
  const mk = (title, labels, model, tokens) => {
    const t = b.addTask("Proj", "feature", { title, labels });
    b.setStatus("Proj", t.ticketNumber, "In Progress");
    logWork(b, "Proj", { ticket: t.ticketNumber, summary: "work", tokens, model });
    b.setStatus("Proj", t.ticketNumber, "Done");
    return t;
  };
  const o1 = mk("a", ["effort:high"], "opus", 100000);
  mk("b", ["effort:high"], "opus", 100000);
  mk("c", ["effort:high"], "opus", 100000);
  mk("d", ["effort:low"], "haiku", 20000);

  // o1 comes back: a follow-up bug filed against it after close-out.
  b.addTask("Proj", "bug", { title: "regression", ref: o1.ticketNumber });

  const sc = routingScorecard(b, "Proj", { minSamples: 3 });
  assert.equal(sc.ticketsScored, 4);
  assert.equal(sc.overall.opus.n, 3);
  assert.equal(sc.overall.opus.reworkTickets, 1);
  assert.equal(sc.overall.opus.cleanTickets, 2);
  assert.equal(sc.overall.haiku.n, 1);
  // cost is real dollars via pricing.js, not token counts
  assert.ok(sc.overall.opus.totalCost > 0);
  // effort cross-cut keeps the two sizes apart
  assert.equal(sc.byEffort.high.opus.n, 3);
  assert.equal(sc.byEffort.low.haiku.n, 1);
  assert.equal(sc.recommendations.high.verdict, "prefer");
  assert.equal(sc.recommendations.high.tier, "opus");
  // haiku has one sample, so its bucket gets no verdict
  assert.equal(sc.recommendations.low.verdict, "insufficient data");
  assert.match(sc.advisory, /never changes a model:\/cap: label/);
});

test("routingScorecard: dispatch events name the tier when the work log doesn't", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x", labels: [] });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "dispatch", to: "sub-agent", worker: "sub-agent", model: "claude-opus-5-20260724" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "work", tokens: 1000 }); // no model recorded
  b.setStatus("Proj", t.ticketNumber, "Done");
  const sc = routingScorecard(b, "Proj", { includeRows: true });
  assert.equal(sc.rows[0].tier, "opus");
});

// FBMCPB-84: rows are the bulk of the response on a mature board (411 tickets =
// 124KB, past the MCP result cap), so they are opt-in and capped.
test("routingScorecard: rows are omitted by default and capped when requested", () => {
  const b = tmpBoard();
  for (let i = 0; i < 5; i++) {
    const t = b.addTask("Proj", "feature", { title: `t${i}`, labels: ["model:opus"] });
    b.setStatus("Proj", t.ticketNumber, "In Progress");
    logWork(b, "Proj", { ticket: t.ticketNumber, summary: "w", tokens: 1000 * (i + 1), model: "opus" });
    b.setStatus("Proj", t.ticketNumber, "Done");
  }

  const lean = routingScorecard(b, "Proj");
  assert.equal(lean.rows, undefined, "rows must not ride along by default");
  assert.equal(lean.ticketsScored, 5, "stats still cover every ticket");
  assert.equal(lean.overall.opus.n, 5);
  assert.match(lean.rowsOmitted, /includeRows/);

  const full = routingScorecard(b, "Proj", { includeRows: true });
  assert.equal(full.rows.length, 5);
  assert.equal(full.rowsTruncated, undefined);

  const capped = routingScorecard(b, "Proj", { includeRows: true, rowLimit: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.rowsTruncated.of, 5);
  // worst-first: the costliest ticket survives the cap
  assert.ok(capped.rows[0].cost >= capped.rows[1].cost);
});

test("routingScorecard: windowDays drops older and undated completions", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "old", labels: [] });
  b.setStatus("Proj", t.ticketNumber, "Done");
  b.updateTask("Proj", t.ticketNumber, {});
  // rewrite the completion date to well outside the window
  const p = path.join(b.projectDir("Proj"), "featurelist.md");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/Completed: \d{4}-\d{2}-\d{2}/, "Completed: 2020-01-01"));
  assert.equal(routingScorecard(b, "Proj", { windowDays: 7 }).ticketsScored, 0);
  assert.equal(routingScorecard(b, "Proj").ticketsScored, 1);
});
