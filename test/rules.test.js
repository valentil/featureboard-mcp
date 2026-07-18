import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { eventsForTicket } from "../server/events.js";
import { evaluateRules, matchesCondition, getRules } from "../server/rules.js";

// FBMCPF-196 — declarative automation rules (trigger -> condition -> action),
// evaluated inside tool handlers (no daemon). Each application logs a "rule"
// audit event and never breaks the triggering call.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-rules-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("matchesCondition: product/label/priority/to/age predicates", () => {
  const task = { product: "Core", labels: ["urgent"], priority: 2, createdDate: "2026-07-01" };
  assert.equal(matchesCondition({}, task), true, "empty condition always matches");
  assert.equal(matchesCondition({ product: "core" }, task), true, "case-insensitive product");
  assert.equal(matchesCondition({ product: "Website" }, task), false);
  assert.equal(matchesCondition({ label: "urgent" }, task), true);
  assert.equal(matchesCondition({ label: "later" }, task), false);
  assert.equal(matchesCondition({ priority: 2 }, task), true);
  assert.equal(matchesCondition({ priority: { lte: 3 } }, task), true);
  assert.equal(matchesCondition({ priority: { lte: 1 } }, task), false);
  assert.equal(matchesCondition({ to: "Done" }, task, { to: "Done" }), true);
  assert.equal(matchesCondition({ to: "Done" }, task, { to: "In Progress" }), false);
  assert.equal(matchesCondition({ ageDaysGte: 5 }, task, { now: "2026-07-16" }), true);
  assert.equal(matchesCondition({ ageDaysGte: 30 }, task, { now: "2026-07-16" }), false);
});

test("getRules filters out malformed rules and unknown triggers", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { rules: [
    { trigger: "ticket-created", action: { type: "warn" } },
    { trigger: "nonsense", action: { type: "warn" } },
    { trigger: "status-change" }, // no action
    null,
  ] });
  const rules = getRules(b, "Proj");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].trigger, "ticket-created");
});

test("ticket-created set-label applies the label and logs a rule event", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { rules: [
    { name: "tag-core", trigger: "ticket-created", condition: { product: "Core" }, action: { type: "set-label", label: "triage" } },
  ] });
  const t = b.addTask("Proj", "feature", { title: "x", product: "Core" });
  const res = evaluateRules(b, "Proj", { trigger: "ticket-created", ticket: t.ticketNumber });
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].label, "triage");
  assert.ok(b.getTask("Proj", t.ticketNumber).labels.includes("triage"));
  const evs = eventsForTicket(b, "Proj", t.ticketNumber).filter((e) => e.field === "rule");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].to, "set-label");
});

test("status-change set-priority fires only when the condition (to:Done) matches", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { rules: [
    { trigger: "status-change", condition: { to: "Done" }, action: { type: "set-priority", priority: 5 } },
  ] });
  const t = b.addTask("Proj", "feature", { title: "x" });
  // wrong target status -> no fire
  const miss = evaluateRules(b, "Proj", { trigger: "status-change", ticket: t.ticketNumber, to: "In Progress" });
  assert.equal(miss.applied.length, 0);
  // matching -> fires
  const hit = evaluateRules(b, "Proj", { trigger: "status-change", ticket: t.ticketNumber, to: "Done" });
  assert.equal(hit.applied.length, 1);
  assert.equal(b.getTask("Proj", t.ticketNumber).priority, 5);
});

test("assign-sprint replaces any existing sprint label", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { rules: [
    { trigger: "ticket-created", action: { type: "assign-sprint", sprint: "S2" } },
  ] });
  const t = b.addTask("Proj", "feature", { title: "x", labels: ["sprint:S1", "keep"] });
  evaluateRules(b, "Proj", { trigger: "ticket-created", ticket: t.ticketNumber });
  const labels = b.getTask("Proj", t.ticketNumber).labels;
  assert.ok(labels.includes("sprint:S2"));
  assert.ok(!labels.includes("sprint:S1"));
  assert.ok(labels.includes("keep"));
});

test("warn returns a warning; notify-slack calls the injected notify", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { rules: [
    { trigger: "status-change", action: { type: "warn", message: "needs review" } },
    { trigger: "status-change", action: { type: "notify-slack", message: "shipped" } },
  ] });
  const t = b.addTask("Proj", "feature", { title: "x" });
  const sent = [];
  const res = evaluateRules(b, "Proj", { trigger: "status-change", ticket: t.ticketNumber, to: "Done" }, { notify: (m) => sent.push(m) });
  assert.deepEqual(res.warnings, ["needs review"]);
  assert.deepEqual(sent, ["shipped"]);
});

test("no rules configured -> no-op, empty result", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "x" });
  const res = evaluateRules(b, "Proj", { trigger: "ticket-created", ticket: t.ticketNumber });
  assert.deepEqual(res, { applied: [], warnings: [] });
});
