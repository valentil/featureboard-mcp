// FBMCPF-361/364 — next_wave: lane partitioning, in-flight withholding, and the
// stop condition. The lane grouper and file-scope resolver are pure, so most of
// this runs without a board on disk; buildWave gets a tiny fake board and an
// injected deps bag (the same shape register/board.js passes).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWave, groupLanes, indexCodeFiles, ticketFileScope } from "../server/wave.js";

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wave-"));
  for (const rel of files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "// x\n");
  }
  return dir;
}

const task = (n, over = {}) => ({
  ticketNumber: n, title: "", description: "", status: "Todo",
  type: "feature", labels: [], priority: null, dueDate: null, ...over,
});

function fakeBoard(tasks) {
  return { listTasks: () => tasks.slice(), getTask: (p, t) => tasks.find((x) => x.ticketNumber === t) || null };
}

// Mirrors metadata.js buildDispatchDirective closely enough for routing:
// model comes off the model: label, dispatchability from routing.js tiers.
const deps = (over = {}) => ({
  getProjectConfig: () => ({ codeLocation: over.codeLocation || null, etaHints: false }),
  buildDispatchDirective: (t) => {
    const m = (t.labels || []).map(String).find((l) => /^model:/i.test(l));
    const model = m ? m.split(":")[1].toLowerCase() : "sonnet";
    const sub = model !== "fable";
    return { model, cap: 80000, effort: "medium", subAgent: sub, parallelizable: sub, instruction: "" };
  },
  isBlocked: () => false,
  ticketsWithUnresolvedReviews: () => new Set(),
  lastDispatchForTicket: () => null,
  getSteeringStatus: () => ({ goalOnlyStreak: over.streak ?? 2, unreviewedDoneCount: over.unreviewed ?? 0 }),
  uncollectedChecks: () => over.checks || [],
  compactView: (t) => ({ ticketNumber: t.ticketNumber, title: t.title, status: t.status, type: t.type }),
  ...over.extra,
});

// --- pure grouper ----------------------------------------------------------

test("groupLanes: file-disjoint tickets land in separate lanes", () => {
  const lanes = groupLanes([
    { ticket: "A", files: ["a.js"], order: 0 },
    { ticket: "B", files: ["b.js"], order: 1 },
  ]);
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes.map((l) => l[0].ticket), ["A", "B"]);
});

test("groupLanes: tickets sharing a file land in one lane, in queue order", () => {
  const lanes = groupLanes([
    { ticket: "B", files: ["shared.js"], order: 1 },
    { ticket: "A", files: ["shared.js", "a.js"], order: 0 },
    { ticket: "C", files: ["c.js"], order: 2 },
  ]);
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes[0].map((e) => e.ticket), ["A", "B"], "shared-file lane is serial and priority-ordered");
  assert.deepEqual(lanes[1].map((e) => e.ticket), ["C"]);
});

test("groupLanes: transitive overlap collapses into a single lane", () => {
  // A—B share x, B—C share y, so C must not run beside A.
  const lanes = groupLanes([
    { ticket: "A", files: ["x.js"], order: 0 },
    { ticket: "B", files: ["x.js", "y.js"], order: 1 },
    { ticket: "C", files: ["y.js"], order: 2 },
  ]);
  assert.equal(lanes.length, 1);
  assert.deepEqual(lanes[0].map((e) => e.ticket), ["A", "B", "C"]);
});

test("groupLanes: unknown scope is isolated, never merged", () => {
  const lanes = groupLanes([
    { ticket: "A", files: [], order: 0 },
    { ticket: "B", files: [], order: 1 },
  ]);
  assert.equal(lanes.length, 2, "empty file sets must not be treated as a shared empty key");
});

// --- file scope ------------------------------------------------------------

test("ticketFileScope: resolves repo-relative and unique bare filenames from text", () => {
  const dir = tmpRepo(["server/wave.js", "server/index.js", "docs/readme.md"]);
  const idx = indexCodeFiles(dir);
  const s = ticketFileScope(task("A", { description: "touch server/wave.js and readme.md" }), idx);
  assert.equal(s.basis, "text");
  assert.deepEqual(s.files, ["docs/readme.md", "server/wave.js"]);
});

test("ticketFileScope: ambiguous basename is no signal, and is reported", () => {
  const dir = tmpRepo(["a/index.js", "b/index.js"]);
  const idx = indexCodeFiles(dir);
  const s = ticketFileScope(task("A", { description: "fix index.js" }), idx);
  assert.equal(s.basis, "unknown", "two files named index.js tell us nothing about which one");
  assert.deepEqual(s.ambiguous ?? [], []);
});

test("ticketFileScope: files: label wins over text, verbatim", () => {
  const dir = tmpRepo(["server/wave.js", "server/other.js"]);
  const idx = indexCodeFiles(dir);
  const s = ticketFileScope(task("A", { description: "mentions server/other.js", labels: ["files:server/wave.js"] }), idx);
  assert.equal(s.basis, "label");
  assert.deepEqual(s.files, ["server/wave.js"]);
});

