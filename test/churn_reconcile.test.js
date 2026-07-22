import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork, setProjectConfig } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";
import { reconcileChurn } from "../server/git.js";

// FBMCPF-191 — reconcile logged (self-reported) churn vs git-actual churn.
// Git-actual comes from recorded commit events (FBMCPF-188) whose numbers were
// captured from `git diff --numstat` at commit time, or a live git grep+numstat
// fallback. Logged churn excludes the commit-enrichment work-log lines (they
// carry a hash and hold git-actual numbers, not the agent's self-report).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-churn-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function done(b, title) {
  const t = b.addTask("Proj", "feature", { title });
  b.setStatus("Proj", t.ticketNumber, "Done", "done");
  return t.ticketNumber;
}

test("recorded commit events supply git-actual churn; logged self-report is compared to it", () => {
  const b = tmpBoard();
  const tk = done(b, "Recorded");
  logWork(b, "Proj", { ticket: tk, summary: "work", additions: 100, deletions: 10 });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: "abc1234", hash: "abc1234deadbeef", shortHash: "abc1234", additions: 80, deletions: 6, source: "commit_feature" });

  const r = reconcileChurn(b, "Proj");
  assert.equal(r.count, 1);
  const row = r.tickets[0];
  assert.equal(row.ticket, tk);
  assert.equal(row.gitSource, "recorded");
  assert.equal(row.loggedAdd, 100);
  assert.equal(row.loggedDel, 10);
  assert.equal(row.gitAdd, 80);
  assert.equal(row.gitDel, 6);
  assert.equal(row.driftRatio, Math.round((24 / 86) * 1000) / 1000); // |110-86|/86
});

test("FBMCPB-52: set_status-Done metrics + a log_work with the same churn count ONCE, not doubled", () => {
  const b = tmpBoard();
  const tk = done(b, "Double logged");
  // Real-world flow that produced the 2x drift: set_status Done writes a
  // completion-metadata work-log line, and the agent ALSO calls log_work with
  // the same additions/deletions on the same day.
  logWork(b, "Proj", { ticket: tk, summary: `Completed ${tk}`, additions: 120, deletions: 12, model: "opus" });
  logWork(b, "Proj", { ticket: tk, summary: "did the work", additions: 120, deletions: 12, model: "opus" });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: "h", hash: "hhhh1", shortHash: "h", additions: 120, deletions: 12, source: "commit_feature" });

  const r = reconcileChurn(b, "Proj");
  const row = r.tickets[0];
  assert.equal(row.loggedAdd, 120, "the duplicate set_status/log_work churn must count once, not 240");
  assert.equal(row.loggedDel, 12);
  assert.equal(row.driftRatio, 0, "logged now matches git-actual instead of reading 2x");
});

test("FBMCPB-52: two DISTINCT same-day log_work chunks with different churn still both count", () => {
  const b = tmpBoard();
  const tk = done(b, "Two real chunks");
  logWork(b, "Proj", { ticket: tk, summary: "part 1", additions: 30, deletions: 3 });
  logWork(b, "Proj", { ticket: tk, summary: "part 2", additions: 70, deletions: 7 });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: "h2", hash: "hhhh2", shortHash: "h2", additions: 100, deletions: 10, source: "commit_feature" });
  const r = reconcileChurn(b, "Proj");
  assert.equal(r.tickets[0].loggedAdd, 100, "distinct churn values are not collapsed");
  assert.equal(r.tickets[0].loggedDel, 10);
  assert.equal(r.tickets[0].driftRatio, 0);
});

test("commit-enrichment work-log lines (carrying a hash) are excluded from logged self-report", () => {
  const b = tmpBoard();
  const tk = done(b, "Enrichment excluded");
  logWork(b, "Proj", { ticket: tk, summary: "real self-report", additions: 50, deletions: 5 });
  logWork(b, "Proj", { ticket: tk, summary: "commit", hash: "deadbee", additions: 999, deletions: 999 });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: "deadbee", hash: "deadbee0000", shortHash: "deadbee", additions: 50, deletions: 5, source: "commit_feature" });

  const r = reconcileChurn(b, "Proj");
  const row = r.tickets[0];
  assert.equal(row.loggedAdd, 50, "the 999 enrichment line must not count as self-report");
  assert.equal(row.loggedDel, 5);
  assert.equal(row.gitAdd, 50);
  assert.equal(row.driftRatio, 0);
});

test("a perfect logged-vs-git match yields driftRatio 0 and churnAccuracy 100", () => {
  const b = tmpBoard();
  const tk = done(b, "Exact");
  logWork(b, "Proj", { ticket: tk, summary: "work", additions: 40, deletions: 4 });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: "h", hash: "hhhh", shortHash: "h", additions: 40, deletions: 4, source: "commit_feature" });
  const r = reconcileChurn(b, "Proj");
  assert.equal(r.tickets[0].driftRatio, 0);
  assert.equal(r.totals.churnAccuracy, 100);
});

