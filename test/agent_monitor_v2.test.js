import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { appendEvent, agentMonitorV2, appendHeartbeat } from "../server/events.js";

// FBMCPF-145 — agent monitor v2: live sessions, stalls, spend.
//
// v1's computeActiveWork (metadata.js, tested in agent_monitor.test.js) stays
// as the cheaper "cumulative work + idle hours" view. agentMonitorV2 is the
// richer per-ticket snapshot the get_agent_monitor tool and the board's stall
// banner read: elapsed time since a ticket went In Progress (from the
// ticket_events.jsonl audit log), its last event (audit or work-log,
// whichever is newer) with age, token spend vs a cap:<tokens> label, spend
// ratio, and a stalled flag driven by a configurable inactivity threshold.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-monitor-v2-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

/** Write raw, timestamp-controlled lines directly into agent_work_log.md
 *  (same trick test/events.test.js uses for ticket_events.jsonl) so tests
 *  don't depend on wall-clock "now" from logWork's own stamp(). */
function writeWorkLog(board, project, date, lines) {
  const p = path.join(board.projectDir(project), "agent_work_log.md");
  const body = `## [${date}]\n` + lines.join("\n") + "\n";
  fs.writeFileSync(p, body, "utf8");
}

test("elapsed time (from the status event), last event + age, spend vs cap:* label, and spend ratio", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Build the thing", labels: ["cap:80k"] });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  // fabricate the authoritative "went In Progress" event, appended after the
  // real one from setStatus so it wins as the most recent status event
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T10:00:00" });
  writeWorkLog(b, "Proj", "2030-01-01", [
    `2030-01-01 10:20:00, made progress, Task: ${t.ticketNumber}, Add: 10, Del: 2, tokens: 20000, model: sonnet`,
    `2030-01-01 10:40:00, more progress, Task: ${t.ticketNumber}, Add: 5, Del: 1, tokens: 15000, model: sonnet`,
  ]);

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T11:00:00" });
  assert.equal(r.count, 1);
  const ticket = r.tickets[0];
  assert.equal(ticket.ticket, t.ticketNumber);
  assert.equal(ticket.startedAtSource, "status_event");
  assert.equal(ticket.elapsedMinutes, 60); // 10:00 -> 11:00
  assert.equal(ticket.lastEvent.kind, "work_log");
  assert.equal(ticket.lastEvent.summary, "more progress");
  assert.equal(ticket.lastEvent.ageMinutes, 20); // 10:40 -> 11:00
  assert.equal(ticket.spend, 35000);
  assert.equal(ticket.cap, 80000); // cap:80k label parsed
  assert.equal(ticket.spendRatio, 0.438); // 35000/80000, rounded to 3dp
  assert.equal(ticket.stalled, false); // 20min idle < default 30min threshold

  assert.equal(r.totalSpend, 35000);
  assert.equal(r.totalCap, 80000);
  assert.equal(r.stalledCount, 0);
  assert.deepEqual(r.stalledTickets, []);
});

test("a ticket with no cap:* label has a null cap and null spend ratio", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No cap set" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  writeWorkLog(b, "Proj", "2030-01-01", [
    `2030-01-01 10:00:00, working, Task: ${t.ticketNumber}, tokens: 5000`,
  ]);
  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:05:00" });
  const ticket = r.tickets[0];
  assert.equal(ticket.cap, null);
  assert.equal(ticket.spendRatio, null);
  assert.equal(ticket.spend, 5000);
});

