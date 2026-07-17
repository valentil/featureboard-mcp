import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { appendEvent, readEvents, appendHeartbeat, readHeartbeats } from "../server/events.js";
import { logWork, readWorkLog } from "../server/metadata.js";

// FBMCPF-162 — mtime-keyed parse caches added to storage.js (featurelist.md/
// buglist.md), events.js (ticket_events.jsonl/heartbeats.jsonl), and
// metadata.js (agent_work_log.md). These tests exist to make cache
// invalidation bugs loud: every mutating path that goes through a cached
// reader must see its own write immediately (write-through), and a file
// changed by something other than this process (a different mtime/size)
// must never serve stale cached data (mtime+size defense layer).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-perfcache-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// --- storage.js: read-after-write freshness across every mutating path ----

test("listTasks sees a freshly addTask'd ticket immediately (no stale cache)", () => {
  const b = tmpBoard();
  assert.equal(b.listTasks("Proj", {}).length, 0);
  b.addTask("Proj", "feature", { title: "One" });
  assert.equal(b.listTasks("Proj", {}).length, 1);
  b.addTask("Proj", "bug", { title: "Two" });
  assert.equal(b.listTasks("Proj", {}).length, 2);
  // interleaved reads between writes must never see a stale count
  b.addTask("Proj", "feature", { title: "Three" });
  assert.equal(b.listTasks("Proj", {}).length, 3);
});

test("getTask sees an updateTask'd title immediately", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Original" });
  // warm the cache with a read before mutating
  assert.equal(b.getTask("Proj", t.ticketNumber).title, "Original");
  b.updateTask("Proj", t.ticketNumber, { title: "Renamed" });
  assert.equal(b.getTask("Proj", t.ticketNumber).title, "Renamed");
});

test("getTask sees a setStatus change immediately, including via listTasks", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  b.listTasks("Proj", {}); // warm cache
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "In Progress");
  assert.equal(b.listTasks("Proj", { status: "In Progress" }).length, 1);
  b.setStatus("Proj", t.ticketNumber, "Done", "shipped it");
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "Done");
  assert.equal(b.listTasks("Proj", { status: "In Progress" }).length, 0);
});

test("deleteTask removes the ticket from listTasks immediately", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Gone soon" });
  b.getTask("Proj", t.ticketNumber); // warm cache
  assert.equal(b.listTasks("Proj", {}).length, 1);
  b.deleteTask("Proj", t.ticketNumber);
  assert.equal(b.listTasks("Proj", {}).length, 0);
  assert.equal(b.getTask("Proj", t.ticketNumber), null);
});

test("linkTasks change is visible on the next getTask", () => {
  const b = tmpBoard();
  const t1 = b.addTask("Proj", "feature", { title: "A" });
  const t2 = b.addTask("Proj", "bug", { title: "B" });
  b.getTask("Proj", t1.ticketNumber); // warm cache
  b.linkTasks("Proj", t1.ticketNumber, t2.ticketNumber);
  assert.equal(b.getTask("Proj", t1.ticketNumber).linkedIssue, t2.ticketNumber);
});

test("repairDuplicateTickets' renumbering is visible immediately (not dryRun)", () => {
  const b = tmpBoard();
  const dir = b.projectDir("Proj");
  // hand-craft a duplicate id the normal API would never produce
  const dup = [
    "# Feature List",
    "- [ ] [FBF-1] **First**: d [Created: 2026-01-01]",
    "- [ ] [FBF-1] **Duplicate**: d [Created: 2026-01-01]",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "featurelist.md"), dup, "utf8");
  b.listTasks("Proj", {}); // warm cache with the duplicated state
  const dupes = b.findDuplicateTickets("Proj");
  assert.equal(dupes.length, 1);
  b.repairDuplicateTickets("Proj", { dryRun: false });
  const tasks = b.listTasks("Proj", {}).map((t) => t.ticketNumber).sort();
  assert.equal(new Set(tasks).size, tasks.length, "no duplicate ids after repair, read fresh not cached");
});

// --- events.js: read-after-write freshness ---------------------------------

test("readEvents sees an appendEvent immediately, across repeated appends", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  assert.equal(readEvents(b, "Proj").length, 0);
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "test" });
  assert.equal(readEvents(b, "Proj").length, 1);
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "In Progress", to: "Done", source: "test" });
  const events = readEvents(b, "Proj");
  assert.equal(events.length, 2);
  assert.equal(events[1].to, "Done");
});

test("readHeartbeats sees an appendHeartbeat immediately, across repeated appends", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  assert.equal(readHeartbeats(b, "Proj").length, 0);
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "starting" });
  assert.equal(readHeartbeats(b, "Proj").length, 1);
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "still going" });
  const hbs = readHeartbeats(b, "Proj");
  assert.equal(hbs.length, 2);
  assert.equal(hbs[1].note, "still going");
});

// --- metadata.js: work-log read-after-write freshness -----------------------

