/**
 * FBMCPF-159: intake orchestration guard — model/cap assignment on every
 * ticket intake path (plan_work, add_feature(s), log_bug, import_tasks,
 * validate_feedback apply, and the CRM company-bug conversion path).
 *
 * model:* and cap:* labels used to only exist when a ticket's creator set
 * them by hand (see budget.js FBMCPF-125/152 — daily_plan/dailyPlan stamps
 * them, but only when someone remembers to run it). This module fills them
 * in AT INTAKE instead, so nothing enters the queue unlabeled. It reuses
 * budget.js's existing model/effort heuristics (suggestEffort, rosterModel)
 * rather than duplicating them — one set of keyword signals governs both
 * "what should today's plan run this on" (daily_plan) and "what should this
 * ticket be labeled at birth" (here), so the two can never drift apart.
 *
 * Purely deterministic, no model/LLM calls — same spirit as feedback.js's
 * classifyFeedback. NEVER overrides a model:/cap: label the ticket creator
 * already set; only fills in what's missing.
 */

import {
  CAP_LABEL_RE,
  MODEL_LABEL_RE,
  modelOfTask,
  capOfTask,
  suggestEffort,
  rosterModel,
} from "./budget.js";

/** Token cap assigned per resolved effort tier at intake. Deliberately
 *  conservative — this ticket's (FBMCPF-159) own cap is 80k, the "medium" tier,
 *  and that's also the fallback when there's no signal either way. */
export const CAP_BY_EFFORT = { low: 40_000, medium: 80_000, high: 160_000 };

// Keyword signals suggestEffort/rosterModel (budget.js) don't already cover —
// intake-specific "this ticket is heavier than its title's other keywords
// suggest" cues called out by FBMCPF-159: UI-heavy work, changes that touch
// many files, and parity/compat work (matching an existing surface exactly).
const INTAKE_HARD_KEYWORDS = /ui[- ]heavy|multi[- ]file|\bparity\b/i;

/**
 * Suggest a {model, cap, reason} triple for a ticket-like object
 * ({ type, title, description, product, priority, labels }). Deterministic:
 *   - an explicit effort:<level> or model:<tier> label always wins (see
 *     budget.js suggestEffort/rosterModel — checked first, before anything
 *     below);
 *   - bugs default toward sonnet (see budget.js suggestModel);
 *   - hard keywords (architecture/schema/migration/orchestration/etc., plus
 *     UI-heavy/multi-file/parity here) push toward opus and "high" effort;
 *   - docs/copy/rename/typo-style light keywords push toward haiku (or
 *     sonnet, when the ticket is a bug) and "low" effort;
 *   - anything else defaults to sonnet / "medium" effort.
 * Cap follows the resolved effort tier via CAP_BY_EFFORT. Conservative
 * default when no signal at all: sonnet, cap 80000.
 */
export function suggestModelAndCap(ticketLike) {
  const t = ticketLike || {};
  // Feeds only suggestEffort's title-keyword / estimate-size fallback path —
  // an explicit effort: or cap: label (checked first inside suggestEffort)
  // always wins over this nominal value.
  const nominalEstimate = CAP_BY_EFFORT.medium;
  const eff = suggestEffort(t, nominalEstimate);
  const mod = rosterModel(t, eff.effort);

  let model = mod.model;
  let modelBasis = mod.basis;
  let effort = eff.effort;

  const hasExplicitModelLabel = modelBasis === "model label";
  const hasExplicitEffortLabel = eff.basis === "effort label";

  if (!hasExplicitModelLabel && model !== "opus" && model !== "fable") {
    const text = `${t.title || ""} ${t.description || ""}`;
    if (INTAKE_HARD_KEYWORDS.test(text)) {
      model = "opus";
      modelBasis = "intake hard keywords (UI-heavy/multi-file/parity)";
    }
  }

  // A ticket heavy enough to warrant opus/fable is heavy enough to warrant
  // "high" effort (and its cap) too — whether opus came from budget.js's own
  // hard-keyword regex (e.g. "refactor") or the intake-specific bump above —
  // unless the creator pinned effort explicitly.
  if (!hasExplicitEffortLabel && (model === "opus" || model === "fable") && effort !== "high") {
    effort = "high";
  }

  const cap = CAP_BY_EFFORT[effort] || CAP_BY_EFFORT.medium;
  return {
    model,
    cap,
    reason: `${modelBasis}; effort ${effort} (${eff.basis})`,
  };
}

/**
 * Fill in model:/cap: labels on a fields object BEFORE it's written by
 * Board.addTask — never overrides labels the creator already set. Pure:
 * takes a plain `fields` object (as passed to board.addTask) and the task
 * `type` ("feature" | "bug"), returns a new fields object with `labels`
 * extended when either label was missing. Call this at each intake tool's
 * call site, right before board.addTask.
 */
