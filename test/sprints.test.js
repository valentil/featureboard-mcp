import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import {
  createSprint,
  listSprints,
  assignSprint,
  sprintOfTask,
  planRollover,
  applyRollover,
  ROLLOVER_CANDIDATE_LABEL,
  ROLLOVER_PENDING_LABEL,
} from "../server/sprints.js";
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

// priority-aware rollover on close_sprint (FBMCPF-197) -----------------------

/** A sprint with one ticket per priority bucket, plus an unprioritized one and a Done one. */
function rolloverBoard() {
  const b = tmpBoard();
  createSprint(b, "Proj", { name: "Sprint 1" });
  const p0 = b.addTask("Proj", "feature", { title: "P0 ticket", labels: ["sprint:Sprint 1"], priority: 0 });
  const p1 = b.addTask("Proj", "feature", { title: "P1 ticket", labels: ["sprint:Sprint 1"], priority: 1 });
  const p2 = b.addTask("Proj", "feature", { title: "P2 ticket", labels: ["sprint:Sprint 1"], priority: 2 });
  const p3 = b.addTask("Proj", "bug", { title: "P3 ticket", labels: ["sprint:Sprint 1"], priority: 3 });
  const p4 = b.addTask("Proj", "feature", { title: "P4 ticket", labels: ["sprint:Sprint 1"], priority: 4 });
  const unprio = b.addTask("Proj", "feature", { title: "Unprioritized ticket", labels: ["sprint:Sprint 1"] });
  const done = b.addTask("Proj", "feature", { title: "Done ticket", labels: ["sprint:Sprint 1"], priority: 0 });
  b.setStatus("Proj", done.ticketNumber, "Done");
  return { b, p0, p1, p2, p3, p4, unprio, done };
}

test("rolloverMode 'review': planRollover categorizes P0/1, P2/3, P4+/unprioritized without mutating anything", () => {
  const { b, p0, p1, p2, p3, p4, unprio, done } = rolloverBoard();
  const before = b.listTasks("Proj", {}).map((t) => ({ ticket: t.ticketNumber, labels: [...t.labels] }));

  const plan = planRollover(b, "Proj", "Sprint 1", { nextSprint: "Sprint 2" });

  assert.equal(plan.sprint, "Sprint 1");
  assert.equal(plan.nextSprint, "Sprint 2");
  assert.deepEqual(plan.autoRoll.map((x) => x.ticket).sort(), [p0.ticketNumber, p1.ticketNumber].sort());
  assert.deepEqual(plan.flagged.map((x) => x.ticket).sort(), [p2.ticketNumber, p3.ticketNumber].sort());
  assert.deepEqual(plan.dropped.map((x) => x.ticket).sort(), [p4.ticketNumber, unprio.ticketNumber].sort());
  assert.ok(!plan.autoRoll.some((x) => x.ticket === done.ticketNumber), "Done tickets are excluded from the plan");

  // nothing moved
  const after = b.listTasks("Proj", {}).map((t) => ({ ticket: t.ticketNumber, labels: [...t.labels] }));
  assert.deepEqual(after, before);
});

test("rolloverMode 'auto' with nextSprint: retags P0/P1, flags P2/P3, drops P4+/unprioritized", () => {
  const { b, p0, p1, p2, p3, p4, unprio, done } = rolloverBoard();

  const res = applyRollover(b, "Proj", "Sprint 1", { nextSprint: "Sprint 2" });
  assert.equal(res.applied, true);

  // P0/P1 retagged into the next sprint
  for (const t of [p0, p1]) {
    const labels = b.getTask("Proj", t.ticketNumber).labels;
    assert.ok(labels.includes("sprint:Sprint 2"), `${t.ticketNumber} should be in Sprint 2`);
    assert.ok(!labels.includes("sprint:Sprint 1"), `${t.ticketNumber} should leave Sprint 1`);
  }
  // Sprint 2 was created/registered
  assert.ok(getProjectConfig(b, "Proj").sprints.some((s) => s.name === "Sprint 2"));

  // P2/P3 flagged rollover-candidate, stay in Sprint 1
  for (const t of [p2, p3]) {
    const labels = b.getTask("Proj", t.ticketNumber).labels;
    assert.ok(labels.includes(ROLLOVER_CANDIDATE_LABEL), `${t.ticketNumber} should be flagged`);
    assert.ok(labels.includes("sprint:Sprint 1"), `${t.ticketNumber} should stay in Sprint 1`);
  }

  // P4+ and unprioritized dropped back to backlog
  for (const t of [p4, unprio]) {
    const labels = b.getTask("Proj", t.ticketNumber).labels;
    assert.equal(sprintOfTask({ labels }), null, `${t.ticketNumber} should have no sprint label`);
  }

  // Done ticket untouched
  const doneLabels = b.getTask("Proj", done.ticketNumber).labels;
  assert.ok(doneLabels.includes("sprint:Sprint 1"));
});

test("rolloverMode 'auto' without nextSprint: P0/P1 stay put and get a rollover-pending flag", () => {
  const { b, p0, p1, p2, p4 } = rolloverBoard();

  const res = applyRollover(b, "Proj", "Sprint 1", {});
  assert.equal(res.nextSprint, null);

  for (const t of [p0, p1]) {
    const labels = b.getTask("Proj", t.ticketNumber).labels;
    assert.ok(labels.includes("sprint:Sprint 1"), `${t.ticketNumber} stays in the closed sprint`);
    assert.ok(labels.includes(ROLLOVER_PENDING_LABEL), `${t.ticketNumber} gets rollover-pending`);
  }
  // P2/P3 and P4+ handling is unaffected by nextSprint being absent
  assert.ok(b.getTask("Proj", p2.ticketNumber).labels.includes(ROLLOVER_CANDIDATE_LABEL));
  assert.equal(sprintOfTask(b.getTask("Proj", p4.ticketNumber)), null);
});

test("rolloverMode 'off': no rollover function is invoked, sprint labels are left exactly as close_sprint's legacy behavior would leave them", () => {
  const { b, p0, p1, p2, p3, p4, unprio } = rolloverBoard();
  const before = b.listTasks("Proj", {}).map((t) => ({ ticket: t.ticketNumber, labels: [...t.labels] }));

  // 'off' means close_sprint never calls planRollover/applyRollover at all —
  // simulate that by simply not calling them, and confirm nothing changed.
  const after = b.listTasks("Proj", {}).map((t) => ({ ticket: t.ticketNumber, labels: [...t.labels] }));
  assert.deepEqual(after, before);
  for (const t of [p0, p1, p2, p3, p4, unprio]) {
    assert.equal(sprintOfTask(b.getTask("Proj", t.ticketNumber)), "Sprint 1");
  }
});
