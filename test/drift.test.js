import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import {
  verdictFor,
  makeRng,
  selectSample,
  wilsonInterval,
  startDriftRun,
  recordDriftScore,
  driftReport,
  applyDriftRemediation,
} from "../server/drift.js";

// FBMCPF-108 — agentic drift evaluation.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-drift-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

/** Create n Done features (FBF-*), returning their ticket numbers oldest-first. */
function makeDoneFeatures(board, project, n, titlePrefix = "Feature") {
  const tickets = [];
  for (let i = 0; i < n; i++) {
    const t = board.addTask(project, "feature", { title: `${titlePrefix} ${i}` });
    board.setStatus(project, t.ticketNumber, "Done", `${titlePrefix} ${i} done`);
    tickets.push(t.ticketNumber);
  }
  return tickets;
}

// ---------------------------------------------------------------------------
// verdictFor
// ---------------------------------------------------------------------------

test("verdictFor: bands at the documented boundaries (>=80 aligned, 50-79 partial, <50 drift)", () => {
  assert.equal(verdictFor(100), "aligned");
  assert.equal(verdictFor(80), "aligned");
  assert.equal(verdictFor(79), "partial");
  assert.equal(verdictFor(50), "partial");
  assert.equal(verdictFor(49), "drift");
  assert.equal(verdictFor(0), "drift");
});

test("verdictFor: non-numeric score is unknown, not a throw", () => {
  assert.equal(verdictFor("not a number"), "unknown");
  assert.equal(verdictFor(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// makeRng
// ---------------------------------------------------------------------------

test("makeRng: same seed reproduces the same sequence; values stay in [0,1)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `${v} in [0,1)`);
  }
});

test("makeRng: different seeds diverge", () => {
  const a = makeRng(1)();
  const b = makeRng(2)();
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// selectSample
// ---------------------------------------------------------------------------

test("selectSample: mode full returns every ticket regardless of sampleSize", () => {
  const tickets = [1, 2, 3, 4, 5].map((n) => ({ ticket: `FBF-${n}` }));
  const { chosen, seed } = selectSample(tickets, { mode: "full", sampleSize: 2 });
  assert.equal(chosen.length, 5);
  assert.equal(seed, null);
});

test("selectSample: population smaller than sampleSize returns everything even in sample mode", () => {
  const tickets = [{ ticket: "FBF-1" }, { ticket: "FBF-2" }];
  const { chosen } = selectSample(tickets, { mode: "sample", sampleSize: 10 });
  assert.equal(chosen.length, 2);
});

test("selectSample: sample mode picks sampleSize items and echoes a reproducible seed", () => {
  const tickets = Array.from({ length: 20 }, (_, i) => ({ ticket: `FBF-${i}` }));
  const { chosen, seed } = selectSample(tickets, { mode: "sample", sampleSize: 5, seed: 7 });
  assert.equal(chosen.length, 5);
  assert.equal(seed, 7);
  // re-running with the same seed reproduces the exact same subset, in order
  const again = selectSample(tickets, { mode: "sample", sampleSize: 5, seed: 7 });
  assert.deepEqual(again.chosen, chosen);
});

test("selectSample: omitted seed still returns a usable (non-null) seed for reproducibility", () => {
  const tickets = Array.from({ length: 20 }, (_, i) => ({ ticket: `FBF-${i}` }));
  const { seed } = selectSample(tickets, { mode: "sample", sampleSize: 5 });
  assert.notEqual(seed, null);
  assert.ok(Number.isInteger(seed));
});

// ---------------------------------------------------------------------------
// wilsonInterval
// ---------------------------------------------------------------------------

test("wilsonInterval: n=0 returns a degenerate zero interval", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
});

test("wilsonInterval: 0 successes of 10 gives a low-anchored interval near zero", () => {
  const { low, high } = wilsonInterval(0, 10);
  assert.equal(low, 0);
  assert.ok(high > 0 && high < 0.35, `high=${high} should be a small positive bound`);
});

test("wilsonInterval: all successes gives a high-anchored interval near one", () => {
  const { low, high } = wilsonInterval(10, 10);
  assert.equal(high, 1);
  assert.ok(low > 0.65 && low < 1, `low=${low} should be close to 1`);
});

test("wilsonInterval: 5/10 matches the hand-computed 95% Wilson bounds", () => {
  // p=0.5, n=10, z=1.96 -> centre=(0.5+1.9208/20)/(1+3.8416/10), margin/denom similarly.
  const z = 1.96, n = 10, p = 0.5;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const expectedLow = (centre - margin) / denom;
  const expectedHigh = (centre + margin) / denom;
  const { low, high } = wilsonInterval(5, 10);
  assert.ok(Math.abs(low - expectedLow) < 1e-9);
  assert.ok(Math.abs(high - expectedHigh) < 1e-9);
});

// ---------------------------------------------------------------------------
// startDriftRun
// ---------------------------------------------------------------------------

test("startDriftRun: throws for a project that doesn't exist", () => {
  const b = tmpBoard();
  assert.throws(() => startDriftRun(b, "Nope", {}), /not found/);
});

test("startDriftRun: throws when there are no Done tickets (empty board)", () => {
  const b = tmpBoard();
  assert.throws(() => startDriftRun(b, "Proj", {}), /No Done tickets/);
});

test("startDriftRun: throws when Done tickets exist but only In Progress/Todo are on the board otherwise", () => {
  const b = tmpBoard();
  b.addTask("Proj", "feature", { title: "still open" });
  assert.throws(() => startDriftRun(b, "Proj", {}), /No Done tickets/);
});

test("startDriftRun: sample mode caps sampleSize and echoes population/mode/tickets", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 8);
  const run = startDriftRun(b, "Proj", { mode: "sample", sampleSize: 3, seed: 99 });
  assert.equal(run.mode, "sample");
  assert.equal(run.population, 8);
  assert.equal(run.sampleSize, 3);
  assert.equal(run.tickets.length, 3);
  assert.equal(run.seed, 99);
  assert.match(run.note, /Sampled 3 of 8/);
});

test("startDriftRun: full mode returns every Done ticket, sample-related knobs ignored", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 4);
  const run = startDriftRun(b, "Proj", { mode: "full", sampleSize: 1 });
  assert.equal(run.mode, "full");
  assert.equal(run.sampleSize, 4);
  assert.equal(run.tickets.length, 4);
  assert.match(run.note, /Evaluating all 4/);
});