export function withOrchestrationLabels(type, fields) {
  const f = fields || {};
  const labels = Array.isArray(f.labels) ? f.labels.slice() : [];
  const hasModel = labels.some((l) => MODEL_LABEL_RE.test(String(l)));
  const hasCap = labels.some((l) => CAP_LABEL_RE.test(String(l)));
  if (hasModel && hasCap) return f; // creator already made the call — never override

  const ticketLike = {
    type: type === "bug" ? "bug" : "feature",
    title: f.title || "",
    description: f.description || "",
    product: f.product || null,
    priority: f.priority != null ? f.priority : null,
    labels,
  };
  const s = suggestModelAndCap(ticketLike);
  if (!hasModel) labels.push(`model:${s.model}`);
  if (!hasCap) labels.push(`cap:${s.cap}`);
  return { ...f, labels };
}

/**
 * Lint: open (non-Done) tickets missing a model: and/or cap: label — nothing
 * should sit in the queue without a sub-model orchestration decision. Feeds
 * scan_board_cleanup (cleanup.js) so it's surfaced alongside duplicate/stale
 * findings.
 */
export function findUnlabeledTickets(tasks) {
  const out = [];
  for (const t of tasks || []) {
    if (t.status === "Done") continue;
    const missingModel = !modelOfTask(t);
    const missingCap = !capOfTask(t);
    if (!missingModel && !missingCap) continue;
    out.push({
      ticket: t.ticketNumber,
      title: t.title,
      status: t.status,
      missing: [missingModel ? "model" : null, missingCap ? "cap" : null].filter(Boolean),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FBMCPF-214: triage intelligence — suggest product/priority (and labels) at
// intake from similar historical tickets. Same never-override contract as the
// model/cap guard above: explicit values always win; we only fill what's
// missing, and label suggestions are surfaced, never auto-applied. Purely
// deterministic token-overlap similarity — no LLM calls.
// ---------------------------------------------------------------------------

const TRIAGE_STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with add fix new tool tools support".split(" ")
);
/** Labels that describe orchestration/bookkeeping, not subject matter. */
const TRIAGE_LABEL_NOISE = /^(model|cap|effort|sprint|pair|experiment|ask|priority):/i;

export function triageTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !TRIAGE_STOPWORDS.has(w))
  );
}

/** Rank existing tickets by title+description token overlap (Jaccard). */
export function similarTickets(tasks, ticketLike, { limit = 5, minScore = 0.15 } = {}) {
  const q = triageTokens(`${ticketLike.title || ""} ${ticketLike.description || ""}`);
  if (!q.size) return [];
  const scored = [];
  for (const t of tasks || []) {
    const c = triageTokens(`${t.title || ""} ${t.description || ""}`);
    if (!c.size) continue;
    let inter = 0;
    for (const w of q) if (c.has(w)) inter++;
    const score = inter / (q.size + c.size - inter);
    if (score >= minScore) scored.push({ task: t, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Suggest product/priority/labels for a new ticket from its nearest historical
 * neighbours. Returns null when there's no usable signal.
 */
export function suggestTriage(tasks, fields, opts = {}) {
  const near = similarTickets(tasks, fields, opts);
  if (!near.length) return null;
  const out = { basis: near.map((n) => ({ ticket: n.task.ticketNumber, score: n.score })) };

  // product: score-weighted majority among neighbours that have one
  const byProduct = new Map();
  for (const n of near) if (n.task.product) byProduct.set(n.task.product, (byProduct.get(n.task.product) || 0) + n.score);
  if (byProduct.size) out.product = [...byProduct.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // priority: median of neighbours that set one
  const prios = near.map((n) => n.task.priority).filter((v) => v != null && v !== "").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (prios.length) out.priority = prios[Math.floor((prios.length - 1) / 2)];

  // labels: subject-matter labels appearing on >= 2 neighbours (or the single best match)
  const counts = new Map();
  for (const n of near)
    for (const l of n.task.labels || []) if (!TRIAGE_LABEL_NOISE.test(String(l))) counts.set(l, (counts.get(l) || 0) + 1);
  const labels = [...counts.entries()].filter(([, c]) => c >= Math.min(2, near.length)).map(([l]) => l);
  if (labels.length) out.labels = labels.slice(0, 4);

  return out.product || out.priority != null || out.labels ? out : null;
}

/**
 * Intake wrapper: fill missing product/priority from triage (explicit values
 * win), and return the suggestion payload for the create response. Label
 * suggestions ride along in `triage.labels` but are NOT auto-applied.
 */
export function applyTriage(tasks, fields) {
  const f = fields || {};
  const t = suggestTriage(tasks, f);
  if (!t) return { fields: f, triage: null };
  const next = { ...f };
  const applied = {};
  if (!next.product && t.product) { next.product = t.product; applied.product = t.product; }
  if ((next.priority == null || next.priority === "") && t.priority != null) { next.priority = t.priority; applied.priority = t.priority; }
  return { fields: next, triage: { ...t, applied: Object.keys(applied).length ? applied : undefined } };
}