test("ticketFileScope: names no file at all -> unknown, not empty-and-safe", () => {
  const dir = tmpRepo(["server/wave.js"]);
  const s = ticketFileScope(task("A", { description: "make the thing better" }), indexCodeFiles(dir));
  assert.equal(s.basis, "unknown");
  assert.deepEqual(s.files, []);
});

// --- buildWave -------------------------------------------------------------

test("buildWave: fable never appears in lanes[], always in sequential[]", () => {
  const dir = tmpRepo(["server/a.js", "server/b.js"]);
  const board = fakeBoard([
    task("F-1", { description: "server/a.js", labels: ["model:sonnet"], priority: 1 }),
    task("F-2", { description: "server/b.js", labels: ["model:fable"], priority: 2 }),
  ]);
  const w = buildWave(board, "P", deps({ codeLocation: dir }), {});
  const laneTickets = w.lanes.flatMap((l) => l.tickets.map((t) => t.ticket));
  assert.ok(!laneTickets.includes("F-2"), "orchestrator-only tier must never be offered as a parallel lane");
  assert.deepEqual(w.sequential.map((t) => t.ticket), ["F-2"]);
});

test("buildWave: occupied tickets are withheld and their lane comes back busy", () => {
  const dir = tmpRepo(["server/shared.js", "server/solo.js"]);
  const board = fakeBoard([
    task("F-1", { description: "server/shared.js", priority: 1 }),
    task("F-2", { description: "server/shared.js", priority: 2 }),
    task("F-3", { description: "server/solo.js", priority: 3 }),
  ]);
  const w = buildWave(board, "P", deps({ codeLocation: dir }), { occupied: ["F-1"] });
  const served = w.lanes.flatMap((l) => l.tickets.map((t) => t.ticket));
  assert.ok(!served.includes("F-1"), "a running ticket is never re-served");
  assert.ok(!served.includes("F-2"), "a ticket sharing files with a running one must wait");
  assert.deepEqual(served, ["F-3"]);
  assert.deepEqual(w.busyLanes[0].waitingOn, ["F-1"]);
  assert.equal(w.stopCondition.inFlight, 1);
});

test("buildWave: maxLanes caps concurrency and reports what it withheld", () => {
  const dir = tmpRepo(["a.js", "b.js", "c.js"]);
  const board = fakeBoard([
    task("F-1", { description: "a.js", priority: 1 }),
    task("F-2", { description: "b.js", priority: 2 }),
    task("F-3", { description: "c.js", priority: 3 }),
  ]);
  const w = buildWave(board, "P", deps({ codeLocation: dir }), { maxLanes: 2 });
  assert.equal(w.laneCount, 2);
  assert.equal(w.lanesWithheld, 1);
  assert.deepEqual(w.lanes.map((l) => l.lane), [0, 1], "lanes are renumbered after the cap");
});

test("buildWave: stop condition is false while work is open", () => {
  const dir = tmpRepo(["a.js"]);
  const board = fakeBoard([task("F-1", { description: "a.js", priority: 1 })]);
  const w = buildWave(board, "P", deps({ codeLocation: dir }), {});
  assert.equal(w.stopCondition.met, false);
  assert.match(w.stopCondition.reasons.join(" "), /open ticket/);
});

test("buildWave: uncollected check runs keep the stop condition false on an empty queue", () => {
  const board = fakeBoard([]);
  const w = buildWave(board, "P", deps({ checks: [{ runId: "r1", ticket: "F-1", status: "failed" }] }), {});
  assert.equal(w.lanes.length, 0);
  assert.equal(w.stopCondition.met, false, "an empty queue with an uncollected failed run is not done");
  assert.equal(w.stopCondition.uncollectedChecks, 1);
  assert.match(w.stopCondition.reasons.join(" "), /get_check_results/);
});

test("buildWave: unreviewed Done tickets keep the stop condition false", () => {
  const board = fakeBoard([]);
  const w = buildWave(board, "P", deps({ unreviewed: 3 }), {});
  assert.equal(w.stopCondition.met, false);
  assert.match(w.stopCondition.reasons.join(" "), /steer_project/);
});

test("buildWave: an idle-steered, fully-collected empty board is the only way to stop", () => {
  const board = fakeBoard([]);
  const w = buildWave(board, "P", deps({ streak: 2, unreviewed: 0, checks: [] }), {});
  assert.equal(w.stopCondition.met, true);
  assert.deepEqual(w.stopCondition.reasons, []);
  assert.match(w.stopCondition.instruction, /Stop condition met/);
});

test("buildWave: steering that has not gone idle blocks the stop even when clear", () => {
  const board = fakeBoard([]);
  const w = buildWave(board, "P", deps({ streak: 0 }), {});
  assert.equal(w.stopCondition.met, false);
  assert.match(w.stopCondition.reasons.join(" "), /steering has not gone idle/);
});
