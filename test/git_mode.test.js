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
  hasCommitForTicket, evaluateCommitGate,
} from "../server/git.js";
import { setProjectConfig } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";

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
  // the plan's own steps run first, in order; FBMCPF-188's commit-info
  // enrichment (rev-parse/diff --numstat) runs afterward — see git.test.js.
  assert.deepEqual(execCalls.slice(0, 2).map((a) => a[0]), ["add", "commit"]);
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
  assert.deepEqual(execCalls.slice(0, 3).map((a) => a[0]), ["add", "commit", "push"]);
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
  assert.deepEqual(execCalls.slice(0, 3).map((a) => a[0]), ["add", "commit", "push"]);
  assert.equal(r.gitMode.source, "global");
});

test('commitFeature: "ask" commits but never pushes, and returns a note asking to confirm', () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "ask" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.deepEqual(execCalls.slice(0, 2).map((a) => a[0]), ["add", "commit"]);
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
  assert.deepEqual(execCalls.slice(0, 3).map((a) => a[0]), ["add", "commit", "push"]);
  // explicit push short-circuits resolution entirely — no gitMode info attached
  assert.equal(r.gitMode, undefined);
});

test("commitFeature: an explicit push:false overrides gitMode commit-push (never pushes)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, gitMode: "commit-push" });
  const { exec, execCalls } = seedRepo();
  const r = commitFeature(board, "P", { ticket: "T", title: "x", push: false }, { cwd: "/repo", exec });
  assert.equal(r.pushed, false);
  assert.deepEqual(execCalls.slice(0, 2).map((a) => a[0]), ["add", "commit"]);
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

// ---------------------------------------------------------------------------
// FBMCPF-189: Done-without-commit correlation — hasCommitForTicket
// ---------------------------------------------------------------------------

// Makes resolveGitTargets(board, "P") resolve to a repo dir with a `.git`
// directory (so hasCommitForTicket's existsSync gate passes) without ever
// shelling out for real — the git log call itself is always the injected exec.
function seedCodeRepo(board, dataDir) {
  const repo = path.join(dataDir, "coderepo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  setProjectConfig(board, "P", { codeLocation: repo });
  return repo;
}

test("hasCommitForTicket: a recorded commit event is found without any git call", () => {
  const { board } = tmpBoard();
  appendEvent(board, "P", { ticket: "T-1", field: "commit", hash: "abc123def456", shortHash: "abc123de" });
  let execCalled = false;
  const exec = () => { execCalled = true; return { status: 0, stdout: "", stderr: "" }; };
  const r = hasCommitForTicket(board, "P", "T-1", { exec });
  assert.equal(r.found, true);
  assert.equal(r.unknown, false);
  assert.equal(r.source, "recorded");
  assert.equal(execCalled, false);
});

test("hasCommitForTicket: no recorded commit, git log --grep finds one -> found via grep", () => {
  const { board, dataDir } = tmpBoard();
  const repo = seedCodeRepo(board, dataDir);
  const exec = (args, cwd) => {
    assert.equal(cwd, repo);
    assert.deepEqual(args.slice(0, 2), ["log", "--fixed-strings"]);
    return { status: 0, stdout: "deadbeef\n", stderr: "" };
  };
  const r = hasCommitForTicket(board, "P", "T-2", { exec });
  assert.equal(r.found, true);
  assert.equal(r.unknown, false);
  assert.equal(r.source, "grep");
  assert.equal(r.shortHash, "deadbeef");
});

test("hasCommitForTicket: no recorded commit, git log --grep finds nothing -> found:false, unknown:false", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  const exec = () => ({ status: 0, stdout: "", stderr: "" });
  const r = hasCommitForTicket(board, "P", "T-3", { exec });
  assert.equal(r.found, false);
  assert.equal(r.unknown, false);
});

test("hasCommitForTicket: no codeLocation configured -> unknown:true (can't tell, not a refusal)", () => {
  const { board } = tmpBoard();
  const r = hasCommitForTicket(board, "P", "T-4");
  assert.equal(r.found, false);
  assert.equal(r.unknown, true);
});

test("hasCommitForTicket: git log fails (non-zero exit) -> unknown:true", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  const exec = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const r = hasCommitForTicket(board, "P", "T-5", { exec });
  assert.equal(r.found, false);
  assert.equal(r.unknown, true);
});

