#!/usr/bin/env node
/**
 * run-checks.mjs (FBMCPF-261) — standalone background static-check runner.
 *
 * The point of this script is to run the cheap, pure-CPU checks that catch the
 * mistakes that slip past a normal churn loop — syntax errors in a changed file,
 * a lint rule, a fast test subset — WITHOUT burning any model tokens and WITHOUT
 * blocking the orchestrator. commit_feature (or the start_checks tool) spawns
 * this DETACHED right after a commit lands, then moves on to the next ticket; the
 * results are collected later via get_check_results.
 *
 * Usage:
 *   node scripts/run-checks.mjs <argsFile.json>
 *
 * argsFile is a JSON object:
 *   {
 *     runId, repo, resultsFile,
 *     revision?,      // commit hash to scope changed files to (git show)
 *     ticket?, project,
 *     checks: { commands: [{name, command, timeoutMinutes?}], syntaxCheckChangedFiles? }
 *   }
 *
 * Behaviour:
 *  - writes resultsFile immediately ({status:"running", ...})
 *  - determines changed files (revision -> git show; else git diff HEAD~1..HEAD,
 *    falling back to git status --porcelain for a dirty tree)
 *  - runs, sequentially: (a) `node --check` on each changed .js/.mjs/.cjs that
 *    still exists (one result per file), then (b) each configured command via a
 *    shell in the repo cwd with its own timeout
 *  - rewrites resultsFile atomically after each check (progressive)
 *  - finishes with status "passed"/"failed", finishedAt, durationMs, summary
 *  - crash-safe: any unexpected throw is caught and written as status "error"
 *
 * Zero network, zero LLM — this is pure CPU.
 *
 * runChecksPipeline() is exported so unit tests can run the whole pipeline
 * in-process against a temp git repo without spawning a child.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OUTPUT_CAP = 2000; // keep only the last ~2000 chars of each check's output

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function tailCap(s) {
  const str = String(s || "");
  return str.length > OUTPUT_CAP ? str.slice(-OUTPUT_CAP) : str;
}

/** Run git in the repo, returning { status, stdout, stderr }. Never throws. */
function git(args, repo) {
  try {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } catch (e) {
    return { status: 1, stdout: "", stderr: String((e && e.message) || e) };
  }
}

function parseFileList(stdout) {
  return (stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The files a run should syntax-check: those touched by `revision` (git show),
 * else those changed in the last commit (git diff HEAD~1..HEAD), else — for a
 * dirty tree with no prior commit to diff — whatever git status reports.
 */
export function changedFiles(repo, revision) {
  if (revision) {
    const r = git(["show", "--name-only", "--format=", String(revision)], repo);
    if (r.status === 0) return parseFileList(r.stdout);
    return [];
  }
  const diff = git(["diff", "--name-only", "HEAD~1..HEAD"], repo);
  if (diff.status === 0 && diff.stdout.trim()) return parseFileList(diff.stdout);
  // fallback: a dirty working tree (or a repo with a single commit)
  const status = git(["status", "--porcelain"], repo);
  if (status.status === 0) {
    return parseFileList(status.stdout).map((line) => line.replace(/^..\s+/, "").trim()).filter(Boolean);
  }
  return [];
}

const SYNTAX_EXT = new Set([".js", ".mjs", ".cjs"]);

/**
 * Core pipeline. Writes the results file progressively and returns the final
 * results object. Never throws for a per-check failure; a genuinely unexpected
 * error propagates so main()/callers can record status "error".
 */
export function runChecksPipeline(args) {
  const { runId, repo, resultsFile, revision = null, ticket = null, project = null } = args;
  const checks = args.checks && typeof args.checks === "object" ? args.checks : {};
  const startMs = Date.now();

  const results = {
    runId,
    status: "running",
    project,
    ticket,
    revision,
    repo,
    startedAt: new Date(startMs).toISOString(),
    checks: [],
  };
  const flush = () => atomicWrite(resultsFile, JSON.stringify(results, null, 2) + "\n");
  flush();

  // (a) syntax-check changed .js/.mjs/.cjs files that still exist.
  if (checks.syntaxCheckChangedFiles !== false) {
    const files = changedFiles(repo, revision).filter((f) => SYNTAX_EXT.has(path.extname(f)));
    for (const rel of files) {
      const abs = path.isAbsolute(rel) ? rel : path.join(repo, rel);
      if (!fs.existsSync(abs)) continue; // deleted/renamed-away — nothing to check
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ["--check", abs], { cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const status = r.status === 0 ? "passed" : "failed";
      results.checks.push({
        name: `syntax:${rel}`,
        type: "syntax",
        file: rel,
        status,
        output: tailCap(`${r.stdout || ""}${r.stderr || ""}`),
        durationMs: Date.now() - t0,
      });
      flush();
    }
  }

  // (b) each configured command, via a shell in the repo cwd, with its timeout.
  const commands = Array.isArray(checks.commands) ? checks.commands : [];
  for (const c of commands) {
    if (!c || !c.command) continue;
    const timeoutMinutes = Number(c.timeoutMinutes) > 0 ? Number(c.timeoutMinutes) : 5;
    const t0 = Date.now();
    let r;
    try {
      r = spawnSync(c.command, {
        cwd: repo,
        shell: true,
        encoding: "utf8",
        timeout: timeoutMinutes * 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      r = { status: 1, stdout: "", stderr: String((e && e.message) || e), error: e };
    }
    const timedOut = r.signal === "SIGTERM" || (r.error && r.error.code === "ETIMEDOUT");
    const status = r.status === 0 && !timedOut ? "passed" : "failed";
    results.checks.push({
      name: c.name || c.command,
      type: "command",
      command: c.command,
      status,
      timedOut: !!timedOut,
      output: tailCap(`${r.stdout || ""}${r.stderr || ""}`),
      durationMs: Date.now() - t0,
    });
    flush();
  }

  const passed = results.checks.filter((c) => c.status === "passed").length;
  const failed = results.checks.filter((c) => c.status === "failed").length;
  results.status = failed > 0 ? "failed" : "passed";
  results.finishedAt = new Date().toISOString();
  results.durationMs = Date.now() - startMs;
  results.summary = { total: results.checks.length, passed, failed };
  flush();
  return results;
}

function main() {
  const argsFile = process.argv[2];
  if (!argsFile) {
    console.error("usage: node scripts/run-checks.mjs <argsFile.json>");
    process.exit(2);
  }
  let args;
  try {
    args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  } catch (e) {
    console.error(`run-checks: could not read args file ${argsFile}: ${e.message}`);
    process.exit(2);
  }
  try {
    runChecksPipeline(args);
  } catch (e) {
    // crash-safety: record an error result rather than dying silently, so a
    // collector polling the results file sees a terminal status.
    try {
      const errResults = {
        runId: args.runId,
        status: "error",
        project: args.project || null,
        ticket: args.ticket || null,
        revision: args.revision || null,
        repo: args.repo || null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        checks: [],
        error: String((e && e.stack) || e),
      };
      atomicWrite(args.resultsFile, JSON.stringify(errResults, null, 2) + "\n");
    } catch {
      /* nothing more we can do */
    }
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isMain) main();
