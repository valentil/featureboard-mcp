// FBMCPF-157: model-aware cost tracking — a small, override-friendly pricing
// table plus helpers that turn work-log token counts into dollar costs.
//
// Defaults reflect Anthropic's published API pricing as of 2026-07-16
// (https://platform.claude.com/docs/en/about-claude/pricing). Work-log
// entries only ever carry a loose model hint (see budget.js MODEL_LABEL_RE /
// suggestModel / rosterModel — "sonnet", "opus", "haiku", "fable", or a full
// model string like "claude-opus-4-5-20260101"), never a dated API model id,
// so pricing here is keyed by *tier* and normalizeModelName() loose-matches
// anything down to one of those four tiers.
//
// Every rate is overridable per project via project config key "pricing"
// (see getPricing below) — a stale default is harmless since a project can
// always correct it without a code change.
//
// Rates in effect on the source date (input / output, $ per MTok):
//   Claude Fable 5                         $10 / $50
//   Claude Opus 4.8 / 4.7 / 4.6 / 4.5      $5  / $25
//   Claude Sonnet 5 (introductory,          $2  / $10   (through 2026-08-31;
//     through 2026-08-31)                                standard rate after
//                                                         is $3 / $15 — bump
//                                                         the "sonnet" tier
//                                                         via project config
//                                                         once it flips)
//   Claude Sonnet 4.6 / 4.5                $3  / $15
//   Claude Haiku 4.5                       $1  / $5
//
// The "sonnet" tier below uses the Sonnet 5 introductory rate since that's
// what's billed today; projects still primarily on Sonnet 4.x are already at
// the (higher) standard $3/$15 rate and should override "sonnet" to that.

import { getProjectConfig } from "./metadata.js";

/** $/MTok input, output, and a blended fallback rate, per model tier. */
export const DEFAULT_PRICING = {
  fable: { inputPerMTok: 10, outputPerMTok: 50, blendedPerMTok: 30 },
  opus: { inputPerMTok: 5, outputPerMTok: 25, blendedPerMTok: 15 },
  sonnet: { inputPerMTok: 2, outputPerMTok: 10, blendedPerMTok: 6 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, blendedPerMTok: 3 },
  // used when a work-log entry has no model recorded, or its model string
  // doesn't normalize to one of the tiers above (see costOfEvent)
  default: { inputPerMTok: 2, outputPerMTok: 10, blendedPerMTok: 6 },
};

const TIER_PATTERNS = [
  ["fable", /fable|mythos/i],
  ["opus", /opus/i],
  ["sonnet", /sonnet/i],
  ["haiku", /haiku/i],
];

/**
 * Normalize a loose or full model string ("sonnet", "Sonnet 4.5",
 * "claude-opus-4-5-20260101", "model:haiku", ...) down to one of the pricing
 * tiers ("fable" | "opus" | "sonnet" | "haiku"). Returns null when the input
 * is blank or doesn't match any known tier (e.g. an unrelated string) —
 * callers fall back to the "default" pricing tier in that case.
 */
export function normalizeModelName(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  for (const [tier, re] of TIER_PATTERNS) {
    if (re.test(s)) return tier;
  }
  return null;
}

/**
 * Cost in USD of one work-log-style entry ({ tokens, inputTokens,
 * outputTokens, model }), given a pricing table (see getPricing /
 * DEFAULT_PRICING; pricing is optional and defaults to DEFAULT_PRICING).
 *
 * When inputTokens and/or outputTokens are present, cost is computed
 * precisely from the split (missing side treated as 0). Older-format
 * entries only ever logged a single "tokens" total with no split — for
 * those, cost falls back to the model's blended rate (documented in
 * DEFAULT_PRICING as a simple average of input/output rates) applied to the
 * total token count. This is an approximation: a workload skewed heavily
 * toward input (large context reads, typical of agentic coding) or toward
 * output will be mis-priced by the blended fallback in proportion to that
 * skew. It's used only when the split truly isn't available.
 */
export function costOfEvent(entry, pricing) {
  if (!entry) return 0;
  const pr = pricing || DEFAULT_PRICING;
  const tier = normalizeModelName(entry.model);
  const rates = (tier && pr[tier]) || pr.default || DEFAULT_PRICING.default;
  const hasSplit = entry.inputTokens != null || entry.outputTokens != null;
  if (hasSplit) {
    const inTok = entry.inputTokens || 0;
    const outTok = entry.outputTokens || 0;
    return (inTok * rates.inputPerMTok + outTok * rates.outputPerMTok) / 1e6;
  }
  const total = entry.tokens != null ? entry.tokens : 0;
  return (total * rates.blendedPerMTok) / 1e6;
}

/**
 * Resolve the effective pricing table for a project: DEFAULT_PRICING with
 * any project-config "pricing" overrides merged in per tier (a project can
 * override just one field of one tier — everything else keeps the default).
 * Never throws: a missing/unreadable/malformed config falls back to
 * DEFAULT_PRICING untouched.
 *
 * Config shape (project_config "pricing" key):
 *   { "sonnet": { "inputPerMTok": 3, "outputPerMTok": 15 }, "opus": {...} }
 */
export function getPricing(board, project) {
  let overrides = null;
  try {
    const cfg = getProjectConfig(board, project);
    overrides = cfg && cfg.pricing && typeof cfg.pricing === "object" ? cfg.pricing : null;
  } catch {
    overrides = null;
  }
  if (!overrides) return DEFAULT_PRICING;
  const merged = {};
  for (const tier of Object.keys(DEFAULT_PRICING)) {
    merged[tier] = { ...DEFAULT_PRICING[tier], ...(overrides[tier] || {}) };
  }
  // allow a project to configure an entirely new/aliased tier too
  for (const tier of Object.keys(overrides)) {
    if (!merged[tier]) merged[tier] = { ...DEFAULT_PRICING.default, ...overrides[tier] };
  }
  return merged;
}

/**
 * Roll up cost + token split across a set of work-log entries, grouped by
 * normalized model tier (entries with no recognizable model group under
 * "unknown"). Feeds the byModel/totalCost sections of get_metrics and the
 * board's metrics panel.
 */
export function rollupCost(entries, pricing) {
  const pr = pricing || DEFAULT_PRICING;
  const byModel = {};
  let totalCost = 0;
  for (const e of entries || []) {
    const key = normalizeModelName(e.model) || "unknown";
    const b = (byModel[key] = byModel[key] || { tokens: 0, inputTokens: 0, outputTokens: 0, events: 0, cost: 0 });
    const tokens = e.tokens != null ? e.tokens : (e.inputTokens || 0) + (e.outputTokens || 0);
    b.tokens += tokens || 0;
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.events += 1;
    const cost = costOfEvent(e, pr);
    b.cost += cost;
    totalCost += cost;
  }
  for (const k of Object.keys(byModel)) byModel[k].cost = Math.round(byModel[k].cost * 1e4) / 1e4;
  return { byModel, totalCost: Math.round(totalCost * 1e4) / 1e4 };
}
