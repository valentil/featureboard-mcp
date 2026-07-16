/**
 * FeatureBoard graduate_project (FBMCPF-150) — incubator → dedicated-repo workflow.
 *
 * Lifecycle "Option C": a project starts life as a pad in the boards dir with its
 * code living alongside the markdown. When it graduates, the *code* is copied out to
 * a dedicated repo, the codeLocation is repointed, the stage flips to "graduated",
 * and a git commit records the move. The pad (featurelist/buglist/scratchpad/etc)
 * STAYS in the boards dir — graduation never removes or edits anything in the source.
 * The dedicated repo additionally gets a read-only snapshot mirror of the pad files
 * under `.featureboard/` so the code repo carries its own board context.
 *
 * The manual prototype was CADSolver (2026-07-16): copy code to a target repo,
 * exclude pad files + junk, commit, repoint codeLocation, set stage/gitTargets, and
 * record the graduation in the scratchpad. This module automates that exactly.
 *
 * Safety invariants (see graduateProject):
 *   - dry-run is the default at the tool layer; planGraduation never writes anything.
 *   - the source directory is only ever READ — never modified, never deleted.
 *   - pad files are excluded from the code copy (they stay in the boards dir).
 *   - git absence / failure is tolerated: captured as a warning, never thrown.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getProjectConfig, setProjectConfig, appendScratchpad } from "./metadata.js";

/** Board/pad files that live with the project — never copied into the code repo. */
export const PAD_FILES = [
  "featurelist.md",
  "buglist.md",
  "scratchpad.md",
  "agent_work_log.md",
  "project_config.json",
  ".featureboard.config.json",
  "git.config.json",
  "experiments.json",
];

/**
 * Junk never worth graduating. Matched by BASENAME with a tiny glob matcher that
 * understands only `*` (any run of characters, including none). Everything else is
 * treated literally. Examples: "node_modules" (exact dir), "*.log" (any .log file),
 * "tmp_*" (basename starting tmp_), "_syncprobe*" (basename starting _syncprobe).
 */
export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "*.log",
  "*.zip",
  "tmp_*",
  "_syncprobe*",
  "test_mesh_cache.json",
];

/** Turn a `*`-glob into an anchored RegExp that matches a whole basename. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True when `name` (a basename) matches any of the glob-ish patterns. */
function matchesAny(name, patterns) {
  return patterns.some((p) => (p.includes("*") ? globToRegExp(p).test(name) : p === name));
}

/** Is a real `git` binary available on this machine? Cached per process. */
let _gitChecked = null;
export function gitAvailable() {
  if (_gitChecked !== null) return _gitChecked;
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" });
    _gitChecked = !r.error && r.status === 0;
  } catch {
    _gitChecked = false;
  }
  return _gitChecked;
}

/** Resolve the directory the code currently lives in for `project`. */
function sourceDir(board, project, cfg) {
  const projectDir = board.projectDir(project);
  const code = cfg.codeLocation;
  if (code && path.resolve(code) !== path.resolve(projectDir)) return code;
  return projectDir;
}

/**
 * Walk `source`, returning { files, skipped } as arrays of paths relative to
 * `source`. Directories whose basename is excluded are skipped whole (not
 * descended). PAD_FILES + DEFAULT_EXCLUDES + extra `excludes` all apply by basename.
 */
function walk(source, excludes) {
  const files = [];
  const skipped = [];
  const padSet = new Set(PAD_FILES);
  const excluded = (name) => padSet.has(name) || matchesAny(name, DEFAULT_EXCLUDES) || matchesAny(name, excludes);

  const recurse = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (excluded(ent.name)) {
        skipped.push(relPath);
        continue;
      }
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        recurse(abs, relPath);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        files.push(relPath);
      }
    }
  };
  recurse(source, "");
  files.sort();
  skipped.sort();
  return { files, skipped };
}

/**
 * Pure(ish) plan: what graduation WOULD do. Reads config + walks the source tree;
 * writes nothing. Source = codeLocation when set and different from the project dir,
 * otherwise the project (pad) dir.
 */
export function planGraduation(board, project, targetPath, { excludes = [] } = {}) {
  if (!targetPath || !String(targetPath).trim()) throw new Error("targetPath is required");
  const cfg = getProjectConfig(board, project) || {};
  const source = sourceDir(board, project, cfg);
  const target = path.resolve(String(targetPath));
  if (path.resolve(source) === target) {
    throw new Error("targetPath must differ from the current source directory");
  }
  const { files, skipped } = walk(source, excludes);
  return {
    source,
    target,
    files,
    skipped,
    targetExists: fs.existsSync(target),
    targetIsGitRepo: fs.existsSync(path.join(target, ".git")),
    alreadyGraduated: cfg.stage === "graduated",
  };
}

