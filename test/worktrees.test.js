import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createWorktree,
  listWorktrees,
  cleanupWorktree,
  mergeBackGuidance,
  branchName,
  resolveWorktreeContext,
} from "../server/worktrees.js";
import { getWorkPacket, setProjectConfig } from "../server/metadata.js";

// FBMCPF-136 — parallel-dispatch git worktrees. All tests use throwaway /tmp repos.

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// A minimal board object (just projectDir) + a real throwaway code repo with one
// commit, and a worktreeDir sibling OUTSIDE the repo.
function setup(withConfig = true) {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wtboard-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wtrepo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.dev"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wtdir-"));
  const board = { projectDir: () => boardDir };
  if (withConfig) setProjectConfig(board, "Proj", { codeLocation: repo, worktreeDir: wtDir });
  return { board, repo, boardDir, wtDir };
}

function makeTask(board, project, ticket) {
  // getWorkPacket needs board.getTask — stub a minimal one on the board.
  board.getTask = (proj, tk) =>
    tk === ticket ? { ticketNumber: ticket, type: "feature", status: "In Progress", title: "T", description: "", labels: [], product: null } : null;
}

test("create_worktree: creates worktree at worktreeDir/<ticket> on branch ticket/<ticket>", () => {
  const { board, wtDir } = setup();
  const res = createWorktree(board, "Proj", "FBF-1", {});
  assert.equal(res.created, true);
  assert.equal(res.reused, false);
  assert.equal(res.branch, "ticket/FBF-1");
  assert.equal(res.path, path.join(wtDir, "FBF-1"));
  assert.ok(fs.existsSync(res.path), "worktree dir exists on disk");
  assert.ok(fs.existsSync(path.join(res.path, "README.md")), "checked out the repo content");
  assert.ok(res.mergeBack && Array.isArray(res.mergeBack.steps));
});

test("create_worktree: default worktreeDir is a sibling OUTSIDE the repo", () => {
  const { board, repo } = setup(false);
  setProjectConfig(board, "Proj", { codeLocation: repo }); // no worktreeDir -> default
  const ctx = resolveWorktreeContext(board, "Proj");
  assert.equal(ctx.worktreeDir, `${path.resolve(repo)}-worktrees`);
  const rel = path.relative(repo, ctx.worktreeDir);
  assert.ok(rel.startsWith(".."), "worktreeDir is outside the repo");
});

test("create_worktree: refuses a worktreeDir inside the code repo (sync caveat)", () => {
  const { board, repo } = setup(false);
  setProjectConfig(board, "Proj", { codeLocation: repo, worktreeDir: path.join(repo, "wt") });
  assert.throws(() => createWorktree(board, "Proj", "FBF-1", {}), /inside the code repo|refusing/i);
});

test("list_worktrees: shows the main tree plus created ticket worktrees", () => {
  const { board } = setup();
  createWorktree(board, "Proj", "FBF-1", {});
  createWorktree(board, "Proj", "FBF-2", {});
  const list = listWorktrees(board, "Proj");
  assert.ok(list.count >= 3);
  const main = list.worktrees.find((w) => w.isMain);
  assert.ok(main, "main working tree present");
  const t1 = list.worktrees.find((w) => w.ticket === "FBF-1");
  assert.equal(t1.branch, "ticket/FBF-1");
});

test("create_worktree: reuses an existing worktree rather than erroring", () => {
  const { board } = setup();
  const first = createWorktree(board, "Proj", "FBF-1", {});
  const second = createWorktree(board, "Proj", "FBF-1", {});
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
  assert.equal(second.branch, "ticket/FBF-1");
});

