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
import { steerProject, readSteeringState, unreviewedDone, getSteeringStatus } from "../server/steering.js";

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
  assert.equal(out.actionable, true, "a goal makes the FIRST research pass actionable");
});

test("FBMCPB-45: a goal is good for ONE research wave, then goes non-actionable until new Done work", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "Proj", { goal: "become the default agent-run task board" });

  // Pass 1: no concrete work, goal set → emit the research wave, actionable.
  const first = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(first.actionable, true, "first goal-only pass emits a research wave");
  assert.equal(first.stopHint, null);
  assert.equal(readSteeringState(board, "Proj").goalOnlyStreak, 1);

  // Pass 2: still nothing concrete → the auto-stop valve can finally fire.
  const second = steerProject(board, "Proj", { now: new Date("2026-07-21T13:00:00Z") });
  assert.equal(second.actionable, false, "a goal must NOT keep steering actionable forever");
  assert.match(second.stopHint, /do not spin/);
  assert.equal(readSteeringState(board, "Proj").goalOnlyStreak, 2);

  // New Done work appears → concrete review resets the streak, actionable again.
  done(board, "Alpha");
  const third = steerProject(board, "Proj", { now: new Date("2026-07-21T14:00:00Z") });
  assert.equal(third.actionable, true, "fresh Done work makes steering actionable again");
  assert.equal(readSteeringState(board, "Proj").goalOnlyStreak, 0);

  // ...and after that wave is reviewed, one more goal-only wave, then stop again.
  const fourth = steerProject(board, "Proj", { now: new Date("2026-07-21T15:00:00Z") });
  assert.equal(fourth.actionable, true, "one goal-only wave allowed after the reset");
  const fifth = steerProject(board, "Proj", { now: new Date("2026-07-21T16:00:00Z") });
  assert.equal(fifth.actionable, false, "second consecutive goal-only pass is non-actionable");
});

test("FBMCPB-45: dryRun does not advance the goal-only streak", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "Proj", { goal: "ship it" });
  steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") }); // streak → 1
  const preview = steerProject(board, "Proj", { now: new Date("2026-07-21T12:30:00Z"), dryRun: true });
  assert.equal(preview.actionable, false, "preview reflects the would-be non-actionable pass");
  assert.equal(readSteeringState(board, "Proj").goalOnlyStreak, 1, "dryRun must not persist streak advance");
});

test("no goal → research pass tells the agent to ask ONCE and store it", () => {
  const { board } = tmpBoard();
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  const research = out.passes.find((p) => p.pass === "research");
  assert.match(research.questions[0], /ask the user for the project's north star ONCE/);
  assert.match(research.questions[0], /set_project_config goal/);
});

test("FBMCPB-44: goalless steer surfaces goalMissing and leads the research pass with a set-goal notice", () => {
  const { board } = tmpBoard();
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(out.goalMissing, true, "top-level goalMissing flag is set when no goal");
  const research = out.passes.find((p) => p.pass === "research");
  assert.equal(research.goalMissing, true);
  assert.match(research.instruction, /NO PROJECT GOAL IS SET/);
  assert.match(research.instruction, /set_project_config goal/);
  assert.match(research.instruction, /don't invent a wave/i);

  // With a goal set, the flag clears and the instruction is the normal research directive.
  setProjectConfig(board, "Proj", { goal: "ship the thing" });
  const out2 = steerProject(board, "Proj", { now: new Date("2026-07-21T13:00:00Z") });
  assert.equal(out2.goalMissing, false);
  const research2 = out2.passes.find((p) => p.pass === "research");
  assert.equal(research2.goalMissing, false);
  assert.match(research2.instruction, /Research toward the goal/);
});

test("FBMCPF-320: steer_project returns a one-line digest of the pass", () => {
  const { board } = tmpBoard();
  done(board, "Alpha");
  setProjectConfig(board, "Proj", { goal: "ship it" });
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(typeof out.digest, "string");
  assert.match(out.digest, /Steering Proj/);
  assert.match(out.digest, /1 to review/);
  assert.match(out.digest, /open/);
  assert.match(out.digest, /goal set/);

  const { board: b2 } = tmpBoard();
  const g = steerProject(b2, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.match(g.digest, /NO GOAL/, "goalless pass says so in the digest");
});

test("FBMCPF-319: get_steering_status reports state without running a pass", () => {
  const { board } = tmpBoard();

  // Never steered yet.
  let s = getSteeringStatus(board, "Proj");
  assert.equal(s.everSteered, false);
  assert.equal(s.lastSteeringAt, null);
  assert.equal(s.reviewedCount, 0);
  assert.equal(s.goalOnlyStreak, 0);
  assert.equal(s.goalMissing, true);

  const a = done(board, "Alpha");
  s = getSteeringStatus(board, "Proj");
  assert.equal(s.unreviewedDoneCount, 1, "Alpha is Done but not yet reviewed");
  assert.equal(s.reviewedCount, 0, "read-only status must NOT claim/review anything");
  assert.equal(readSteeringState(board, "Proj").lastSteeringAt, null, "get_steering_status must not write state");

  // Run a real pass, then status reflects it.
  setProjectConfig(board, "Proj", { goal: "ship it" });
  steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  s = getSteeringStatus(board, "Proj");
  assert.equal(s.everSteered, true);
  assert.equal(s.lastSteeringAt, "2026-07-21T12:00:00.000Z");
  assert.equal(s.reviewedCount, 1, "Alpha was claimed by the pass");
  assert.ok(s.reviewedTickets.includes(a));
  assert.equal(s.goalMissing, false);
  assert.equal(s.unreviewedDoneCount, 0);
});

test("empty board + no goal → not actionable, stopHint present, resume pass last", () => {
  const { board } = tmpBoard();
  const out = steerProject(board, "Proj", { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(out.actionable, false);
  assert.match(out.stopHint, /do not spin/);
  assert.equal(out.passes[out.passes.length - 1].pass, "resume");
});
