#!/usr/bin/env node
/**
 * autoresearch.mjs (FBMCPF-246) — Karpathy-style auto-research outer loop.
 *
 * The shape (per Karpathy's autoresearch, March 2026): an agent modifies the
 * code, a fixed-budget run measures one objective metric, the change is KEPT
 * if the metric improved and REVERTED if not — then the loop repeats,
 * unattended, all night. Accepted changes stack.
 *
 * This is the FeatureBoard incarnation. It is a STANDALONE runner — no Cowork
 * session, no MCP server. Schedule it with the OS (Task Scheduler / cron) or
 * leave it running; Claude's role is the nightly CONFIGURATOR: a Cowork
 * scheduled task refreshes autoresearch.config.json (hypothesis queue, budgets)
 * and triages autoresearch_results.json into board tickets each morning
 * (see docs/RECIPES.md → "Nightly Auto-Research Outer Loop").
 *
 * Per experiment:
 *   1. git worktree on a fresh branch off the integration branch (never main).
 *   2. Headless `claude -p` implements the hypothesis inside the worktree.
 *   3. Constraint gate: the FULL test suite must stay green — non-negotiable.
 *   4. Objective: one numeric metric (default scripts/autoresearch-metric.mjs).
 *   5. Decision: green + improved beyond minDelta → merge into the integration
 *      branch (baseline advances, changes stack); otherwise discard.
 *   6. Append a structured entry to autoresearch_results.json either way.
 *
 * TOKEN SAFETY (FBMCPF-248): the runner itself makes ZERO API calls. The ONLY
 * token-consuming step is the single headless `claude -p` invocation that
 * implements each hypothesis; the constraint suite and the objective metric
 * are pure local compute. Budgets cap that one spend: agent.maxTurns and
 * agent.model bound each call, --output-format json usage is captured per
 * experiment, and budget.maxUsdPerExperiment / maxUsdPerRun (or the token
 * variants) halt the loop when exhausted. Unparseable usage is treated as the
 * per-experiment cap (conservative), never as free.
 *
 * Safety rails: main is never written; the integration branch (default
 * autoresearch/nightly) is the only merge target, reviewed by a human/Claude
 * before anything graduates. Every experiment is worktree-isolated, budget-
 * capped, crash-safe (a thrown error records a "failed" result, never kills
 * the loop), and SIGINT-clean.
 *
 * Usage:
 *   node scripts/autoresearch.mjs                # run the configured queue
 *   node scripts/autoresearch.mjs --once         # single experiment
 *   node scripts/autoresearch.mjs --dry-run      # validate config + print plan
 *   node scripts/autoresearch.mjs --config <p>   # alternate config path
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_FILE = "autoresearch_results.json";
const CONFIG_FILE = "autoresearch.config.json";

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  integrationBranch: "autoresearch/nightly",
  baseBranch: "main",
  objective: {
    command: "node scripts/autoresearch-metric.mjs",
    parse: "METRIC ([0-9.]+)",
    direction: "min", // "min" = lower is better, "max" = higher is better
    minDelta: 0.5, // percent improvement required to accept (guards noise)
    samples: 3, // metric runs per measurement; median is used
  },
  constraint: {
    command: "node scripts/run-tests.mjs",
    mustMatch: "# fail 0",
    timeoutMinutes: 5,
  },
  agent: {
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits", "--output-format", "json"],
    model: null, // e.g. "haiku"/"sonnet" — appended as --model when set
    maxTurns: 25, // appended as --max-turns; hard bound on each agent loop
    timeoutMinutes: 12,
  },
  budget: {
    maxExperiments: 20,
    stopAfterMinutes: 480,
    maxUsdPerExperiment: 3, // conservative fallback charge when usage is unparseable
    maxUsdPerRun: 15, // loop halts once cumulative agent spend reaches this
    maxTokensPerExperiment: null, // optional token-denominated variants
    maxTokensPerRun: null,
  },
  experiments: [],
};

/** Deep-merge user config over defaults (arrays replace, objects merge). */
export function mergeConfig(user = {}) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(user || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Validate a merged config; returns a list of problems (empty = valid). */
export function validateConfig(cfg) {
  const errs = [];
  if (!cfg.integrationBranch || /\s/.test(cfg.integrationBranch)) errs.push("integrationBranch must be a branch name without spaces");
  if (!["min", "max"].includes(cfg.objective?.direction)) errs.push('objective.direction must be "min" or "max"');
  if (!cfg.objective?.command) errs.push("objective.command is required");
  if (!cfg.objective?.parse) errs.push("objective.parse (regex with one capture group) is required");
  if (!cfg.constraint?.command) errs.push("constraint.command is required");
  if (!cfg.constraint?.mustMatch) errs.push("constraint.mustMatch is required");
  if (!Array.isArray(cfg.experiments)) errs.push("experiments must be an array");
  else {
    cfg.experiments.forEach((e, i) => {
      if (!e || !e.id) errs.push(`experiments[${i}] needs an id`);
      if (!e || !e.hypothesis) errs.push(`experiments[${i}] needs a hypothesis`);
    });
    const ids = cfg.experiments.map((e) => e && e.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) errs.push("experiment ids must be unique");
  }
  if (!(cfg.budget?.maxExperiments > 0)) errs.push("budget.maxExperiments must be > 0");
  return errs;
}

/** Extract the numeric metric from command output via the configured regex. */
export function parseMetric(output, pattern) {
  const m = new RegExp(pattern).exec(String(output || ""));
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Median of a numeric array (null on empty). */
export function median(xs) {
  const a = (xs || []).filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * The keep/revert decision: accept only when the metric moved in the right
 * direction by at least minDelta PERCENT of the baseline (noise guard).
 */
export function shouldAccept({ baseline, value, direction, minDelta = 0 }) {
  if (!Number.isFinite(baseline) || !Number.isFinite(value)) return false;
  if (baseline === 0) return direction === "max" ? value > 0 : false;
  const improvedBy = direction === "min" ? ((baseline - value) / Math.abs(baseline)) * 100 : ((value - baseline) / Math.abs(baseline)) * 100;
  return improvedBy >= minDelta;
}

/** The bounded, contract-carrying prompt handed to the headless agent. */
export function buildExperimentPrompt(exp, cfg) {
  return [
    `You are running ONE bounded auto-research experiment in this repository. Work autonomously; nobody is watching.`,
    ``,
    `HYPOTHESIS: ${exp.hypothesis}`,
    exp.hint ? `WHERE TO LOOK: ${exp.hint}` : null,
    ``,
    `CONTRACT — violating any of these voids the experiment:`,
    `- Make the SMALLEST change that tests the hypothesis. One idea per experiment.`,
    `- Behavior must stay identical except for the targeted improvement: the full test suite (${cfg.constraint.command}) must pass unchanged afterwards. Run it yourself before finishing.`,
    `- Do not modify test files except to ADD tests. Never weaken or delete an assertion.`,
    `- Do not touch: package.json dependencies, .git*, scripts/autoresearch*.`,
    `- Objective metric: ${cfg.objective.command} (${cfg.objective.direction === "min" ? "lower" : "higher"} is better). Your change should plausibly improve it.`,
    `- Commit your change with message "autoresearch(${exp.id}): <one line>" before exiting. If you conclude the hypothesis is wrong or too risky, revert everything, commit NOTHING, and exit.`,
  ].filter((l) => l !== null).join("\n");
}

/**
 * Parse usage out of `claude -p --output-format json` stdout: the result object
 * carries total_cost_usd and usage token counts. Returns { costUsd, tokens }
 * with nulls when nothing parseable is found — callers must treat null
 * conservatively (charge the per-experiment cap), never as zero.
 */
export function parseAgentUsage(stdout) {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && (o.total_cost_usd !== undefined || o.usage)) {
        const u = o.usage || {};
        const tokens = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
          .reduce((n, k) => n + (Number.isFinite(u[k]) ? u[k] : 0), 0);
        return { costUsd: Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null, tokens: tokens || null };
      }
    } catch { /* not this line */ }
  }
  return { costUsd: null, tokens: null };
}

