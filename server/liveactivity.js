/**
 * FBMCPF-254: get_live_activity — read-only git/filesystem ground truth about
 * what coding sub-agents are doing RIGHT NOW, for one project or across all of
 * them at once.
 *
 * Why this exists: sub-agents deliberately never write the board mid-flight
 * (only the orchestrator does — set_status/log_work/commit_feature), so
 * between a ticket going "In Progress" and coming back "Done" the board itself
 * has nothing new to say. The only truth in that window is the filesystem:
 * dirty files, fresh commits, git worktrees another agent has checked out, and
 * whatever a sub-agent chose to jot into its `.fb-progress` file. This module
 * is a pure read: it never writes to the board and never mutates a repo.
 *
 * Mirrors the exec-injection pattern from git.js (defaultExec = spawnSync git)
 * so tests can substitute a fake exec, and follows the same "never throw for a
 * broken/missing repo" convention as getTicketDiff/openPullRequest — every
 * failure mode becomes a `warning` string on the affected repo/project rather
 * than an exception.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveGitTargets, readWorkLog } from "./metadata.js";

const PROGRESS_FILE = ".fb-progress";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "build"]);
// FBMCPF-254: hard cap on stat() calls per repo during the recently-modified-files
// walk, so an all-projects call over two dozen repos stays fast — this is a
// "give me a live pulse" tool, not a full repo audit.
const MAX_STAT_CALLS = 5000;
// NUL-byte field separator for `git log --format=...` parsing, built at
// runtime via fromCharCode so no literal control character sits in this
// source file. Paired with the %x00 directive in the format string below
// (that directive is plain ASCII text sent to git, not a JS escape).
const NUL = String.fromCharCode(0);

/** Default exec: run git synchronously in cwd. Returns {status, stdout, stderr}. */
function defaultExec(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function ageMinutesFromMs(ms, now) {
  if (!Number.isFinite(ms)) return null;
  return Math.round(((now.getTime() - ms) / 60000) * 10) / 10;
}

function ageMinutesFromIso(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return ageMinutesFromMs(t, now);
}

// ---------------------------------------------------------------------------
// git primitives
// ---------------------------------------------------------------------------

/** Dirty working-tree + index state: file list (capped) + total count + pending
 *  additions/deletions (unstaged + staged, summed). Never throws. */
function gitDirty(exec, repo, maxFiles) {
  const st = exec(["status", "--porcelain"], repo);
  if (st.status !== 0) {
    return { count: 0, files: [], additions: 0, deletions: 0, warning: `git status failed: ${(st.stderr || "").trim() || "unknown error"}` };
  }
  const lines = (st.stdout || "").split(/\r?\n/).filter(Boolean);
  const files = lines.slice(0, Math.max(1, maxFiles)).map((l) => l.trim());

  const parseShortstat = (out) => {
    const a = (out || "").match(/(\d+) insertion/);
    const d = (out || "").match(/(\d+) deletion/);
    return { a: a ? parseInt(a[1], 10) : 0, d: d ? parseInt(d[1], 10) : 0 };
  };
  const unstaged = exec(["diff", "--shortstat"], repo);
  const staged = exec(["diff", "--cached", "--shortstat"], repo);
  const p1 = parseShortstat(unstaged.stdout);
  const p2 = parseShortstat(staged.stdout);
  return { count: lines.length, files, additions: p1.a + p2.a, deletions: p1.d + p2.d };
}

/** Commits in the last `sinceMinutes`, newest first, capped at maxCommits. */
function gitRecentCommits(exec, repo, sinceMinutes, maxCommits, now) {
  const log = exec(
    ["log", `--since=${sinceMinutes} minutes ago`, `--max-count=${maxCommits}`, "--format=%H%x00%s%x00%aI"],
    repo
  );
  if (log.status !== 0) {
    return { commits: [], warning: `git log failed: ${(log.stderr || "").trim() || "unknown error"}` };
  }
  const rows = (log.stdout || "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const commits = rows.map((row) => {
    const [hash, subject, date] = row.split(NUL);
    return {
      hash,
      shortHash: (hash || "").slice(0, 8),
      subject: subject || null,
      date: date || null,
      ageMinutes: date ? ageMinutesFromIso(date, now) : null,
    };
  });
  return { commits };
}

/** Parse `git worktree list --porcelain` blocks into { path, branch, detached, bare }. */
function parseWorktreePorcelain(out) {
  const blocks = String(out || "").split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const w = {};
      for (const line of block.split(/\r?\n/)) {
        const sp = line.indexOf(" ");
        const key = sp === -1 ? line : line.slice(0, sp);
        const val = sp === -1 ? "" : line.slice(sp + 1);
        if (key === "worktree") w.path = val;
        else if (key === "branch") w.branch = val.replace(/^refs\/heads\//, "");
        else if (key === "detached") w.detached = true;
        else if (key === "bare") w.bare = true;
      }
      return w;
    })
    .filter((w) => w.path);
}

