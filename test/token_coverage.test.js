import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork, computeHealth } from "../server/metadata.js";

// FBMCPF-190 — token-telemetry coverage on get_health: the share of the 30 most
// recent work-log events that carry a numeric token count. tokens:null entries
// skew velocity/eval readouts (docs/EVIDENCE.md), so coverage flags how
// trustworthy the current token numbers are.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-token-coverage-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("tokenCoverage is null when there are no work-log events", () => {
  const b = tmpBoard();
  assert.equal(computeHealth(b, "Proj").tokenCoverage, null);
});

test("tokenCoverage is 100 when every recent event carries numeric tokens", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "a", tokens: 1000 });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "b", tokens: 2000 });
  assert.equal(computeHealth(b, "Proj").tokenCoverage, 100);
});

test("tokenCoverage is 0 when no recent event carries tokens", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "a", additions: 5 });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "b", additions: 3 });
  assert.equal(computeHealth(b, "Proj").tokenCoverage, 0);
});

test("tokenCoverage is the rounded percentage for a mix of recorded/omitted tokens", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "a", tokens: 100 });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "b" });          // no tokens
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "c", tokens: 300 });
  assert.equal(computeHealth(b, "Proj").tokenCoverage, 67); // 2/3 -> 67
});

test("tokenCoverage only measures the 30 most recent events (older gaps fall outside the window)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x" });
  logWork(b, "Proj", { ticket: t.ticketNumber, summary: "ancient, no tokens" }); // oldest
  for (let i = 0; i < 30; i++) {
    logWork(b, "Proj", { ticket: t.ticketNumber, summary: `w${i}`, tokens: 100 });
  }
  // 31 events total; the sole token-less one is outside the last-30 window
  assert.equal(computeHealth(b, "Proj").tokenCoverage, 100);
});