/**
 * Budget gate. `spent` accumulates { usd, tokens } across the run; an
 * experiment with unknown usage was already charged maxUsdPerExperiment by the
 * caller. Returns { stop, reason } — stop BEFORE starting the next experiment.
 */
export function budgetExceeded(spent, budget = {}) {
  if (budget.maxUsdPerRun != null && spent.usd >= budget.maxUsdPerRun) {
    return { stop: true, reason: `USD budget spent ($${spent.usd.toFixed(2)} >= $${budget.maxUsdPerRun})` };
  }
  if (budget.maxTokensPerRun != null && spent.tokens >= budget.maxTokensPerRun) {
    return { stop: true, reason: `token budget spent (${spent.tokens} >= ${budget.maxTokensPerRun})` };
  }
  return { stop: false, reason: null };
}

/** Append entries to autoresearch_results.json (array file, corrupt-tolerant). */
export function appendResults(repoRoot, entries) {
  const file = path.join(repoRoot, RESULTS_FILE);
  let existing = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
      if (Array.isArray(parsed)) existing = parsed;
      else fs.copyFileSync(file, `${file}.bak`);
    } catch {
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
    }
  }
  const combined = existing.concat(entries || []);
  fs.writeFileSync(file, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
  return combined;
}

// ---------------------------------------------------------------------------
// impure machinery
// ---------------------------------------------------------------------------