/** Copy PAD_FILES that exist in the boards dir into <target>/.featureboard/. */
function mirrorPad(board, project, target) {
  const padDir = board.projectDir(project);
  const mirrorDir = path.join(target, ".featureboard");
  const mirrored = [];
  for (const name of PAD_FILES) {
    const src = path.join(padDir, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.cpSync(src, path.join(mirrorDir, name));
    mirrored.push(`.featureboard/${name}`);
  }
  return mirrored;
}

/** Run the git side of graduation. Never throws — returns a status object. */
function runGit(target, addPaths, targetIsGitRepo) {
  const result = { attempted: true, initialized: false, committed: false };
  const run = (args) => spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
  try {
    if (!targetIsGitRepo) {
      const init = run(["init"]);
      if (init.error || init.status !== 0) {
        result.warning = `git init failed: ${(init.stderr || init.error?.message || "").trim()}`;
        return result;
      }
      result.initialized = true;
    }
    const add = run(["add", "--", ...addPaths]);
    if (add.error || add.status !== 0) {
      result.warning = `git add failed: ${(add.stderr || add.error?.message || "").trim()}`;
      return result;
    }
    const message =
      "PROJECT graduation: code moved from incubator (FeatureBoard graduate_project)";
    const commit = run(["commit", "-m", message]);
    if (commit.error || commit.status !== 0) {
      result.warning = `git commit failed: ${(commit.stderr || commit.stdout || commit.error?.message || "").trim()}`;
      return result;
    }
    result.committed = true;
    result.message = message;
  } catch (e) {
    result.warning = `git error: ${e.message}`;
  }
  return result;
}

/**
 * Graduate a project. dryRun (default) returns the plan only and writes nothing.
 * A real run: mkdir the target, copy each planned file (preserving subdirs), mirror
 * the pad into <target>/.featureboard/, optionally git-init+commit the copied code
 * and mirror, then repoint config (codeLocation/stage/gitTargets) and record the
 * graduation in the scratchpad. The SOURCE directory is never modified or deleted.
 */
export function graduateProject(board, project, targetPath, { excludes = [], commit = true, dryRun = true } = {}) {
  const plan = planGraduation(board, project, targetPath, { excludes });
  if (dryRun) return { dryRun: true, ...plan };

  const { source, target, files, skipped } = plan;

  // 1. Copy code files into the target, preserving subdirectory structure.
  fs.mkdirSync(target, { recursive: true });
  for (const rel of files) {
    const src = path.join(source, rel);
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest);
  }

  // 2. Mirror the pad (read-only snapshot) into <target>/.featureboard/.
  const mirror = mirrorPad(board, project, target);

  // 3. Commit code + mirror in the target repo (tolerant of git absence/failure).
  let git;
  if (commit && gitAvailable()) {
    const addPaths = [...files, ...mirror];
    git = runGit(target, addPaths.length ? addPaths : ["."], plan.targetIsGitRepo);
  } else {
    git = {
      attempted: false,
      committed: false,
      reason: commit ? "git is not available on this machine" : "commit disabled by caller",
    };
  }

  // 4. Repoint config: preserve any existing padRepo, set codeRepo to the target.
  const prev = getProjectConfig(board, project) || {};
  const prevTargets = prev.gitTargets || {};
  const gitTargets = { codeRepo: { path: target } };
  if (prevTargets.padRepo) gitTargets.padRepo = prevTargets.padRepo;
  const config = setProjectConfig(board, project, {
    codeLocation: target,
    stage: "graduated",
    gitTargets,
  });

  // 5. Record the graduation in the scratchpad (pad stays put).
  const date = new Date().toISOString().slice(0, 10);
  const note = `[GRADUATION ${date}] code → ${target} (${files.length} files, ${skipped.length} skipped); pad stays here; mirror in .featureboard/`;
  appendScratchpad(board, project, note);

  return {
    dryRun: false,
    source,
    target,
    files,
    skipped,
    copied: files.length,
    mirror,
    git,
    stage: "graduated",
    gitTargets,
    codeLocation: config.codeLocation,
    scratchpadNote: note,
    alreadyGraduated: plan.alreadyGraduated,
  };
}
