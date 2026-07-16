import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { ARM_RE, PAIR_RE, armOfTask, pairOfTask, evalReport } from "../server/eval.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-eval-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// ---------------------------------------------------------------------------
// armOfTask / pairOfTask
// ---------------------------------------------------------------------------

test("ARM_RE / PAIR_RE match the label conventions", () => {
  assert.ok(ARM_RE.test("experiment:board"));
  assert.ok(ARM_RE.test("experiment:chat"));
  assert.ok(!ARM_RE.test("experiment:other"));
  const m = "pair:xyz-1".match(PAIR_RE);
  assert.equal(m[1], "xyz-1");
});

test("armOfTask reads the experiment arm label case-insensitively", () => {
  assert.equal(armOfTask({ labels: ["experiment:board"] }), "board");
  assert.equal(armOfTask({ labels: ["Core", "experiment:CHAT"] }), "chat");
  assert.equal(armOfTask({ labels: ["Core"] }), null);
  assert.equal(armOfTask({ labels: [] }), null);
  assert.equal(armOfTask({}), null);
});

test("pairOfTask reads the pair id label", () => {
  assert.equal(pairOfTask({ labels: ["experiment:board", "pair:p1"] }), "p1");
  assert.equal(pairOfTask({ labels: ["pair:xyz-1"] }), "xyz-1");
  assert.equal(pairOfTask({ labels: [] }), null);
  assert.equal(pairOfTask({}), null);
});

// ---------------------------------------------------------------------------
// evalReport
// ---------------------------------------------------------------------------

function seedTwoPairs(b) {
  // Fixture lines written directly so createdDate/completionDate are controlled
  // exactly (setStatus would stamp today's date instead).
  const features = [
    // pair p1: board trial, 2 days wall time
    "- [x] [FBF-1] **Board task 1**: implement via board [Labels: experiment:board, pair:p1] [Created: 2026-07-01 | Completed: 2026-07-03]",
    // pair p1: chat trial, 5 days wall time
    "- [x] [FBF-2] **Chat task 1**: implement via chat [Labels: experiment:chat, pair:p1] [Created: 2026-07-01 | Completed: 2026-07-06]",
    // pair p2: board trial, 1 day wall time
    "- [x] [FBF-3] **Board task 2**: implement via board [Labels: experiment:board, pair:p2] [Created: 2026-07-05 | Completed: 2026-07-06]",
    // pair p2: chat trial, 5 days wall time
    "- [x] [FBF-4] **Chat task 2**: implement via chat [Labels: experiment:chat, pair:p2] [Created: 2026-07-05 | Completed: 2026-07-10]",
    // unpaired board trial (no pair: label)
    "- [x] [FBF-5] **Unpaired board task**: solo board trial [Labels: experiment:board] [Created: 2026-07-01 | Completed: 2026-07-02]",
    // not part of the experiment at all
    "- [ ] [FBF-6] **Not part of eval**: ordinary ticket [Created: 2026-07-01]",
  ];
  const bugs = [
    // linked to FBF-1, 1 day after completion (2026-07-03) -> within the 7-day window
    "- [ ] [FBB-1] **Regression 1**: broke again 🔗 FBF-1 [Created: 2026-07-04]",
    // linked to FBF-1, exactly 7 days after completion -> boundary, still within window
    "- [ ] [FBB-2] **Regression 2**: boundary case 🔗 FBF-1 [Created: 2026-07-10]",
    // linked to FBF-1, 9 days after completion -> outside the window
    "- [ ] [FBB-3] **Late bug**: too late to be rework 🔗 FBF-1 [Created: 2026-07-12]",
    // linked to FBF-1 but created BEFORE completion -> not rework
    "- [ ] [FBB-4] **Preexisting bug**: found before the fix landed 🔗 FBF-1 [Created: 2026-07-02]",
  ];
  fs.writeFileSync(path.join(b.projectDir("Proj"), "featurelist.md"), "# Feature List\n" + features.join("\n") + "\n");
  fs.writeFileSync(path.join(b.projectDir("Proj"), "buglist.md"), "# Bug List\n" + bugs.join("\n") + "\n");

  // work log: tokens/additions/deletions per ticket, tokens summed across entries
  logWork(b, "Proj", { ticket: "FBF-1", summary: "part 1", tokens: 4000, additions: 20, deletions: 2 });
  logWork(b, "Proj", { ticket: "FBF-1", summary: "part 2", tokens: 2000, additions: 20, deletions: 3 });
  logWork(b, "Proj", { ticket: "FBF-2", summary: "chat work", tokens: 30000, additions: 150, deletions: 10 });
  logWork(b, "Proj", { ticket: "FBF-3", summary: "board work", tokens: 8000, additions: 50, deletions: 5 });
  logWork(b, "Proj", { ticket: "FBF-4", summary: "chat work", tokens: 32000, additions: 160, deletions: 12 });
  logWork(b, "Proj", { ticket: "FBF-5", summary: "solo board work", tokens: 5000, additions: 30, deletions: 1 });
}

