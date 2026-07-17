/**
 * FeatureBoard parallel-dispatch git worktrees (FBMCPF-136) — Cline-Kanban parity.
 *
 * Working N tickets in parallel means N agents editing the SAME code repo at once,
 * which corrupts each other's working tree. Git worktrees give each ticket its own
 * checked-out directory on its own branch (ticket/<ticket>) sharing one .git object
 * store, so N sub-agents can edit disjoint areas simultaneously and merge back
 * serially.
 *
 * ⚠️ SYNC CAVEAT (why this module is careful about WHERE worktrees live): under
 * Cowork the host↔sandbox folder sync interacts badly with git's internal worktree
 * administration files. A worktree created INSIDE the code repo (or inside any other
 * synced mount) can corrupt or fail to sync. So worktrees are placed OUTSIDE the
 * repo by default — a sibling directory `<codeLocation>-worktrees/` — configurable
 * via the project config key `worktreeDir`. This module REFUSES to create a worktree
 * inside the code repo, ever.
 *
 * Pure-ish: all git runs through an injectable `exec(args, cwd)` (spawnSync by
 * default) so the lifecycle can be tested against throwaway /tmp repos. Robust
 * errors: no codeLocation, path is not a git repo, git too old for worktrees,
 * worktreeDir inside the repo, path exists but is not a registered worktree.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveGitTargets, getProjectConfig } from "./metadata.js";

/** Default exec: run git synchronously in cwd. Returns {status, stdout, stderr}. */
function defaultExec(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Branch name convention for a ticket's worktree. */
export function branchName(ticket) {
  return `ticket/${String(ticket).trim()}`;
}

/** Is `child` at or inside `parent`? (path containment, not symlink-aware) */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** git worktree requires git >= 2.5. Throws a clear error when too old / unparseable-old. */
function assertGitVersion(exec) {
  const r = exec(["--version"], undefined);
  if (r.status !== 0) {
    throw new Error(`could not run git (git --version failed: ${(r.stderr || "").trim() || "unknown error"}) — is git installed?`);
  }
  const m = (r.stdout || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return; // can't parse a modern-looking version; assume ok
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 2 || (major === 2 && minor < 5)) {
    throw new Error(`git ${m[0]} is too old for worktrees (need >= 2.5) — upgrade git.`);
  }
}

/** Resolve the project's code repo path, throwing clearly when it's missing / not a repo. */
function resolveCodeRepo(board, project) {
  const targets = resolveGitTargets(board, project);
  const repo = targets.codeRepo && targets.codeRepo.path;
  if (!repo) {
    throw new Error("no codeLocation configured for this project — set codeLocation (or gitTargets.codeRepo) to the code git repo before creating worktrees.");
  }
  if (!fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`no git repository at ${repo} (no .git) — worktrees require a git repo.`);
  }
  return path.resolve(repo);
}

/**
 * Resolve { repo, worktreeDir } for a project. worktreeDir comes from the project
 * config key `worktreeDir` when set, otherwise defaults to the sibling directory
 * `<repo>-worktrees/` — deliberately OUTSIDE the repo (see the sync caveat). Refuses
 * a worktreeDir that resolves inside the code repo.
 */
export function resolveWorktreeContext(board, project) {
  const repo = resolveCodeRepo(board, project);
  const cfg = getProjectConfig(board, project) || {};
  let worktreeDir;
  if (cfg.worktreeDir && String(cfg.worktreeDir).trim()) {
    worktreeDir = path.resolve(String(cfg.worktreeDir).trim());
  } else {
    worktreeDir = `${repo}-worktrees`;
  }
  if (isInside(worktreeDir, repo)) {
    throw new Error(
      `worktreeDir (${worktreeDir}) is inside the code repo (${repo}) — refusing. Under Cowork, worktrees inside a synced repo mount can corrupt git internals. Set project config worktreeDir to a directory OUTSIDE the repo.`
    );
  }
  return { repo, worktreeDir };
}

