/**
 * FBMCPF-351: routing scorecard — the empirical arm of the model-tier policy in
 * routing.js.
 *
 * Every routing decision on this board (budget.js suggestModel/rosterModel,
 * orchestration.js suggestModelAndCap, CAP_BY_EFFORT) is a keyword heuristic
 * with no feedback loop: nothing ever checks whether opus tickets actually
 * finish cheaper, faster, or cleaner than sonnet ones. This module closes that
 * loop from data the board already keeps:
 *
 *   agent_work_log.md   tokens + model per work event  -> spend, and $ via pricing.js
 *   ticket_events.jsonl status transitions             -> cycle time, and reopens
 *   the board itself     bugs filed with ref:<ticket>  -> rework after close-out
 *
 * The headline number is COST PER CLEAN TICKET: total dollars spent on a tier,
 * divided by the tickets it closed that did NOT come back. A tier that is cheap
 * per token but needs a second pass is not actually cheap, and a flat
 * cost-per-ticket average hides exactly that.
 *
 * Honesty rules, deliberately strict:
 *   - a tier with fewer than `minSamples` closed tickets gets no verdict, ever —
 *     the readout says "insufficient data" and reports the sample count;
 *   - tickets whose tier can't be established are bucketed as "unknown" rather
 *     than being assumed to be the default tier;
 *   - this is ADVICE. Nothing here mutates a label or overrides rosterModel.
 *     Intake stays deterministic (see orchestration.js's stated contract) — a
 *     human or the orchestrator decides what to do with the numbers.
 *
 * No import cycle: metadata/events/pricing/budget do NOT import this module.
 */

import { readWorkLog } from "./metadata.js";
import { readEvents } from "./events.js";
import { getPricing, costOfEvent } from "./pricing.js";
import { effortOfTask, modelOfTask } from "./budget.js";
import { normalizeTier, MODEL_TIERS } from "./routing.js";

const DEFAULT_MIN_SAMPLES = 3;
const EFFORT_BUCKETS = ["low", "medium", "high", "unknown"];

const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const round4 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1e4) / 1e4);

