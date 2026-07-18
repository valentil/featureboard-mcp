import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  getGitConfig, setGitConfig, commitMessage, buildCommitPlan, commitFeature,
  mirrorGraduatedPad, captureCommitInfo, GIT_CONFIG_FILE, DEFAULT_GIT_CONFIG,
  parseClosingRefs, autoStatusFromCommit,
} from "../server/git.js";
import { setProjectConfig } from "../server/metadata.js";
import { recordedCommitsForTicket } from "../server/events.js";
import { Board } from "../server/storage.js";

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
  // add/commit/push happen first, in order; commit-info enrichment (rev-parse,
  // diff --numstat) runs afterward — see the FBMCPF-188 tests below.
  assert.deepEqual(calls.slice(0, 3).map((c) => c.args[0]), ["add", "commit", "push"]);
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

// FBMCPF-151 — pad mirror on close-out: snapshot the projectpad into
// <codeRepo>/.featureboard/ for graduated projects, on commit_feature (and,
// separately, on set_status Done via the shared mirrorGraduatedPad helper).

function seedPad(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

test("mirrorGraduatedPad: skipped for non-graduated (incubating) projects", () => {
  const { board } = tmpBoard();
  const r = mirrorGraduatedPad(board, "P", { stage: "incubating", codeRepo: { path: "/anywhere" } });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /not graduated/);
});

test("mirrorGraduatedPad: skipped when no code repo path is configured", () => {
  const { board } = tmpBoard();
  const r = mirrorGraduatedPad(board, "P", { stage: "graduated", codeRepo: { path: null } });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no code repo/);
});

test("mirrorGraduatedPad: copies pad files + config into <codeRepo>/.featureboard/", () => {
  const { dir, board } = tmpBoard();
  seedPad(dir, {
    "featurelist.md": "# Features\n",
    "buglist.md": "# Bugs\n",
    "scratchpad.md": "notes\n",
    "agent_work_log.md": "log\n",
    "project_config.json": "{}\n",
  });
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-mirror-"));
  const r = mirrorGraduatedPad(board, "P", { stage: "graduated", codeRepo: { path: codeCwd } });
  assert.ok(!r.skipped);
  assert.ok(!r.warning);
  for (const f of ["featurelist.md", "buglist.md", "scratchpad.md", "agent_work_log.md", "project_config.json"]) {
    assert.ok(fs.existsSync(path.join(codeCwd, ".featureboard", f)), `${f} mirrored`);
    assert.ok(r.mirrored.includes(`.featureboard/${f}`) || r.mirrored.includes(path.join(".featureboard", f)));
  }
  assert.equal(
    fs.readFileSync(path.join(codeCwd, ".featureboard", "featurelist.md"), "utf8"),
    "# Features\n"
  );
});

test("mirrorGraduatedPad: tolerates missing pad files (mirrors what exists)", () => {
  const { board } = tmpBoard(); // no pad files written at all
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-mirror-empty-"));
  const r = mirrorGraduatedPad(board, "P", { stage: "graduated", codeRepo: { path: codeCwd } });
  assert.ok(!r.skipped);
  assert.ok(!r.warning);
  assert.deepEqual(r.mirrored, []);
});

test("mirrorGraduatedPad: a copy failure is reported as a warning, never thrown", () => {
  const { dir, board } = tmpBoard();
  seedPad(dir, { "featurelist.md": "# Features\n" });
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-mirror-fail-"));
  // Put a plain FILE where the mirror needs to create a directory, so mkdirSync throws.
  fs.writeFileSync(path.join(codeCwd, ".featureboard"), "not a directory\n");
  const r = mirrorGraduatedPad(board, "P", { stage: "graduated", codeRepo: { path: codeCwd } });
  assert.ok(!r.skipped);
  assert.ok(r.warning, "failure surfaces as a warning");
  assert.match(r.warning, /pad mirror failed/);
});

