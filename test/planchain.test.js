// FBMCPF-137 — plan chaining: wave computation + plan_work dependency wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { computeWaves } from "../server/planchain.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-plan-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// Faithful mirror of the plan_work handler's dependency-wiring loop, so the
// storage cycle rejection + warning collection + computeWaves are tested
// end-to-end against a real Board. `deps` maps a combined-list index -> number[]
// of prerequisite indices.
function wire(board, project, tickets, deps) {
  const edges = [];
  const warnings = [];
  for (let i = 0; i < tickets.length; i++) {
    const d = deps[i];
    if (!Array.isArray(d) || !d.length) continue;
    const ticket = tickets[i];
    const blockers = [];
    for (const idx of d) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= tickets.length) {
        warnings.push(`${ticket}: dependsOn index ${idx} out of range`);
        continue;
      }
      if (idx === i) { warnings.push(`${ticket}: self`); continue; }
      const b = tickets[idx];
      if (!blockers.includes(b)) blockers.push(b);
    }
    if (!blockers.length) continue;
    try {
      board.updateTask(project, ticket, { blockedBy: blockers });
      edges.push({ ticket, blockedBy: blockers });
    } catch (e) {
      warnings.push(`${ticket}: rejected (${e.message})`);
    }
  }
  return { edges, warnings, waves: computeWaves(tickets, edges) };
}

// --- computeWaves (pure) ---------------------------------------------------

test("diamond graph A->B,C->D yields three waves [A],[B,C],[D]", () => {
  const created = ["FBF-1", "FBF-2", "FBF-3", "FBF-4"]; // A,B,C,D
  const edges = [
    { ticket: "FBF-2", blockedBy: ["FBF-1"] }, // B <- A
    { ticket: "FBF-3", blockedBy: ["FBF-1"] }, // C <- A
    { ticket: "FBF-4", blockedBy: ["FBF-2", "FBF-3"] }, // D <- B,C
  ];
  const waves = computeWaves(created, edges);
  assert.deepEqual(waves, [["FBF-1"], ["FBF-2", "FBF-3"], ["FBF-4"]]);
});

test("no edges => a single wave holding every ticket, in order", () => {
  const created = ["FBF-1", "FBF-2", "FBF-3"];
  assert.deepEqual(computeWaves(created, []), [["FBF-1", "FBF-2", "FBF-3"]]);
});

test("empty created => no waves", () => {
  assert.deepEqual(computeWaves([], []), []);
});

test("dangling and self blockers are ignored (still wave 1)", () => {
  const created = ["FBF-1"];
  const edges = [{ ticket: "FBF-1", blockedBy: ["FBF-99", "FBF-1"] }];
  assert.deepEqual(computeWaves(created, edges), [["FBF-1"]]);
});

test("a residual cycle is emitted as a final wave (nothing lost)", () => {
  const created = ["FBF-1", "FBF-2"];
  const edges = [
    { ticket: "FBF-1", blockedBy: ["FBF-2"] },
    { ticket: "FBF-2", blockedBy: ["FBF-1"] },
  ];
  const waves = computeWaves(created, edges);
  const flat = waves.flat().sort();
  assert.deepEqual(flat, ["FBF-1", "FBF-2"]);
});

// --- wiring against a real Board (mirrors the handler) ---------------------

test("full diamond wired on a real board: edges persisted, correct waves", () => {
  const board = tmpBoard();
  const A = board.addTask("Proj", "feature", { title: "A" }).ticketNumber;
  const B = board.addTask("Proj", "feature", { title: "B" }).ticketNumber;
  const C = board.addTask("Proj", "feature", { title: "C" }).ticketNumber;
  const D = board.addTask("Proj", "feature", { title: "D" }).ticketNumber;
  const tickets = [A, B, C, D];
  const { edges, warnings, waves } = wire(board, "Proj", tickets, {
    1: [0], 2: [0], 3: [1, 2],
  });
  assert.equal(warnings.length, 0);
  assert.equal(edges.length, 3);
  assert.deepEqual(waves, [[A], [B, C], [D]]);
  // persisted onto the board
  assert.deepEqual(board.getTask("Proj", D).blockedBy, [B, C]);
});

test("cycle-rejected edge produces a warning but the ticket still lands in a wave", () => {
  const board = tmpBoard();
  const A = board.addTask("Proj", "feature", { title: "A" }).ticketNumber;
  const Bk = board.addTask("Proj", "feature", { title: "B" }).ticketNumber;
  // A depends on B (ok); B depends on A (would close a loop -> rejected).
  const { edges, warnings, waves } = wire(board, "Proj", [A, Bk], { 0: [1], 1: [0] });
  assert.equal(edges.length, 1); // only A<-B applied
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rejected/);
  // both tickets still scheduled; B leads, A follows
  assert.deepEqual(waves, [[Bk], [A]]);
  assert.equal(board.getTask("Proj", Bk).blockedBy.length, 0);
});

test("out-of-range dependsOn index warns and leaves the ticket unblocked in wave 1", () => {
  const board = tmpBoard();
  const A = board.addTask("Proj", "feature", { title: "A" }).ticketNumber;
  const { edges, warnings, waves } = wire(board, "Proj", [A], { 0: [5] });
  assert.equal(edges.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /out of range/);
  assert.deepEqual(waves, [[A]]);
});

test("bugs follow features in the combined index space", () => {
  const board = tmpBoard();
  const F = board.addTask("Proj", "feature", { title: "F" }).ticketNumber;
  const G = board.addTask("Proj", "bug", { title: "G" }).ticketNumber;
  // combined = [F(0), G(1)]; bug G depends on feature F.
  const { edges, waves } = wire(board, "Proj", [F, G], { 1: [0] });
  assert.deepEqual(edges, [{ ticket: G, blockedBy: [F] }]);
  assert.deepEqual(waves, [[F], [G]]);
});