test("startDriftRun: type filter restricts the Done population (bugs excluded when type=feature)", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 2);
  const bug = b.addTask("Proj", "bug", { title: "a bug" });
  b.setStatus("Proj", bug.ticketNumber, "Done", "fixed");
  const runAll = startDriftRun(b, "Proj", { mode: "full" });
  assert.equal(runAll.population, 3);
  const b2 = tmpBoard();
  makeDoneFeatures(b2, "Proj", 2);
  const bug2 = b2.addTask("Proj", "bug", { title: "a bug" });
  b2.setStatus("Proj", bug2.ticketNumber, "Done", "fixed");
  const runFeatures = startDriftRun(b2, "Proj", { mode: "full", type: "feature" });
  assert.equal(runFeatures.population, 2);
  assert.ok(runFeatures.tickets.every((t) => t.ticket !== bug2.ticketNumber));
  assert.ok(runFeatures.tickets.every((t) => b2.getTask("Proj", t.ticket).type === "feature"));
});

test("startDriftRun: persists the run so a later drift_report(runId) can find it", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 2);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.runId, run.runId);
  assert.equal(report.population, 2);
  assert.equal(report.scored, 0);
});

// ---------------------------------------------------------------------------
// recordDriftScore
// ---------------------------------------------------------------------------

test("recordDriftScore: requires a ticket and a run to already exist", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  assert.throws(() => recordDriftScore(b, "Proj", run.runId, { score: 90 }), /ticket is required/);
  assert.throws(() => recordDriftScore(b, "Proj", "bogus-run-id", { ticket: "FBF-1", score: 90 }), /not found/);
});

