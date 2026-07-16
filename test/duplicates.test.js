import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(
    path.join(dir, "Proj", "featurelist.md"),
    "# Feature List\n" +
      "- [x] [PF-1] **First**: a [Created: 2026-05-01]\n" +
      "- [ ] [PF-2] **Second**: b [Created: 2026-05-02]\n" +
      "- [x] [PF-2] **Second again (collision)**: c [Created: 2026-05-03]\n"
  );
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("findDuplicateTickets reports legacy collisions (FBMCPB-11)", () => {
  const b = tmpBoard();
  const dupes = b.findDuplicateTickets("Proj");
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].ticket, "PF-2");
  assert.equal(dupes[0].first, "Second");
  assert.equal(dupes[0].duplicate, "Second again (collision)");
});

test("updates to a duplicated id are refused until repaired", () => {
  const b = tmpBoard();
  assert.throws(() => b.updateTask("Proj", "PF-2", { title: "which one?" }), /appears 2 times/);
  assert.throws(() => b.setStatus("Proj", "PF-2", "Done"), /appears 2 times/);
});

test("repairDuplicateTickets: dry-run reports, apply renumbers the later occurrence", () => {
  const b = tmpBoard();
  const dry = b.repairDuplicateTickets("Proj", { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changes.length, 1);
  assert.equal(dry.changes[0].from, "PF-2");
  // dry-run must not modify the board
  assert.equal(b.findDuplicateTickets("Proj").length, 1);

  const fix = b.repairDuplicateTickets("Proj", { dryRun: false });
  assert.equal(fix.changes.length, 1);
  assert.match(fix.changes[0].to, /^PF-\d+$/);
  assert.notEqual(fix.changes[0].to, "PF-2");
  assert.equal(b.findDuplicateTickets("Proj").length, 0);
  // both tickets survive, first keeps its id, and updates work again
  assert.equal(b.getTask("Proj", "PF-2").title, "Second");
  assert.equal(b.getTask("Proj", fix.changes[0].to).title, "Second again (collision)");
  b.updateTask("Proj", "PF-2", { title: "unambiguous now" });
  assert.equal(b.getTask("Proj", "PF-2").title, "unambiguous now");
});

test("_nextId skips past repaired ids (no re-collision)", () => {
  const b = tmpBoard();
  b.repairDuplicateTickets("Proj", { dryRun: false });
  const t = b.addTask("Proj", "feature", { title: "fresh" });
  const ids = ["PF-1", "PF-2"];
  assert.ok(!ids.includes(t.ticketNumber));
});