test("readWorkLog sees a logWork entry immediately, across repeated appends", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  assert.equal(readWorkLog(b, "Proj").length, 0);
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "did a thing", additions: 5, deletions: 1, tokens: 100 });
  assert.equal(readWorkLog(b, "Proj").length, 1);
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "did another thing", additions: 3, deletions: 0, tokens: 50 });
  const log = readWorkLog(b, "Proj");
  assert.equal(log.length, 2);
  assert.equal(log[1].text, "did another thing");
});

// --- mtime/size defense layer: a file changed OUTSIDE this process's write
// paths (simulated with a direct fs write + an explicit distant mtime) must
// never serve the previously-cached, now-stale content. ----------------------

function touchWithDistinctMtime(filePath) {
  // Push the mtime meaningfully into the future so this is robust even on a
  // filesystem with coarse (e.g. 1s) mtime resolution — a same-tick write
  // would otherwise risk a false cache hit.
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  fs.utimesSync(filePath, future, future);
}

test("board markdown: an external rewrite with a distinct mtime is not served stale", () => {
  const b = tmpBoard();
  const dir = b.projectDir("Proj");
  const featPath = path.join(dir, "featurelist.md");
  b.addTask("Proj", "feature", { title: "Original" });
  assert.equal(b.listTasks("Proj", {}).length, 1); // warms the cache

  // bypass Board entirely — simulate another process/tool editing the file
  const rewritten = [
    "# Feature List",
    "- [ ] [FBF-1] **Externally edited**: replaced entirely [Created: 2026-01-01]",
    "- [ ] [FBF-2] **Brand new**: added externally [Created: 2026-01-01]",
    "",
  ].join("\n");
  fs.writeFileSync(featPath, rewritten, "utf8");
  touchWithDistinctMtime(featPath);

  const tasks = b.listTasks("Proj", {});
  assert.equal(tasks.length, 2, "must reflect the external rewrite, not the cached single-task state");
  assert.ok(tasks.some((t) => t.title === "Externally edited"));
  assert.ok(tasks.some((t) => t.title === "Brand new"));
});

test("ticket_events.jsonl: an external append with a distinct mtime is not served stale", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  appendEvent(b, "Proj", { ticket: t.ticketNumber, field: "status", from: "Todo", to: "In Progress", source: "test" });
  assert.equal(readEvents(b, "Proj").length, 1); // warms the cache

  const p = path.join(b.projectDir("Proj"), "ticket_events.jsonl");
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ticket: t.ticketNumber, field: "status", from: "In Progress", to: "Done", source: "external" }) + "\n", "utf8");
  touchWithDistinctMtime(p);

  const events = readEvents(b, "Proj");
  assert.equal(events.length, 2, "must reflect the externally-appended event, not the cached single-event state");
  assert.equal(events[1].source, "external");
});

test("heartbeats.jsonl: an external append with a distinct mtime is not served stale", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  appendHeartbeat(b, "Proj", { ticket: t.ticketNumber, note: "first" });
  assert.equal(readHeartbeats(b, "Proj").length, 1); // warms the cache

  const p = path.join(b.projectDir("Proj"), "heartbeats.jsonl");
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ticket: t.ticketNumber, note: "external" }) + "\n", "utf8");
  touchWithDistinctMtime(p);

  const hbs = readHeartbeats(b, "Proj");
  assert.equal(hbs.length, 2, "must reflect the externally-appended heartbeat, not the cached single-heartbeat state");
  assert.equal(hbs[1].note, "external");
});

test("agent_work_log.md: an external rewrite with a distinct mtime is not served stale", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "first", tokens: 10 });
  assert.equal(readWorkLog(b, "Proj").length, 1); // warms the cache

  const p = path.join(b.projectDir("Proj"), "agent_work_log.md");
  const existing = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, existing + "2026-01-02 00:00:00, external entry, Task: " + t.ticketNumber + ", tokens: 5\n", "utf8");
  touchWithDistinctMtime(p);

  const log = readWorkLog(b, "Proj");
  assert.equal(log.length, 2, "must reflect the externally-appended work-log line, not the cached single-entry state");
  assert.equal(log[1].text, "external entry");
});

// --- mtime resolution edge case: same-tick external overwrite still caught
// via the size component of the cache key (no utimesSync here) -------------

test("board markdown: a same-instant external rewrite that changes size is still detected", () => {
  const b = tmpBoard();
  const dir = b.projectDir("Proj");
  const featPath = path.join(dir, "featurelist.md");
  b.addTask("Proj", "feature", { title: "Original" });
  assert.equal(b.listTasks("Proj", {}).length, 1); // warms the cache

  // No utimesSync — relies purely on the size half of the mtime+size key,
  // exercising the case where mtime resolution can't distinguish the writes.
  const stat0 = fs.statSync(featPath);
  fs.appendFileSync(featPath, "- [ ] [FBF-2] **Second**: added [Created: 2026-01-01]\n", "utf8");
  const stat1 = fs.statSync(featPath);
  assert.notEqual(stat0.size, stat1.size, "sanity: the append must change the file size");

  const tasks = b.listTasks("Proj", {});
  assert.equal(tasks.length, 2, "size change alone must bust the cache even if mtime resolution didn't tick");
});