test("evalReport: trials, tokens summed from log, rework windowed to 7 days after completion", () => {
  const b = tmpBoard();
  seedTwoPairs(b);
  const { trials } = evalReport(b, "Proj");

  // FBF-6 (no experiment label) must not appear
  assert.ok(!trials.some((t) => t.ticket === "FBF-6"));
  assert.equal(trials.length, 5);

  const byTicket = Object.fromEntries(trials.map((t) => [t.ticket, t]));

  const t1 = byTicket["FBF-1"];
  assert.equal(t1.arm, "board");
  assert.equal(t1.pair, "p1");
  assert.equal(t1.status, "Done");
  assert.equal(t1.tokens, 6000); // 4000 + 2000, summed from the work log
  assert.equal(t1.additions, 40);
  assert.equal(t1.deletions, 5);
  assert.equal(t1.wallDays, 2); // 2026-07-01 -> 2026-07-03
  // FBB-1 (day 1) and FBB-2 (day 7, boundary) count; FBB-3 (day 9) and FBB-4 (before completion) don't
  assert.equal(t1.rework, 2);

  const t2 = byTicket["FBF-2"];
  assert.equal(t2.arm, "chat");
  assert.equal(t2.pair, "p1");
  assert.equal(t2.tokens, 30000);
  assert.equal(t2.wallDays, 5);
  assert.equal(t2.rework, 0);

  const t5 = byTicket["FBF-5"];
  assert.equal(t5.arm, "board");
  assert.equal(t5.pair, null); // unpaired
  assert.equal(t5.wallDays, 1);
});

test("evalReport: byArm aggregates medians and totals over Done trials", () => {
  const b = tmpBoard();
  seedTwoPairs(b);
  const { byArm } = evalReport(b, "Proj");

  // board: FBF-1 (6000), FBF-3 (8000), FBF-5 (5000) -> median 6000
  assert.equal(byArm.board.trials, 3);
  assert.equal(byArm.board.done, 3);
  assert.equal(byArm.board.medianTokens, 6000);
  assert.equal(byArm.board.medianWallDays, 1); // wallDays 2, 1, 1 -> median 1
  assert.equal(byArm.board.totalAdditions, 40 + 50 + 30);
  assert.equal(byArm.board.totalDeletions, 5 + 5 + 1);
  assert.equal(byArm.board.reworkTotal, 2); // only FBF-1 has rework

  // chat: FBF-2 (30000), FBF-4 (32000) -> median 31000
  assert.equal(byArm.chat.trials, 2);
  assert.equal(byArm.chat.done, 2);
  assert.equal(byArm.chat.medianTokens, 31000);
  assert.equal(byArm.chat.medianWallDays, 5);
  assert.equal(byArm.chat.reworkTotal, 0);
});