function sh(cmd, { cwd = ROOT, timeoutMs = 10 * 60_000 } = {}) {
  // Run through the shell so config commands can be full command lines.
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: r.error?.code === "ETIMEDOUT" };
}

function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const log = (msg) => console.log(`[autoresearch ${new Date().toISOString().slice(11, 19)}] ${msg}`);

function measureObjective(cfg, cwd) {
  const vals = [];
  for (let i = 0; i < (cfg.objective.samples || 1); i++) {
    const r = sh(cfg.objective.command, { cwd, timeoutMs: 10 * 60_000 });
    if (r.status !== 0) return { value: null, error: `objective command failed: ${(r.stderr || r.stdout).slice(0, 400)}` };
    const v = parseMetric(r.stdout + "\n" + r.stderr, cfg.objective.parse);
    if (v == null) return { value: null, error: "objective output did not match parse pattern" };
    vals.push(v);
  }
  return { value: median(vals) };
}

function runConstraint(cfg, cwd) {
  const r = sh(cfg.constraint.command, { cwd, timeoutMs: (cfg.constraint.timeoutMinutes || 5) * 60_000 });
  const ok = r.status === 0 && (r.stdout + r.stderr).includes(cfg.constraint.mustMatch);
  return { ok, detail: ok ? null : (r.timedOut ? "constraint timed out" : `suite not green (status ${r.status})`) };
}

function ensureIntegrationBranch(cfg) {
  if (git(["rev-parse", "--verify", "-q", cfg.integrationBranch]).status !== 0) {
    const base = git(["rev-parse", "--verify", "-q", cfg.baseBranch]).status === 0 ? cfg.baseBranch : "HEAD";
    const r = git(["branch", cfg.integrationBranch, base]);
    if (r.status !== 0) fail(`cannot create integration branch: ${r.stderr}`);
    log(`created ${cfg.integrationBranch} from ${base}`);
  }
}