test("hasCommitForTicket: an exec that throws is swallowed -> unknown:true", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  const exec = () => { throw new Error("spawn ENOENT"); };
  const r = hasCommitForTicket(board, "P", "T-6", { exec });
  assert.equal(r.found, false);
  assert.equal(r.unknown, true);
});

// ---------------------------------------------------------------------------
// FBMCPF-189: evaluateCommitGate — the set_status Done-without-commit
// warning/refusal decision (config fixture pattern from above, reused).
// ---------------------------------------------------------------------------

test("evaluateCommitGate: git disabled for the project -> silent no-op regardless of requireCommitOnDone", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir); // repo exists but git.config.json is never enabled
  setProjectConfig(board, "P", { requireCommitOnDone: true });
  const gate = evaluateCommitGate(board, "P", "T-10");
  assert.deepEqual(gate, { missingCommit: false, refuse: false });
});

test("evaluateCommitGate: git enabled, a recorded commit exists -> no warning, no refusal", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  setGitConfig(board, "P", { enabled: true });
  setProjectConfig(board, "P", { requireCommitOnDone: true }); // even with the strict gate on
  appendEvent(board, "P", { ticket: "T-11", field: "commit", hash: "1234567890ab" });
  const gate = evaluateCommitGate(board, "P", "T-11");
  assert.deepEqual(gate, { missingCommit: false, refuse: false });
});

// A deterministic "git log --grep found nothing" double, so these gate tests
// don't depend on `coderepo` being a real (git-initialized) repository.
const noCommitExec = () => ({ status: 0, stdout: "", stderr: "" });

test("evaluateCommitGate: git enabled, no commit, requireCommitOnDone off (default) -> warning only", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  setGitConfig(board, "P", { enabled: true });
  const gate = evaluateCommitGate(board, "P", "T-12", { exec: noCommitExec });
  assert.equal(gate.missingCommit, true);
  assert.equal(gate.refuse, false);
  assert.equal(gate.error, undefined);
});

test("evaluateCommitGate: git enabled, no commit, requireCommitOnDone on -> refusal with a clear error", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  setGitConfig(board, "P", { enabled: true });
  setProjectConfig(board, "P", { requireCommitOnDone: true });
  const gate = evaluateCommitGate(board, "P", "T-13", { exec: noCommitExec });
  assert.equal(gate.missingCommit, true);
  assert.equal(gate.refuse, true);
  assert.match(gate.error, /requireCommitOnDone/);
  assert.match(gate.error, /T-13/);
});

test("evaluateCommitGate: requireCommitOnDone on but approve:true overrides the refusal (still flags missingCommit)", () => {
  const { board, dataDir } = tmpBoard();
  seedCodeRepo(board, dataDir);
  setGitConfig(board, "P", { enabled: true });
  setProjectConfig(board, "P", { requireCommitOnDone: true });
  const gate = evaluateCommitGate(board, "P", "T-14", { approve: true, exec: noCommitExec });
  assert.equal(gate.missingCommit, true);
  assert.equal(gate.refuse, false);
});

test("evaluateCommitGate: git enabled but no codeLocation/repo (unknown result) -> never refuses, even with requireCommitOnDone on", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  setProjectConfig(board, "P", { requireCommitOnDone: true });
  const gate = evaluateCommitGate(board, "P", "T-15");
  assert.deepEqual(gate, { missingCommit: false, refuse: false });
});

test("evaluateCommitGate: git never configured at all (fresh project) -> silent no-op (non-git path untouched)", () => {
  const { board } = tmpBoard();
  const gate = evaluateCommitGate(board, "P", "T-16");
  assert.deepEqual(gate, { missingCommit: false, refuse: false });
});