test("stall detection respects a configurable threshold, both under and over", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Idling ticket" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T09:00:00" });
  writeWorkLog(b, "Proj", "2030-01-01", [
    `2030-01-01 09:15:00, last touch, Task: ${t.ticketNumber}, tokens: 1000`,
  ]);
  const asOf = "2030-01-01T10:00:00"; // 45min after last touch

  const withDefault = agentMonitorV2(b, "Proj", { asOf }); // default 30min
  assert.equal(withDefault.tickets[0].stalled, true);
  assert.equal(withDefault.stalledCount, 1);
  assert.equal(withDefault.stalledTickets.length, 1);
  assert.equal(withDefault.stalledTickets[0].ticket, t.ticketNumber);
  assert.equal(withDefault.stalledTickets[0].ageMinutes, 45);

  const withLongerThreshold = agentMonitorV2(b, "Proj", { asOf, stallMinutes: 60 });
  assert.equal(withLongerThreshold.tickets[0].stalled, false);
  assert.equal(withLongerThreshold.stalledCount, 0);

  // stallHours is accepted as a back-compat alias, converted to minutes
  const viaHours = agentMonitorV2(b, "Proj", { asOf, stallHours: 1 }); // 60min
  assert.equal(viaHours.tickets[0].stalled, false);
});

test("falls back gracefully when there is no recorded status event (pre-audit-trail ticket)", () => {
  const b = tmpBoard();
  // created directly In Progress, bypassing setStatus entirely — no
  // ticket_events.jsonl entry at all for this ticket, simulating a board
  // that predates FBMCPF-142 or a ticket never mutated through setStatus.
  const t = b.addTask("Proj", "feature", { title: "Legacy in-progress ticket", status: "In Progress" });
  writeWorkLog(b, "Proj", "2030-01-01", [
    `2030-01-01 08:00:00, earliest touch, Task: ${t.ticketNumber}, tokens: 2000`,
    `2030-01-01 08:30:00, latest touch, Task: ${t.ticketNumber}, tokens: 3000`,
  ]);
  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T09:00:00" });
  assert.equal(r.count, 1);
  const ticket = r.tickets[0];
  // falls back to the earliest work-log entry as a proxy for when work began
  assert.equal(ticket.startedAtSource, "work_log_fallback");
  assert.equal(ticket.startedAt, "2030-01-01T08:00:00");
  assert.equal(ticket.elapsedMinutes, 60);
  assert.equal(ticket.lastEvent.kind, "work_log");
  assert.equal(ticket.lastEvent.summary, "latest touch");
  assert.equal(ticket.spend, 5000);
});

test("a ticket with neither events nor work log falls back to createdDate and is stalled (never touched)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Untouched", status: "In Progress" });
  const r = agentMonitorV2(b, "Proj", {});
  assert.equal(r.count, 1);
  const ticket = r.tickets[0];
  assert.equal(ticket.startedAtSource, "created_date_fallback");
  assert.equal(ticket.lastEvent, null);
  assert.equal(ticket.stalled, true);
  assert.equal(r.stalledCount, 1);
  assert.equal(r.stalledTickets[0].ageMinutes, null);
});

test("board / project with no ticket_events.jsonl file at all is handled without error", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Fresh board", status: "In Progress" });
  // no ticket_events.jsonl has ever been written for this project
  assert.doesNotThrow(() => agentMonitorV2(b, "Proj", {}));
  const r = agentMonitorV2(b, "Proj", {});
  assert.equal(r.count, 1);
  assert.equal(r.project, "Proj");
});

test("sorts most-recently-active first and rolls up totals across multiple tickets", () => {
  const b = tmpBoard();
  const t1 = b.addTask("Proj", "feature", { title: "Stale one", labels: ["cap:10k"], status: "In Progress" });
  const t2 = b.addTask("Proj", "feature", { title: "Fresh one", labels: ["cap:20k"], status: "In Progress" });
  writeWorkLog(b, "Proj", "2030-01-01", [
    `2030-01-01 08:00:00, old work, Task: ${t1.ticketNumber}, tokens: 4000`,
    `2030-01-01 09:50:00, recent work, Task: ${t2.ticketNumber}, tokens: 6000`,
  ]);
  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:00:00" });
  assert.equal(r.count, 2);
  assert.equal(r.tickets[0].ticket, t2.ticketNumber); // 10min idle, most recent
  assert.equal(r.tickets[1].ticket, t1.ticketNumber); // 2h idle
  assert.equal(r.totalSpend, 10000);
  assert.equal(r.totalCap, 30000);
});