function runExperiment(exp, cfg, worktreesDir) {
  const started = Date.now();
  const branch = `autoresearch/exp-${exp.id}`;
  const wt = path.join(worktreesDir, `exp-${exp.id}`);
  const entry = { id: exp.id, hypothesis: exp.hypothesis, startedAt: new Date().toISOString(), accepted: false, status: "failed", baseline: null, value: null, notes: [] };
  const cleanup = () => {
    git(["worktree", "remove", "--force", wt]);
    git(["branch", "-D", branch]);
  };
  try {
    git(["branch", "-D", branch]); // stale from a crashed run
    let r = git(["worktree", "add", "-b", branch, wt, cfg.integrationBranch]);
    if (r.status !== 0) throw new Error(`worktree add failed: ${r.stderr}`);

    // agent implements the hypothesis inside the worktree
    const prompt = buildExperimentPrompt(exp, cfg);
    const agentArgs = [...cfg.agent.args];
    if (cfg.agent.model) agentArgs.push("--model", cfg.agent.model);
    if (cfg.agent.maxTurns) agentArgs.push("--max-turns", String(cfg.agent.maxTurns));
    const agentRes = spawnSync(cfg.agent.command, [...agentArgs, prompt], {
      cwd: wt, encoding: "utf8", timeout: (cfg.agent.timeoutMinutes || 12) * 60_000, maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32", // claude is a .cmd shim on Windows
    });
    if (agentRes.error && agentRes.error.code === "ENOENT") throw new Error(`agent command not found: ${cfg.agent.command} (install Claude Code CLI or set agent.command)`);
    // token accounting — the ONLY spend in the whole loop happens in the call above
    const usage = parseAgentUsage(agentRes.stdout);
    entry.agentCostUsd = usage.costUsd;
    entry.agentTokens = usage.tokens;
    if (usage.costUsd == null) entry.notes.push(`agent usage unparseable — charged the per-experiment cap ($${cfg.budget.maxUsdPerExperiment}) against the run budget`);
    else if (cfg.budget.maxUsdPerExperiment != null && usage.costUsd > cfg.budget.maxUsdPerExperiment) entry.notes.push(`over per-experiment USD cap ($${usage.costUsd.toFixed(2)} > $${cfg.budget.maxUsdPerExperiment})`);
    if (usage.tokens != null && cfg.budget.maxTokensPerExperiment != null && usage.tokens > cfg.budget.maxTokensPerExperiment) entry.notes.push(`over per-experiment token cap (${usage.tokens} > ${cfg.budget.maxTokensPerExperiment})`);
    const headMoved = git(["rev-list", "--count", `${cfg.integrationBranch}..${branch}`], wt).stdout !== "0";
    if (!headMoved) { entry.status = "no-change"; entry.notes.push("agent committed nothing (hypothesis withdrawn or agent failed)"); cleanup(); return entry; }

    // constraint gate: full suite green in the worktree
    const gate = runConstraint(cfg, wt);
    if (!gate.ok) { entry.status = "rejected"; entry.notes.push(gate.detail); cleanup(); return entry; }

    // objective: baseline on the integration branch state vs the experiment
    const base = measureObjective(cfg, ROOT); // ROOT sits on integration branch during a run
    const val = measureObjective(cfg, wt);
    entry.baseline = base.value; entry.value = val.value;
    if (base.error || val.error) { entry.status = "rejected"; entry.notes.push(base.error || val.error); cleanup(); return entry; }

    if (shouldAccept({ baseline: base.value, value: val.value, direction: cfg.objective.direction, minDelta: cfg.objective.minDelta })) {
      const m = git(["merge", "--no-ff", "-m", `autoresearch: accept ${exp.id} (${base.value} -> ${val.value})`, branch]);
      if (m.status !== 0) { git(["merge", "--abort"]); entry.status = "rejected"; entry.notes.push(`merge conflict: ${m.stderr.slice(0, 200)}`); cleanup(); return entry; }
      entry.accepted = true; entry.status = "accepted";
    } else {
      entry.status = "rejected";
      entry.notes.push(`metric did not improve by >=${cfg.objective.minDelta}% (${base.value} -> ${val.value})`);
    }
    cleanup();
    return entry;
  } catch (err) {
    entry.notes.push(String(err && err.message || err).slice(0, 400));
    try { cleanup(); } catch { /* best effort */ }
    return entry;
  } finally {
    entry.durationMs = Date.now() - started;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const opt = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

  const cfgPath = path.resolve(ROOT, opt("--config", CONFIG_FILE));
  if (!fs.existsSync(cfgPath)) fail(`no config at ${cfgPath} — let Claude's nightly configurator write one, or copy autoresearch.config.example.json`);
  let cfg;
  try { cfg = mergeConfig(JSON.parse(fs.readFileSync(cfgPath, "utf8"))); } catch (e) { fail(`config is not valid JSON: ${e.message}`); }
  const errs = validateConfig(cfg);
  if (errs.length) fail(`invalid config:\n  - ${errs.join("\n  - ")}`);

  const todo = cfg.experiments.filter((e) => !e.status || e.status === "todo");
  if (flag("--dry-run")) {
    console.log(`config OK. integration branch: ${cfg.integrationBranch}; objective: ${cfg.objective.command} (${cfg.objective.direction}, minDelta ${cfg.objective.minDelta}%)`);
    console.log(`plan: ${Math.min(todo.length, cfg.budget.maxExperiments)} of ${todo.length} queued experiment(s) within ${cfg.budget.stopAfterMinutes} min:`);
    todo.slice(0, cfg.budget.maxExperiments).forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${e.hypothesis}`));
    process.exit(0);
  }
  if (!todo.length) { log("experiment queue is empty — nothing to do."); process.exit(0); }
  if (git(["rev-parse", "--git-dir"]).status !== 0) fail("not a git repository");
  if (git(["status", "--porcelain"]).stdout) fail("working tree is dirty — commit or stash before an unattended run");

  ensureIntegrationBranch(cfg);
  const startBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  const swap = git(["checkout", cfg.integrationBranch]);
  if (swap.status !== 0) fail(`cannot checkout ${cfg.integrationBranch}: ${swap.stderr}`);

  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-autoresearch-"));
  const t0 = Date.now();
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; log("SIGINT — finishing current experiment, then stopping."); });

  const results = [];
  const spent = { usd: 0, tokens: 0 };
  const limit = flag("--once") ? 1 : cfg.budget.maxExperiments;
  for (const exp of todo.slice(0, limit)) {
    if (stopped) break;
    if ((Date.now() - t0) / 60_000 > cfg.budget.stopAfterMinutes) { log("time budget spent — stopping."); break; }
    const gate = budgetExceeded(spent, cfg.budget);
    if (gate.stop) { log(`${gate.reason} — stopping.`); break; }
    log(`experiment [${exp.id}]: ${exp.hypothesis}`);
    const entry = runExperiment(exp, cfg, worktreesDir);
    spent.usd += entry.agentCostUsd != null ? entry.agentCostUsd : (cfg.budget.maxUsdPerExperiment || 0);
    spent.tokens += entry.agentTokens || 0;
    log(`  → ${entry.status}${entry.baseline != null ? ` (${entry.baseline} -> ${entry.value})` : ""}${entry.agentCostUsd != null ? ` [$${entry.agentCostUsd.toFixed(2)}]` : ""}`);
    results.push(entry);
    // persist config progress + results after EVERY experiment (crash-safe)
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const re = (raw.experiments || []).find((e) => e.id === exp.id);
    if (re) re.status = entry.status === "accepted" ? "accepted" : "done";
    fs.writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`);
    appendResults(ROOT, [entry]);
  }

  git(["checkout", startBranch]); // leave the tree where we found it
  const accepted = results.filter((r) => r.accepted).length;
  log(`done: ${results.length} experiment(s), ${accepted} accepted on ${cfg.integrationBranch}. Agent spend: $${spent.usd.toFixed(2)}${spent.tokens ? ` / ${spent.tokens} tokens` : ""}. Results in ${RESULTS_FILE}.`);
  if (accepted) log(`review with: git log ${startBranch}..${cfg.integrationBranch} --oneline`);
}
