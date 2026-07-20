import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getLiveActivity, scanProjectLiveActivity } from "../server/liveactivity.js";
import { setProjectConfig } from "../server/metadata.js";
import { Board } from "../server/storage.js";

// FBMCPF-254 — get_live_activity: git/filesystem ground truth about what
// coding sub-agents are doing RIGHT NOW.

function git(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env || process.env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function initRepo(repo) {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.dev"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

function commit(repo, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

/** Commit with author/committer date backdated to `isoDate`. */
function commitAt(repo, file, content, message, isoDate) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", "-A"]);
  const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  git(repo, ["commit", "-q", "-m", message], env);
}

/** Backdate a file's mtime so the recently-modified-files walk skips it too
 *  (git commit dates don't touch filesystem mtimes — the write itself does). */
function backdateFile(filePath, isoDate) {
  const t = new Date(isoDate);
  fs.utimesSync(filePath, t, t);
}

// A board whose config lives in `boardDir`, pointing codeLocation at a real
// throwaway git repo — same shape as test/ticket_diff.test.js's setup().
function setup() {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liveboard-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liverepo-"));
  initRepo(repo);
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: repo });
  return { board, repo, boardDir };
}

test("scanProjectLiveActivity: dirty files + pending diffstat detected", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "hello\n", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello world\n"); // unstaged change
  fs.writeFileSync(path.join(repo, "b.txt"), "new file\n");
  git(repo, ["add", "b.txt"]); // staged addition

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  const codeRepo = res.repos.find((r) => r.role === "code");
  assert.ok(codeRepo, "code repo present");
  assert.equal(codeRepo.dirty.count, 2);
  assert.ok(codeRepo.dirty.files.some((f) => f.includes("a.txt")));
  assert.ok(codeRepo.dirty.additions > 0, "additions counted across unstaged + staged");
  assert.equal(res.quiet, false);
});

test("scanProjectLiveActivity: fresh commit within window included, older commit excluded", () => {
  const { board, repo } = setup();
  const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  commitAt(repo, "old.txt", "old\n", "an old commit", oldIso);
  backdateFile(path.join(repo, "old.txt"), oldIso);
  commit(repo, "new.txt", "new\n", "a fresh commit");

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 10 });
  const codeRepo = res.repos.find((r) => r.role === "code");
  const subjects = codeRepo.recentCommits.map((c) => c.subject);
  assert.ok(subjects.includes("a fresh commit"));
  assert.ok(!subjects.includes("an old commit"));
  const fresh = codeRepo.recentCommits.find((c) => c.subject === "a fresh commit");
  assert.ok(fresh.ageMinutes != null && fresh.ageMinutes < 10);
  assert.equal(fresh.shortHash.length, 8);
});

test("scanProjectLiveActivity: .fb-progress last ~5 lines + mtime age surfaced", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "x\n", "init");
  const lines = Array.from({ length: 8 }, (_, i) => `12:0${i} step ${i + 1}`);
  fs.writeFileSync(path.join(repo, ".fb-progress"), lines.join("\n") + "\n");

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  assert.equal(res.progressNotes.length, 1);
  assert.deepEqual(res.progressNotes[0].lines, lines.slice(-5));
  assert.equal(res.progressNotes[0].role, "code");
  assert.ok(res.progressNotes[0].ageMinutes != null && res.progressNotes[0].ageMinutes < 1);
});

test("scanProjectLiveActivity: recently modified file listed, node_modules excluded", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "x\n", "init");
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "junk.js"), "ignore me\n");
  fs.writeFileSync(path.join(repo, "fresh.txt"), "fresh content\n");

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  const paths = res.recentFiles.map((f) => f.path);
  assert.ok(paths.includes("fresh.txt"));
  assert.ok(!paths.some((p) => p.includes("node_modules")));
});

test("scanProjectLiveActivity: broken codeLocation -> warning, never throws", () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liveboard-noloc-"));
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: path.join(boardDir, "does-not-exist") });

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  assert.equal(res.repos.length, 1);
  assert.match(res.repos[0].warning, /does not exist/);
  assert.equal(res.quiet, true);
});

test("scanProjectLiveActivity: not-a-git-repo codeLocation -> warning, never throws", () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liveboard-nogit-"));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liveplain-"));
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: plain });

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  assert.equal(res.repos.length, 1);
  assert.match(res.repos[0].warning, /no git repository/);
});

test("scanProjectLiveActivity: other worktrees surfaced with branch + dirty count", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "x\n", "init");
  const wtDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fb-livewt-")), "wt");
  git(repo, ["worktree", "add", "-b", "ticket/FBX-1", wtDir]);
  fs.writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");

  const res = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  const codeRepo = res.repos.find((r) => r.role === "code");
  assert.equal(codeRepo.worktrees.length, 1);
  assert.equal(codeRepo.worktrees[0].branch, "ticket/FBX-1");
  assert.equal(codeRepo.worktrees[0].dirtyCount, 1);
});

test("getLiveActivity: all-projects mode aggregates two projects and marks a quiet one", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liveallproj-"));
  const board = new Board(dataDir);

  // Active project — untracked dirty file, freshly written.
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liverepoA-"));
  initRepo(repoA);
  board.createProject("ActiveProj", "");
  setProjectConfig(board, "ActiveProj", { codeLocation: repoA });
  commit(repoA, "a.txt", "x\n", "init");
  fs.writeFileSync(path.join(repoA, "dirty.txt"), "wip\n");

  // Quiet project — one old, backdated commit, nothing pending, mtimes backdated too.
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "fb-liverepoB-"));
  initRepo(repoB);
  board.createProject("QuietProj", "");
  setProjectConfig(board, "QuietProj", { codeLocation: repoB });
  const oldIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  commitAt(repoB, "b.txt", "x\n", "old commit", oldIso);
  backdateFile(path.join(repoB, "b.txt"), oldIso);

  const res = getLiveActivity(board, null, { sinceMinutes: 30 });
  assert.equal(res.summary.activeProjects, 1);
  assert.equal(res.summary.totalDirtyFiles >= 1, true);
  const activeEntry = res.projects.find((p) => typeof p === "object" && p.project === "ActiveProj");
  assert.ok(activeEntry, "active project returned as a full object");
  assert.ok(res.projects.includes("QuietProj"), "quiet project returned as a plain name");
});

test("getLiveActivity: single-project mode is equivalent to scanProjectLiveActivity", () => {
  const { board } = setup();
  const direct = scanProjectLiveActivity(board, "Proj", { sinceMinutes: 30 });
  const viaTop = getLiveActivity(board, "Proj", { sinceMinutes: 30 });
  assert.equal(viaTop.project, direct.project);
  assert.deepEqual(viaTop.repos.map((r) => r.path), direct.repos.map((r) => r.path));
});
