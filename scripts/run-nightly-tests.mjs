#!/usr/bin/env node
/**
 * run-nightly-tests.mjs (FBMCPF-37) — Nightly test scheduling.
 *
 * Reads nightly_tests.json, runs the configured test command, and records a
 * timestamped JSON result under resultsDir (pruned to keepRuns). If the config
 * points testLogPath at a board's test_runs.md, it also appends a line in the
 * board's testing-center format so get_test_runs / the 🧪 Tests panel surface
 * the nightly run alongside manual ones.
 *
 * The original OpenClaw app ran background routines as a daemon; per DESIGN.md an
 * MCP server has no daemon, so this is a plain script a scheduled task invokes:
 *   node scripts/run-nightly-tests.mjs        (npm run nightly)
 *
 * Exit code mirrors the test run (0 pass, non-zero fail) so a scheduler can alert.
 * Pure helpers are exported for unit testing; the run only executes when the file
 * is invoked directly.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULTS = {
  enabled: true,
  schedule: "0 3 * * *",
  timezone: "local",
  command: "npm",
  args: ["test"],
  timeoutMinutes: 10,
  resultsDir: ".featureboard/nightly",
  keepRuns: 30,
  notifyOnFailureOnly: true,
  testLogPath: null,
};

/** Merge raw config over defaults and validate shapes. Throws on bad input. */
export function resolveConfig(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("nightly_tests.json must be a JSON object");
  }
  const cfg = { ...DEFAULTS, ...raw };
  if (typeof cfg.command !== "string" || !cfg.command.trim()) {
    throw new Error("config.command must be a non-empty string");
  }
  if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string")) {
    throw new Error("config.args must be an array of strings");
  }
  if (typeof cfg.timeoutMinutes !== "number" || !(cfg.timeoutMinutes > 0)) {
    throw new Error("config.timeoutMinutes must be a positive number");
  }
  if (!Number.isInteger(cfg.keepRuns) || cfg.keepRuns < 1) {
    throw new Error("config.keepRuns must be a positive integer");
  }
  if (typeof cfg.resultsDir !== "string" || !cfg.resultsDir.trim()) {
    throw new Error("config.resultsDir must be a non-empty string");
  }
  cfg.enabled = cfg.enabled !== false;
  cfg.notifyOnFailureOnly = cfg.notifyOnFailureOnly !== false;
  return cfg;
}

/** Two-digit zero pad. */
const p2 = (n) => String(n).padStart(2, "0");

/** UTC-stable timestamp parts for filenames and log lines. */
export function stampParts(now = new Date()) {
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const fileStamp = `${date}T${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return { date, time, fileStamp };
}

/** Turn a resolved config into an executable plan (pure; no side effects). */
export function planNightlyRun(config, { now = new Date() } = {}) {
  const { fileStamp } = stampParts(now);
  return {
    enabled: config.enabled,
    command: config.command,
    args: [...config.args],
    timeoutMs: Math.round(config.timeoutMinutes * 60_000),
    resultFile: `nightly-${fileStamp}.json`,
  };
}

/** Parse node:test TAP summary counters from combined stdout/stderr. */
export function parseTapSummary(output = "") {
  const grab = (re) => {
    const m = output.match(re);
    return m ? parseInt(m[1], 10) : null;
  };
  const tests = grab(/^#\s*tests\s+(\d+)/m);
  const pass = grab(/^#\s*pass\s+(\d+)/m);
  const fail = grab(/^#\s*fail\s+(\d+)/m);
  const skipped = grab(/^#\s*skipped\s+(\d+)/m);
  return {
    tests: tests ?? 0,
    passed: pass ?? 0,
    failed: fail ?? 0,
    skipped: skipped ?? 0,
    parsed: tests != null || pass != null || fail != null,
  };
}

/**
 * Decide which existing result files to delete so only keepRuns remain.
 * Filenames sort lexically by their embedded timestamp, so newest = last.
 */
export function prunePlan(files = [], keepRuns) {
  const nightly = files.filter((f) => /^nightly-.*\.json$/.test(f)).sort();
  const excess = nightly.length - keepRuns;
  return excess > 0 ? nightly.slice(0, excess) : [];
}

/** Format a board test_runs.md line (matches metadata.js logTestRun output). */
export function formatTestLogLine(result, { now = new Date() } = {}) {
  const { date, time } = stampParts(now);
  const parts = [
    `${date} ${time}`,
    `passed: ${result.passed || 0}`,
    `failed: ${result.failed || 0}`,
    `skipped: ${result.skipped || 0}`,
    "suite: nightly",
  ];
  const status = (result.failed || 0) === 0 && result.exitCode === 0 ? "pass" : "FAIL";
  parts.push(`nightly run ${status} (exit ${result.exitCode})`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Execution (only when invoked directly)
// ---------------------------------------------------------------------------

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cfgPath = path.join(root, "nightly_tests.json");
  if (!fs.existsSync(cfgPath)) {
    console.error(`nightly_tests.json not found at ${cfgPath}`);
    process.exit(2);
  }
  let config;
  try {
    config = resolveConfig(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  } catch (e) {
    console.error("Invalid nightly_tests.json:", e.message);
    process.exit(2);
  }

  if (!config.enabled) {
    console.log("Nightly tests disabled (config.enabled=false); nothing to run.");
    process.exit(0);
  }

  const now = new Date();
  const plan = planNightlyRun(config, { now });
  console.log(`Nightly test run: ${plan.command} ${plan.args.join(" ")} (timeout ${config.timeoutMinutes}m)`);

  const started = Date.now();
  const proc = spawnSync(plan.command, plan.args, {
    cwd: root,
    encoding: "utf8",
    timeout: plan.timeoutMs,
    shell: process.platform === "win32", // npm is npm.cmd on Windows
  });
  const durationMs = Date.now() - started;
  const output = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  const summary = parseTapSummary(output);
  const timedOut = proc.error && proc.error.code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : proc.status == null ? 1 : proc.status;

  const result = {
    ticket: "FBMCPF-37",
    date: stampParts(now).date,
    time: stampParts(now).time,
    command: `${plan.command} ${plan.args.join(" ")}`,
    exitCode,
    timedOut: !!timedOut,
    durationMs,
    ...summary,
  };

  // Persist JSON result + prune history.
  const outDir = path.join(root, config.resultsDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, plan.resultFile), JSON.stringify(result, null, 2) + "\n", "utf8");
  for (const stale of prunePlan(fs.readdirSync(outDir), config.keepRuns)) {
    try { fs.unlinkSync(path.join(outDir, stale)); } catch { /* ignore */ }
  }

  // Optionally append to a board's test_runs.md.
  if (config.testLogPath) {
    try {
      const line = formatTestLogLine(result, { now });
      const existing = fs.existsSync(config.testLogPath)
        ? fs.readFileSync(config.testLogPath, "utf8")
        : "# Test Runs\n";
      fs.writeFileSync(config.testLogPath, existing.replace(/\s*$/, "") + "\n" + line + "\n", "utf8");
    } catch (e) {
      console.warn("Could not append to testLogPath:", e.message);
    }
  }

  const passed = exitCode === 0 && result.failed === 0;
  if (!passed) {
    console.error(`Nightly tests FAILED — exit ${exitCode}, ${result.failed} failing, ${result.passed} passing.`);
  } else if (!config.notifyOnFailureOnly) {
    console.log(`Nightly tests passed — ${result.passed}/${result.tests} in ${Math.round(durationMs / 1000)}s.`);
  } else {
    console.log(`Nightly tests passed (${result.passed}/${result.tests}).`);
  }
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
