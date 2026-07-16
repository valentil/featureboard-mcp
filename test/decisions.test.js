import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { addDecision, listDecisions, decisionsForTicket } from "../server/decisions.js";

// FBMCPF-139 — architecture decision records (Foundry-style ADR log).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbadr-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("addDecision → listDecisions round-trips and auto-numbers across calls", () => {
  const b = tmpBoard();
  const first = addDecision(b, "Proj", {
    title: "Use SQLite for storage",
    context: "We need durable persistence across restarts.",
    decision: "Adopt SQLite instead of flat JSON files.",
    consequences: "Requires a migration step for existing data.",
    tickets: ["FBF-1", "FBB-2"],
  });
  assert.equal(first.id, "ADR-1");
  assert.equal(first.n, 1);
  assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(first.tickets, ["FBF-1", "FBB-2"]);

  const second = addDecision(b, "Proj", {
    title: "Adopt atomic writes",
    decision: "Write via tmp file + rename to avoid partial writes.",
  });
  assert.equal(second.id, "ADR-2");
  assert.equal(second.n, 2);
  // optional fields default to empty rather than throwing
  assert.equal(second.context, "");
  assert.equal(second.consequences, "");
  assert.deepEqual(second.tickets, []);

  const list = listDecisions(b, "Proj");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "ADR-1");
  assert.equal(list[0].title, "Use SQLite for storage");
  assert.equal(list[0].context, "We need durable persistence across restarts.");
  assert.equal(list[0].decision, "Adopt SQLite instead of flat JSON files.");
  assert.equal(list[0].consequences, "Requires a migration step for existing data.");
  assert.deepEqual(list[0].tickets, ["FBF-1", "FBB-2"]);
  assert.equal(list[1].id, "ADR-2");
  assert.equal(list[1].title, "Adopt atomic writes");

  const p = path.join(b.projectDir("Proj"), "decisions.md");
  assert.ok(fs.existsSync(p), "decisions.md written");
  const raw = fs.readFileSync(p, "utf8");
  assert.match(raw, /^## ADR-1: Use SQLite for storage/);
  assert.match(raw, /## ADR-2: Adopt atomic writes/);
  assert.match(raw, /\*\*Tickets:\*\* FBF-1, FBB-2/);
});

test("addDecision requires title and decision", () => {
  const b = tmpBoard();
  assert.throws(() => addDecision(b, "Proj", { decision: "x" }), /title/i);
  assert.throws(() => addDecision(b, "Proj", { title: "x" }), /decision/i);
  assert.throws(() => addDecision(b, "Proj", { title: "  ", decision: "  " }), /title/i);
});

test("decisionsForTicket matches via the tickets field", () => {
  const b = tmpBoard();
  addDecision(b, "Proj", {
    title: "Pin the SDK version",
    decision: "Pin to 1.2.3 until upstream fixes the regression.",
    tickets: ["FBF-10"],
  });
  addDecision(b, "Proj", {
    title: "Unrelated decision",
    decision: "Something else entirely.",
    tickets: ["FBB-99"],
  });

  const hits = decisionsForTicket(b, "Proj", "FBF-10");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Pin the SDK version");
});

test("decisionsForTicket matches via text mention when not in the tickets field", () => {
  const b = tmpBoard();
  addDecision(b, "Proj", {
    title: "Rework the export pipeline",
    context: "Came up while investigating FBF-42.",
    decision: "Switch to streaming exports.",
    consequences: "Fixes the timeout seen on FBF-42.",
    // no tickets field set
  });

  const hits = decisionsForTicket(b, "Proj", "FBF-42");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Rework the export pipeline");

  assert.deepEqual(decisionsForTicket(b, "Proj", "FBF-9999"), []);
});

test("decisionsForTicket returns [] for an empty ticket id", () => {
  const b = tmpBoard();
  addDecision(b, "Proj", { title: "Some decision", decision: "Some choice." });
  assert.deepEqual(decisionsForTicket(b, "Proj", ""), []);
});

test("listDecisions tolerates hand-edited / malformed entries", () => {
  const b = tmpBoard();
  addDecision(b, "Proj", {
    title: "Well-formed entry",
    context: "ctx",
    decision: "dec",
    consequences: "cons",
    tickets: ["FBF-1"],
  });

  const p = path.join(b.projectDir("Proj"), "decisions.md");
  const existing = fs.readFileSync(p, "utf8");
  // A human appends a stray note (not a proper entry) and a malformed entry
  // missing most fields, plus an out-of-order/hand-numbered header.
  const handEdited =
    existing.trim() +
    "\n\n" +
    "Some stray note a human left here that isn't a real entry.\n\n" +
    "## ADR-7: Hand added, minimal\n" +
    "*2026-01-01*\n\n" +
    "**Decision:** Just decided this on the fly.\n";
  fs.writeFileSync(p, handEdited);

  const list = listDecisions(b, "Proj");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "ADR-1");
  assert.equal(list[1].id, "ADR-7");
  assert.equal(list[1].n, 7);
  assert.equal(list[1].title, "Hand added, minimal");
  assert.equal(list[1].date, "2026-01-01");
  assert.equal(list[1].decision, "Just decided this on the fly.");
  // fields absent from the hand-added entry come back empty, not throwing
  assert.equal(list[1].context, "");
  assert.equal(list[1].consequences, "");
  assert.deepEqual(list[1].tickets, []);

  // auto-numbering continues past the hand-added ADR-7
  const next = addDecision(b, "Proj", { title: "Next one", decision: "Whatever." });
  assert.equal(next.id, "ADR-8");
  assert.equal(next.n, 8);
});

test("listDecisions and decisionsForTicket return [] for a project with no decisions.md", () => {
  const b = tmpBoard();
  assert.deepEqual(listDecisions(b, "Proj"), []);
  assert.deepEqual(decisionsForTicket(b, "Proj", "FBF-1"), []);
});