test("only In Progress tickets are included — Todo/Done tickets are excluded", () => {
  const b = tmpBoard();
  b.addTask("Proj", "feature", { title: "Still Todo" });
  const inProg = b.addTask("Proj", "feature", { title: "Working on it", status: "In Progress" });
  const done = b.addTask("Proj", "feature", { title: "Finished", status: "In Progress" });
  b.setStatus("Proj", done.ticketNumber, "Done");
  const r = agentMonitorV2(b, "Proj", {});
  assert.equal(r.count, 1);
  assert.equal(r.tickets[0].ticket, inProg.ticketNumber);
});


// FBMCPB-15 — heartbeats surfaced through agentMonitorV2: lastHeartbeat per
// ticket, heartbeats counting as "activity" for stall detection, and
// capModel inference falling back to a heartbeat's model when there is no
// model:* label or work-log entry yet (e.g. before a sub-agent's first
// log_work call).

test("agentMonitorV2 exposes a ticket's latest heartbeat (note/model/elapsed/spend/age)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Long dispatch" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T10:00:00" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "reading affected files", model: "sonnet", elapsedMinutes: 1, spend: 3000, ts: "2030-01-01T10:03:00" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "wrote the fix, running tests", model: "sonnet", elapsedMinutes: 6, spend: 12000, ts: "2030-01-01T10:08:00" });

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:10:00" });
  const ticket = r.tickets[0];
  assert.ok(ticket.lastHeartbeat);
  assert.equal(ticket.lastHeartbeat.note, "wrote the fix, running tests");
  assert.equal(ticket.lastHeartbeat.model, "sonnet");
  assert.equal(ticket.lastHeartbeat.elapsedMinutes, 6);
  assert.equal(ticket.lastHeartbeat.spend, 12000);
  assert.equal(ticket.lastHeartbeat.ageMinutes, 2); // 10:08 -> 10:10
});

test("a heartbeat counts as activity: lastEvent reflects it and a ticket with only heartbeats (no status/work-log event) is not stalled", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Heartbeat only" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T10:00:00" });
  // no work-log entries at all yet — only a heartbeat, 5 minutes before "now"
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "still going", ts: "2030-01-01T10:20:00" });

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:25:00" });
  const ticket = r.tickets[0];
  assert.equal(ticket.lastEvent.kind, "heartbeat");
  assert.equal(ticket.lastEvent.summary, "still going");
  assert.equal(ticket.lastEvent.ageMinutes, 5);
  assert.equal(ticket.stalled, false); // 5min idle < default 30min threshold
});

test("a heartbeat newer than the status event still leaves a ticket stalled once its own age exceeds the threshold", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Stale heartbeat" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "set_status", ts: "2030-01-01T08:00:00" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "long since gone quiet", ts: "2030-01-01T08:10:00" });

  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T09:00:00" }); // 50min after the heartbeat
  const ticket = r.tickets[0];
  assert.equal(ticket.lastEvent.kind, "heartbeat");
  assert.equal(ticket.stalled, true);
  assert.equal(r.stalledCount, 1);
});

test("capModel falls back to a heartbeat's model when there is no model:* label or work-log entry yet", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No work-log yet", labels: ["cap:10000"] });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "just started", model: "opus" });

  const r = agentMonitorV2(b, "Proj", {});
  const ticket = r.tickets[0];
  assert.equal(ticket.cap, 10000);
  // capCost is only computable once a model can be inferred — here, solely
  // from the heartbeat (no model:* label, no work-log entries at all).
  assert.ok(ticket.capCost != null);
});

test("a ticket with no heartbeats at all has lastHeartbeat null (back-compat, unaffected by FBMCPB-15)", () => {
  const b = tmpBoard();
  b.addTask("Proj", "feature", { title: "No heartbeats", status: "In Progress" });
  const r = agentMonitorV2(b, "Proj", {});
  assert.equal(r.tickets[0].lastHeartbeat, null);
});
