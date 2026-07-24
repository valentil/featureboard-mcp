import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runChecksPipeline } from "../scripts/run-checks.mjs";
import {
  startChecks, getCheckResults, evaluateChecksGate, resolveChecksConfig, stageRunner, pruneRuns,
} from "../server/checks.js";
import { setProjectConfig } from "../server/metadata.js";
import { eventsForTicket } from "../server/events.js";
import { Board } from "../server/storage.js";

// FBMCPF-261 — async background static-check runner.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FBMCPB-39 — the runner is executed from a copy staged in the project's own
// checks dir, not directly from the app-managed bundle (which triggers desktop
// file-preview/security popups on some hosts).
test("FBMCPB-39: stageRunner copies the runner into the target dir and runs from there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbchecks-stage-"));
  const staged = stageRunner(dir);
  assert.equal(path.dirname(staged), dir, "runner is staged in the given (user-owned) dir, not the app bundle");
  assert.equal(path.basename(staged), "run-checks.mjs");
  assert.ok(fs.existsSync(staged), "staged runner file exists");
  assert.match(fs.readFileSync(staged, "utf8"), /run-checks\.mjs .* standalone background static-check runner/,
    "staged copy is the real runner");
});

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbchecks-board-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbchecks-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}
function commit(dir, files, msg) {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function tmpResults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbchecks-out-"));
  return path.join(dir, "run.json");
}

// (a) in-process pipeline -----------------------------------------------------

test("pipeline: passing syntax check on a changed good file", () => {
  const repo = initRepo();
  commit(repo, { "good.js": "const x = 1;\n" }, "init");
  const rev = commit(repo, { "good.js": "const x = 2;\n" }, "change");
  const resultsFile = tmpResults();
  const res = runChecksPipeline({
    runId: "r-good", repo, resultsFile, revision: rev, ticket: "FBF-1", project: "Proj",
    checks: { syntaxCheckChangedFiles: true, commands: [] },
  });
  assert.equal(res.status, "passed");
  const syntax = res.checks.find((c) => c.type === "syntax" && c.file === "good.js");
  assert.ok(syntax, "a syntax check for good.js is present");
  assert.equal(syntax.status, "passed");
  assert.equal(res.summary.failed, 0);
  // progressive/final file shape on disk
  const onDisk = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  assert.equal(onDisk.status, "passed");
  assert.ok(onDisk.startedAt && onDisk.finishedAt, "carries startedAt + finishedAt");
  assert.equal(typeof onDisk.durationMs, "number");
});

test("pipeline: failing syntax check on a file with a syntax error", () => {
  const repo = initRepo();
  commit(repo, { "good.js": "const x = 1;\n" }, "init");
  const rev = commit(repo, { "bad.js": "const y = ;\n" }, "add bad"); // deliberate syntax error
  const resultsFile = tmpResults();
  const res = runChecksPipeline({
    runId: "r-bad", repo, resultsFile, revision: rev, ticket: "FBF-2", project: "Proj",
    checks: { syntaxCheckChangedFiles: true, commands: [] },
  });
  assert.equal(res.status, "failed");
  const bad = res.checks.find((c) => c.file === "bad.js");
  assert.equal(bad.status, "failed");
  assert.ok(bad.output.length > 0, "captured node --check stderr output");
});

test("pipeline: configured command failure + per-check output capture", () => {
  const repo = initRepo();
  commit(repo, { "a.txt": "hi" }, "init");
  const resultsFile = tmpResults();
  const res = runChecksPipeline({
    runId: "r-cmd", repo, resultsFile, revision: null, project: "Proj",
    checks: {
      syntaxCheckChangedFiles: false,
      commands: [
        { name: "ok", command: 'node -e "process.exit(0)"' },
        { name: "echoer", command: "echo hello-from-check" },
        { name: "boom", command: 'node -e "process.exit(1)"' },
      ],
    },
  });
  assert.equal(res.status, "failed");
  assert.equal(res.summary.total, 3);
  assert.equal(res.checks.find((c) => c.name === "ok").status, "passed");
  assert.equal(res.checks.find((c) => c.name === "boom").status, "failed");
  assert.match(res.checks.find((c) => c.name === "echoer").output, /hello-from-check/);
});