test("evalReport: pairs only include ids present on both arms; unpaired trial excluded", () => {
  const b = tmpBoard();
  seedTwoPairs(b);
  const { pairs } = evalReport(b, "Proj");

  assert.equal(pairs.length, 2);
  const byPair = Object.fromEntries(pairs.map((p) => [p.pair, p]));

  const p1 = byPair.p1;
  assert.equal(p1.board.ticket, "FBF-1");
  assert.equal(p1.chat.ticket, "FBF-2");
  assert.equal(p1.board.tokens, 6000);
  assert.equal(p1.chat.tokens, 30000);
  assert.equal(p1.tokenRatio, 5); // 30000 / 6000

  const p2 = byPair.p2;
  assert.equal(p2.board.tokens, 8000);
  assert.equal(p2.chat.tokens, 32000);
  assert.equal(p2.tokenRatio, 4); // 32000 / 8000

  // the unpaired FBF-5 trial must not surface in any pair
  assert.ok(!pairs.some((p) => p.board.ticket === "FBF-5" || p.chat.ticket === "FBF-5"));
});

test("evalReport: summary reads as a one-line human string reflecting the pairs", () => {
  const b = tmpBoard();
  seedTwoPairs(b);
  const { summary } = evalReport(b, "Proj");
  assert.equal(typeof summary, "string");
  assert.match(summary, /2 paired trials/);
  assert.match(summary, /board median 7k tokens vs chat 31k/);
  assert.match(summary, /rework 2 vs 0/);
});

test("evalReport: a trial with an unrecognized/missing pair partner is not paired, tokenRatio null when a side has zero tokens", () => {
  const b = tmpBoard();
  const features = [
    "- [x] [FBF-1] **Board only pair**: no chat counterpart [Labels: experiment:board, pair:solo] [Created: 2026-07-01 | Completed: 2026-07-02]",
    "- [x] [FBF-2] **Chat zero tokens**: [Labels: experiment:chat, pair:p1] [Created: 2026-07-01 | Completed: 2026-07-02]",
    "- [x] [FBF-3] **Board with tokens**: [Labels: experiment:board, pair:p1] [Created: 2026-07-01 | Completed: 2026-07-02]",
  ];
  fs.writeFileSync(path.join(b.projectDir("Proj"), "featurelist.md"), "# Feature List\n" + features.join("\n") + "\n");
  logWork(b, "Proj", { ticket: "FBF-3", summary: "work", tokens: 1000 });
  // FBF-2 (chat, pair p1) has no work-log entry -> tokens 0

  const { pairs, trials } = evalReport(b, "Proj");
  assert.equal(trials.length, 3);
  // "solo" pair has only a board side -> not in pairs
  assert.ok(!pairs.some((p) => p.pair === "solo"));
  const p1 = pairs.find((p) => p.pair === "p1");
  assert.ok(p1);
  assert.equal(p1.chat.tokens, 0);
  assert.equal(p1.tokenRatio, null); // chat side has 0 tokens -> ratio undefined
});

test("evalReport: empty project yields empty structures without throwing", () => {
  const b = tmpBoard();
  const report = evalReport(b, "Proj");
  assert.deepEqual(report.trials, []);
  assert.deepEqual(report.pairs, []);
  assert.equal(report.byArm.board.trials, 0);
  assert.equal(report.byArm.board.done, 0);
  assert.equal(report.byArm.board.medianTokens, null);
  assert.equal(report.byArm.board.medianWallDays, null);
  assert.equal(report.byArm.board.totalAdditions, 0);
  assert.equal(report.byArm.board.totalDeletions, 0);
  assert.equal(report.byArm.board.reworkTotal, 0);
  assert.equal(report.byArm.chat.trials, 0);
  assert.equal(typeof report.summary, "string");
  assert.match(report.summary, /No experiment trials found/);
});

test("evalReport: unpaired-only project reports trial counts per arm without paired data", () => {
  const b = tmpBoard();
  const features = [
    "- [x] [FBF-1] **Board solo**: [Labels: experiment:board] [Created: 2026-07-01 | Completed: 2026-07-02]",
  ];
  fs.writeFileSync(path.join(b.projectDir("Proj"), "featurelist.md"), "# Feature List\n" + features.join("\n") + "\n");
  const { pairs, byArm, summary } = evalReport(b, "Proj");
  assert.equal(pairs.length, 0);
  assert.equal(byArm.board.trials, 1);
  assert.equal(byArm.chat.trials, 0);
  assert.match(summary, /no paired trials yet/);
});
