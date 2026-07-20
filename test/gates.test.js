import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig, logTestRun, logWork } from "../server/metadata.js";
import { addReviewComment, resolveReviewComment } from "../server/reviews.js";
import { evaluateDoneGates } from "../server/gates.js";

// FBMCPF-215 — configurable Done gates.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgates-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("no doneGates config → no gate", () => {
  const b = tmpBoard();
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-1").refuse, false);
});

test("requireResolvedReview blocks until comments are resolved", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { doneGates: { requireResolvedReview: true } });
  const c = addReviewComment(b, "Proj", "FBF-1", { comment: "tighten this" });
  const g = evaluateDoneGates(b, "Proj", "FBF-1");
  assert.equal(g.refuse, true);
  assert.match(g.error, /unresolved review/);
  resolveReviewComment(b, "Proj", c.id);
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-1").refuse, false);
});

test("requirePassingTest blocks until a passing run for the ticket is logged", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { doneGates: { requirePassingTest: true } });
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-2").refuse, true);
  logTestRun(b, "Proj", { passed: 3, failed: 1, ticket: "FBF-2" });
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-2").refuse, true, "failing run does not satisfy the gate");
  logTestRun(b, "Proj", { passed: 4, failed: 0, ticket: "FBF-2" });
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-2").refuse, false);
});

test("requireWorkLog blocks until log_work records the ticket", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { doneGates: { requireWorkLog: true } });
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-3").refuse, true);
  logWork(b, "Proj", { ticket: "FBF-3", summary: "did the thing", additions: 5, deletions: 1 });
  assert.equal(evaluateDoneGates(b, "Proj", "FBF-3").refuse, false);
});

test("multiple gates report every missing precondition", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { doneGates: { requirePassingTest: true, requireWorkLog: true } });
  const g = evaluateDoneGates(b, "Proj", "FBF-4");
  assert.equal(g.refuse, true);
  assert.equal(g.missing.length, 2);
});
