import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { scanBoardCleanup, dismissCleanupFinding, findingId } from "../server/cleanup.js";

// FBMCPF-204 — dismiss cleanup findings (append-only sidecar) so they stop
// reappearing on every scan, without deleting anything.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dismiss-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("findingId is stable and type-scoped", () => {
  assert.equal(findingId("stale", "FBF-1"), findingId("stale", "FBF-1"));
  assert.notEqual(findingId("stale", "FBF-1"), findingId("duplicate", "FBF-1"));
  assert.match(findingId("stale", "FBF-1"), /^[0-9a-f]{12}$/);
});

test("dismissCleanupFinding requires a findingId", () => {
  const b = tmpBoard();
  assert.throws(() => dismissCleanupFinding(b, "Proj", {}), /findingId is required/);
});

test("a dismissed finding is suppressed on rescan and counted", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "todo" }); // placeholder title -> stale finding

  let scan = scanBoardCleanup(b, "Proj");
  const finding = scan.stale.find((x) => x.ticket === t.ticketNumber);
  assert.ok(finding && finding.id, "finding carries a stable id");
  assert.equal(scan.dismissedCount, 0);

  const rec = dismissCleanupFinding(b, "Proj", { findingId: finding.id, reason: "intentional placeholder" });
  assert.equal(rec.id, finding.id);
  assert.equal(rec.reason, "intentional placeholder");

  scan = scanBoardCleanup(b, "Proj");
  assert.ok(!scan.stale.some((x) => x.ticket === t.ticketNumber), "dismissed finding no longer surfaces");
  assert.equal(scan.dismissedCount, 1);
});

test("dismissing one finding does not suppress a different ticket's finding", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "todo" });
  const c = b.addTask("Proj", "feature", { title: "tbd" });
  dismissCleanupFinding(b, "Proj", { findingId: findingId("stale", a.ticketNumber) });
  const scan = scanBoardCleanup(b, "Proj");
  assert.ok(!scan.stale.some((x) => x.ticket === a.ticketNumber));
  assert.ok(scan.stale.some((x) => x.ticket === c.ticketNumber), "unrelated finding still shows");
  assert.equal(scan.dismissedCount, 1);
});
