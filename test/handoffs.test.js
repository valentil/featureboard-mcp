import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { writeHandoff, readHandoff, handoffsFor } from "../server/handoffs.js";

// FBMCPF-144 — pipeline handoffs: when a ticket completes, its output feeds
// every ticket that is blockedBy it (FBMCPF-133).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbhandoff-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("writeHandoff -> readHandoff round-trips", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Build the widget" });
  const note = "# Widget API\n\nExposes `renderWidget(el)`. See src/widget.js.\n";
  const summary = writeHandoff(b, "Proj", t.ticketNumber, note);

  assert.equal(summary.ticket, t.ticketNumber);
  assert.ok(summary.path.endsWith(path.join("handoffs", `${t.ticketNumber}.md`)));
  assert.equal(summary.bytes, Buffer.byteLength(note, "utf8"));
  assert.ok(fs.existsSync(summary.path), "handoff file written");

  assert.equal(readHandoff(b, "Proj", t.ticketNumber), note);
});

test("writeHandoff overwrites on a second call (atomic write)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Iterate" });
  writeHandoff(b, "Proj", t.ticketNumber, "first draft");
  writeHandoff(b, "Proj", t.ticketNumber, "final note");
  assert.equal(readHandoff(b, "Proj", t.ticketNumber), "final note");
});

test("writeHandoff throws for a missing ticket", () => {
  const b = tmpBoard();
  assert.throws(() => writeHandoff(b, "Proj", "FBF-999", "note"), /not found/);
});

test("readHandoff returns null when no note exists", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No note yet" });
  assert.equal(readHandoff(b, "Proj", t.ticketNumber), null);
});

test("handoffsFor returns [] for a ticket with no blockedBy deps", () => {
  const b = tmpBoard();
  const c = b.addTask("Proj", "feature", { title: "C, standalone" });
  assert.deepEqual(handoffsFor(b, "Proj", c.ticketNumber), []);
});

test("handoffsFor returns [] for an unknown ticket", () => {
  const b = tmpBoard();
  assert.deepEqual(handoffsFor(b, "Proj", "FBF-999"), []);
});

test("handoffsFor: chain A Done with summary+note, B blockedBy A sees both", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const bb = b.addTask("Proj", "feature", { title: "B", blockedBy: [a.ticketNumber] });

  b.setStatus("Proj", a.ticketNumber, "Done", "Shipped the A module.");
  writeHandoff(b, "Proj", a.ticketNumber, "## Handoff\nUse `aExport()` from src/a.js.\n");

  const seen = handoffsFor(b, "Proj", bb.ticketNumber);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ticket, a.ticketNumber);
  assert.equal(seen[0].status, "Done");
  assert.equal(seen[0].completionSummary, "Shipped the A module.");
  assert.equal(seen[0].handoff, "## Handoff\nUse `aExport()` from src/a.js.\n");
});

test("handoffsFor: predecessor not Done and no note is excluded", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A in progress" });
  const bb = b.addTask("Proj", "feature", { title: "B", blockedBy: [a.ticketNumber] });
  b.setStatus("Proj", a.ticketNumber, "In Progress");

  assert.deepEqual(handoffsFor(b, "Proj", bb.ticketNumber), []);
});

test("handoffsFor: predecessor not Done but WITH a note is included (handoff visible early)", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A in progress" });
  const bb = b.addTask("Proj", "feature", { title: "B", blockedBy: [a.ticketNumber] });
  b.setStatus("Proj", a.ticketNumber, "In Progress");
  writeHandoff(b, "Proj", a.ticketNumber, "early preview note");

  const seen = handoffsFor(b, "Proj", bb.ticketNumber);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "In Progress");
  assert.equal(seen[0].handoff, "early preview note");
});

test("handoffsFor: predecessor Done without a note is included with handoff:null", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A done, no note" });
  const bb = b.addTask("Proj", "feature", { title: "B", blockedBy: [a.ticketNumber] });
  b.setStatus("Proj", a.ticketNumber, "Done", "Done, forgot the handoff note.");

  const seen = handoffsFor(b, "Proj", bb.ticketNumber);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ticket, a.ticketNumber);
  assert.equal(seen[0].status, "Done");
  assert.equal(seen[0].completionSummary, "Done, forgot the handoff note.");
  assert.equal(seen[0].handoff, null);
});

test("handoffsFor tolerates a dangling blockedBy ref", () => {
  const b = tmpBoard();
  const bb = b.addTask("Proj", "feature", { title: "B", blockedBy: ["FBF-999"] });
  assert.deepEqual(handoffsFor(b, "Proj", bb.ticketNumber), []);
});

test("handoffsFor: multiple blockers, mixed qualification", () => {
  const b = tmpBoard();
  const a1 = b.addTask("Proj", "feature", { title: "A1 done" });
  const a2 = b.addTask("Proj", "feature", { title: "A2 open, no note" });
  const a3 = b.addTask("Proj", "feature", { title: "A3 open, has note" });
  const bb = b.addTask("Proj", "feature", {
    title: "B",
    blockedBy: [a1.ticketNumber, a2.ticketNumber, a3.ticketNumber, "FBF-999"],
  });

  b.setStatus("Proj", a1.ticketNumber, "Done", "A1 complete.");
  writeHandoff(b, "Proj", a3.ticketNumber, "A3 preview");

  const seen = handoffsFor(b, "Proj", bb.ticketNumber);
  const tickets = seen.map((s) => s.ticket).sort();
  assert.deepEqual(tickets, [a1.ticketNumber, a3.ticketNumber].sort());
});
