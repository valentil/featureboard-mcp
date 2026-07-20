import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { createSprint, activeSprintName, autoAssignSprintFields } from "../server/sprints.js";

// FBMCPF-219 — sprint auto-assign policy.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbspr-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("activeSprintName prefers a dated sprint spanning today, else latest undated", () => {
  const b = tmpBoard();
  assert.equal(activeSprintName(b, "Proj"), null);
  createSprint(b, "Proj", { name: "W30", start: "2026-07-20", end: "2026-07-26" });
  createSprint(b, "Proj", { name: "Backlog" });
  assert.equal(activeSprintName(b, "Proj", "2026-07-21"), "W30");
  assert.equal(activeSprintName(b, "Proj", "2026-08-05"), "Backlog");
});

test("off by default; priority mode only assigns P<=2; explicit sprint wins", () => {
  const b = tmpBoard();
  createSprint(b, "Proj", { name: "W30", start: "2026-01-01", end: "2099-01-01" });
  // default off
  assert.equal(autoAssignSprintFields(b, "Proj", { title: "x", priority: 1 }).autoSprint, null);
  setProjectConfig(b, "Proj", { sprintAutoAssign: "priority" });
  const hi = autoAssignSprintFields(b, "Proj", { title: "x", priority: 1 });
  assert.equal(hi.autoSprint, "W30");
  assert.ok(hi.fields.labels.includes("sprint:W30"));
  assert.equal(autoAssignSprintFields(b, "Proj", { title: "x", priority: 5 }).autoSprint, null);
  assert.equal(autoAssignSprintFields(b, "Proj", { title: "x" }).autoSprint, null);
  const explicit = autoAssignSprintFields(b, "Proj", { title: "x", priority: 1, labels: ["sprint:W99"] });
  assert.equal(explicit.autoSprint, null);
  assert.deepEqual(explicit.fields.labels, ["sprint:W99"]);
});

test("all mode assigns regardless of priority", () => {
  const b = tmpBoard();
  createSprint(b, "Proj", { name: "W30", start: "2026-01-01", end: "2099-01-01" });
  setProjectConfig(b, "Proj", { sprintAutoAssign: "all" });
  assert.equal(autoAssignSprintFields(b, "Proj", { title: "x" }).autoSprint, "W30");
});