/** Parse `git worktree list --porcelain` output into records. */
function parsePorcelain(out) {
  const blocks = String(out || "").split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const w = {};
    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? "" : line.slice(sp + 1);
      if (key === "worktree") w.path = val;
      else if (key === "HEAD") w.head = val;
      else if (key === "branch") w.branch = val.replace(/^refs\/heads\//, "");
      else if (key === "detached") w.detached = true;
      else if (key === "bare") w.bare = true;
      else if (key === "locked") w.locked = true;
      else if (key === "prunable") w.prunable = true;
    }
    return w;
  }).filter((w) => w.path);
}

/**
 * List the project's git worktrees. Each record is annotated with `isMain` (the
 * primary repo working tree) and `ticket` (derived from a ticket/<id> branch or from
 * living under worktreeDir). Returns { repo, worktreeDir, count, worktrees }.
 */
export function listWorktrees(board, project, { exec = defaultExec } = {}) {
  const { repo, worktreeDir } = resolveWorktreeContext(board, project);
  const r = exec(["worktree", "list", "--porcelain"], repo);
  if (r.status !== 0) {
    throw new Error(`git worktree list failed: ${(r.stderr || "").trim() || "unknown error"}`);
  }
  const worktrees = parsePorcelain(r.stdout).map((w) => {
    const isMain = path.resolve(w.path) === repo;
    let ticket = null;
    const bm = w.branch && w.branch.match(/^ticket\/(.+)$/);
    if (bm) ticket = bm[1];
    else if (!isMain && isInside(w.path, worktreeDir)) ticket = path.basename(w.path);
    return { ...w, isMain, ticket };
  });
  return { repo, worktreeDir, count: worktrees.length, worktrees };
}

/**
 * Create (or reuse) a git worktree for a ticket at <worktreeDir>/<ticket> on branch
 * ticket/<ticket>. Reuses the worktree if one is already registered at that path.
 * Creates the branch off `baseRef` (or the repo's current HEAD) when it doesn't yet
 * exist, otherwise checks out the existing branch. Never places the worktree inside
 * the code repo. `exec` is injectable for tests.
 */