test("recordDriftScore: validates score is a number in [0,100]", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const ticket = run.tickets[0].ticket;
  assert.throws(() => recordDriftScore(b, "Proj", run.runId, { ticket, score: -1 }), /0–100/);
  assert.throws(() => recordDriftScore(b, "Proj", run.runId, { ticket, score: 101 }), /0–100/);
  assert.throws(() => recordDriftScore(b, "Proj", run.runId, { ticket, score: "not-a-number" }), /0–100/);
});

test("recordDriftScore: derives verdict from score and rounds fractional scores", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const ticket = run.tickets[0].ticket;
  const res = recordDriftScore(b, "Proj", run.runId, { ticket, score: 75.6 });
  assert.equal(res.verdict, "partial");
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.flagged[0].score, 76); // Math.round(75.6)
});

test("recordDriftScore: explicit verdict overrides the derived one", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const ticket = run.tickets[0].ticket;
  const res = recordDriftScore(b, "Proj", run.runId, { ticket, score: 95, verdict: "partial" });
  assert.equal(res.verdict, "partial");
});

test("recordDriftScore: re-scoring the same ticket upserts rather than duplicating", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const ticket = run.tickets[0].ticket;
  recordDriftScore(b, "Proj", run.runId, { ticket, score: 20, gap: "missed AC1" });
  const res2 = recordDriftScore(b, "Proj", run.runId, { ticket, score: 90 });
  assert.equal(res2.scored, 1); // still just one entry
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.scored, 1);
  assert.equal(report.meanScore, 90);
});

// ---------------------------------------------------------------------------
// driftReport
// ---------------------------------------------------------------------------

test("driftReport: throws when no runs exist at all", () => {
  const b = tmpBoard();
  assert.throws(() => driftReport(b, "Proj", null), /no drift runs yet/);
});

test("driftReport: an unscored run reports zeroed-out aggregates and a full pending list", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 3);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.scored, 0);
  assert.equal(report.meanScore, null);
  assert.deepEqual(report.counts, { aligned: 0, partial: 0, drift: 0 });
  assert.equal(report.driftRatePct, 0);
  assert.equal(report.flaggedRatePct, 0);
  assert.equal(report.pending.length, 3);
  assert.deepEqual(report.flagged, []);
});

test("driftReport: all-clean run — every ticket aligned, zero drift rate, no confidence needed to flag anything", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 4);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  for (const t of run.tickets) recordDriftScore(b, "Proj", run.runId, { ticket: t.ticket, score: 95 });
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.meanScore, 95);
  assert.equal(report.counts.aligned, 4);
  assert.equal(report.driftRatePct, 0);
  assert.equal(report.flaggedRatePct, 0);
  assert.deepEqual(report.flagged, []);
});

test("driftReport: all-drifted run — mean/counts/rates and hand-computed Wilson CI", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 5);
  const run = startDriftRun(b, "Proj", { mode: "sample", sampleSize: 5, seed: 1 });
  for (const t of run.tickets) recordDriftScore(b, "Proj", run.runId, { ticket: t.ticket, score: 10 });
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.meanScore, 10);
  assert.equal(report.counts.drift, 5);
  assert.equal(report.driftRatePct, 100);
  assert.equal(report.flaggedRatePct, 100);
  assert.ok(report.confidence, "sample-mode run must carry a confidence interval");
  const ci = wilsonInterval(5, 5);
  assert.equal(report.confidence.interval[1], Math.round(ci.high * 1000) / 1000);
  assert.equal(report.confidence.point, 1);
  assert.equal(report.confidence.population, 5);
  assert.equal(report.confidence.sampled, 5);
});

test("driftReport: full mode never carries a confidence interval (no sampling to bound)", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 2);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  for (const t of run.tickets) recordDriftScore(b, "Proj", run.runId, { ticket: t.ticket, score: 10 });
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.confidence, null);
});

