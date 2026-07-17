import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork, readWorkLog, velocity, findDuplicateWorkEntry } from "../server/metadata.js";

// FBMCPB-21 — work-log double-count guard.
//
// The recommended close-out is set_status Done (which writes a metrics line
// when given additions/deletions) and THEN log_work. When both carry identical
// additions/deletions for the same ticket on the same day, velocity counted the
// one event twice (this is what happened to FBMCPB-17: two 241/2 lines -> 482/4).
// findDuplicateWorkEntry flags the second write so the log_work tool can attach
// a non-blocking `duplicateSuspected` warning.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dupcount-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("set_status Done metrics + an identical log_work are flagged as a suspected duplicate", () => {
  const b = tmpBoard();
  // first writer: the set_status Done metadata path
  logWork(b, "Proj", { ticket: "FBB-1", summary: "Completed FBB-1", additions: 241, deletions: 2, model: "fable" });
  // second writer: a redundant log_work with the same numbers, checked BEFORE it is appended
  const entry = { ticket: "FBB-1", summary: "same work, logged again", additions: 241, deletions: 2, model: "fable" };
  const dup = findDuplicateWorkEntry(b, "Proj", entry);
  assert.ok(dup, "the earlier identical entry should be detected");
  assert.equal(dup.additions, 241);
  assert.equal(dup.deletions, 2);
});

test("distinct numbers for the same ticket/day are NOT flagged (legit multi-session work)", () => {
  const b = tmpBoard();
  logWork(b, "Proj", { ticket: "FBB-2", summary: "session 1", additions: 10, deletions: 1 });
  const dup = findDuplicateWorkEntry(b, "Proj", { ticket: "FBB-2", summary: "session 2", additions: 40, deletions: 3 });
  assert.equal(dup, null);
});

test("an entry carrying no additions/deletions is never flagged", () => {
  const b = tmpBoard();
  logWork(b, "Proj", { ticket: "FBB-3", summary: "note", tokens: 100 });
  const dup = findDuplicateWorkEntry(b, "Proj", { ticket: "FBB-3", summary: "another note", tokens: 200 });
  assert.equal(dup, null);
});

test("velocity single-counts when guarded, double-counts when the duplicate is kept", () => {
  const b = tmpBoard();
  // one metrics line -> counted once
  logWork(b, "Proj", { ticket: "FBB-4", summary: "metrics via set_status", additions: 100, deletions: 5 });
  const v1 = velocity(readWorkLog(b, "Proj"));
  assert.equal(v1.totals.additions, 100);
  assert.equal(v1.totals.deletions, 5);
  // the guard would catch a second identical write
  const dup = findDuplicateWorkEntry(b, "Proj", { ticket: "FBB-4", additions: 100, deletions: 5 });
  assert.ok(dup, "identical second write is a suspected duplicate");
  // if appended anyway, velocity now double-counts -- the very bug this guards
  logWork(b, "Proj", { ticket: "FBB-4", summary: "metrics via log_work", additions: 100, deletions: 5 });
  const v2 = velocity(readWorkLog(b, "Proj"));
  assert.equal(v2.totals.additions, 200);
  assert.equal(v2.totals.deletions, 10);
});