// (b) real detached spawn -----------------------------------------------------

test("startChecks spawns a detached runner that finishes to a terminal status", async () => {
  const board = tmpBoard();
  const repo = initRepo();
  commit(repo, { "a.txt": "hi" }, "init");
  setProjectConfig(board, "Proj", { codeLocation: repo });

  const started = startChecks(board, "Proj", {
    ticket: "FBF-3",
    checks: { syntaxCheckChangedFiles: false, commands: [{ name: "noop", command: 'node -e "process.exit(0)"' }] },
  });
  assert.equal(started.started, true);
  assert.ok(started.runId, "returns a runId immediately");

  // FBMCPF-339: the pad's .featureboard/ carries a `*` .gitignore so runner
  // artifacts never get committed to the projectpad repo.
  const giPath = path.join(board.projectDir("Proj"), ".featureboard", ".gitignore");
  assert.ok(fs.existsSync(giPath), ".featureboard/.gitignore written");
  assert.match(fs.readFileSync(giPath, "utf8"), /^\*/, "ignores everything under .featureboard/");

  let final = null;
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    if (fs.existsSync(started.resultsFile)) {
      const r = JSON.parse(fs.readFileSync(started.resultsFile, "utf8"));
      if (r.status === "passed" || r.status === "failed" || r.status === "error") { final = r; break; }
    }
    await sleep(100);
  }
  assert.ok(final, "detached run reached a terminal status within 9s");
  assert.equal(final.status, "passed");
  assert.equal(final.ticket, "FBF-3");
});

// (c) getCheckResults + audit event -------------------------------------------

