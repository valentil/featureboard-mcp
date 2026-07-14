import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getGitConfig, setGitConfig, commitMessage, buildCommitPlan, commitFeature,
  GIT_CONFIG_FILE, DEFAULT_GIT_CONFIG,
} from "../server/git.js";

// FBMCPF-65 — configurable per-project git integration

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-"));
  return { dir, board: { projectDir: () => dir } };
}

test("git integration is disabled by default", () => {
  const { board } = tmpBoard();
  assert.equal(getGitConfig(board, "P").enabled, false);
  assert.equal(getGitConfig(board, "P").remote, "origin");
});

test("setGitConfig persists and validates", () => {
  const { dir, board } = tmpBoard();
  const c = setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "master", push: true });
  assert.equal(c.enabled, true);
  assert.equal(c.branch, "master");
  assert.equal(c.push, true);
  assert.ok(fs.existsSync(path.join(dir, GIT_CONFIG_FILE)));
  assert.equal(getGitConfig(board, "P").enabled, true); // round-trips
  assert.throws(() => setGitConfig(board, "P", { remote: "  " }), /remote must be non-empty/);
});

test("commitMessage: explicit wins, else ticket: title, with prefix", () => {
  assert.equal(commitMessage({ ticket: "FBMCPF-65", title: "Git" }), "FBMCPF-65: Git");
  assert.equal(commitMessage({ message: "custom", messagePrefix: "[fb] " }), "[fb] custom");
  assert.throws(() => commitMessage({}), /required/);
});

test("buildCommitPlan yields add/commit, push only when requested", () => {
  const cfg = { ...DEFAULT_GIT_CONFIG, remote: "origin", branch: "main" };
  const noPush = buildCommitPlan(cfg, { ticket: "FBMCPF-65", title: "Git" });
  assert.deepEqual(noPush.steps.map((s) => s.label), ["add", "commit"]);
  assert.deepEqual(noPush.steps[0].args, ["add", "--", "."]);
  assert.deepEqual(noPush.steps[1].args, ["commit", "-m", "FBMCPF-65: Git"]);

  const withPush = buildCommitPlan(cfg, { ticket: "T", title: "x", push: true, paths: ["featureboard-mcp"] });
  assert.deepEqual(withPush.steps.map((s) => s.label), ["add", "commit", "push"]);
  assert.deepEqual(withPush.steps[0].args, ["add", "--", "featureboard-mcp"]);
  assert.deepEqual(withPush.steps[2].args, ["push", "origin", "main"]);
});

test("commitFeature no-ops when disabled", () => {
  const { board } = tmpBoard();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec: () => { throw new Error("should not run"); } });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /disabled/);
});

test("commitFeature runs steps via injected exec and reports success", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, push: true, branch: "main", remote: "origin" });
  const calls = [];
  const exec = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "ok", stderr: "" }; };
  const r = commitFeature(board, "P", { ticket: "FBMCPF-65", title: "Git" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.equal(r.message, "FBMCPF-65: Git");
  assert.deepEqual(calls.map((c) => c.args[0]), ["add", "commit", "push"]);
  assert.equal(calls[0].cwd, "/repo");
});

test("commitFeature stops at first failing step", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const exec = (args) => (args[0] === "commit" ? { status: 1, stdout: "", stderr: "nothing to commit" } : { status: 0, stdout: "", stderr: "" });
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, false);
  assert.equal(r.failedAt, "commit");
  assert.match(r.results.find((s) => s.step === "commit").stderr, /nothing to commit/);
});

test("commitFeature requires a cwd when enabled", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  assert.throws(() => commitFeature(board, "P", { ticket: "T", title: "x" }, { exec: () => ({ status: 0 }) }), /code repo path/);
});
