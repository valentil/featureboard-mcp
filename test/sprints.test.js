import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { createSprint, listSprints, assignSprint, sprintOfTask } from "../server/sprints.js";
import { getProjectConfig } from "../server/metadata.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("sprintOfTask reads the sprint label case-insensitively", () => {
  assert.equal(sprintOfTask({ labels: ["Core", "sprint:Sprint 1"] }), "Sprint 1");
  assert.equal(sprintOfTask({ labels: ["SPRINT:2026-W29"] }), "2026-W29");
  assert.equal(sprintOfTask({ labels: ["Core"] }), null);
  assert.equal(sprintOfTask({}), null);
});

test("createSprint persists the registry in project config and validates input", () => {
  const b = tmpBoard();
  const s = createSprint(b, "Proj", { name: "Sprint 1", start: "2026-07-20", end: "2026-07-31", goal: "Ship it" });
  assert.equal(s.name, "Sprint 1");
  const cfg = getProjectConfig(b, "Proj");
  assert.equal(cfg.sprints.length, 1);
  assert.equal(cfg.sprints[0].start, "2026-07-20");
  // update, not duplicate (case-insensitive)
  createSprint(b, "Proj", { name: "sprint 1", end: "2026-08-01" });
  assert.equal(getProjectConfig(b, "Proj").sprints.length, 1);
  assert.equal(getProjectConfig(b, "Proj").sprints[0].end, "2026-08-01");
  assert.throws(() => createSprint(b, "Proj", { name: "bad:name" }), /cannot contain/);
  assert.throws(() => createSprint(b, "Proj", { name: "S2", start: "not-a-date" }), /Invalid date/);
  assert.throws(() => createSprint(b, "Proj", { name: "S2", start: "2026-08-02", end: "2026-08-01" }), /before its start/);
});

test("assignSprint sets/replaces/clears the sprint label and auto-registers", () => {
  const b = tmpBoard();
  const t1 = b.addTask("Proj", "feature", { title: "A", labels: ["Core"] });
  const t2 = b.addTask("Proj", "feature", { title: "B" });
  const r = assignSprint(b, "Proj", [t1.ticketNumber, t2.ticketNumber], "Sprint 1");
  assert.equal(r.updated.length, 2);
  assert.ok(b.getTask("Proj", t1.ticketNumber).labels.includes("sprint:Sprint 1"));
  assert.ok(b.getTask("Proj", t1.ticketNumber).labels.includes("Core")); // other labels kept
  assert.equal(getProjectConfig(b, "Proj").sprints[0].name, "Sprint 1"); // auto-registered
  // replace
  assignSprint(b, "Proj", [t1.ticketNumber], "Sprint 2");
  const labels = b.getTask("Proj", t1.ticketNumber).labels;
  assert.ok(labels.includes("sprint:Sprint 2"));
  assert.ok(!labels.some((l) => l === "sprint:Sprint 1"));
  // clear
  assignSprint(b, "Proj", [t1.ticketNumber], null);
  assert.equal(sprintOfTask(b.getTask("Proj", t1.ticketNumber)), null);
});

test("listSprints merges registry + label-only sprints with progress counts", () => {
  const b = tmpBoard();
  createSprint(b, "Proj", { name: "Sprint 1", start: "2026-07-20" });
  const t1 = b.addTask("Proj", "feature", { title: "A", labels: ["sprint:Sprint 1"] });
  b.addTask("Proj", "feature", { title: "B", labels: ["sprint:Sprint 1"] });
  b.addTask("Proj", "feature", { title: "C", labels: ["sprint:Label Only"] }); // written by the board UI
  b.addTask("Proj", "feature", { title: "backlog" });
  b.setStatus("Proj", t1.ticketNumber, "Done");
  const { sprints, backlogOpen } = listSprints(b, "Proj");
  const s1 = sprints.find((s) => s.name === "Sprint 1");
  const lo = sprints.find((s) => s.name === "Label Only");
  assert.equal(s1.total, 2);
  assert.equal(s1.done, 1);
  assert.equal(s1.todo, 1);
  assert.equal(s1.complete, false);
  assert.ok(lo, "label-only sprint surfaces");
  assert.equal(lo.total, 1);
  assert.equal(backlogOpen, 1);
});