function placeRun(board, project, run) {
  const dir = path.join(board.projectDir(project), ".featureboard", "checks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2) + "\n");
}

test("getCheckResults: by runId + latest-for-ticket + single audit event on collect", () => {
  const board = tmpBoard();
  const runId = "1700000000000-aaa";
  placeRun(board, "Proj", {
    runId, status: "failed", project: "Proj", ticket: "FBF-9",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    checks: [
      { name: "syntax:bad.js", type: "syntax", status: "failed", output: "SyntaxError" },
      { name: "ok", type: "command", status: "passed", output: "" },
    ],
    summary: { total: 2, passed: 1, failed: 1 },
  });

  // by runId
  const r1 = getCheckResults(board, "Proj", { runId });
  assert.equal(r1.found, true);
  assert.equal(r1.status, "failed");
  assert.equal(typeof r1.ageSeconds, "number");

  // audit event written exactly once
  const ev1 = eventsForTicket(board, "Proj", "FBF-9").filter((e) => e.field === "checks");
  assert.equal(ev1.length, 1);
  assert.equal(ev1[0].runId, runId);
  assert.deepEqual(ev1[0].failedChecks, ["syntax:bad.js"]);

  // collecting again does NOT duplicate the event
  getCheckResults(board, "Proj", { runId });
  const ev2 = eventsForTicket(board, "Proj", "FBF-9").filter((e) => e.field === "checks");
  assert.equal(ev2.length, 1, "checks audit event is deduped via collected marker");

  // latest-for-ticket resolution
  const rt = getCheckResults(board, "Proj", { ticket: "FBF-9" });
  assert.equal(rt.runId, runId);

  // unknown runId → not found
  assert.equal(getCheckResults(board, "Proj", { runId: "nope" }).found, false);
});

// (d) requireChecksOnDone gate ------------------------------------------------

test("requireChecksOnDone gate: refuses on fail, approve overrides, passes when green, note when running", () => {
  const board = tmpBoard();
  setProjectConfig(board, "Proj", { requireChecksOnDone: true });

  placeRun(board, "Proj", {
    runId: "run-fail", status: "failed", project: "Proj", ticket: "FBF-5",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    checks: [{ name: "syntax:bad.js", status: "failed" }], summary: { total: 1, passed: 0, failed: 1 },
  });
  const g = evaluateChecksGate(board, "Proj", "FBF-5", { approve: false });
  assert.equal(g.refuse, true);
  assert.match(g.error, /requireChecksOnDone/);
  // approve:true overrides
  assert.equal(evaluateChecksGate(board, "Proj", "FBF-5", { approve: true }).refuse, false);

  // green run → no refusal
  placeRun(board, "Proj", {
    runId: "run-pass", status: "passed", project: "Proj", ticket: "FBF-6",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    checks: [{ name: "ok", status: "passed" }], summary: { total: 1, passed: 1, failed: 0 },
  });
  assert.equal(evaluateChecksGate(board, "Proj", "FBF-6", { approve: false }).refuse, false);

  // still-running run → allow with a note, never block
  placeRun(board, "Proj", {
    runId: "run-live", status: "running", project: "Proj", ticket: "FBF-7",
    startedAt: new Date().toISOString(), checks: [],
  });
  const gr = evaluateChecksGate(board, "Proj", "FBF-7", { approve: false });
  assert.equal(gr.refuse, false);
  assert.ok(gr.note, "pending run surfaces a note instead of blocking");

  // ticket with no run at all → no gate
  assert.equal(evaluateChecksGate(board, "Proj", "FBF-99", { approve: false }).refuse, false);

  // flag off → no gate even on a failed run
  const board2 = tmpBoard();
  placeRun(board2, "Proj", {
    runId: "run-fail2", status: "failed", project: "Proj", ticket: "FBF-5",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    checks: [{ name: "x", status: "failed" }], summary: { total: 1, passed: 0, failed: 1 },
  });
  assert.equal(evaluateChecksGate(board2, "Proj", "FBF-5", { approve: false }).refuse, false);
});

// (e) config resolution -------------------------------------------------------

test("resolveChecksConfig: null without package.json, default with it, explicit config wins", () => {
  const board = tmpBoard();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fbchecks-code-"));
  setProjectConfig(board, "Proj", { codeLocation: repo });

  // no checks config + no package.json → null
  assert.equal(resolveChecksConfig(board, "Proj"), null);

  // package.json present → cheap syntax-only default
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  const def = resolveChecksConfig(board, "Proj");
  assert.equal(def.source, "default");
  assert.equal(def.syntaxCheckChangedFiles, true);
  assert.equal(def.commands.length, 0);
  assert.equal(def.autoOnCommit, true);

  // explicit config wins + normalizes
  setProjectConfig(board, "Proj", { checks: { autoOnCommit: false, commands: [{ name: "lint", command: "true" }] } });
  const cfg = resolveChecksConfig(board, "Proj");
  assert.equal(cfg.source, "config");
  assert.equal(cfg.autoOnCommit, false);
  assert.equal(cfg.commands.length, 1);
  assert.equal(cfg.syntaxCheckChangedFiles, true);
});

test("FBMCPF-339: pruneRuns keeps the newest N runs and their .args.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbprune-"));
  for (let i = 0; i < 25; i++) {
    const runId = `17000000000${String(i).padStart(2, "0")}-abc`;
    fs.writeFileSync(path.join(dir, `${runId}.json`), "{}");
    fs.writeFileSync(path.join(dir, `${runId}.args.json`), "{}");
  }
  pruneRuns(dir, 20);
  const results = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".args.json"));
  assert.equal(results.length, 20, "kept the 20 newest result files");
  // oldest removed (result + args), newest kept
  assert.ok(!fs.existsSync(path.join(dir, "1700000000000-abc.json")));
  assert.ok(!fs.existsSync(path.join(dir, "1700000000000-abc.args.json")));
  assert.ok(fs.existsSync(path.join(dir, "1700000000024-abc.json")));
});
