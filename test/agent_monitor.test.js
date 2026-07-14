import { test } from "node:test";
import assert from "node:assert/strict";
import { computeActiveWork } from "../server/metadata.js";

// FBMCPF-18 — Agent monitor (currently-running tasks)

const asOf = "2026-07-13T12:00:00";

test("aggregates work and sorts most-recently-active first", () => {
  const r = computeActiveWork({
    inProgress: [
      { ticketNumber: "F-1", title: "old", priority: 1 },
      { ticketNumber: "F-2", title: "fresh", priority: 2 },
    ],
    log: [
      { ticket: "F-1", date: "2026-07-13", time: "09:00:00", additions: 5, deletions: 1, tokens: 100, text: "a" },
      { ticket: "F-1", date: "2026-07-13", time: "10:00:00", additions: 3, deletions: 0, tokens: 50, text: "b" },
      { ticket: "F-2", date: "2026-07-13", time: "11:30:00", additions: 2, deletions: 0, tokens: 20, text: "c" },
    ],
    asOf,
  });
  assert.equal(r.activeCount, 2);
  // F-2 last active 11:30 (0.5h idle) sorts before F-1 last active 10:00 (2h idle)
  assert.equal(r.active[0].ticket, "F-2");
  assert.equal(r.active[0].idleHours, 0.5);
  assert.equal(r.active[1].ticket, "F-1");
  assert.equal(r.active[1].idleHours, 2);
  // F-1 cumulative work across its two entries
  assert.equal(r.active[1].work.additions, 8);
  assert.equal(r.active[1].work.events, 2);
  assert.equal(r.active[1].lastActivity.summary, "b");
});

test("flags stalled: no activity, or idle beyond threshold", () => {
  const r = computeActiveWork({
    inProgress: [
      { ticketNumber: "F-1", title: "never touched" },
      { ticketNumber: "F-2", title: "long idle" },
    ],
    log: [{ ticket: "F-2", date: "2026-07-10", time: "12:00:00", additions: 1, text: "old" }],
    asOf,
    stallHours: 24,
  });
  const byId = Object.fromEntries(r.active.map((a) => [a.ticket, a]));
  assert.equal(byId["F-1"].stalled, true);
  assert.equal(byId["F-1"].idleHours, null);
  assert.equal(byId["F-2"].stalled, true); // ~72h idle > 24h
  assert.equal(r.stalledCount, 2);
});

test("empty board => no active work", () => {
  const r = computeActiveWork({ inProgress: [], log: [], asOf });
  assert.equal(r.activeCount, 0);
  assert.equal(r.stalledCount, 0);
});