/** Worktrees other than the main one, each with branch + dirty-file count
 *  (a live sub-agent edit surface). Never throws. */
function gitWorktrees(exec, repo) {
  const r = exec(["worktree", "list", "--porcelain"], repo);
  if (r.status !== 0) {
    return { worktrees: [], warning: `git worktree list failed: ${(r.stderr || "").trim() || "unknown error"}` };
  }
  const all = parseWorktreePorcelain(r.stdout);
  const mainResolved = path.resolve(repo);
  const others = all.filter((w) => path.resolve(w.path) !== mainResolved);
  const worktrees = others.map((w) => {
    let dirtyCount = 0;
    try {
      const st = exec(["status", "--porcelain"], w.path);
      if (st.status === 0) dirtyCount = (st.stdout || "").split(/\r?\n/).filter(Boolean).length;
    } catch {
      // a worktree whose dir vanished (removed but not pruned) — leave dirtyCount at 0
    }
    return { path: w.path, branch: w.branch || (w.detached ? "(detached)" : null), dirtyCount };
  });
  return { worktrees };
}

// ---------------------------------------------------------------------------
// filesystem primitives
// ---------------------------------------------------------------------------

/** Last ~5 non-empty lines of <root>/.fb-progress, plus the file's mtime age.
 *  Null when the file doesn't exist (or can't be read). */
function readProgressFile(root, now) {
  const p = path.join(root, PROGRESS_FILE);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  let content = "";
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { path: p, lines: lines.slice(-5), ageMinutes: ageMinutesFromMs(stat.mtimeMs, now) };
}

/** Newest files under `root` modified within `sinceMinutes`, depth-limited,
 *  skipping node_modules/.git/dist/vendor/build. Bails after MAX_STAT_CALLS
 *  stat() calls so a big repo (or an all-projects sweep) stays fast. Never
 *  throws — an unreadable dir is simply skipped. */
function walkRecentFiles(root, sinceMinutes, maxFiles, now) {
  const cutoffMs = now.getTime() - sinceMinutes * 60000;
  const found = [];
  let statCalls = 0;
  const stack = [root];
  while (stack.length && statCalls < MAX_STAT_CALLS) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (statCalls >= MAX_STAT_CALLS) break;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      statCalls++;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoffMs) found.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxFiles).map((f) => ({
    path: path.relative(root, f.path).split(path.sep).join("/"),
    ageMinutes: ageMinutesFromMs(f.mtimeMs, now),
  }));
}

// ---------------------------------------------------------------------------
// per-repo / per-project scan
// ---------------------------------------------------------------------------

/** Scan one repo (code or website): dirty state, recent commits, other
 *  worktrees. Returns a `warning`-only record (no dirty/recentCommits/
 *  worktrees) when the path doesn't exist or isn't a git repo — never throws. */
function scanRepo(exec, repoPath, role, { sinceMinutes, maxFiles, maxCommits }, now) {
  if (!fs.existsSync(repoPath)) {
    return { path: repoPath, role, warning: `path does not exist: ${repoPath}` };
  }
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    return { path: repoPath, role, warning: `no git repository at ${repoPath} (no .git)` };
  }
  const dirtyRaw = gitDirty(exec, repoPath, maxFiles);
  const commitsRaw = gitRecentCommits(exec, repoPath, sinceMinutes, maxCommits, now);
  const wtRaw = gitWorktrees(exec, repoPath);
  const out = {
    path: repoPath,
    role,
    dirty: { count: dirtyRaw.count, files: dirtyRaw.files, additions: dirtyRaw.additions, deletions: dirtyRaw.deletions },
    recentCommits: commitsRaw.commits,
    worktrees: wtRaw.worktrees,
  };
  const warnings = [dirtyRaw.warning, commitsRaw.warning, wtRaw.warning].filter(Boolean);
  if (warnings.length) out.warning = warnings.join("; ");
  return out;
}

/**
 * Live-activity snapshot for a single project: dirty files + pending
 * diffstat, recent commits, other worktrees (+ their dirty surface),
 * `.fb-progress` notes (repo root + every worktree root), recently-modified
 * files, and the cheap board-side signals (In Progress count, last work-log
 * age). Never throws — a missing/broken repo shows up as a `warning` on its
 * entry, not an exception.
 */
