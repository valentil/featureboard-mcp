import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Board, localDateStr } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { getTimelineData } from "../server/events.js";

// FBMCPB-18 — piano-roll timeline data accuracy:
//   - createdDate/completionDate must be stamped from the LOCAL calendar day,
//     not derived from toISOString()'s UTC instant (which rolls the date
//     forward/back a day for any timezone offset from UTC).
//   - getTimelineData must prefer a precise event/work-log timestamp for a
//     Done ticket's span end over the coarse, date-only completionDate, and
//     must never let a Done span end land in the future.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-timeline-accuracy-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function spanFor(res, ticket) {
  return res.spans.find((s) => s.ticket === ticket);
}

test("localDateStr uses local Y/M/D components, not toISOString's UTC instant", () => {
  // Sanity-check within this process's own timezone: localDateStr must equal
  // the date built from the same Date object's local getters.
  const d = new Date(2026, 6, 16, 22, 0, 0); // local wall-clock: 2026-07-16, 10pm
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(localDateStr(d), expected);
});

test("late-evening local time does not roll the stamped date forward via UTC (FBMCPB-18 repro)", () => {
  // Reproduce the reported bug in an isolated child process pinned to a
  // timezone west of UTC (America/Los_Angeles, UTC-7 in July): at 22:00
  // local on 2026-07-16, the UTC instant is already 2026-07-17 05:00. The
  // old `new Date().toISOString().split("T")[0]` stamp would record
  // "2026-07-17" for a ticket closed at that local moment; localDateStr
  // must still record "2026-07-16".
  const storagePath = new URL("../server/storage.js", import.meta.url).href;
  const code =
    'import { localDateStr } from ' + JSON.stringify(storagePath) + ';\n' +
    'const d = new Date(2026, 6, 16, 22, 0, 0);\n' +
    'process.stdout.write(JSON.stringify({ local: localDateStr(d), utcSlice: d.toISOString().slice(0, 10) }));\n';
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, TZ: "America/Los_Angeles" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // Proves the bug: naive UTC-slice stamping lands on the wrong (next) day.
  assert.equal(out.utcSlice, "2026-07-17");
  // Proves the fix: the local-date helper stamps the correct (same) day.
  assert.equal(out.local, "2026-07-16");
});

test("addTask/setStatus stamp createdDate/completionDate via the local-date helper", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Stamped" });
  assert.equal(t.createdDate, localDateStr());
  const done = b.setStatus("Proj", t.ticketNumber, "Done", { completionSummary: "done" });
  assert.equal(done.completionDate, localDateStr());
});

test("Done span end prefers the status->Done event timestamp over date-only completionDate", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Precise finish" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  b.setStatus("Proj", t.ticketNumber, "Done", { completionSummary: "done" });

  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, t.ticketNumber);
  assert.equal(s.completedSource, "status_event");
  assert.equal(s.completedClamped, false);
  // The precise event timestamp carries a real time-of-day, not the coarse
  // "T23:59:59" end-of-day the date-only completionDate fallback would use.
  assert.ok(!s.completedAt.endsWith("T23:59:59"), "not the date-only fallback stamp");
});

test("Done span end falls back to the last work-log entry when there's no Done audit event", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No event trail" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "first", tokens: 50 });
  const last = logWork(b, "Proj", { ticket: t.ticketNumber, summary: "final push", tokens: 75 });
  // Simulate legacy/imported data: Done status with no completionDate and no
  // ticket_events.jsonl trail (bypassing setStatus, which would log both).
  b._mutate("Proj", t.ticketNumber, (task) => {
    task.status = "Done";
    task.completionDate = null;
    return task;
  });

  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, t.ticketNumber);
  assert.equal(s.completedSource, "work_log");
  assert.equal(s.completedAt, `${last.date}T${last.time}`);
});

test("a future-dated completionDate with no event/work-log trail is clamped to now", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Legacy import, bad date" });
  b._mutate("Proj", t.ticketNumber, (task) => {
    task.status = "Done";
    task.completionDate = "2099-01-01"; // already-stored future date, no repair on disk
    return task;
  });

  const asOf = "2026-07-16T20:00:00.000Z";
  const res = getTimelineData(b, "Proj", { asOf });
  const s = spanFor(res, t.ticketNumber);
  assert.equal(s.completedSource, "completion_date_clamped");
  assert.equal(s.completedClamped, true);
  assert.equal(s.completedAt, asOf, "clamped to \"now\" (opts.asOf), never left in the future");
  assert.ok(res.asOf, "asOf echoed back so the client can share one time basis for the now-line");
});

test("a Done event timestamp after opts.asOf is also clamped (defends against clock skew, not just completionDate)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Future event" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  b.setStatus("Proj", t.ticketNumber, "Done", { completionSummary: "done" });

  // Pin "now" earlier than the Done event that just got appended (simulates
  // a payload requested with a slightly-behind asOf, or clock skew).
  const asOf = "2020-01-01T00:00:00.000Z";
  const res = getTimelineData(b, "Proj", { asOf });
  const s = spanFor(res, t.ticketNumber);
  assert.equal(s.completedClamped, true);
  assert.equal(s.completedAt, asOf);
  assert.ok(s.completedSource.endsWith("_clamped"));
});

test("completedAt/completedSource/asOf are present in the payload for the timeline tooltip's finished-at display", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Tooltip data" });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  b.setStatus("Proj", t.ticketNumber, "Done", { completionSummary: "done" });

  const res = getTimelineData(b, "Proj");
  const s = spanFor(res, t.ticketNumber);
  assert.ok(res.asOf, "payload carries asOf");
  assert.ok(s.completedAt, "span carries completedAt");
  assert.ok("completedSource" in s, "span carries completedSource");
  assert.ok("completedClamped" in s, "span carries completedClamped");
});
