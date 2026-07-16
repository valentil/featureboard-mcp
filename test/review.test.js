import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, parseMarkdown, serializeTask } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-review-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("FBMCPF-134: [r] parses as Review and serializes back", () => {
  const line = "- [r] [FBF-9] **In review**: needs eyes [Created: 2026-07-10]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.equal(t.status, "Review");
  assert.equal(t.ticketNumber, "FBF-9");
  // uppercase R also maps to Review
  const [u] = parseMarkdown("- [R] [FBF-9] **x**: y [Created: 2026-07-10]", "featurelist.md");
  assert.equal(u.status, "Review");
  // round-trip: a Review task serializes with the [r] checkbox
  const back = serializeTask({ ...t, createdDate: "2026-07-10" });
  assert.ok(back.startsWith("- [r] "), back);
  assert.equal(parseMarkdown(back, "featurelist.md")[0].status, "Review");
});

test("FBMCPF-134: setStatus can move a ticket to Review and back", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Thing" });
  b.setStatus("Proj", f.ticketNumber, "Review");
  assert.equal(b.getTask("Proj", f.ticketNumber).status, "Review");
  b.setStatus("Proj", f.ticketNumber, "In Progress");
  assert.equal(b.getTask("Proj", f.ticketNumber).status, "In Progress");
});

test("FBMCPF-134: gate off — direct In Progress→Done still works (back-compat)", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Legacy" });
  b.setStatus("Proj", f.ticketNumber, "In Progress");
  const r = b.setStatus("Proj", f.ticketNumber, "Done", "shipped");
  assert.equal(r.status, "Done");
  assert.equal(b.getTask("Proj", f.ticketNumber).status, "Done");
});

test("FBMCPF-134: gate on — In Progress→Done throws, Review→Done succeeds", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { requireReview: true });
  const f = b.addTask("Proj", "feature", { title: "Gated" });
  b.setStatus("Proj", f.ticketNumber, "In Progress");
  assert.throws(
    () => b.setStatus("Proj", f.ticketNumber, "Done", "nope"),
    /requireReview is on/
  );
  // ticket must be untouched after the throw
  assert.equal(b.getTask("Proj", f.ticketNumber).status, "In Progress");
  // move to Review first, then Done is allowed
  b.setStatus("Proj", f.ticketNumber, "Review");
  const r = b.setStatus("Proj", f.ticketNumber, "Done", "reviewed");
  assert.equal(r.status, "Done");
});

test("FBMCPF-134: gate on — approve:true overrides straight from In Progress", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { requireReview: true });
  const f = b.addTask("Proj", "feature", { title: "Override" });
  b.setStatus("Proj", f.ticketNumber, "In Progress");
  const r = b.setStatus("Proj", f.ticketNumber, "Done", "forced", { approve: true });
  assert.equal(r.status, "Done");
});

test("FBMCPF-134: getMetrics reports inReview (0 when none)", () => {
  const b = tmpBoard();
  const m0 = b.getMetrics("Proj");
  assert.equal(m0.features.inReview, 0);
  assert.equal(m0.bugs.inReview, 0);
  const f = b.addTask("Proj", "feature", { title: "F" });
  const bug = b.addTask("Proj", "bug", { title: "B" });
  b.setStatus("Proj", f.ticketNumber, "Review");
  b.setStatus("Proj", bug.ticketNumber, "Review");
  const m = b.getMetrics("Proj");
  assert.equal(m.features.inReview, 1);
  assert.equal(m.bugs.inReview, 1);
  // Review bugs still count as open, not closed
  assert.equal(m.bugs.open, 1);
  assert.equal(m.bugs.closed, 0);
});

test("FBMCPF-134: old-format lines (no [r]) round-trip byte-identically", () => {
  const lines = [
    "- [ ] [FBF-1] **Todo item**: a description [Created: 2026-07-07]",
    "- [-] [FBF-2] **In progress**: doing it [Created: 2026-07-07 | Due: 2026-07-14]",
    "- [x] [FBF-3] **Done item**: finished Summary: shipped it [Created: 2026-07-01 | Completed: 2026-07-02]",
  ];
  for (const line of lines) {
    const [t] = parseMarkdown(line, "featurelist.md");
    assert.equal(serializeTask(t), line);
  }
});
