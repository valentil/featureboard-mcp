import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGitConfig, commitFeature, buildCommitPlan, DEFAULT_GIT_CONFIG } from "../server/git.js";

// FBMCPB-22 — commit_feature paths param: stage only the given paths so
// concurrent tickets' pending edits aren't swept into this ticket's commit.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbpaths-"));
  return { dir, board: { projectDir: () => dir } };
}

function captureExec(calls) {
  return (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "rev-parse") return { status: 1, stdout: "", stderr: "" }; // skip enrichment
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("buildCommitPlan: explicit paths land in git add --", () => {
  const plan = buildCommitPlan(DEFAULT_GIT_CONFIG, { ticket: "T-1", title: "x", paths: ["a.txt", "src/b.js"] });
  const add = plan.steps.find((s) => s.label === "add");
  assert.deepEqual(add.args, ["add", "--", "a.txt", "src/b.js"]);
});

test("commitFeature: forwards paths to the add step (only those paths staged)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const calls = [];
  const r = commitFeature(board, "P", { ticket: "T-1", title: "x", paths: ["only-mine.js"] }, { cwd: "/repo", exec: captureExec(calls) });
  assert.equal(r.committed, true);
  const add = calls.find((c) => c.args[0] === "add");
  assert.deepEqual(add.args, ["add", "--", "only-mine.js"]);
});

test("commitFeature: no paths still stages the whole repo (back-compat)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const calls = [];
  const r = commitFeature(board, "P", { ticket: "T-1", title: "x" }, { cwd: "/repo", exec: captureExec(calls) });
  assert.equal(r.committed, true);
  const add = calls.find((c) => c.args[0] === "add");
  assert.deepEqual(add.args, ["add", "--", "."]);
});

test("commitFeature: empty paths array behaves like no paths", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const calls = [];
  commitFeature(board, "P", { ticket: "T-1", title: "x", paths: [] }, { cwd: "/repo", exec: captureExec(calls) });
  const add = calls.find((c) => c.args[0] === "add");
  assert.deepEqual(add.args, ["add", "--", "."]);
});
