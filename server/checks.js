/**
 * FBMCPF-261: async background static checks.
 *
 * Motivation: occasional syntax errors (and other cheap-to-catch mistakes) slip
 * through the churn loop. These checks are pure CPU — zero model tokens — so we
 * run them on every check-in WITHOUT blocking the orchestrator or burning
 * budget: commit_feature (or the start_checks tool) spawns scripts/run-checks.mjs
 * DETACHED, the orchestrator immediately pulls the next ticket, and results are
 * collected later (between tickets / before ending the session) via
 * get_check_results.
 *
 * This module is the board-side coordinator: it resolves the effective checks
 * config (with a cheap default), spawns the detached runner, and reads/collects
 * results. The heavy lifting (git, node --check, configured commands) lives in
 * scripts/run-checks.mjs so the exact same pipeline is testable in-process.
 *
 * Layout, per project: <projectDir>/checks/
 *   <runId>.args.json   the runner's input
 *   <runId>.json        the progressive/terminal results file
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjectConfig, resolveGitTargets } from "./metadata.js";
import { appendEvent, eventsForTicket } from "./events.js";

// FBMCPB-55: the runner's transient files (<runId>.args.json, results json,
// the staged run-checks.mjs) must live OUTSIDE the Cowork-watched projectpad
// root, or the host staples each newly-written file onto a fresh chat. Keep
// them user-owned + in-project (FBMCPB-39's requirement) but hidden under the
// dot-prefixed .featureboard/ dir, which file pickers/watchers ignore.
const CHECKS_DIR = path.join(".featureboard", "checks");

// The cheap default when a project has no explicit `checks` block but its code
// repo has a package.json: syntax-check changed .js/.mjs/.cjs files, nothing
// else. No configured commands (a project opts into tests/lint explicitly).
export const DEFAULT_CHECKS = { autoOnCommit: true, commands: [], syntaxCheckChangedFiles: true };

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** The project's code repo path (via resolveGitTargets), or null. */
function codeRepoPath(board, project) {
  try {
    const targets = resolveGitTargets(board, project);
    return (targets.codeRepo && targets.codeRepo.path) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective checks config for a project. Precedence:
 *   1. an explicit project-config `checks` object (normalized over DEFAULT_CHECKS).
 *   2. otherwise, when the code repo has a package.json, DEFAULT_CHECKS (cheap
 *      syntax-only default so a code project gets *some* guard for free).
 *   3. otherwise null — nothing to run.
 * Returns { autoOnCommit, commands, syntaxCheckChangedFiles, source } or null.
 */
export function resolveChecksConfig(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  if (cfg.checks && typeof cfg.checks === "object") {
    const c = cfg.checks;
    return {
      autoOnCommit: c.autoOnCommit !== false,
      commands: Array.isArray(c.commands) ? c.commands : [],
      syntaxCheckChangedFiles: c.syntaxCheckChangedFiles !== false,
      source: "config",
    };
  }
  const repo = codeRepoPath(board, project);
  if (repo && fs.existsSync(path.join(repo, "package.json"))) {
    return { ...DEFAULT_CHECKS, source: "default" };
  }
  return null;
}

/** Ensure and return <projectDir>/.featureboard/checks/. */
function checksDir(board, project) {
  const dir = path.join(board.projectDir(project), CHECKS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // FBMCPF-339: keep the runner's transient artifacts (and anything else under
  // .featureboard/) out of the projectpad git repo — a one-line `*` .gitignore
  // in .featureboard/ ignores the whole internal dir. Best-effort, idempotent.
  try {
    const gi = path.join(path.dirname(dir), ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
  } catch { /* best-effort */ }
  return dir;
}

/**
 * FBMCPF-339: keep the checks dir bounded — retain the newest `keep` runs
 * (result file <runId>.json + its <runId>.args.json) and delete older ones.
 * runIds are `${Date.now()}-${rand}`, so a lexicographic sort of the result
 * filenames is newest-first for same-width timestamps. Best-effort; never throws.
 */
export function pruneRuns(dir, keep = 20) {
  try {
    const results = fs.readdirSync(dir)
      .filter((n) => /^\d+-[a-z0-9]+\.json$/.test(n)) // <runId>.json (not .args.json)
      .sort((a, b) => b.localeCompare(a));
    for (const name of results.slice(keep)) {
      const base = name.replace(/\.json$/, "");
      for (const f of [`${base}.json`, `${base}.args.json`]) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* best-effort */ }
}

function resultsFilePath(dir, runId) {
  return path.join(dir, `${runId}.json`);
}
function argsFilePath(dir, runId) {
  return path.join(dir, `${runId}.args.json`);
}

/** Resolve the runner script path from this module's location (unpacked-bundle safe). */
function runnerScriptPath() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // server/
  return path.join(here, "..", "scripts", "run-checks.mjs");
}

/**
 * FBMCPB-39: don't execute the runner directly from the app-managed Claude
 * Extensions dir. On some hosts (Windows especially) spawning node on a script
 * inside the app bundle triggers desktop file-preview / security popups and
 * looks hostile to host hardening. run-checks.mjs imports only node builtins, so
 * we stage a copy into the project's own checks dir — a user-owned location
 * outside the app bundle — and run THAT. Falls back to the in-bundle script if
 * staging fails, so checks never silently stop.
 */
export function stageRunner(dir) {
  const src = runnerScriptPath();
  try {
    const dest = path.join(dir, "run-checks.mjs");
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return src; // best-effort: fall back to the in-bundle runner
  }
}

/**
 * Fire-and-forget: spawn the detached background check runner for a project.
 * Allocates a runId, writes the runner's args file, spawns run-checks.mjs
 * detached (stdio ignored, unref'd) so it survives this process moving on, and
 * returns immediately with { runId, resultsFile, started }.
 *
 * `checks` may be passed (the resolved config); when omitted it is resolved
 * here. Returns { started:false, reason } when there's nothing to run (no
 * checks config and no package.json) or no code repo.
 */
export function startChecks(board, project, { ticket = null, revision = null, checks = null } = {}) {
  const resolved = checks || resolveChecksConfig(board, project);
  if (!resolved) {
    return { started: false, reason: "no checks configured and no package.json in the code repo" };
  }
  const repo = codeRepoPath(board, project);
  if (!repo) {
    return { started: false, reason: "no codeLocation / code repo configured for this project" };
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = checksDir(board, project);
  const resultsFile = resultsFilePath(dir, runId);
  const argsFile = argsFilePath(dir, runId);
  const args = {
    runId,
    repo,
    resultsFile,
    revision: revision || null,
    ticket: ticket || null,
    project,
    checks: {
      commands: Array.isArray(resolved.commands) ? resolved.commands : [],
      syntaxCheckChangedFiles: resolved.syntaxCheckChangedFiles !== false,
    },
  };
  atomicWrite(argsFile, JSON.stringify(args, null, 2) + "\n");
  pruneRuns(dir);

  // FBMCPB-39: run a staged copy from the project's checks dir, not the app bundle.
  const runner = stageRunner(dir);
  const child = spawn(process.execPath, [runner, argsFile], {
    cwd: repo,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return { runId, resultsFile, started: true };
}

/** List parsed run-result objects in a project's checks dir, newest first (by mtime). */
function listRuns(board, project) {
  const dir = path.join(board.projectDir(project), CHECKS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".args.json")) continue;
    const p = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const parsed = readJsonSafe(p);
    if (parsed && parsed.runId) runs.push({ file: p, mtimeMs, results: parsed });
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runs;
}

/**
 * The newest run for a ticket (parsed), or null. Read-only — does NOT collect /
 * emit an audit event (that's getCheckResults' job). Used by the Done gate.
 */
export function latestCheckRunForTicket(board, project, ticket) {
  const run = listRuns(board, project).find((r) => r.results && r.results.ticket === ticket);
  return run ? run.results : null;
}

function ageSecondsOf(results) {
  const ref = results.finishedAt || results.startedAt;
  const t = ref ? Date.parse(ref) : NaN;
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
}

/**
 * Read background check results: by runId, else the newest run for a ticket,
 * else the newest run overall. Returns the parsed results + ageSeconds +
 * resultsFile, or { found:false } when nothing matches.
 *
 * Side-effect (once): the FIRST time a FINISHED, FAILED run is collected for a
 * ticket, append a field:"checks" audit event so the failure lands in the
 * ticket's history. Deduped by rewriting the run file with collected:true, so
 * re-reading the same failed run never re-fires the event.
 */
export function getCheckResults(board, project, { runId = null, ticket = null } = {}) {
  const dir = path.join(board.projectDir(project), CHECKS_DIR);
  let file = null;
  let results = null;
  if (runId) {
    file = resultsFilePath(dir, runId);
    results = readJsonSafe(file);
  } else if (ticket) {
    const run = listRuns(board, project).find((r) => r.results && r.results.ticket === ticket);
    if (run) {
      file = run.file;
      results = run.results;
    }
  } else {
    const run = listRuns(board, project)[0];
    if (run) {
      file = run.file;
      results = run.results;
    }
  }
  if (!results) return { found: false, project, runId: runId || null, ticket: ticket || null };

  // First-collection audit event for a finished, failed run tied to a ticket.
  if (results.status === "failed" && results.ticket && !results.collected) {
    try {
      const failedChecks = (results.checks || []).filter((c) => c.status === "failed").map((c) => c.name);
      appendEvent(board, project, {
        ticket: results.ticket,
        field: "checks",
        from: null,
        to: results.status,
        source: "get_check_results",
        runId: results.runId,
        failedChecks,
      });
      results.collected = true;
      if (file) atomicWrite(file, JSON.stringify(results, null, 2) + "\n");
    } catch {
      // audit/marker best-effort — never fail a read over it
    }
  }

  return { found: true, ...results, ageSeconds: ageSecondsOf(results), resultsFile: file };
}

/**
 * Done-gate decision for requireChecksOnDone (mirrors evaluateCommitGate's
 * shape). When the flag is on and the ticket's latest background check run
 * FAILED, refuse the → Done move (approve:true overrides). A still-running run
 * does NOT block — it returns a note instead (don't stall the loop on pending
 * checks). No run, no flag, passed, or errored → no gate.
 *
 * Returns { refuse, error? , note? }. Never throws.
 */
export function evaluateChecksGate(board, project, ticket, { approve = false } = {}) {
  if (approve === true) return { refuse: false };
  let requireChecksOnDone = false;
  try {
    requireChecksOnDone = !!(getProjectConfig(board, project) || {}).requireChecksOnDone;
  } catch {
    requireChecksOnDone = false;
  }
  if (!requireChecksOnDone) return { refuse: false };

  let run = null;
  try {
    run = latestCheckRunForTicket(board, project, ticket);
  } catch {
    run = null;
  }
  if (!run) return { refuse: false };

  if (run.status === "failed") {
    const failed = (run.checks || []).filter((c) => c.status === "failed").map((c) => c.name);
    return {
      refuse: true,
      error:
        `requireChecksOnDone is on — the latest background check run for ${ticket} ` +
        `(runId ${run.runId}) FAILED: ${failed.join(", ") || "one or more checks"}. ` +
        `Fix the checks and re-run (start_checks), or pass approve:true to override.`,
    };
  }
  if (run.status === "running") {
    return { refuse: false, note: `background checks for ${ticket} (runId ${run.runId}) are still running — collect with get_check_results.` };
  }
  return { refuse: false };
}