test("commitFeature: mirrors the pad into .featureboard/ and includes it for graduated projects", () => {
  const { dir, board } = tmpBoard();
  seedPad(dir, {
    "featurelist.md": "# Features\n",
    "buglist.md": "# Bugs\n",
  });
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-commit-grad-"));
  setProjectConfig(board, "P", { stage: "graduated", gitTargets: { codeRepo: { path: codeCwd } } });
  setGitConfig(board, "P", { enabled: true });

  const calls = [];
  const exec = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "ok", stderr: "" }; };
  const r = commitFeature(board, "P", { ticket: "FBMCPF-151", title: "Pad mirror" }, { exec });

  assert.equal(r.committed, true);
  assert.ok(r.padMirror && !r.padMirror.skipped);
  assert.ok(fs.existsSync(path.join(codeCwd, ".featureboard", "featurelist.md")));
  assert.ok(fs.existsSync(path.join(codeCwd, ".featureboard", "buglist.md")));
  // the mirrored files land in the code repo BEFORE "git add ." runs there
  assert.equal(calls[0].args[0], "add");
  assert.equal(calls[0].cwd, codeCwd);
});

test("commitFeature: pad mirror is skipped (and no .featureboard/ created) for non-graduated projects", () => {
  const { dir, board } = tmpBoard();
  seedPad(dir, { "featurelist.md": "# Features\n" });
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-commit-incub-"));
  setProjectConfig(board, "P", { codeLocation: codeCwd }); // stage defaults to "incubating"
  setGitConfig(board, "P", { enabled: true });
  const exec = () => ({ status: 0, stdout: "", stderr: "" });
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { exec });
  assert.equal(r.committed, true);
  assert.equal(r.padMirror, undefined);
  assert.equal(fs.existsSync(path.join(codeCwd, ".featureboard")), false);
});

test("commitFeature: a pad-mirror failure warns but never blocks the code commit", () => {
  const { dir, board } = tmpBoard();
  seedPad(dir, { "featurelist.md": "# Features\n" });
  const codeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-commit-fail-"));
  fs.writeFileSync(path.join(codeCwd, ".featureboard"), "not a directory\n");
  setProjectConfig(board, "P", { stage: "graduated", gitTargets: { codeRepo: { path: codeCwd } } });
  setGitConfig(board, "P", { enabled: true });
  const exec = () => ({ status: 0, stdout: "", stderr: "" });
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { exec });
  assert.equal(r.committed, true, "the code commit still succeeds despite the mirror failure");
  assert.ok(r.padMirror.warning);
  assert.match(r.warning, /pad mirror failed/);
});

// FBMCPF-188 — commit_feature captures the commit it just produced (hash +
// line stats) and records it onto the ticket instead of leaving correlation
// to grep-only get_ticket_diff lookups.

function realGitExec(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function realRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-realrepo-"));
  realGitExec(["init", "-q"], repo);
  realGitExec(["config", "user.email", "t@t.dev"], repo);
  realGitExec(["config", "user.name", "Tester"], repo);
  realGitExec(["config", "commit.gpgsign", "false"], repo);
  return repo;
}

test("captureCommitInfo: guards the root-commit case (no HEAD^) and still reports line stats", () => {
  const repo = realRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "line1\nline2\n");
  realGitExec(["add", "-A"], repo);
  realGitExec(["commit", "-q", "-m", "root commit"], repo);

  const info = captureCommitInfo(realGitExec, repo);
  assert.ok(info);
  assert.equal(info.hash.length, 40);
  assert.equal(info.shortHash, info.hash.slice(0, 8));
  assert.equal(info.additions, 2);
  assert.equal(info.deletions, 0);
});

test("captureCommitInfo: reports additions/deletions for a normal (non-root) commit", () => {
  const repo = realRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "line1\n");
  realGitExec(["add", "-A"], repo);
  realGitExec(["commit", "-q", "-m", "first"], repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "line1\nline2\nline3\n");
  realGitExec(["add", "-A"], repo);
  realGitExec(["commit", "-q", "-m", "second"], repo);

  const info = captureCommitInfo(realGitExec, repo);
  assert.equal(info.additions, 2);
  assert.equal(info.deletions, 0);
});

test("captureCommitInfo: returns null (never throws) when rev-parse fails", () => {
  const info = captureCommitInfo(() => ({ status: 1, stdout: "", stderr: "fatal: not a git repository" }), "/nowhere");
  assert.equal(info, null);
});