test("Done tickets with no tagged commits are skipped (nothing to reconcile)", () => {
  const b = tmpBoard();
  const tk = done(b, "No commit");
  logWork(b, "Proj", { ticket: tk, summary: "work", additions: 12, deletions: 2 });
  const r = reconcileChurn(b, "Proj");
  assert.equal(r.count, 0);
  assert.equal(r.totals.churnAccuracy, null);
});

test("grep+numstat fallback (allowGit) via injected exec when no recorded events; allowGit:false skips it", () => {
  const b = tmpBoard();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-churn-repo-"));
  fs.mkdirSync(path.join(repo, ".git")); // make repoUsable true
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const tk = done(b, "Grep only");
  logWork(b, "Proj", { ticket: tk, summary: "work", additions: 30, deletions: 3 });

  const exec = (args) => {
    if (args[0] === "log") return { status: 0, stdout: "hash1\n", stderr: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: "", stderr: "" }; // parent exists
    if (args[0] === "diff") return { status: 0, stdout: "20\t2\tfile.js\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const withGit = reconcileChurn(b, "Proj", { exec });
  assert.equal(withGit.count, 1);
  assert.equal(withGit.tickets[0].gitSource, "git");
  assert.equal(withGit.tickets[0].gitAdd, 20);
  assert.equal(withGit.tickets[0].gitDel, 2);

  const noGit = reconcileChurn(b, "Proj", { exec, allowGit: false });
  assert.equal(noGit.count, 0, "allowGit:false must not shell out; the grep-only ticket is excluded");
});

// FBMCPB-42 — reconcile output is paginated (worst drift first) so a big board
// stays inside the token budget, without distorting the totals rollup.
function reconciled(b, title, { logAdd, logDel, gitAdd, gitDel }) {
  const tk = done(b, title);
  logWork(b, "Proj", { ticket: tk, summary: "work", additions: logAdd, deletions: logDel });
  appendEvent(b, "Proj", { ticket: tk, field: "commit", to: tk, hash: tk + "hash", shortHash: tk, additions: gitAdd, deletions: gitDel, source: "commit_feature" });
  return tk;
}

test("FBMCPB-42: default page is worst-drift-first and capped by limit; totals cover ALL tickets", () => {
  const b = tmpBoard();
  const a = reconciled(b, "Mid drift", { logAdd: 100, logDel: 10, gitAdd: 80, gitDel: 6 });   // |110-86|/86 ≈ 0.279
  const cln = reconciled(b, "Clean", { logAdd: 40, logDel: 4, gitAdd: 40, gitDel: 4 });        // 0
  const worst = reconciled(b, "Worst drift", { logAdd: 200, logDel: 20, gitAdd: 100, gitDel: 10 }); // 1.0

  const all = reconcileChurn(b, "Proj");
  assert.equal(all.count, 3);
  assert.equal(all.matched, 3);
  assert.equal(all.returned, 3);
  assert.deepEqual(all.tickets.map((t) => t.ticket), [worst, a, cln], "worst drift first");
  assert.equal(all.truncated, false);

  // A tiny limit pages the list but leaves the rollup intact.
  const first = reconcileChurn(b, "Proj", { limit: 1 });
  assert.equal(first.returned, 1);
  assert.equal(first.matched, 3);
  assert.equal(first.truncated, true);
  assert.equal(first.tickets[0].ticket, worst, "the single returned row is the worst offender");
  assert.equal(first.totals.churnAccuracy, all.totals.churnAccuracy, "totals must not depend on the page size");
  assert.deepEqual(first.totals, all.totals);

  const second = reconcileChurn(b, "Proj", { limit: 1, offset: 1 });
  assert.equal(second.tickets[0].ticket, a, "offset walks down the worst-first list");
  assert.equal(second.truncated, true);
});

test("FBMCPB-42: driftThreshold omits clean tickets from the page but not from totals; full:true returns everything", () => {
  const b = tmpBoard();
  reconciled(b, "Mid", { logAdd: 100, logDel: 10, gitAdd: 80, gitDel: 6 });   // ≈0.279
  const cln = reconciled(b, "Clean", { logAdd: 40, logDel: 4, gitAdd: 40, gitDel: 4 }); // 0
  reconciled(b, "Worst", { logAdd: 200, logDel: 20, gitAdd: 100, gitDel: 10 }); // 1.0

  const base = reconcileChurn(b, "Proj");
  const filtered = reconcileChurn(b, "Proj", { driftThreshold: 0.2 });
  assert.equal(filtered.matched, 2, "only the two drifting tickets match");
  assert.ok(!filtered.tickets.some((t) => t.ticket === cln), "the clean ticket is omitted from the page");
  assert.equal(filtered.totals.churnAccuracy, base.totals.churnAccuracy, "threshold must not change the rollup");
  assert.equal(filtered.count, 3, "count still reflects every reconciled ticket");

  const full = reconcileChurn(b, "Proj", { limit: 1, full: true });
  assert.equal(full.returned, 3, "full:true ignores limit");
  assert.equal(full.truncated, false);
});
