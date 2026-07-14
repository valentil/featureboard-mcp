/**
 * FeatureBoard agentic drift evaluation (FBMCPF-108).
 *
 * Measures whether the agent's implementation drifted from each ticket's intent.
 * This module owns the *mechanics* — sampling Done tickets, persisting per-ticket
 * fidelity scores, aggregating a report with a confidence interval, and applying
 * one-click remediation. The *judgment* (comparing a ticket's scope/DoD + work log
 * against the actual code it touched, and scoring it) is done by Claude, driven by
 * the `evaluate_drift` prompt, which calls recordDriftScore for each ticket.
 *
 * A run lives in <project>/.featureboard.drift.json:
 *   { runs: [ { runId, mode, createdAt, population, sampleSize, seed,
 *               tickets: [{ticket,title}], scores: [{ticket,score,verdict,gap,at}],
 *               remediations: [...] } ] }
 *
 * Scoring: 0–100 fidelity. Verdict bands — >=80 aligned, 50–79 partial, <50 drift.
 * Pure helpers (selectSample, wilsonInterval, verdictFor, makeRng) are exported for
 * unit testing.
 */

import fs from "node:fs";
import path from "node:path";

const DRIFT_STORE = ".featureboard.drift.json";

function storePath(board, project) {
  return path.join(board.projectDir(project), DRIFT_STORE);
}
function readStore(board, project) {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(board, project), "utf8"));
    if (!j || !Array.isArray(j.runs)) return { runs: [] };
    return j;
  } catch {
    return { runs: [] };
  }
}
function writeStore(board, project, data) {
  const p = storePath(board, project);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/** Map a 0–100 fidelity score to a verdict band. */
export function verdictFor(score) {
  const s = Number(score);
  if (Number.isNaN(s)) return "unknown";
  if (s >= 80) return "aligned";
  if (s >= 50) return "partial";
  return "drift";
}

/** Deterministic PRNG (mulberry32) so sampling is reproducible from a seed. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose which Done tickets to evaluate. mode "full" returns them all (newest
 * first); mode "sample" returns a seeded random subset of size min(sampleSize, N).
 * Returns { chosen, seed } — the seed used is echoed so a run is reproducible.
 */
export function selectSample(tickets, { mode = "sample", sampleSize = 10, seed } = {}) {
  const list = tickets.slice();
  if (mode === "full" || list.length <= sampleSize) {
    return { chosen: list, seed: seed == null ? null : seed >>> 0 };
  }
  const usedSeed = (seed == null ? (Date.now() ^ (list.length * 2654435761)) : seed) >>> 0;
  const rng = makeRng(usedSeed);
  // Fisher–Yates shuffle a copy, then take the first sampleSize.
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return { chosen: list.slice(0, sampleSize), seed: usedSeed };
}

/**
 * Wilson score interval for a binomial proportion (successes/n) at ~95% (z=1.96).
 * Robust for small n, unlike the normal approximation. Returns { low, high } in 0..1.
 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!n) return { low: 0, high: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = Math.max(0, (centre - margin) / denom);
  const high = Math.min(1, (centre + margin) / denom);
  return { low, high };
}

function findRun(store, runId) {
  if (!store.runs.length) return null;
  if (!runId) return store.runs[store.runs.length - 1];
  return store.runs.find((r) => r.runId === runId) || null;
}

function stampRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `drift-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * Begin a drift-evaluation run. Pulls the board's Done tickets, selects the set to
 * evaluate (full or sampled), persists a run skeleton, and returns the tickets for
 * Claude to score one by one.
 */
export function startDriftRun(board, project, { mode = "sample", sampleSize = 10, seed, type = "all" } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const m = mode === "full" ? "full" : "sample";
  const size = Math.max(1, Math.floor(Number(sampleSize) || 10));
  const done = board.listTasks(project, { status: "Done", type }).map((t) => ({
    ticket: t.ticketNumber,
    title: t.title,
    product: t.product || null,
  }));
  const population = done.length;
  if (!population) {
    throw new Error(`No Done tickets to evaluate in "${project}".`);
  }
  const { chosen, seed: usedSeed } = selectSample(done, { mode: m, sampleSize: size, seed });
  const run = {
    runId: stampRunId(),
    mode: m,
    createdAt: new Date().toISOString(),
    population,
    sampleSize: chosen.length,
    seed: usedSeed,
    tickets: chosen,
    scores: [],
    remediations: [],
    status: "open",
  };
  const store = readStore(board, project);
  store.runs.push(run);
  writeStore(board, project, store);
  return {
    runId: run.runId,
    mode: m,
    population,
    sampleSize: chosen.length,
    seed: usedSeed,
    tickets: chosen,
    note:
      m === "sample"
        ? `Sampled ${chosen.length} of ${population} Done tickets. Score each with drift_record, then drift_report.`
        : `Evaluating all ${population} Done tickets. Score each with drift_record, then drift_report.`,
  };
}

/**
 * Record a fidelity score (0–100) for one ticket in a run. verdict is derived from
 * the score when not given. gap explains the drift when partial/drift. Upserts by
 * ticket so re-scoring overwrites.
 */
export function recordDriftScore(board, project, runId, { ticket, score, verdict, gap, files } = {}) {
  if (!ticket) throw new Error("ticket is required");
  const s = Number(score);
  if (Number.isNaN(s) || s < 0 || s > 100) throw new Error("score must be a number 0–100");
  const store = readStore(board, project);
  const run = findRun(store, runId);
  if (!run) throw new Error(runId ? `drift run ${runId} not found` : "no drift run yet — call drift_start first");
  const entry = {
    ticket: String(ticket),
    score: Math.round(s),
    verdict: verdict || verdictFor(s),
    gap: gap ? String(gap) : "",
    files: Array.isArray(files) ? files.map(String) : undefined,
    at: new Date().toISOString(),
  };
  const idx = run.scores.findIndex((e) => e.ticket === entry.ticket);
  if (idx >= 0) run.scores[idx] = entry;
  else run.scores.push(entry);
  writeStore(board, project, store);
  return { runId: run.runId, recorded: entry.ticket, verdict: entry.verdict, scored: run.scores.length, target: run.sampleSize };
}

/**
 * Aggregate a run into a report: per-ticket scores, mean fidelity, verdict counts,
 * drift rate, and (for sampling) a 95% Wilson confidence interval on the true drift
 * fraction extrapolated to the Done population. Flags partial/drift tickets w/ gaps.
 */
export function driftReport(board, project, runId) {
  const store = readStore(board, project);
  const run = findRun(store, runId);
  if (!run) throw new Error(runId ? `drift run ${runId} not found` : "no drift runs yet");
  const scores = run.scores;
  const n = scores.length;
  const counts = { aligned: 0, partial: 0, drift: 0 };
  let sum = 0;
  for (const s of scores) {
    sum += s.score;
    if (counts[s.verdict] !== undefined) counts[s.verdict] += 1;
  }
  const meanScore = n ? Math.round((sum / n) * 10) / 10 : null;
  const driftedCount = counts.drift;
  const flaggedCount = counts.drift + counts.partial;
  const driftRatePct = n ? Math.round((driftedCount / n) * 1000) / 10 : 0;
  const flaggedRatePct = n ? Math.round((flaggedCount / n) * 1000) / 10 : 0;

  let confidence = null;
  if (run.mode === "sample" && n) {
    const ci = wilsonInterval(driftedCount, n);
    confidence = {
      metric: "fraction of Done tickets that drifted",
      level: "95%",
      point: Math.round((driftedCount / n) * 1000) / 1000,
      interval: [Math.round(ci.low * 1000) / 1000, Math.round(ci.high * 1000) / 1000],
      estPopulationDrifted: [Math.floor(ci.low * run.population), Math.ceil(ci.high * run.population)],
      population: run.population,
      sampled: n,
    };
  }

  const flagged = scores
    .filter((s) => s.verdict === "drift" || s.verdict === "partial")
    .sort((a, b) => a.score - b.score)
    .map((s) => ({ ticket: s.ticket, score: s.score, verdict: s.verdict, gap: s.gap, files: s.files }));

  return {
    runId: run.runId,
    mode: run.mode,
    population: run.population,
    sampleSize: run.sampleSize,
    scored: n,
    pending: run.tickets.filter((t) => !scores.some((s) => s.ticket === t.ticket)).map((t) => t.ticket),
    meanScore,
    counts,
    driftRatePct,
    flaggedRatePct,
    confidence,
    flagged,
    remediations: run.remediations || [],
  };
}

/**
 * Apply a chosen remediation across a run's flagged tickets, automatically:
 *  - "file_bugs": file a linked bug (log_bug) describing each gap
 *  - "reopen":    move each flagged ticket back to Todo
 *  - "relabel":   add a "drift" label to each flagged ticket
 * `verdicts` selects which bands to act on (default ["drift"]). dryRun previews
 * without writing. Records what it did on the run.
 */
export function applyDriftRemediation(board, project, runId, { action, verdicts = ["drift"], dryRun = false } = {}) {
  const valid = ["file_bugs", "reopen", "relabel"];
  if (!valid.includes(action)) throw new Error(`action must be one of ${valid.join(", ")}`);
  const store = readStore(board, project);
  const run = findRun(store, runId);
  if (!run) throw new Error(runId ? `drift run ${runId} not found` : "no drift runs yet");
  const targets = run.scores.filter((s) => verdicts.includes(s.verdict));
  if (!targets.length) return { runId: run.runId, action, applied: 0, results: [], note: "no tickets match the selected verdicts" };

  const results = [];
  for (const t of targets) {
    if (dryRun) {
      results.push({ ticket: t.ticket, wouldApply: action });
      continue;
    }
    if (action === "file_bugs") {
      const bug = board.addTask(project, "bug", {
        title: `Drift: ${t.ticket} implementation gap`,
        description: `Drift eval (run ${run.runId}) scored ${t.ticket} ${t.score}/100 (${t.verdict}). Gap: ${t.gap || "see report"}.`,
        product: "Task Processing",
        labels: ["drift"],
        linkedIssue: t.ticket,
      });
      results.push({ ticket: t.ticket, filedBug: bug.ticketNumber });
    } else if (action === "reopen") {
      board.setStatus(project, t.ticket, "Todo", `Reopened by drift eval ${run.runId} (score ${t.score}, ${t.verdict})`);
      results.push({ ticket: t.ticket, reopened: true });
    } else if (action === "relabel") {
      const cur = board.getTask(project, t.ticket);
      const labels = cur && Array.isArray(cur.labels) ? cur.labels.slice() : [];
      if (!labels.includes("drift")) labels.push("drift");
      board.updateTask(project, t.ticket, { labels });
      results.push({ ticket: t.ticket, relabeled: "drift" });
    }
  }
  if (!dryRun) {
    run.remediations.push({ action, verdicts, at: new Date().toISOString(), count: results.length, results });
    writeStore(board, project, store);
  }
  return { runId: run.runId, action, dryRun: !!dryRun, applied: results.length, results };
}
