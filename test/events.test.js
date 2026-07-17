import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { assignSprint } from "../server/sprints.js";
import { logWork } from "../server/metadata.js";
import { appendEvent, readEvents, eventsForTicket, getTicketHistory, appendHeartbeat, readHeartbeats, heartbeatsForTicket } from "../server/events.js";

// FBMCPF-142 — audit timeline: get_ticket_history event log per ticket.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-events-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("setStatus appends a status event (old -> new) with source", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "status");
  assert.equal(events[0].from, "Todo");
  assert.equal(events[0].to, "In Progress");
  assert.equal(events[0].source, "set_status");
  assert.ok(events[0].ts);
});

test("setStatus does NOT append an event when the status is unchanged", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "Todo"); // no-op: already Todo
  assert.deepEqual(eventsForTicket(b, "Proj", t.ticketNumber), []);
});

test("a failed setStatus (requireReview gate) does not leave a partial event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Gated" });
  // force requireReview via project config, then move straight to Done from Todo — should throw
  fs.writeFileSync(
    path.join(b.projectDir("Proj"), ".featureboard.config.json"),
    JSON.stringify({ requireReview: true })
  );
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  assert.throws(() => b.setStatus("Proj", t.ticketNumber, "Done"), /requireReview is on/);
  // only the one In Progress event should be recorded, no Done event
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "In Progress");
});

test("updateTask appends a priority event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.updateTask("Proj", t.ticketNumber, { priority: 3 });
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "priority");
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, 3);
  assert.equal(events[0].source, "update_task");
});

test("updateTask appends a dueDate event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing", dueDate: "2026-07-20" });
  b.updateTask("Proj", t.ticketNumber, { dueDate: "2026-08-01" });
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "dueDate");
  assert.equal(events[0].from, "2026-07-20");
  assert.equal(events[0].to, "2026-08-01");
});

test("updateTask appends a labels event for non-sprint label changes", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing", labels: ["core"] });
  b.updateTask("Proj", t.ticketNumber, { labels: ["core", "urgent"] });
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "labels");
  assert.deepEqual(events[0].from, ["core"]);
  assert.deepEqual(events[0].to, ["core", "urgent"]);
});

test("updateTask with no actual field changes appends nothing", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing", priority: 2, labels: ["core"] });
  b.updateTask("Proj", t.ticketNumber, { priority: 2, labels: ["core"] });
  assert.deepEqual(eventsForTicket(b, "Proj", t.ticketNumber), []);
});

test("assignSprint (via updateTask) appends a sprint event, not a generic labels event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing", labels: ["core"] });
  assignSprint(b, "Proj", [t.ticketNumber], "Sprint 1");
  let events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "sprint");
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, "Sprint 1");
  assert.equal(events[0].source, "assign_sprint");

  // moving to a different sprint again — one more sprint event
  assignSprint(b, "Proj", [t.ticketNumber], "Sprint 2");
  events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 2);
  assert.equal(events[1].field, "sprint");
  assert.equal(events[1].from, "Sprint 1");
  assert.equal(events[1].to, "Sprint 2");

  // clearing back to backlog
  assignSprint(b, "Proj", [t.ticketNumber], null);
  events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 3);
  assert.equal(events[2].from, "Sprint 2");
  assert.equal(events[2].to, null);
});

test("events file is append-only JSONL and tolerates malformed lines on read", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  const p = path.join(b.projectDir("Proj"), "ticket_events.jsonl");
  fs.appendFileSync(p, "not json at all\n");
  fs.appendFileSync(p, "\n"); // blank line
  const all = readEvents(b, "Proj");
  assert.equal(all.length, 1); // malformed/blank lines skipped, valid one kept
});

test("readEvents / eventsForTicket tolerate a missing events file entirely", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  assert.deepEqual(readEvents(b, "Proj"), []);
  assert.deepEqual(eventsForTicket(b, "Proj", t.ticketNumber), []);
});

test("getTicketHistory merges events + work-log entries in chronological order", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });

  // backdate a work-log entry before the event by writing it directly, then
  // append the event with an explicit earlier/later ts to control ordering.
  logWork(b, "Proj", { summary: "started digging in", ticket: t.ticketNumber, additions: 5, deletions: 1, tokens: 1000 });
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2099-01-01T00:00:00.000Z" });

  const hist = getTicketHistory(b, "Proj", t.ticketNumber);
  assert.equal(hist.project, "Proj");
  assert.equal(hist.ticket, t.ticketNumber);
  assert.equal(hist.count, 2);
  // work log entry (stamped "now", i.e. well before 2099) should sort first
  assert.equal(hist.history[0].kind, "work_log");
  assert.equal(hist.history[1].kind, "event");
  assert.equal(hist.history[1].field, "status");
});

test("getTicketHistory tolerates a ticket with no events file (pre-feature tickets) — falls back to work-log only", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Legacy ticket" });
  logWork(b, "Proj", { summary: "old work, no events feature yet", ticket: t.ticketNumber, additions: 10, deletions: 2 });

  const hist = getTicketHistory(b, "Proj", t.ticketNumber);
  assert.equal(hist.count, 1);
  assert.equal(hist.history[0].kind, "work_log");
  assert.equal(hist.history[0].summary, "old work, no events feature yet");
});

test("getTicketHistory returns an empty history for a ticket with neither events nor work log", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Untouched" });
  const hist = getTicketHistory(b, "Proj", t.ticketNumber);
  assert.equal(hist.count, 0);
  assert.deepEqual(hist.history, []);
});


// FBMCPB-15 — heartbeats: lightweight in-flight progress pings, separate
// append-only log from ticket_events.jsonl.

test("appendHeartbeat writes a normalized record and heartbeatsForTicket reads it back", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  const rec = appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "reading affected files", model: "sonnet", elapsedMinutes: 2.5, spend: 8000 });
  assert.equal(rec.ticket, t.ticketNumber);
  assert.equal(rec.note, "reading affected files");
  assert.equal(rec.model, "sonnet");
  assert.equal(rec.elapsedMinutes, 2.5);
  assert.equal(rec.spend, 8000);
  assert.ok(rec.ts);

  const hb = heartbeatsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(hb.length, 1);
  assert.equal(hb[0].note, "reading affected files");
});

test("heartbeats.jsonl is append-only and distinct from ticket_events.jsonl", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "milestone 1" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "milestone 2" });

  const hb = heartbeatsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(hb.length, 2);
  assert.equal(hb[0].note, "milestone 1");
  assert.equal(hb[1].note, "milestone 2");

  // the status-change audit event is untouched by heartbeat writes
  const events = eventsForTicket(b, "Proj", t.ticketNumber);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, "status");

  const p = path.join(b.projectDir("Proj"), "heartbeats.jsonl");
  assert.ok(fs.existsSync(p));
  const eventsPath = path.join(b.projectDir("Proj"), "ticket_events.jsonl");
  assert.notEqual(p, eventsPath);
});

test("readHeartbeats / heartbeatsForTicket tolerate a missing heartbeats file entirely", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  assert.deepEqual(readHeartbeats(b, "Proj"), []);
  assert.deepEqual(heartbeatsForTicket(b, "Proj", t.ticketNumber), []);
});

test("heartbeats.jsonl tolerates malformed lines on read", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "ok" });
  const p = path.join(b.projectDir("Proj"), "heartbeats.jsonl");
  fs.appendFileSync(p, "not json at all\n");
  fs.appendFileSync(p, "\n");
  const all = readHeartbeats(b, "Proj");
  assert.equal(all.length, 1);
});
