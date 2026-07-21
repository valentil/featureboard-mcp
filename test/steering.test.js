// FBMCPF-317 — steering loop: state persistence, claim-once review semantics,
// goal/standard-aware research pass, and the two-empty-passes stop hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { applyStandard } from "../server/standards.js";
import { steerProject, readSteeringState, unreviewedDone } from "../server/steering.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-steer-"));
  const board = new Board(dir);
  board.createProject("Proj");
  return { dir, board };
}
const done = (board, title) => {
  const t = board.addTask("Proj", "feature", { title });
  board.setStatus("Proj", t.ticketNumber, "Done", `${title} shipped.`, { approve: true });
  return t.ticketNumber;
};

test("first steering pass claims recent Done tickets; second pass skips them", () => {
  const { board } = tmpBoard();
  const a = done(board, "Alpha");
  const b = done(board, "Beta");
  const now = new Date("2026-07-21T12:00:00Z");

  const first = steerProject(board, "Proj", { now });
  const review = first.passes.find((p) => p.pass === "review");
  assert.deepEqual(review.tickets.map((t) => t.ticket).sort(), [a, b].sort());
  assert.equal(first.actionable, true);
  assert.equal(readSteeringState(board, "Proj").lastSteeringAt, now.toISOString());

  const second = steerProject(board, "Proj", { now: new Date("2026-07-21T13:00:00Z") });
  const review2 = second.passes.find((p) => p.pass === "review");
  assert.equal(review2.tickets.length, 0, "already-reviewed tickets must not resurface");

  // new Done work after steering IS picked up
  const c = done(board, "Gamma");
  const third = steerProject(board, "Proj", { now: new Date("2026-07-21T14:00:00Z") });
  assert.deepEqual(third.passes.find((p) => p.pass === "review").tickets.map((t) => t.ticket), [c]);
});

test("dryRun previews without claiming", () => {
  const { board } = tmpBoard();
  const a = done(board, "Alpha");
  const preview = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z"), dryRun: true });
  assert.equal(preview.passes.find((p) => p.pass === "review").tickets.length, 1);
  assert.equal(readSteeringState(board, "Proj").reviewedTickets.length, 0);
  const real = steerProject(board, "Proj", { now: new Date("2026-07-21T12:30:00Z") });
  assert.equal(real.passes.find((p) => p.pass === "review").tickets[0].ticket, a);
});

test("research pass carries the goal and the polished question set", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "Proj", {
    goal: "become the default agent-run task board",
    standard: applyStandard(null, { level: "polished", mandate: "competitor research + automation" }).standard,
  });
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(out.goal, "become the default agent-run task board");
  assert.equal(out.standard.level, "polished");
  assert.equal(out.standard.mandate, "competitor research + automation");
  const research = out.passes.find((p) => p.pass === "research");
  const qs = research.questions.join(" ");
  assert.match(qs, /become the default agent-run task board/);
  assert.match(qs, /Competitor teardown/);
  assert.match(research.instruction, /add_feature per proposal/);
  assert.equal(out.actionable, true, "a goal alone keeps steering actionable");
});

test("no goal → research pass tells the agent to ask ONCE and store it", () => {
  const { board } = tmpBoard();
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  const research = out.passes.find((p) => p.pass === "research");
  assert.match(research.questions[0], /ask the user for the project's north star ONCE/);
  assert.match(research.questions[0], /set_project_config goal/);
});

test("empty board + no goal → not actionable, stopHint present, resume pass last", () => {
  const { board } = tmpBoard();
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(out.actionable, false);
  assert.match(out.stopHint, /do not spin/);
  assert.equal(out.passes[out.passes.length - 1].pass, "resume");
});