test("driftReport: mixed verdicts — meanScore, per-band counts, and flagged sorted worst-first", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 4);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  const scores = { [tickets[0]]: 90, [tickets[1]]: 60, [tickets[2]]: 20, [tickets[3]]: 55 };
  for (const [ticket, score] of Object.entries(scores)) {
    recordDriftScore(b, "Proj", run.runId, { ticket, score, gap: score < 50 ? "big gap" : "" });
  }
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.meanScore, 56.3); // Math.round(56.25 * 10) / 10 (round-half-up)
  assert.deepEqual(report.counts, { aligned: 1, partial: 2, drift: 1 });
  assert.equal(report.driftRatePct, 25);
  assert.equal(report.flaggedRatePct, 75);
  // flagged excludes the aligned ticket and is sorted ascending by score
  assert.equal(report.flagged.length, 3);
  assert.deepEqual(report.flagged.map((f) => f.score), [20, 55, 60]);
  assert.equal(report.flagged[0].gap, "big gap");
});

// ---------------------------------------------------------------------------
// applyDriftRemediation
// ---------------------------------------------------------------------------

test("applyDriftRemediation: rejects an unknown action", () => {
  const b = tmpBoard();
  makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  assert.throws(() => applyDriftRemediation(b, "Proj", run.runId, { action: "nuke" }), /action must be one of/);
});

test("applyDriftRemediation: no tickets match the selected verdicts -> no-op with a note", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 95 }); // aligned
  const res = applyDriftRemediation(b, "Proj", run.runId, { action: "reopen" }); // default verdicts: ["drift"]
  assert.equal(res.applied, 0);
  assert.match(res.note, /no tickets match/);
});

test("applyDriftRemediation: dryRun previews without mutating the board or persisting", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 10 });
  const res = applyDriftRemediation(b, "Proj", run.runId, { action: "reopen", dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.applied, 1);
  assert.equal(res.results[0].wouldApply, "reopen");
  // ticket status untouched, and nothing recorded on the run
  assert.equal(b.getTask("Proj", tickets[0]).status, "Done");
  const report = driftReport(b, "Proj", run.runId);
  assert.deepEqual(report.remediations, []);
});

test("applyDriftRemediation: reopen moves flagged tickets back to Todo", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 2);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 10 }); // drift
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[1], score: 95 }); // aligned, untouched
  const res = applyDriftRemediation(b, "Proj", run.runId, { action: "reopen" });
  assert.equal(res.applied, 1);
  assert.equal(b.getTask("Proj", tickets[0]).status, "Todo");
  assert.equal(b.getTask("Proj", tickets[1]).status, "Done");
});

test("applyDriftRemediation: relabel adds a drift label without duplicating it on rerun", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 10 });
  applyDriftRemediation(b, "Proj", run.runId, { action: "relabel" });
  assert.deepEqual(b.getTask("Proj", tickets[0]).labels, ["drift"]);
  applyDriftRemediation(b, "Proj", run.runId, { action: "relabel" }); // rerun
  assert.deepEqual(b.getTask("Proj", tickets[0]).labels, ["drift"]); // no duplicate
});

test("applyDriftRemediation: file_bugs opens a linked bug describing the gap, and records the remediation on the run", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 1);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 15, gap: "ignored the DoD" });
  const res = applyDriftRemediation(b, "Proj", run.runId, { action: "file_bugs" });
  assert.equal(res.applied, 1);
  const filedBug = res.results[0].filedBug;
  assert.equal(b.getTask("Proj", filedBug).type, "bug");
  const bug = b.getTask("Proj", filedBug);
  assert.equal(bug.linkedIssue, tickets[0]);
  assert.match(bug.description, /ignored the DoD/);
  const report = driftReport(b, "Proj", run.runId);
  assert.equal(report.remediations.length, 1);
  assert.equal(report.remediations[0].action, "file_bugs");
  assert.equal(report.remediations[0].count, 1);
});

test("applyDriftRemediation: verdicts option can widen remediation to partial as well as drift", () => {
  const b = tmpBoard();
  const tickets = makeDoneFeatures(b, "Proj", 2);
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[0], score: 10 }); // drift
  recordDriftScore(b, "Proj", run.runId, { ticket: tickets[1], score: 60 }); // partial
  const res = applyDriftRemediation(b, "Proj", run.runId, { action: "reopen", verdicts: ["drift", "partial"] });
  assert.equal(res.applied, 2);
  assert.equal(b.getTask("Proj", tickets[0]).status, "Todo");
  assert.equal(b.getTask("Proj", tickets[1]).status, "Todo");
});
