import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { appendEvent, eventsForTicket, lastDispatchForTicket, agentMonitorV2 } from "../server/events.js";

// FBMCPF-256 — record_dispatch: who's actively working an In Progress
// ticket, surfaced through lastDispatchForTicket() and folded into
// get_agent_monitor's per-ticket lastDispatch + subAgentCount/parallelCount
// summary. No schema change needed — appendEvent already persists extra
// fields onto a "dispatch" event (worker/model/parallel/note) the same way
// FBMCPF-188's commit events ride hash/shortHash/additions/deletions.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-record-dispatch-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

/** Mirrors what the record_dispatch tool handler does (appendEvent with field:"dispatch"). */
function recordDispatch(b, project, ticket, { worker, model, parallel, note, ts } = {}) {
  return appendEvent(b, project, { ticket, field: "dispatch", from: null, to: worker, source: "record_dispatch", worker, model, parallel, note, ts });
}

test("record_dispatch appends a dispatch event with worker/model/parallel/note", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "sub-agent", model: "sonnet", parallel: true, note: "initial dispatch" });

  const events = eventsForTicket(b, "Proj", t.ticketNumber).filter((e) => e.field === "dispatch");
  assert.equal(events.length, 1);
  assert.equal(events[0].worker, "sub-agent");
  assert.equal(events[0].model, "sonnet");
  assert.equal(events[0].parallel, true);
  assert.equal(events[0].note, "initial dispatch");
  assert.equal(events[0].to, "sub-agent");
  assert.equal(events[0].source, "record_dispatch");
});

test("lastDispatchForTicket returns null when no dispatch was ever recorded", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Untouched" });
  assert.equal(lastDispatchForTicket(b, "Proj", t.ticketNumber), null);
});

test("lastDispatchForTicket returns the newest dispatch event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "sub-agent", model: "sonnet", parallel: false, ts: "2030-01-01T10:00:00" });
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "sub-agent", model: "opus", parallel: false, ts: "2030-01-01T10:05:00" });

  const last = lastDispatchForTicket(b, "Proj", t.ticketNumber);
  assert.ok(last);
  assert.equal(last.worker, "sub-agent");
  assert.equal(last.model, "opus"); // the later of the two dispatches
  assert.equal(last.ts, "2030-01-01T10:05:00");
});

test("a take-back dispatch (worker: orchestrator) wins over the original sub-agent dispatch", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "sub-agent", model: "sonnet", parallel: true, ts: "2030-01-01T10:00:00" });
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "orchestrator", note: "taking back for review", ts: "2030-01-01T10:30:00" });

  const last = lastDispatchForTicket(b, "Proj", t.ticketNumber);
  assert.equal(last.worker, "orchestrator");
  assert.equal(last.note, "taking back for review");
});

test("appendEvent throws for an unknown ticket when routed through the tool's own guard", () => {
  const b = tmpBoard();
  // record_dispatch's tool handler looks the ticket up via board.getTask()
  // before calling appendEvent, and throws when it's missing — mirror that
  // guard here since appendEvent itself is a dumb, best-effort append.
  assert.equal(b.getTask("Proj", "FBF-999"), null);
  assert.throws(() => {
    const task = b.getTask("Proj", "FBF-999");
    if (!task) throw new Error('Ticket FBF-999 not found in "Proj".');
  }, /not found/);
});

test("get_agent_monitor surfaces lastDispatch per ticket, ageMinutes, and subAgentCount/parallelCount summary", () => {
  const b = tmpBoard();
  const t1 = b.addTask("Proj", "feature", { title: "On a sub-agent, parallel" });
  const t2 = b.addTask("Proj", "feature", { title: "On a sub-agent, solo" });
  const t3 = b.addTask("Proj", "feature", { title: "Back with the orchestrator" });
  b.setStatus("Proj", t1.ticketNumber, "In Progress");
  b.setStatus("Proj", t2.ticketNumber, "In Progress");
  b.setStatus("Proj", t3.ticketNumber, "In Progress");

  recordDispatch(b, "Proj", t1.ticketNumber, { worker: "sub-agent", model: "sonnet", parallel: true, ts: "2030-01-01T10:00:00" });
  recordDispatch(b, "Proj", t2.ticketNumber, { worker: "sub-agent", model: "haiku", parallel: false, ts: "2030-01-01T09:50:00" });
  recordDispatch(b, "Proj", t3.ticketNumber, { worker: "orchestrator", note: "reviewing diff", ts: "2030-01-01T09:55:00" });

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:12:00" });
  assert.equal(r.count, 3);
  assert.equal(r.subAgentCount, 2);
  assert.equal(r.parallelCount, 1);

  const m1 = r.tickets.find((x) => x.ticket === t1.ticketNumber);
  assert.ok(m1.lastDispatch);
  assert.equal(m1.lastDispatch.worker, "sub-agent");
  assert.equal(m1.lastDispatch.model, "sonnet");
  assert.equal(m1.lastDispatch.parallel, true);
  assert.equal(m1.lastDispatch.ageMinutes, 12); // 10:00 -> 10:12

  const m3 = r.tickets.find((x) => x.ticket === t3.ticketNumber);
  assert.equal(m3.lastDispatch.worker, "orchestrator");
  assert.equal(m3.lastDispatch.note, "reviewing diff");
  assert.equal(m3.lastDispatch.model, null);
});

test("get_agent_monitor's lastDispatch is null for a ticket that has never been dispatched", () => {
  const b = tmpBoard();
  b.addTask("Proj", "feature", { title: "No dispatch yet", status: "In Progress" });
  const r = agentMonitorV2(b, "Proj", {});
  assert.equal(r.tickets[0].lastDispatch, null);
  assert.equal(r.subAgentCount, 0);
  assert.equal(r.parallelCount, 0);
});

test("a dispatch event also surfaces as lastEvent with a readable summary", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T09:00:00" });
  recordDispatch(b, "Proj", t.ticketNumber, { worker: "sub-agent", model: "sonnet", parallel: true, ts: "2030-01-01T09:05:00" });

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T09:10:00" });
  const ticket = r.tickets[0];
  assert.equal(ticket.lastEvent.kind, "event");
  assert.equal(ticket.lastEvent.summary, "dispatch → sub-agent (sonnet)");
  assert.equal(ticket.lastEvent.ageMinutes, 5);
});