export function scanProjectLiveActivity(board, project, opts = {}, { exec = defaultExec } = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sinceMinutes = clampInt(opts.sinceMinutes, 30, 1, 1440);
  const maxFiles = clampInt(opts.maxFiles, 15, 1, 200);
  const maxCommits = clampInt(opts.maxCommits, 10, 1, 200);

  const targets = resolveGitTargets(board, project);
  const repoDefs = [];
  const codePath = targets.codeRepo && targets.codeRepo.path;
  if (codePath) repoDefs.push({ path: codePath, role: "code" });
  const websitePath = targets.websiteRepo && targets.websiteRepo.path;
  if (websitePath && websitePath !== codePath) repoDefs.push({ path: websitePath, role: "website" });

  const repos = [];
  const progressNotes = [];
  const recentFilesAll = [];
  let totalDirtyFiles = 0;
  let totalRecentCommits = 0;
  let totalActiveWorktrees = 0;

  for (const def of repoDefs) {
    const scanned = scanRepo(exec, def.path, def.role, { sinceMinutes, maxFiles, maxCommits }, now);
    repos.push(scanned);
    if (scanned.dirty) {
      totalDirtyFiles += scanned.dirty.count;
      totalRecentCommits += scanned.recentCommits.length;
      totalActiveWorktrees += scanned.worktrees.filter((w) => w.dirtyCount > 0).length;
    }
    if (!fs.existsSync(def.path)) continue;

    const pn = readProgressFile(def.path, now);
    if (pn) progressNotes.push({ source: def.path, role: def.role, ...pn });
    for (const w of scanned.worktrees || []) {
      const wpn = readProgressFile(w.path, now);
      if (wpn) progressNotes.push({ source: w.path, role: `${def.role}-worktree`, branch: w.branch || null, ...wpn });
    }

    try {
      for (const f of walkRecentFiles(def.path, sinceMinutes, maxFiles, now)) recentFilesAll.push(f);
    } catch {
      // best-effort — a walk failure never breaks the scan
    }
  }

  recentFilesAll.sort((a, b) => (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity));
  const recentFiles = recentFilesAll.slice(0, maxFiles);

  let inProgress = 0;
  try {
    inProgress = board.listTasks(project, {}).filter((t) => t.status === "In Progress").length;
  } catch {
    inProgress = 0;
  }

  let lastWorkLogAgeMinutes = null;
  try {
    const log = readWorkLog(board, project);
    if (log.length) {
      const last = log[log.length - 1];
      const ts = Date.parse(`${last.date}T${last.time}`);
      if (!Number.isNaN(ts)) lastWorkLogAgeMinutes = ageMinutesFromMs(ts, now);
    }
  } catch {
    lastWorkLogAgeMinutes = null;
  }

  const anyFreshProgress = progressNotes.some((p) => p.ageMinutes != null && p.ageMinutes <= sinceMinutes);
  const anyFreshWorkLog = lastWorkLogAgeMinutes != null && lastWorkLogAgeMinutes <= sinceMinutes;
  const quiet = !(
    totalDirtyFiles > 0 ||
    totalRecentCommits > 0 ||
    totalActiveWorktrees > 0 ||
    recentFiles.length > 0 ||
    anyFreshProgress ||
    anyFreshWorkLog
  );

  const result = {
    project,
    inProgress,
    lastWorkLogAgeMinutes,
    repos,
    progressNotes,
    recentFiles,
    quiet,
  };
  if (!repoDefs.length) {
    result.warning = "no codeLocation configured for this project — set the project's codeLocation to see live git activity.";
  }
  return result;
}

/**
 * Read-only ground truth about what coding sub-agents are doing RIGHT NOW,
 * for one project (`project` given) or a rollup across every project that
 * has a codeLocation configured (`project` null/omitted).
 */
export function getLiveActivity(board, project, opts = {}, { exec = defaultExec } = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sinceMinutes = clampInt(opts.sinceMinutes, 30, 1, 1440);
  const maxFiles = clampInt(opts.maxFiles, 15, 1, 200);
  const maxCommits = clampInt(opts.maxCommits, 10, 1, 200);
  const runOpts = { sinceMinutes, maxFiles, maxCommits, now };

  if (project) {
    return scanProjectLiveActivity(board, project, runOpts, { exec });
  }

  let allProjects = [];
  try {
    allProjects = board.listProjects();
  } catch {
    allProjects = [];
  }

  const withCode = [];
  for (const p of allProjects) {
    let targets;
    try {
      targets = resolveGitTargets(board, p.name);
    } catch {
      targets = null;
    }
    if (targets && targets.codeRepo && targets.codeRepo.path) withCode.push(p.name);
  }

  const active = [];
  const quietNames = [];
  let totalDirtyFiles = 0;
  let totalRecentCommits = 0;
  let totalActiveWorktrees = 0;

  for (const name of withCode) {
    let res;
    try {
      res = scanProjectLiveActivity(board, name, runOpts, { exec });
    } catch (e) {
      res = { project: name, warning: `live-activity scan failed: ${e.message}`, quiet: true, repos: [] };
    }
    for (const r of res.repos || []) {
      if (!r.dirty) continue;
      totalDirtyFiles += r.dirty.count;
      totalRecentCommits += r.recentCommits.length;
      totalActiveWorktrees += r.worktrees.filter((w) => w.dirtyCount > 0).length;
    }
    if (res.quiet) quietNames.push(name);
    else active.push(res);
  }

  return {
    asOf: now.toISOString(),
    sinceMinutes,
    projects: [...active, ...quietNames],
    summary: {
      activeProjects: active.length,
      totalDirtyFiles,
      totalRecentCommits,
      totalActiveWorktrees,
    },
  };
}
