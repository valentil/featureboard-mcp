import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { findSlaBreaches, resolveSlaThresholds, DEFAULT_SLA_THRESHOLDS, scanBoardCleanup, findDuplicateGroups } from "../server/cleanup.js";

// FBMCPB-43 — deliberate paired A/B experiment records (experiment:board /
// experiment:chat, or a shared pair:<id> label) have near-identical titles by
// design and must NOT be nominated as duplicates.
test("FBMCPB-43: paired experiment arms are not grouped as duplicates", () => {
  const chat = { ticketNumber: "FBMCPF-174", title: "Chat trial p10: fix the thing", status: "Done", labels: ["experiment:chat", "pair:p10"] };
  const packet = { ticketNumber: "FBMCPF-184", title: "Packet trial p10: fix the thing (with packet)", status: "Done", labels: ["experiment:board", "pair:p10"] };
  assert.equal(findDuplicateGroups([chat, packet], { threshold: 0.6 }).length, 0, "experiment arms must not be flagged");

  // same explicit pair id, even without experiment: labels, is also protected
  const a = { ticketNumber: "FBF-1", title: "Trial variant A of the flow", status: "Todo", labels: ["pair:pX"] };
  const b = { ticketNumber: "FBF-2", title: "Trial variant A of the flow", status: "Todo", labels: ["pair:pX"] };
  assert.equal(findDuplicateGroups([a, b], { threshold: 0.7 }).length, 0);
});

test("FBMCPB-43: genuine duplicates without experiment labels are still grouped", () => {
  const a = { ticketNumber: "FBF-3", title: "Add dark mode toggle to settings", status: "Todo", labels: [] };
  const b = { ticketNumber: "FBF-4", title: "Add dark mode toggle to settings", status: "Todo", labels: [] };
  const groups = findDuplicateGroups([a, b], { threshold: 0.7 });
  assert.equal(groups.length, 1, "real duplicates are still caught");
  assert.equal(groups[0].removeCandidates.length, 1);
});

// FBMCPF-198 — priority-scaled SLA / stale escalation on scan_board_cleanup.
const NOW = new Date("2026-07-17T12:00:00Z");

test("P0 In Progress >1d with no activity escalates", () => {
  const b = findSlaBreaches([{ ticketNumber: "FBF-1", title: "hot", status: "In Progress", priority: 0, createdDate: "2026-07-10" }], { now: NOW });
  assert.equal(b.length, 1);
  assert.equal(b[0].severity, "escalate");
  assert.equal(b[0].threshold, 1);
});

test("recent work-log activity resets the In Progress SLA", () => {
  const b = findSlaBreaches([{ ticketNumber: "FBF-1", title: "hot", status: "In Progress", priority: 0, createdDate: "2026-07-10" }], { now: NOW, lastActivity: { "FBF-1": "2026-07-17" } });
  assert.equal(b.length, 0, "activity today -> age 0 -> no breach");
});

test("P2 Todo >7d is stale; a fresh Todo is not", () => {
  const stale = findSlaBreaches([{ ticketNumber: "FBF-2", title: "old", status: "Todo", priority: 2, createdDate: "2026-07-01" }], { now: NOW });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, "stale");
  assert.equal(stale[0].threshold, 7);
  const fresh = findSlaBreaches([{ ticketNumber: "FBF-3", title: "new", status: "Todo", priority: 2, createdDate: "2026-07-15" }], { now: NOW });
  assert.equal(fresh.length, 0);
});

test("Done/Review tickets never breach", () => {
  const tasks = [
    { ticketNumber: "FBF-4", title: "done", status: "Done", priority: 0, createdDate: "2020-01-01" },
    { ticketNumber: "FBF-5", title: "review", status: "Review", priority: 0, createdDate: "2020-01-01" },
  ];
  assert.equal(findSlaBreaches(tasks, { now: NOW }).length, 0);
});

test("unprioritized tickets use the default threshold", () => {
  const b = findSlaBreaches([{ ticketNumber: "FBF-6", title: "x", status: "Todo", priority: null, createdDate: "2026-06-01" }], { now: NOW });
  assert.equal(b.length, 1);
  assert.equal(b[0].threshold, DEFAULT_SLA_THRESHOLDS.todoDays.default);
});

test("resolveSlaThresholds merges config over defaults", () => {
  const merged = resolveSlaThresholds({ todoDays: { 2: 3 } });
  assert.equal(merged.todoDays[2], 3, "override applied");
  assert.equal(merged.todoDays.default, DEFAULT_SLA_THRESHOLDS.todoDays.default, "defaults preserved");
  assert.equal(merged.inProgressDays[0], DEFAULT_SLA_THRESHOLDS.inProgressDays[0]);
});

test("scanBoardCleanup surfaces slaBreaches for an aged Todo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-sla-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  const b = new Board(dir);
  const t = b.addTask("Proj", "feature", { title: "aged todo", priority: 2 });
  b._mutate("Proj", t.ticketNumber, (task) => { task.createdDate = "2026-07-01"; return task; });
  const res = scanBoardCleanup(b, "Proj", { now: NOW });
  assert.ok(res.slaBreachCount >= 1);
  assert.ok(res.slaBreaches.some((x) => x.ticket === t.ticketNumber && x.severity === "stale"));
});
