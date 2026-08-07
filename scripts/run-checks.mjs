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


// ── FBMCPF-387: impact testing ──────────────────────────────────────────────
// A require/import graph over the repo's own test entry points, reversed, so a
// run can execute ONLY the tests whose transitive dependency closure contains a
// changed file. The graph is a small JSON database persisted (by the caller,
// via checks.testImpact.graphPath) between runs:
//   { version: 1, builtAt, entries: [..], files: { <rel>: { m, s, deps: [..] } } }
// `m`/`s` are mtimeMs/size, so rebuilds re-parse only files that changed —
// the same interchange format CADSolver's tools/impacted_tests.js established.

const DEP_PATTERNS = [
  /require\(\s*["'](\.[^"']+)["']\s*\)/g,   // require('./x')
  /import\s+[^"']*["'](\.[^"']+)["']/g,        // import x from './x'
  /import\(\s*["'](\.[^"']+)["']\s*\)/g,    // dynamic import('./x')
  /export\s+[^"']*from\s*["'](\.[^"']+)["']/g, // export ... from './x'
];

/** Relative import/require specifiers in a source string (deduped, raw). */
export function parseRelativeDeps(src) {
  const found = new Set();
  for (const re of DEP_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

const norm = (p) => p.replace(/\\/g, "/");

/** Resolve one raw specifier against a file's dir → repo-relative path, or null. */
function resolveDep(repo, fromRel, raw) {
  const baseDir = path.dirname(path.join(repo, fromRel));
  for (const cand of [raw, raw + ".js", raw + ".mjs", raw + ".cjs", raw + "/index.js"]) {
    const abs = path.resolve(baseDir, cand);
    try {
      if (fs.statSync(abs).isFile()) return norm(path.relative(repo, abs));
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Test entry points from the repo's package.json scripts: every `node <p>.js`
 * (or .mjs/.cjs) invocation that is not a bare `node --check`. Empty when there
 * is no package.json — pass checks.testImpact.entries explicitly then.
 */
export function discoverTestEntries(repo) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const text = Object.values(pkg.scripts || {}).join("\n");
  const entries = new Set();
  for (const m of text.matchAll(/node\s+(?!--check\s)([^\s&|"']+\.(?:js|mjs|cjs))/g)) {
    const rel = norm(m[1]);
    if (!rel.startsWith("-") && fs.existsSync(path.join(repo, rel))) entries.add(rel);
  }
  return [...entries].sort();
}

/**
 * Build (or incrementally refresh, given `prior`) the impact graph for a set of
 * entry files: walk each entry's transitive relative deps, re-parsing only
 * files whose mtime/size changed since `prior`. Returns the graph object.
 */
export function buildImpactGraph(repo, entries, prior = null) {
  const priorFiles = (prior && prior.version === 1 && prior.files) || {};
  const files = {};
  const deps = (rel) => {
    if (files[rel]) return files[rel].deps;
    let st;
    try {
      st = fs.statSync(path.join(repo, rel));
    } catch {
      files[rel] = { m: 0, s: 0, deps: [] };
      return files[rel].deps;
    }
    const hit = priorFiles[rel];
    if (hit && hit.m === st.mtimeMs && hit.s === st.size) {
      files[rel] = hit;
      return hit.deps;
    }
    let out = [];
    try {
      const src = fs.readFileSync(path.join(repo, rel), "utf8");
      out = parseRelativeDeps(src)
        .map((raw) => resolveDep(repo, rel, raw))
        .filter(Boolean);
    } catch { /* unreadable → leaf */ }
    files[rel] = { m: st.mtimeMs, s: st.size, deps: out };
    return out;
  };
  for (const entry of entries) {
    const seen = new Set([entry]);
    const stack = [entry];
    while (stack.length) {
      for (const d of deps(stack.pop())) {
        if (!seen.has(d)) { seen.add(d); stack.push(d); }
      }
    }
  }
  return { version: 1, builtAt: new Date().toISOString(), entries: [...entries], files };
}

/**
 * Which entries can see any of `changed`? Reverse the graph and union.
 * Returns { impacted: [entries], unmapped: [changed js files no entry sees] }.
 */
export function impactedTests(graph, changed) {
  const entries = (graph && graph.entries) || [];
  const files = (graph && graph.files) || {};
  const reverse = new Map(); // rel → Set(entry)
  for (const entry of entries) {
    const seen = new Set([entry]);
    const stack = [entry];
    while (stack.length) {
      const f = stack.pop();
      if (!reverse.has(f)) reverse.set(f, new Set());
      reverse.get(f).add(entry);
      for (const d of (files[f] && files[f].deps) || []) {
        if (!seen.has(d)) { seen.add(d); stack.push(d); }
      }
    }
  }
  const impacted = new Set();
  const unmapped = [];
  for (const c of changed) {
    const rel = norm(c);
    const hits = reverse.get(rel);
    if (hits) for (const e of hits) impacted.add(e);
    else if (/\.(js|mjs|cjs)$/.test(rel)) unmapped.push(rel);
  }
  return { impacted: [...impacted].sort(), unmapped };
}

const matchesAny = (rel, patterns) =>
  (patterns || []).some((s) => rel === s || rel.startsWith(s) || norm(rel).includes(s));

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

  // (a2) FBMCPF-387: impact testing. When checks.testImpact is configured, run
  // ONLY the test entries whose dependency closure contains a changed file.
  // The graph database persists at testImpact.graphPath between runs.
  const ti = checks.testImpact && typeof checks.testImpact === "object" ? checks.testImpact : null;
  if (ti) {
    const t0 = Date.now();
    try {
      const ignore = Array.isArray(ti.ignorePatterns) ? ti.ignorePatterns : [];
      const changed = changedFiles(repo, revision).filter((f) => !matchesAny(f, ignore));
      const entries = Array.isArray(ti.entries) && ti.entries.length ? ti.entries : discoverTestEntries(repo);
      const prior = ti.graphPath ? (() => { try { return JSON.parse(fs.readFileSync(ti.graphPath, "utf8")); } catch { return null; } })() : null;
      const graph = buildImpactGraph(repo, entries, prior);
      if (ti.graphPath) {
        try { atomicWrite(ti.graphPath, JSON.stringify(graph) + "\n"); } catch { /* db write is best-effort */ }
      }
      const { impacted, unmapped } = impactedTests(graph, changed);
      const slowPatterns = Array.isArray(ti.slowPatterns) ? ti.slowPatterns : [];
      const deferred = impacted.filter((e) => matchesAny(e, slowPatterns));
      const toRun = impacted.filter((e) => !matchesAny(e, slowPatterns));
      results.checks.push({
        name: "impact-map",
        type: "impact-map",
        status: "passed",
        output: tailCap(
          `${changed.length} changed → ${impacted.length} impacted ` +
          `(${toRun.length} run, ${deferred.length} deferred slow, ${unmapped.length} unmapped)` +
          (deferred.length ? `\ndeferred: ${deferred.join(", ")}` : "") +
          (unmapped.length ? `\nunmapped (no test entry reaches them — CI is the backstop): ${unmapped.join(", ")}` : "")),
        changed: changed.length,
        impacted,
        deferred,
        unmapped,
        durationMs: Date.now() - t0,
      });
      flush();
      if (ti.command) {
        // Delegated mode: the repo has its own impact runner (e.g. npm run
        // test:impact) — run it once, with the changed list in the env.
        const timeoutMinutes = Number(ti.timeoutMinutes) > 0 ? Number(ti.timeoutMinutes) : 10;
        const tc = Date.now();
        let r;
        try {
          r = spawnSync(ti.command, {
            cwd: repo,
            shell: true,
            encoding: "utf8",
            timeout: timeoutMinutes * 60_000,
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, FB_IMPACT_CHANGED: changed.join("\n"), FB_IMPACT_REVISION: revision || "" },
          });
        } catch (e) {
          r = { status: 1, stdout: "", stderr: String((e && e.message) || e), error: e };
        }
        const timedOut = r.signal === "SIGTERM" || (r.error && r.error.code === "ETIMEDOUT");
        results.checks.push({
          name: "impact:" + ti.command,
          type: "impact",
          command: ti.command,
          status: r.status === 0 && !timedOut ? "passed" : "failed",
          timedOut: !!timedOut,
          output: tailCap(`${r.stdout || ""}${r.stderr || ""}`),
          durationMs: Date.now() - tc,
        });
        flush();
      } else {
        // Builtin mode: run each impacted entry directly with node.
        const perTestMinutes = Number(ti.timeoutMinutes) > 0 ? Number(ti.timeoutMinutes) : 5;
        for (const entry of toRun) {
          const tt = Date.now();
          const r = spawnSync(process.execPath, [entry], {
            cwd: repo,
            encoding: "utf8",
            timeout: perTestMinutes * 60_000,
            maxBuffer: 32 * 1024 * 1024,
          });
          const timedOut = r.signal === "SIGTERM";
          results.checks.push({
            name: "impact:" + entry,
            type: "impact",
            file: entry,
            status: r.status === 0 && !timedOut ? "passed" : "failed",
            timedOut: !!timedOut,
            output: tailCap(`${r.stdout || ""}${r.stderr || ""}`),
            durationMs: Date.now() - tt,
          });
          flush();
        }
      }
    } catch (e) {
      // impact stage must never take down the whole run
      results.checks.push({
        name: "impact-map",
        type: "impact-map",
        status: "failed",
        output: tailCap(String((e && e.stack) || e)),
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
