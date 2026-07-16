import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, parseMarkdown, serializeTask, wouldCycle, isBlocked } from "../server/storage.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dep-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("parse a line WITHOUT BlockedBy: field defaults to []", () => {
  const line =
    "- [ ] [FBF-1] **Title**: desc [Product: Core] [Created: 2026-07-07]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.deepEqual(t.blockedBy, []);
  // token-free title/desc unchanged
  assert.equal(t.title, "Title");
  assert.equal(t.description, "desc");
});

test("parse a line WITH BlockedBy: yields the id list, not bleeding into text", () => {
  const line =
    "- [ ] [FBF-2] **Dep**: needs deps [BlockedBy: FBF-1, FBB-3] [Created: 2026-07-07]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.deepEqual(t.blockedBy, ["FBF-1", "FBB-3"]);
  assert.equal(t.title, "Dep");
  assert.equal(t.description, "needs deps");
});

test("round-trip serialize/parse WITH BlockedBy", () => {
  const task = {
    ticketNumber: "FBF-5",
    title: "Blocked one",
    description: "d",
    status: "Todo",
    createdDate: "2026-07-07",
    blockedBy: ["FBF-1", "FBF-2"],
  };
  const line = serializeTask(task);
  assert.match(line, /\[BlockedBy: FBF-1, FBF-2\]/);
  const [back] = parseMarkdown(line, "featurelist.md");
  assert.deepEqual(back.blockedBy, ["FBF-1", "FBF-2"]);
});

test("back-compat: a line WITHOUT BlockedBy serializes byte-identically", () => {
  const line =
    "- [x] [FBF-546] **Title here**: some desc [Product: Core] [Labels: a, b] Summary: got it done [Created: 2026-05-24 | Due: 2026-05-29]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.equal(serializeTask(t), line);
  // and no BlockedBy token appears
  assert.ok(!serializeTask(t).includes("BlockedBy"));
});

test("back-compat: a no-op updateTask does not introduce a BlockedBy token", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Plain", description: "d" });
  const before = b.getTask("Proj", t.ticketNumber)._raw;
  assert.ok(!before.includes("BlockedBy"));
  const upd = b.updateTask("Proj", t.ticketNumber, { title: "Plain" }); // same title
  assert.ok(!upd.line.includes("BlockedBy"));
  assert.equal(upd.line, before);
});

test("updateTask sets and clears blockedBy (null and [])", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const c = b.addTask("Proj", "feature", { title: "C" });
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [c.ticketNumber] });
  assert.deepEqual(b.getTask("Proj", a.ticketNumber).blockedBy, [c.ticketNumber]);
  // clear with []
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [] });
  assert.deepEqual(b.getTask("Proj", a.ticketNumber).blockedBy, []);
  // set then clear with null
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [c.ticketNumber] });
  b.updateTask("Proj", a.ticketNumber, { blockedBy: null });
  assert.deepEqual(b.getTask("Proj", a.ticketNumber).blockedBy, []);
});

test("addTask accepts a blockedBy list", () => {
  const b = tmpBoard();
  const x = b.addTask("Proj", "feature", { title: "X" });
  const y = b.addTask("Proj", "feature", { title: "Y", blockedBy: [x.ticketNumber] });
  assert.deepEqual(b.getTask("Proj", y.ticketNumber).blockedBy, [x.ticketNumber]);
});

test("cycle rejection: self-block and A->B->A are refused", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const bb = b.addTask("Proj", "feature", { title: "B" });
  // self-block
  assert.throws(
    () => b.updateTask("Proj", a.ticketNumber, { blockedBy: [a.ticketNumber] }),
    /would create a dependency cycle/
  );
  // A blocked by B is fine
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [bb.ticketNumber] });
  // now B blocked by A closes the loop
  assert.throws(
    () => b.updateTask("Proj", bb.ticketNumber, { blockedBy: [a.ticketNumber] }),
    /would create a dependency cycle/
  );
  // the rejected edge was not persisted
  assert.deepEqual(b.getTask("Proj", bb.ticketNumber).blockedBy, []);
});

test("wouldCycle helper: direct and transitive detection", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const bb = b.addTask("Proj", "feature", { title: "B" });
  const c = b.addTask("Proj", "feature", { title: "C" });
  // A <- B <- C chain
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [bb.ticketNumber] });
  b.updateTask("Proj", bb.ticketNumber, { blockedBy: [c.ticketNumber] });
  // making C blocked by A closes the transitive loop
  assert.equal(wouldCycle(b, "Proj", c.ticketNumber, [a.ticketNumber]), true);
  // making C blocked by an unrelated new node does not
  const d = b.addTask("Proj", "feature", { title: "D" });
  assert.equal(wouldCycle(b, "Proj", c.ticketNumber, [d.ticketNumber]), false);
});

test("isBlocked flips as blockers complete", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const bb = b.addTask("Proj", "feature", { title: "B" });
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [bb.ticketNumber] });
  assert.equal(isBlocked(b, "Proj", b.getTask("Proj", a.ticketNumber)), true);
  b.setStatus("Proj", bb.ticketNumber, "Done");
  assert.equal(isBlocked(b, "Proj", b.getTask("Proj", a.ticketNumber)), false);
});

test("isBlocked tolerates dangling blocker refs (not blocking)", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  // FBF-999 does not exist on the board
  b.updateTask("Proj", a.ticketNumber, { blockedBy: ["FBF-999"] });
  assert.equal(isBlocked(b, "Proj", b.getTask("Proj", a.ticketNumber)), false);
  // and a dangling ref does not trip cycle detection either
  assert.equal(wouldCycle(b, "Proj", a.ticketNumber, ["FBF-999"]), false);
});

test("isBlocked with a mix of done and open blockers stays blocked until all done", () => {
  const b = tmpBoard();
  const a = b.addTask("Proj", "feature", { title: "A" });
  const b1 = b.addTask("Proj", "feature", { title: "B1" });
  const b2 = b.addTask("Proj", "feature", { title: "B2" });
  b.updateTask("Proj", a.ticketNumber, { blockedBy: [b1.ticketNumber, b2.ticketNumber] });
  b.setStatus("Proj", b1.ticketNumber, "Done");
  assert.equal(isBlocked(b, "Proj", b.getTask("Proj", a.ticketNumber)), true); // b2 still open
  b.setStatus("Proj", b2.ticketNumber, "Done");
  assert.equal(isBlocked(b, "Proj", b.getTask("Proj", a.ticketNumber)), false);
});
