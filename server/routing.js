/**
 * FBMCPF-350: model tier policy — the single source of truth for "what is this
 * tier trusted with, can it be dispatched to a sub-agent, and what does it cost
 * us in planning weight".
 *
 * Written for Opus 5 (2026-07-24), which shipped as the Claude Max default at
 * the same $5/$25 per-MTok API rate as Opus 4.8. The old assumption baked into
 * the dispatch path — "opus is orchestrator-tier, run it sequentially, it is
 * nearly as expensive as fable" — is stale: opus is now the workhorse and only
 * fable remains genuinely scarce. This module encodes that once so the three
 * places that used to repeat it (metadata.js buildDispatchDirective,
 * budget.js COST_UNITS + dailyPlan's dispatch split, orchestration.js's
 * effort bump) can never drift apart again.
 *
 * DELIBERATELY ZERO IMPORTS. metadata.js imports this module, and budget.js
 * already imports metadata.js — anything imported here would risk a cycle.
 * Keep it pure data + pure functions.
 */

/**
 * The roster. Order is the escalation order (cheapest/most mechanical first).
 *
 *   dispatchable — can be handed to a sub-agent that edits code and runs tests
 *                  but never writes the board or commits. Everything except
 *                  fable: the orchestrator's own context is the scarce thing,
 *                  so anything that CAN leave it should.
 *   costUnits    — blended relative planning weight per token (NOT dollars;
 *                  see pricing.js for real $/MTok). Anchored at sonnet = 1 and
 *                  scaled from the published per-MTok blended rates:
 *                  haiku $3, sonnet $6, opus $15, fable $30.
 *   rank         — capability ordering, low to high. Used to answer "is this a
 *                  step up or down from that", not to pick a default.
 */
export const MODEL_TIERS = {
  haiku: {
    dispatchable: true,
    costUnits: 0.5,
    rank: 1,
    note: "mechanical work: docs/copy edits, label churn, data reshaping",
  },
  sonnet: {
    dispatchable: true,
    costUnits: 1,
    rank: 2,
    note: "standard implementation: UI, features, most bugs, integrations",
  },
  opus: {
    dispatchable: true,
    costUnits: 2.5,
    rank: 3,
    note:
      "Opus 5 — architecture, multi-file server changes, storage invariants. " +
      "Dispatchable since 2026-07-24: same API rate as Opus 4.8 and the Max " +
      "default, so it fans out to parallel sub-agents like sonnet does.",
  },
  fable: {
    dispatchable: false,
    costUnits: 5,
    rank: 4,
    note:
      "orchestration, cross-cutting design, spec/architecture review. The one " +
      "orchestrator-only tier: its value is holding the whole plan in context, " +
      "which a sub-agent by definition cannot do.",
  },
};

/** Tier used when a ticket carries no model: label and no heuristic fired. */
export const DEFAULT_TIER = "sonnet";

/** Blended relative cost per token, keyed by tier (planning weight, not pricing). */
export const COST_UNITS = Object.fromEntries(
  Object.entries(MODEL_TIERS).map(([tier, t]) => [tier, t.costUnits])
);

/** Tiers that may be handed to a sub-agent, cheapest first. */
export const DISPATCHABLE_TIERS = Object.keys(MODEL_TIERS).filter((t) => MODEL_TIERS[t].dispatchable);

/** Tiers that must stay in the orchestrator's own context. */
export const ORCHESTRATOR_TIERS = Object.keys(MODEL_TIERS).filter((t) => !MODEL_TIERS[t].dispatchable);

// Matched in rank order so a string naming two tiers (rare, but e.g. a note
// like "opus, not sonnet") resolves to the stronger one rather than whichever
// happens to appear first in the text.
const TIER_PATTERNS = [
  ["fable", /fable|mythos/i],
  ["opus", /opus/i],
  ["sonnet", /sonnet/i],
  ["haiku", /haiku/i],
];

/**
 * Normalize a loose or full model string down to one of the tiers above.
 * Handles every shape the board actually stores: a bare tier ("opus"), a
 * label ("model:opus"), a versioned name ("Opus 5", "opus-5"), and a dated
 * API model id ("claude-opus-5-20260724"). Returns null when the input is
 * blank or names no known tier — callers decide their own fallback rather
 * than being silently handed a default.
 */
export function normalizeTier(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  for (const [tier, re] of TIER_PATTERNS) {
    if (re.test(s)) return tier;
  }
  return null;
}

/**
 * Can this model be handed to a sub-agent? Unknown/unrecognized models are
 * NOT dispatchable: if we can't identify the tier we can't vouch for the
 * hand-off, so the safe answer is "keep it in the orchestrator".
 */
export function isDispatchable(model) {
  const tier = normalizeTier(model);
  return tier ? !!MODEL_TIERS[tier].dispatchable : false;
}

/** Planning cost weight for a model string; falls back to sonnet's weight. */
export function costUnitsFor(model) {
  const tier = normalizeTier(model);
  return tier ? MODEL_TIERS[tier].costUnits : COST_UNITS[DEFAULT_TIER];
}

/** Capability rank (1 = most mechanical), or null for an unknown model. */
export function rankOf(model) {
  const tier = normalizeTier(model);
  return tier ? MODEL_TIERS[tier].rank : null;
}