/** Median of a numeric array, or null when empty. Not rounded — callers round. */
export function median(xs) {
  const s = (xs || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Which tier actually ran a ticket, in decreasing order of trustworthiness:
 *   1. the work log — what was really recorded at close-out (set_status/log_work
 *      write `model` here), weighted by tokens so the tier that did the bulk of
 *      the work wins when a ticket was handled by more than one;
 *   2. the newest field:"dispatch" event — who it was handed to;
 *   3. the ticket's own model: label — an intention, not an observation, so it
 *      is the last resort.
 * Returns null when none of the three names a recognizable tier.
 */
export function resolveTier(task, workEntries, dispatchEvents) {
  const byTier = new Map();
  for (const e of workEntries || []) {
    const tier = normalizeTier(e.model);
    if (!tier) continue;
    const tokens = e.tokens != null ? e.tokens : (e.inputTokens || 0) + (e.outputTokens || 0);
    // a recorded event with no token count still votes, just minimally
    byTier.set(tier, (byTier.get(tier) || 0) + (tokens > 0 ? tokens : 1));
  }
  if (byTier.size) {
    return [...byTier.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  for (let i = (dispatchEvents || []).length - 1; i >= 0; i--) {
    const tier = normalizeTier(dispatchEvents[i].model);
    if (tier) return tier;
  }
  return normalizeTier(modelOfTask(task || { labels: [] }));
}

/**
 * Minutes from the ticket's FIRST move into "In Progress" to its LAST move into
 * "Done", from status events. Null when either end is missing (an imported or
 * hand-edited ticket may have no event trail) or the span is negative.
 */
export function cycleMinutes(statusEvents) {
  let start = null, end = null;
  for (const e of statusEvents || []) {
    if (e.field !== "status") continue;
    const ms = Date.parse(e.ts);
    if (Number.isNaN(ms)) continue;
    if (e.to === "In Progress" && start == null) start = ms;
    if (e.to === "Done") end = ms;
  }
  if (start == null || end == null || end < start) return null;
  return (end - start) / 60000;
}

/**
 * Did this ticket come back after being closed? Two independent signals, either
 * of which counts:
 *   - a status event moving it OUT of Done (reopened);
 *   - a bug filed with ref:<ticket> at or after its completion date (the
 *     follow-up defect pattern this board uses).
 */
export function isRework(task, statusEvents, followUpBugs) {
  for (const e of statusEvents || []) {
    if (e.field === "status" && e.from === "Done" && e.to && e.to !== "Done") return true;
  }
  const completed = task && task.completionDate ? Date.parse(task.completionDate) : NaN;
  for (const b of followUpBugs || []) {
    const created = b.createdDate ? Date.parse(b.createdDate) : NaN;
    if (Number.isNaN(completed) || Number.isNaN(created)) return true; // undated follow-up still counts
    if (created >= completed) return true;
  }
  return false;
}

/**
 * Roll a set of normalized rows into per-tier stats. A "row" is
 * { ticket, tier, effort, tokens, cost, cycleMinutes, rework } — see
 * routingScorecard for how rows are gathered. Pure, so it unit-tests without
 * touching disk.
 */
export function summarizeRows(rows, { minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const byTier = {};
  for (const r of rows || []) {
    const key = r.tier || "unknown";
    const b = (byTier[key] = byTier[key] || { tier: key, tickets: [], tokens: [], costs: [], cycles: [], rework: 0 });
    b.tickets.push(r.ticket);
    if (Number.isFinite(r.tokens)) b.tokens.push(r.tokens);
    if (Number.isFinite(r.cost)) b.costs.push(r.cost);
    if (Number.isFinite(r.cycleMinutes)) b.cycles.push(r.cycleMinutes);
    if (r.rework) b.rework += 1;
  }
  const out = {};
  for (const [tier, b] of Object.entries(byTier)) {
    const n = b.tickets.length;
    const clean = n - b.rework;
    const totalCost = b.costs.reduce((a, c) => a + c, 0);
    out[tier] = {
      tier,
      n,
      cleanTickets: clean,
      reworkTickets: b.rework,
      reworkRate: n ? round2(b.rework / n) : null,
      medianTokens: median(b.tokens) == null ? null : Math.round(median(b.tokens)),
      medianCost: round4(median(b.costs)),
      medianCycleMinutes: round2(median(b.cycles)),
      totalCost: round4(totalCost),
      // The headline: dollars per ticket that stayed closed. Null when a tier
      // closed nothing cleanly — an infinite cost is not a number we'll print.
      costPerCleanTicket: clean > 0 && totalCost > 0 ? round4(totalCost / clean) : null,
      dispatchable: MODEL_TIERS[tier] ? MODEL_TIERS[tier].dispatchable : null,
      sufficient: n >= minSamples,
    };
  }
  return out;
}

/**
 * Pick the best tier from a per-tier stats object: lowest cost-per-clean-ticket
 * among tiers with enough samples. Returns an explicit insufficient-data verdict
 * rather than a guess when nothing qualifies.
 */
export function recommendTier(stats, { minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const eligible = Object.values(stats || {}).filter(
    (s) => s.tier !== "unknown" && s.n >= minSamples && s.costPerCleanTicket != null
  );
  const samples = Object.fromEntries(Object.values(stats || {}).map((s) => [s.tier, s.n]));
  if (!eligible.length) {
    return {
      verdict: "insufficient data",
      minSamples,
      samples,
      note: `No tier has ${minSamples}+ closed tickets with recorded spend yet — routing stays on the routing.js heuristics until it does.`,
    };
  }
  eligible.sort((a, b) => a.costPerCleanTicket - b.costPerCleanTicket);
  const best = eligible[0];
  const runnerUp = eligible[1] || null;
  return {
    verdict: "prefer",
    tier: best.tier,
    costPerCleanTicket: best.costPerCleanTicket,
    reworkRate: best.reworkRate,
    medianCycleMinutes: best.medianCycleMinutes,
    n: best.n,
    runnerUp: runnerUp
      ? { tier: runnerUp.tier, costPerCleanTicket: runnerUp.costPerCleanTicket, n: runnerUp.n }
      : null,
    // How much better than the next-best tier, as a fraction. A thin margin on
    // small n is a coin flip, and the readout should let a reader see that.
    marginVsRunnerUp: runnerUp
      ? round2((runnerUp.costPerCleanTicket - best.costPerCleanTicket) / runnerUp.costPerCleanTicket)
      : null,
    minSamples,
    samples,
  };
}

/**
 * Build the scorecard for one project.
 *
 *   windowDays   - only count tickets completed within the last N days (null =
 *                  all history). Routing advice from two-month-old runs on a
 *                  different model generation is worse than no advice.
 *   minSamples   - closed tickets a tier needs before it gets a verdict (3).
 *   includeRows  - FBMCPB-84: return the per-ticket rows. OFF by default. Every
 *                  Done ticket produces a row, so on a mature board rows[] is
 *                  the whole response — 411 tickets came to 124KB, past the MCP
 *                  result cap, which made the scorecard unreadable in exactly
 *                  the situation it is most useful. The stats above rows are
 *                  computed from every row either way; this only controls
 *                  whether the raw evidence rides along.
 *   rowLimit     - cap on rows when includeRows is on (default 200), worst
 *                  first: rework, then costliest. A truncated list says so.
 *
 * Returns { project, windowDays, minSamples, ticketsScored, overall,
 *           byEffort, recommendations, summary } plus rows/rowsTruncated when
 * includeRows is on.
 */
export function routingScorecard(
  board,
  project,
  { windowDays = null, minSamples = DEFAULT_MIN_SAMPLES, includeRows = false, rowLimit = 200 } = {}
) {
  const tasks = board.listTasks(project, {});
  const pricing = getPricing(board, project);

  const workByTicket = new Map();
  for (const e of readWorkLog(board, project)) {
    if (!e.ticket) continue;
    if (!workByTicket.has(e.ticket)) workByTicket.set(e.ticket, []);
    workByTicket.get(e.ticket).push(e);
  }
  const eventsByTicket = new Map();
  for (const e of readEvents(board, project)) {
    if (!e.ticket) continue;
    if (!eventsByTicket.has(e.ticket)) eventsByTicket.set(e.ticket, []);
    eventsByTicket.get(e.ticket).push(e);
  }
  const bugsByRef = new Map();
  for (const t of tasks) {
    if (t.type !== "bug" || !t.ref) continue;
    if (!bugsByRef.has(t.ref)) bugsByRef.set(t.ref, []);
    bugsByRef.get(t.ref).push(t);
  }

  const cutoff = windowDays != null ? Date.now() - Number(windowDays) * 86400000 : null;

  const rows = [];
  for (const t of tasks) {
    if (t.status !== "Done") continue;
    if (cutoff != null) {
      const done = t.completionDate ? Date.parse(t.completionDate) : NaN;
      // An undated Done ticket can't be placed in the window, so a windowed
      // scorecard drops it rather than silently counting it as recent.
      if (Number.isNaN(done) || done < cutoff) continue;
    }
    const work = workByTicket.get(t.ticketNumber) || [];
    const events = eventsByTicket.get(t.ticketNumber) || [];
    const dispatches = events.filter((e) => e.field === "dispatch");
    const tokens = work.reduce(
      (a, e) => a + (e.tokens != null ? e.tokens : (e.inputTokens || 0) + (e.outputTokens || 0)),
      0
    );
    const cost = work.reduce((a, e) => a + costOfEvent(e, pricing), 0);
    const effort = effortOfTask(t) || "unknown";
    rows.push({
      ticket: t.ticketNumber,
      title: t.title,
      tier: resolveTier(t, work, dispatches),
      effort,
      tokens: tokens || null,
      cost: cost || null,
      cycleMinutes: cycleMinutes(events),
      rework: isRework(t, events, bugsByRef.get(t.ticketNumber) || []),
    });
  }

  const overall = summarizeRows(rows, { minSamples });
  const byEffort = {};
  const recommendations = { overall: recommendTier(overall, { minSamples }) };
  for (const bucket of EFFORT_BUCKETS) {
    const subset = rows.filter((r) => r.effort === bucket);
    if (!subset.length) continue;
    byEffort[bucket] = summarizeRows(subset, { minSamples });
    recommendations[bucket] = recommendTier(byEffort[bucket], { minSamples });
  }

  const rec = recommendations.overall;
  const summary =
    rows.length === 0
      ? `No closed tickets${windowDays != null ? ` in the last ${windowDays}d` : ""} to score — routing advice is unavailable, not neutral.`
      : rec.verdict === "prefer"
        ? `${rows.length} closed ticket${rows.length === 1 ? "" : "s"} scored; ${rec.tier} is cheapest per clean ticket ($${rec.costPerCleanTicket}, n=${rec.n}${rec.runnerUp ? `, ${Math.round((rec.marginVsRunnerUp || 0) * 100)}% under ${rec.runnerUp.tier}` : ""}).`
        : `${rows.length} closed ticket${rows.length === 1 ? "" : "s"} scored, but no tier has ${minSamples}+ samples with recorded spend — no routing verdict.`;

  const out = {
    project,
    windowDays,
    minSamples,
    generatedAt: new Date().toISOString(),
    ticketsScored: rows.length,
    overall,
    byEffort,
    recommendations,
    advisory: "Advice only — this never changes a model:/cap: label. Intake stays deterministic (server/orchestration.js).",
    summary,
  };

  // FBMCPB-84: rows are evidence, not the answer — opt in, and cap it. Sorted
  // worst-first (rework, then dollars) so a truncated list is still the useful
  // half of the tail rather than an arbitrary slice.
  if (includeRows) {
    const cap = Number.isFinite(rowLimit) && rowLimit > 0 ? Math.floor(rowLimit) : 200;
    const ordered = rows
      .slice()
      .sort((a, b) => (b.rework ? 1 : 0) - (a.rework ? 1 : 0) || (b.cost || 0) - (a.cost || 0));
    out.rows = ordered.slice(0, cap);
    if (ordered.length > cap) {
      out.rowsTruncated = { returned: cap, of: ordered.length, order: "rework first, then costliest" };
    }
  } else {
    out.rowsOmitted = `${rows.length} per-ticket row(s) not returned — pass includeRows:true (rowLimit caps at ${rowLimit}) if you need the raw evidence.`;
  }

  return out;
}
