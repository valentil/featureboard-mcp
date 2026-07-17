// FBMCPF-163 — account-wide + per-project git push mode ("gitMode"):
// resolution precedence (project > global > default), each mode's actual push
// behavior in commitFeature, "ask" never pushing, explicit push always winning,
// get_git_config-style resolved-source reporting, and tolerant global-file parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getGitConfig, setGitConfig, commitFeature,
  getGlobalConfig, setGlobalConfig, resolveGitMode,
  GLOBAL_CONFIG_FILE, DEFAULT_GLOBAL_CONFIG, GIT_MODES,
} from "../server/git.js";
import { setProjectConfig } from "../server/metadata.js";

// A real board-shaped double: dataDir is the root, projectDir nests under it —
// matches storage.js's Board so global-config resolution has somewhere to look.
function tmpBoard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgitmode-"));
  const board = {
    dataDir,
    projectDir(name) {
      const dir = path.join(dataDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
  return { dataDir, board };
}

// ---------------------------------------------------------------------------
// getGlobalConfig / setGlobalConfig
// ---------------------------------------------------------------------------

test("getGlobalConfig defaults to commit-only when no file exists", () => {
  const { board } = tmpBoard();
  assert.deepEqual(getGlobalConfig(board), { gitMode: "commit-only" });
});

test("setGlobalConfig persists gitMode and round-trips", () => {
  const { dataDir, board } = tmpBoard();
  const cfg = setGlobalConfig(board, { gitMode: "commit-push" });
  assert.equal(cfg.gitMode, "commit-push");
  assert.ok(fs.existsSync(path.join(dataDir, GLOBAL_CONFIG_FILE)));
  assert.equal(getGlobalConfig(board).gitMode, "commit-push");
});

test("setGlobalConfig rejects an invalid gitMode", () => {
  const { board } = tmpBoard();
  assert.throws(() => setGlobalConfig(board, { gitMode: "yolo" }), /gitMode must be one of/);
});

test("setGlobalConfig throws clearly when the board has no resolvable dataDir", () => {
  const fakeBoard = { projectDir: () => "/tmp/whatever" };
  assert.throws(() => setGlobalConfig(fakeBoard, { gitMode: "ask" }), /dataDir/);
});

test("getGlobalConfig tolerates a missing dataDir (returns default, never throws)", () => {
  const fakeBoard = { projectDir: () => "/tmp/whatever" };
  assert.deepEqual(getGlobalConfig(fakeBoard), { gitMode: "commit-only" });
});

test("getGlobalConfig tolerates a corrupt (non-JSON) global file", () => {
  const { dataDir, board } = tmpBoard();
  fs.writeFileSync(path.join(dataDir, GLOBAL_CONFIG_FILE), "{ not: valid json,,,");
  assert.deepEqual(getGlobalConfig(board), { gitMode: "commit-only" });
});

test("getGlobalConfig tolerates a global file with an invalid gitMode value (falls back to default)", () => {
  const { dataDir, board } = tmpBoard();
  fs.writeFileSync(path.join(dataDir, GLOBAL_CONFIG_FILE), JSON.stringify({ gitMode: "nonsense" }));
  assert.equal(getGlobalConfig(board).gitMode, "commit-only");
});

test("getGlobalConfig tolerates a global file that isn't a JSON object (e.g. an array)", () => {
  const { dataDir, board } = tmpBoard();
  fs.writeFileSync(path.join(dataDir, GLOBAL_CONFIG_FILE), JSON.stringify([1, 2, 3]));
  assert.deepEqual(getGlobalConfig(board), { gitMode: "commit-only" });
});

// ---------------------------------------------------------------------------
// setGitConfig: gitMode validation at the project level
// ---------------------------------------------------------------------------

test("setGitConfig accepts a valid gitMode and persists it", () => {
  const { board } = tmpBoard();
  const cfg = setGitConfig(board, "P", { gitMode: "ask" });
  assert.equal(cfg.gitMode, "ask");
  assert.equal(getGitConfig(board, "P").gitMode, "ask");
});

test("setGitConfig rejects an invalid gitMode", () => {
  const { board } = tmpBoard();
  assert.throws(() => setGitConfig(board, "P", { gitMode: "sometimes" }), /gitMode must be one of/);
});

test("getGitConfig defaults gitMode to null (inherit) when never set", () => {
  const { board } = tmpBoard();
  assert.equal(getGitConfig(board, "P").gitMode, null);
});

// ---------------------------------------------------------------------------
// resolveGitMode: precedence — project > global > default
// ---------------------------------------------------------------------------

test("resolveGitMode: falls back to the built-in default when nothing is set anywhere", () => {
  const { board } = tmpBoard();
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "commit-only", source: "default" });
});

test("resolveGitMode: an explicitly-set global gitMode wins over the default", () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "commit-push" });
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "commit-push", source: "global" });
});

test("resolveGitMode: a project gitMode wins over an explicit global gitMode", () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "commit-push" });
  setGitConfig(board, "P", { gitMode: "ask" });
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "ask", source: "project" });
});

test("resolveGitMode: a project gitMode wins even when global is unset (falls to default otherwise)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { gitMode: "commit-push" });
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "commit-push", source: "project" });
});

test("resolveGitMode: legacy per-project push:true (pre-gitMode) resolves as project-sourced commit-push", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { push: true });
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "commit-push", source: "project" });
});

test("resolveGitMode: an explicit project gitMode wins over legacy push:true", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { push: true, gitMode: "commit-only" });
  const cfg = getGitConfig(board, "P");
  assert.deepEqual(resolveGitMode(board, "P", cfg), { mode: "commit-only", source: "project" });
});