test("commitFeature: FBMCPF-188 enrichment records the commit hash + stats onto the ticket's work log and events.jsonl", () => {
  const { board, dir } = tmpBoard();
  const repo = realRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\nworld\n");
  setGitConfig(board, "P", { enabled: true });

  const r = commitFeature(board, "P", { ticket: "FBMCPF-188", title: "Correlation" }, { cwd: repo });
  assert.equal(r.committed, true);
  assert.ok(r.commit);
  assert.equal(r.commit.hash.length, 40);
  assert.equal(r.commit.shortHash, r.commit.hash.slice(0, 8));
  assert.equal(r.commit.additions, 2);
  assert.equal(r.commit.deletions, 0);

  // the work-log line for this ticket now carries the commit hash
  const workLog = fs.readFileSync(path.join(dir, "agent_work_log.md"), "utf8");
  assert.match(workLog, new RegExp(`Task: FBMCPF-188.*commit:${r.commit.shortHash}`));
  assert.match(workLog, /Add: 2, Del: 0/);

  // events.jsonl carries a "commit" event with the full hash + stats
  const recorded = recordedCommitsForTicket(board, "P", "FBMCPF-188");
  assert.deepEqual(recorded, [r.commit.hash]);
});

test("commitFeature: commit info is still captured without a ticket, but nothing is logged/recorded", () => {
  const { board, dir } = tmpBoard();
  const repo = realRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  setGitConfig(board, "P", { enabled: true });

  const r = commitFeature(board, "P", { title: "no ticket" }, { cwd: repo });
  assert.equal(r.committed, true);
  assert.ok(r.commit);
  assert.equal(fs.existsSync(path.join(dir, "agent_work_log.md")), false);
});

test("commitFeature: a failing commit-info capture never fails the commit result (guarded)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true });
  const exec = (args) => {
    if (args[0] === "rev-parse") return { status: 1, stdout: "", stderr: "fatal: bad revision" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const r = commitFeature(board, "P", { ticket: "T", title: "x" }, { cwd: "/repo", exec });
  assert.equal(r.committed, true);
  assert.equal(r.commit, undefined);
});


// FBMCPF-200 — auto-status-on-commit (GitHub-style "closes FBB-12").

function realBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgit-real-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// exec that satisfies commitFeature's add/commit + FBMCPF-188 enrichment calls
function okExec() {
  return (args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: "", stderr: "" }; // parent exists
    if (args[0] === "diff") return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" }; // add / commit
  };
}

test("parseClosingRefs picks up closes/fixes/resolves + ticket id, deduped", () => {
  const refs = parseClosingRefs("FBF-9: work; closes FBB-1, fixes FBF-2. resolves FBB-1 again");
  assert.deepEqual(refs.map((r) => r.ticket), ["FBB-1", "FBF-2"]);
  assert.equal(refs[0].keyword, "closes");
  assert.deepEqual(parseClosingRefs("no keywords here FBB-9"), []);
});

test("autoStatusFromCommit moves a referenced ticket to Done (same project only)", () => {
  const b = realBoard();
  const t = b.addTask("Proj", "bug", { title: "bug to close" });
  const applied = autoStatusFromCommit(b, "Proj", `work; closes ${t.ticketNumber}`);
  assert.deepEqual(applied, [{ ticket: t.ticketNumber, keyword: "closes", status: "Done" }]);
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "Done");
  // an id that isn't on the board is ignored
  assert.deepEqual(autoStatusFromCommit(b, "Proj", "fixes FBB-999"), []);
});

test("autoStatusFromCommit respects requireReview: closes -> Review, not Done", () => {
  const b = realBoard();
  setProjectConfig(b, "Proj", { requireReview: true });
  const t = b.addTask("Proj", "feature", { title: "gated" });
  const applied = autoStatusFromCommit(b, "Proj", `resolves ${t.ticketNumber}`);
  assert.equal(applied[0].status, "Review");
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "Review");
});

test("commitFeature applies auto-status only when the autoStatusOnCommit config is on", () => {
  const b = realBoard();
  setGitConfig(b, "Proj", { enabled: true });
  const t = b.addTask("Proj", "bug", { title: "closed via commit" });

  // off by default: no status change
  const off = commitFeature(b, "Proj", { ticket: "FBF-100", title: "x", message: `x; closes ${t.ticketNumber}` }, { cwd: "/repo", exec: okExec() });
  assert.equal(off.committed, true);
  assert.equal(off.autoStatus, undefined);
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "Todo");

  // enable and retry
  setProjectConfig(b, "Proj", { autoStatusOnCommit: true });
  const on = commitFeature(b, "Proj", { ticket: "FBF-101", title: "x", message: `x; closes ${t.ticketNumber}` }, { cwd: "/repo", exec: okExec() });
  assert.ok(on.autoStatus && on.autoStatus.some((a) => a.ticket === t.ticketNumber && a.status === "Done"));
  assert.equal(b.getTask("Proj", t.ticketNumber).status, "Done");
});
