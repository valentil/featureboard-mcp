import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setRequirements, getRequirements, checkAcceptance } from "../server/requirements.js";
import { getWorkPacket } from "../server/metadata.js";

// FBMCPF-138 — per-ticket requirements refinement (8090-Refinery style).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbreq-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("setRequirements → getRequirements round-trips", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Do a thing" });
  const summary = setRequirements(b, "Proj", t.ticketNumber, {
    intent: "Users can export a report.",
    assumptions: ["Report data already exists", "PDF is out of scope"],
    acceptanceCriteria: ["Export button is visible", "Clicking export downloads a CSV"],
    openQuestions: ["Which columns are included?"],
  });
  assert.equal(summary.ticket, t.ticketNumber);
  assert.equal(summary.acceptanceCriteria, 2);
  assert.equal(summary.assumptions, 2);
  assert.equal(summary.openQuestions, 1);
  assert.ok(summary.path.endsWith(path.join("requirements", `${t.ticketNumber}.md`)));
  assert.ok(fs.existsSync(summary.path), "pad file written");

  const parsed = getRequirements(b, "Proj", t.ticketNumber);
  assert.equal(parsed.intent, "Users can export a report.");
  assert.deepEqual(parsed.assumptions, ["Report data already exists", "PDF is out of scope"]);
  assert.deepEqual(parsed.acceptanceCriteria, [
    { text: "Export button is visible", done: false },
    { text: "Clicking export downloads a CSV", done: false },
  ]);
  assert.deepEqual(parsed.openQuestions, ["Which columns are included?"]);
  assert.match(parsed.raw, new RegExp(`^# ${t.ticketNumber} — requirements`));
});

test("setRequirements throws for a missing ticket", () => {
  const b = tmpBoard();
  assert.throws(() => setRequirements(b, "Proj", "FBF-999", { intent: "x" }), /not found/);
});

test("getRequirements returns null when no file exists", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No reqs yet" });
  assert.equal(getRequirements(b, "Proj", t.ticketNumber), null);
});

test("setRequirements tolerates string acceptance criteria and empty sections", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Minimal" });
  const s = setRequirements(b, "Proj", t.ticketNumber, { intent: "Just intent." });
  assert.equal(s.acceptanceCriteria, 0);
  const parsed = getRequirements(b, "Proj", t.ticketNumber);
  assert.equal(parsed.intent, "Just intent.");
  assert.deepEqual(parsed.assumptions, []);
  assert.deepEqual(parsed.acceptanceCriteria, []);
  assert.deepEqual(parsed.openQuestions, []);
});

test("checkAcceptance toggles the target criterion (1-based)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Toggle me" });
  setRequirements(b, "Proj", t.ticketNumber, {
    intent: "i",
    acceptanceCriteria: ["first", "second", "third"],
  });
  const r = checkAcceptance(b, "Proj", t.ticketNumber, 2, true);
  assert.equal(r.done, 1);
  assert.equal(r.total, 3);

  const parsed = getRequirements(b, "Proj", t.ticketNumber);
  assert.deepEqual(parsed.acceptanceCriteria.map((c) => c.done), [false, true, false]);
  assert.deepEqual(parsed.acceptanceCriteria.map((c) => c.text), ["first", "second", "third"]);

  // un-toggle
  checkAcceptance(b, "Proj", t.ticketNumber, 2, false);
  const again = getRequirements(b, "Proj", t.ticketNumber);
  assert.deepEqual(again.acceptanceCriteria.map((c) => c.done), [false, false, false]);
});

test("checkAcceptance rejects an out-of-range index and a missing file", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Range" });
  setRequirements(b, "Proj", t.ticketNumber, { intent: "i", acceptanceCriteria: ["only one"] });
  assert.throws(() => checkAcceptance(b, "Proj", t.ticketNumber, 5, true), /out of range/);

  const t2 = b.addTask("Proj", "feature", { title: "No file" });
  assert.throws(() => checkAcceptance(b, "Proj", t2.ticketNumber, 1, true), /No requirements/);
});

// Guarantee: checkAcceptance operates on the raw text, so a hand-added unknown
// section survives the rewrite verbatim (only the target checkbox marker moves).
test("hand-added unknown section survives a checkAcceptance rewrite", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Hand edited" });
  setRequirements(b, "Proj", t.ticketNumber, {
    intent: "i",
    acceptanceCriteria: ["ac one", "ac two"],
  });
  // A human appends an extra section the schema doesn't know about.
  const p = path.join(b.projectDir("Proj"), "requirements", `${t.ticketNumber}.md`);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8") + "\n## Design notes\n- keep it simple\n- reuse the exporter\n");

  checkAcceptance(b, "Proj", t.ticketNumber, 1, true);

  const raw = fs.readFileSync(p, "utf8");
  assert.match(raw, /## Design notes/);
  assert.match(raw, /- keep it simple/);
  assert.match(raw, /- reuse the exporter/);
  // The checkbox actually toggled.
  const parsed = getRequirements(b, "Proj", t.ticketNumber);
  assert.deepEqual(parsed.acceptanceCriteria.map((c) => c.done), [true, false]);
  // Unknown section content is preserved in raw (not in the structured fields).
  assert.match(parsed.raw, /## Design notes/);
});

test("getWorkPacket injects requirements and swaps definitionOfDone", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Ticket with reqs" });
  setRequirements(b, "Proj", t.ticketNumber, {
    intent: "Ship the widget.",
    acceptanceCriteria: ["Widget renders", "Widget is clickable"],
  });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.ok(packet.requirements, "packet carries parsed requirements");
  assert.equal(packet.requirements.intent, "Ship the widget.");
  assert.equal(packet.requirements.acceptanceCriteria.length, 2);
  // definitionOfDone becomes ticket-specific: AC-prefixed criteria + generic tail.
  assert.deepEqual(packet.definitionOfDone, [
    "AC: Widget renders",
    "AC: Widget is clickable",
    "Summarize what was built",
  ]);
});

test("getWorkPacket keeps the generic definitionOfDone when no requirements exist (back-compat)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Plain ticket" });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.equal(packet.requirements, undefined, "no requirements field when file absent");
  assert.deepEqual(packet.definitionOfDone, [
    "Implement the described behaviour",
    "Verify it works end to end",
    "Add or adjust a test",
    "Update docs if user-facing",
    "Summarize what was built",
  ]);
});