test("GIT_MODES / DEFAULT_GLOBAL_CONFIG sanity", () => {
  assert.deepEqual(GIT_MODES, ["commit-only", "commit-push", "ask"]);
  assert.equal(DEFAULT_GLOBAL_CONFIG.gitMode, "commit-only");
});

// ---------------------------------------------------------------------------
// commitFeature: actual push behavior per resolved mode
// ---------------------------------------------------------------------------

function seedRepo(dir) {
  const execCalls = [];
  const exec = (args) => { execCalls.push(args); return { status: 0, stdout: "", stderr: "" }; };
  return { exec, execCalls };
}

test("commitFeature: commit-only (default) commits but never pushes when push is omitted", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.equal(r.note, undefined);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit"]);
  assert.equal(r.gitMode.mode, "commit-only");
  assert.equal(r.gitMode.source, "default");
});

test("commitFeature: commit-push (project gitMode) pushes automatically when push is omitted", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "commit-push", remote: "origin", branch: "main" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit", "push"]);
  assert.equal(r.gitMode.mode, "commit-push");
  assert.equal(r.gitMode.source, "project");
});

test("commitFeature: commit-push resolved from the account-wide global config pushes too", () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "commit-push" });
  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.pushed, true);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit", "push"]);
  assert.equal(r.gitMode.source, "global");
});

test('commitFeature: "ask" commits but never pushes, and returns a note asking to confirm', () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "ask" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit"]);
  assert.match(r.note, /ask/i);
  assert.match(r.note, /confirm/i);
  assert.equal(r.gitMode.mode, "ask");
});

test('commitFeature: "ask" resolved from global also never pushes silently', () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "ask" });
  setGitConfig(board, "P", { enabled: true });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.pushed, false);
  assert.ok(!execCalls.some((a) => a[0] === "push"));
  assert.ok(r.note);
});

test("commitFeature: an explicit push:true overrides gitMode commit-only", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true }); // gitMode unset -> default commit-only
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x", push: true }, { cwd: "/repo", exec });
  assert.equal(r.pushed, true);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit", "push"]);
  // explicit push short-circuits resolution entirely — no gitMode info attached
  assert.equal(r.gitMode, undefined);
});

test("commitFeature: an explicit push:false overrides gitMode commit-push (never pushes)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "commit-push" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x", push: false }, { cwd: "/repo", exec });
  assert.equal(r.pushed, false);
  assert.deepEqual(execCalls.map((a) => a[0]), ["add", "commit"]);
  assert.equal(r.note, undefined);
});

test("commitFeature: explicit push:false under ask mode also produces no note (explicit wins outright)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "ask" });
  const { exec } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x", push: false }, { cwd: "/repo", exec });
  assert.equal(r.pushed, false);
  assert.equal(r.note, undefined);
  assert.equal(r.gitMode, undefined);
});

// ---------------------------------------------------------------------------
// get_git_config-equivalent resolved reporting (project vs global vs default)
// ---------------------------------------------------------------------------

test("resolved config reporting: project override reports source project", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { gitMode: "commit-push" });
  const cfg = getGitConfig(board, "P");
  const resolved = resolveGitMode(board, "P", cfg);
  const reported = { ...cfg, resolvedGitMode: resolved.mode, gitModeSource: resolved.source };
  assert.equal(reported.gitMode, "commit-push"); // raw project value
  assert.equal(reported.resolvedGitMode, "commit-push");
  assert.equal(reported.gitModeSource, "project");
});

test("resolved config reporting: unset project + set global reports source global, raw project gitMode stays null", () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "ask" });
  const cfg = getGitConfig(board, "P");
  const resolved = resolveGitMode(board, "P", cfg);
  assert.equal(cfg.gitMode, null);
  assert.equal(resolved.mode, "ask");
  assert.equal(resolved.source, "global");
});

test("resolved config reporting: nothing set anywhere reports source default", () => {
  const { board } = tmpBoard();
  const cfg = getGitConfig(board, "P");
  const resolved = resolveGitMode(board, "P", cfg);
  assert.equal(resolved.mode, "commit-only");
  assert.equal(resolved.source, "default");
});

// ---------------------------------------------------------------------------
// Independence: two different projects under the same board can have different
// resolved modes, and the global default applies to whichever hasn't overridden.
// ---------------------------------------------------------------------------

test("two projects resolve independently: one project override, one falling through to global", () => {
  const { board } = tmpBoard();
  setGlobalConfig(board, { gitMode: "commit-push" });
  setGitConfig(board, "A", { gitMode: "commit-only" });
  // project B sets no override -> inherits global
  setGitConfig(board, "B", { enabled: true });

  const cfgA = getGitConfig(board, "A");
  const cfgB = getGitConfig(board, "B");
  assert.deepEqual(resolveGitMode(board, "A", cfgA), { mode: "commit-only", source: "project" });
  assert.deepEqual(resolveGitMode(board, "B", cfgB), { mode: "commit-push", source: "global" });
});

// sanity: setProjectConfig import used to keep parity with git.test.js patterns
// (not required by these tests, but confirms metadata.js still loads cleanly
// alongside git.js's new exports).
test("metadata.setProjectConfig still works alongside the new gitMode exports", () => {
  const { board } = tmpBoard();
  const cfg = setProjectConfig(board, "P", { codeLocation: "/repo" });
  assert.equal(cfg.codeLocation, "/repo");
});
