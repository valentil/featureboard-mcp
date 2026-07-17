import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { appendEvent, getTimelineData } from "../server/events.js";

// FBMCPF-158 — piano-roll Timeline data source: per-ticket worked spans +
// board-wide datastream rollup, assembled from tasks + ticket_events.jsonl +
// the work log in one read pass.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-timeline-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function spanFor(res, ticket) {
  return res.spans.find((s) => s.ticket === ticket);
}

test("assembles a span: startedAt from the In Progress event, completed, and work rollups", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Piano roll", product: "Analytics" });
  b.setStatus("Proj", t.ticketNumber, "In Progress"); // -> status event
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "work", additions: 40, deletions: 5, tokens: 12000, model: "opus" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "more", additions: 10, deletions: 2, tokens: 3000, model: "opus" });
  b.setStatus("Proj", t.ticketNumber, "Done", { completionSummary: "done" });

  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, t.ticketNumber);
  assert.ok(s, "span present");
  assert.equal(s.startedSource, "status_event");
  assert.ok(s.startedAt, "startedAt set");
  assert.ok(s.completedAt, "completedAt set (completionDate)");
  assert.equal(s.product, "Analytics");
  assert.equal(s.type, "feature");
  assert.equal(s.tokens, 15000);
  assert.equal(s.additions, 50);
  assert.equal(s.deletions, 7);
  assert.ok(s.cost >= 0, "cost computed");
  assert.equal(s.days.length, 1, "one active day rollup (logged today)");
  assert.equal(s.days[0].tokens, 15000);
  assert.ok(Array.isArray(res.byDate) && res.byDate.length === 1, "board-wide byDate rollup");
  assert.equal(res.byDate[0].tokens, 15000);
});

test("ticket with no events falls back to createdDate for startedAt", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Untouched" });
  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, t.ticketNumber);
  assert.ok(s);
  assert.equal(s.startedSource, "created_date");
  assert.ok(s.startedAt.startsWith(t.createdDate));
  assert.equal(s.completedAt, null);
  assert.equal(s.tokens, 0);
  assert.deepEqual(s.days, []);
});

test("from/to keeps only spans whose worked window overlaps the range", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Old work" });
  // inject a historical worked window via explicit-ts events
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", ts: "2020-01-01T09:00:00.000Z" });
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "In Progress", to: "Done", ts: "2020-01-02T17:00:00.000Z" });

  const inRange = getTimelineData(b, "Proj", { from: "2020-01-01", to: "2020-12-31" });
  assert.ok(spanFor(inRange, t.ticketNumber), "included when range overlaps");

  const outRange = getTimelineData(b, "Proj", { from: "2019-01-01", to: "2019-12-31" });
  assert.equal(spanFor(outRange, t.ticketNumber), undefined, "excluded when range is before the span");
});

test("bug tickets are typed as bug and sprint labels surface for lane grouping", () => {
  const b = tmpBoard();
  const bug = b.addTask("Proj", "bug", { title: "Broken" });
  b.updateTask("Proj", bug.ticketNumber, { labels: ["sprint:S1", "model:sonnet"] });
  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, bug.ticketNumber);
  assert.equal(s.type, "bug");
  assert.equal(s.sprint, "S1");
  assert.equal(s.model, "sonnet");
});