export function createWorktree(board, project, ticket, opts = {}, { exec = defaultExec } = {}) {
  const tk = String(ticket || "").trim();
  if (!tk) throw new Error("ticket is required");
  assertGitVersion(exec);
  const { repo, worktreeDir } = resolveWorktreeContext(board, project);
  const branch = branchName(tk);
  const wtPath = path.join(worktreeDir, tk);
  const baseRef = opts.baseRef ? String(opts.baseRef).trim() : null;

  // Reuse an already-registered worktree at this path.
  const existing = listWorktrees(board, project, { exec }).worktrees.find(
    (w) => path.resolve(w.path) === path.resolve(wtPath)
  );
  if (existing) {
    return {
      reused: true,
      created: false,
      ticket: tk,
      path: wtPath,
      branch: existing.branch || branch,
      worktreeDir,
      repo,
      mergeBack: mergeBackGuidance(tk, { branch: existing.branch || branch }),
      syncNote: SYNC_NOTE,
    };
  }

  // A directory is squatting the path but git doesn't know it — don't clobber it.
  if (fs.existsSync(wtPath)) {
    throw new Error(`path ${wtPath} already exists but is not a registered git worktree — remove it or choose another worktreeDir.`);
  }

  fs.mkdirSync(worktreeDir, { recursive: true });

  const branchExists = exec(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).status === 0;
  const args = ["worktree", "add"];
  if (branchExists) {
    args.push(wtPath, branch);
  } else {
    args.push("-b", branch, wtPath);
    if (baseRef) args.push(baseRef);
  }
  const r = exec(args, repo);
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${(r.stderr || "").trim() || "unknown error"}`);
  }
  return {
    created: true,
    reused: false,
    ticket: tk,
    path: wtPath,
    branch,
    baseRef: baseRef || null,
    worktreeDir,
    repo,
    mergeBack: mergeBackGuidance(tk, { branch }),
    syncNote: SYNC_NOTE,
  };
}

/**
 * Remove a ticket's worktree (git worktree remove + prune). Refuses when the
 * worktree has uncommitted changes unless `force` is set. Returns a benign result
 * (rather than throwing) when no worktree is registered for the ticket. Never
 * force-deletes a path that git doesn't recognise as a worktree.
 */
export function cleanupWorktree(board, project, ticket, opts = {}, { exec = defaultExec } = {}) {
  const tk = String(ticket || "").trim();
  if (!tk) throw new Error("ticket is required");
  const force = !!opts.force;
  const { repo, worktreeDir } = resolveWorktreeContext(board, project);
  const wtPath = path.join(worktreeDir, tk);

  const existing = listWorktrees(board, project, { exec }).worktrees.find(
    (w) => path.resolve(w.path) === path.resolve(wtPath)
  );
  if (!existing) {
    // Clear any stale administrative entries, then report.
    exec(["worktree", "prune"], repo);
    if (fs.existsSync(wtPath)) {
      throw new Error(`path ${wtPath} exists but is not a registered git worktree — refusing to remove it automatically.`);
    }
    return { removed: false, ticket: tk, path: wtPath, message: `no worktree registered for ${tk} at ${wtPath}.` };
  }

  if (!force) {
    const st = exec(["status", "--porcelain"], wtPath);
    if (st.status === 0 && (st.stdout || "").trim()) {
      throw new Error(`worktree for ${tk} at ${wtPath} has uncommitted changes — commit or discard them, or pass force:true to remove anyway.`);
    }
  }

  const args = ["worktree", "remove", wtPath];
  if (force) args.push("--force");
  const r = exec(args, repo);
  if (r.status !== 0) {
    throw new Error(`git worktree remove failed: ${(r.stderr || "").trim() || "unknown error"}`);
  }
  exec(["worktree", "prune"], repo);
  return { removed: true, ticket: tk, path: wtPath, branch: existing.branch || branchName(tk), forced: force };
}

const SYNC_NOTE =
  "Worktree lives OUTSIDE the code repo on purpose: under Cowork, git worktrees inside a synced repo mount can corrupt git internals. Point sub-agents at this path; keep board writes on the orchestrator.";

/**
 * Instructions for merging a ticket's worktree branch back into the base branch.
 * Returned in create/list results and in the ticket's work packet. Merge tickets
 * back SERIALLY to keep conflict resolution sane.
 */
export function mergeBackGuidance(ticket, opts = {}) {
  const tk = String(ticket || "").trim();
  const branch = opts.branch || branchName(tk);
  const base = opts.baseBranch || "main";
  return {
    branch,
    baseBranch: base,
    steps: [
      `Make sure the ticket's work in the worktree is committed on ${branch}.`,
      `In the MAIN repo, switch to the base branch: git checkout ${base}`,
      `Merge the ticket branch: git merge ${branch}  (or rebase ${branch} onto ${base} first for linear history).`,
      "Run the test suite and resolve any conflicts before continuing.",
      `Record the work: commit_feature (or set_status Done) referencing ${tk}.`,
      `Remove the worktree once merged: cleanup_worktree ticket=${tk}.`,
    ],
    note: "Merge tickets back SERIALLY, one at a time. Only the orchestrator writes to the board.",
  };
}

/**
 * Packet helper: if a worktree exists for a ticket, return
 * { worktreePath, branch, mergeBack } for getWorkPacket. Never throws — any error
 * (no codeLocation, not a repo, git missing) simply yields null so the packet stays
 * robust.
 */
export function worktreeForTicket(board, project, ticket, { exec = defaultExec } = {}) {
  try {
    const tk = String(ticket || "").trim();
    if (!tk) return null;
    const list = listWorktrees(board, project, { exec });
    const wtPath = path.join(list.worktreeDir, tk);
    const found = list.worktrees.find((w) => path.resolve(w.path) === path.resolve(wtPath));
    if (!found) return null;
    const branch = found.branch || branchName(tk);
    return { worktreePath: found.path, branch, mergeBack: mergeBackGuidance(tk, { branch }) };
  } catch {
    return null;
  }
}