test("getWorkPacket: includes worktreePath + branch + mergeBack when a worktree exists", () => {
  const { board } = setup();
  makeTask(board, "Proj", "FBF-7");
  const before = getWorkPacket(board, "Proj", "FBF-7");
  assert.equal(before.worktree, undefined, "no worktree block before creation");
  createWorktree(board, "Proj", "FBF-7", {});
  const after = getWorkPacket(board, "Proj", "FBF-7");
  assert.ok(after.worktree, "worktree block present");
  assert.equal(after.worktree.branch, "ticket/FBF-7");
  assert.ok(after.worktree.worktreePath.endsWith(path.join("FBF-7")));
  assert.ok(Array.isArray(after.worktree.mergeBack.steps));
});

test("cleanup_worktree: refuses a dirty worktree unless force", () => {
  const { board } = setup();
  const wt = createWorktree(board, "Proj", "FBF-1", {});
  fs.writeFileSync(path.join(wt.path, "dirty.txt"), "uncommitted\n");
  assert.throws(() => cleanupWorktree(board, "Proj", "FBF-1", {}), /uncommitted changes/i);
  // still registered
  assert.ok(listWorktrees(board, "Proj").worktrees.some((w) => w.ticket === "FBF-1"));
  // force removes it
  const res = cleanupWorktree(board, "Proj", "FBF-1", { force: true });
  assert.equal(res.removed, true);
  assert.equal(res.forced, true);
  assert.ok(!fs.existsSync(wt.path), "worktree dir removed");
  assert.ok(!listWorktrees(board, "Proj").worktrees.some((w) => w.ticket === "FBF-1"));
});

test("cleanup_worktree: removes a clean worktree and no-ops when absent", () => {
  const { board } = setup();
  const wt = createWorktree(board, "Proj", "FBF-1", {});
  const res = cleanupWorktree(board, "Proj", "FBF-1", {});
  assert.equal(res.removed, true);
  assert.ok(!fs.existsSync(wt.path));
  // second cleanup: nothing registered -> benign result, no throw
  const again = cleanupWorktree(board, "Proj", "FBF-1", {});
  assert.equal(again.removed, false);
  assert.match(again.message, /no worktree registered/);
});

test("errors: no codeLocation, and codeLocation not a git repo", () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wtnocfg-"));
  const board = { projectDir: () => boardDir };
  assert.throws(() => createWorktree(board, "Proj", "FBF-1", {}), /no codeLocation/i);

  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-wtplain-"));
  setProjectConfig(board, "Proj", { codeLocation: notRepo });
  assert.throws(() => createWorktree(board, "Proj", "FBF-1", {}), /no git repository/i);
});

test("error: path exists but is not a registered worktree", () => {
  const { board, wtDir } = setup();
  fs.mkdirSync(path.join(wtDir, "FBF-9"), { recursive: true });
  fs.writeFileSync(path.join(wtDir, "FBF-9", "squat.txt"), "x\n");
  assert.throws(() => createWorktree(board, "Proj", "FBF-9", {}), /not a registered git worktree/i);
});

test("error: git too old for worktrees", () => {
  const { board } = setup();
  const oldGit = (args) => {
    if (args[0] === "--version") return { status: 0, stdout: "git version 2.4.0\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.throws(() => createWorktree(board, "Proj", "FBF-1", {}, { exec: oldGit }), /too old/i);
});

test("mergeBackGuidance + branchName: sane, serial-merge instructions", () => {
  assert.equal(branchName("FBF-3"), "ticket/FBF-3");
  const g = mergeBackGuidance("FBF-3");
  assert.equal(g.branch, "ticket/FBF-3");
  assert.equal(g.baseBranch, "main");
  assert.ok(g.steps.some((s) => /merge/i.test(s)));
  assert.match(g.note, /SERIALLY/);
});

test("baseRef: new branch is based on the requested ref", () => {
  const { board, repo } = setup();
  // create a second commit on main, tag the first as an earlier ref
  const firstSha = git(repo, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(repo, "second.txt"), "2\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "second"]);
  const wt = createWorktree(board, "Proj", "FBF-5", { baseRef: firstSha });
  // the worktree HEAD should be the first commit (second.txt absent)
  assert.ok(!fs.existsSync(path.join(wt.path, "second.txt")), "based on the earlier ref");
});
