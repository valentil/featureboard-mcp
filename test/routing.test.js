// FBMCPF-350: model tier policy — the single source of truth for dispatchability
// and planning cost weight.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_TIERS,
  COST_UNITS,
  DEFAULT_TIER,
  DISPATCHABLE_TIERS,
  ORCHESTRATOR_TIERS,
  normalizeTier,
  isDispatchable,
  costUnitsFor,
  rankOf,
} from "../server/routing.js";
import { normalizeModelName } from "../server/pricing.js";

test("normalizeTier handles every shape the board actually stores", () => {
  assert.equal(normalizeTier("opus"), "opus");
  assert.equal(normalizeTier("Opus 5"), "opus");
  assert.equal(normalizeTier("opus-5"), "opus");
  assert.equal(normalizeTier("claude-opus-5-20260724"), "opus");
  assert.equal(normalizeTier("model:opus"), "opus");
  assert.equal(normalizeTier("  SONNET  "), "sonnet");
  assert.equal(normalizeTier("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(normalizeTier("fable"), "fable");
  assert.equal(normalizeTier("mythos"), "fable");
});

test("normalizeTier returns null rather than a silent default", () => {
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier(""), null);
  assert.equal(normalizeTier("   "), null);
  assert.equal(normalizeTier("gpt-9"), null);
});

test("pricing.normalizeModelName delegates to the same vocabulary", () => {
  for (const raw of ["Opus 5", "model:opus", "claude-sonnet-5", "haiku", "nope", ""]) {
    assert.equal(normalizeModelName(raw), normalizeTier(raw), `disagreement on "${raw}"`);
  }
});

test("everything except fable is dispatchable (Opus 5 rebalance)", () => {
  assert.equal(isDispatchable("haiku"), true);
  assert.equal(isDispatchable("sonnet"), true);
  assert.equal(isDispatchable("opus"), true);
  assert.equal(isDispatchable("Opus 5"), true);
  assert.equal(isDispatchable("fable"), false);
  assert.deepEqual(ORCHESTRATOR_TIERS, ["fable"]);
  assert.deepEqual(DISPATCHABLE_TIERS.sort(), ["haiku", "opus", "sonnet"]);
});

test("an unrecognized model is NOT dispatchable — unknown means keep it inline", () => {
  assert.equal(isDispatchable("gpt-9"), false);
  assert.equal(isDispatchable(null), false);
  assert.equal(isDispatchable(""), false);
});

test("cost units are ordered and anchored at sonnet = 1", () => {
  assert.equal(COST_UNITS.sonnet, 1);
  assert.ok(COST_UNITS.haiku < COST_UNITS.sonnet);
  assert.ok(COST_UNITS.sonnet < COST_UNITS.opus);
  assert.ok(COST_UNITS.opus < COST_UNITS.fable);
  // Opus 5 bills at half of Fable 5, so its planning weight must too.
  assert.equal(COST_UNITS.opus, COST_UNITS.fable / 2);
  assert.equal(costUnitsFor("claude-opus-5-20260724"), COST_UNITS.opus);
  // unknown models fall back to the default tier's weight, not to zero
  assert.equal(costUnitsFor("gpt-9"), COST_UNITS[DEFAULT_TIER]);
});

test("ranks order the roster and every tier is complete", () => {
  assert.ok(rankOf("haiku") < rankOf("sonnet"));
  assert.ok(rankOf("sonnet") < rankOf("opus"));
  assert.ok(rankOf("opus") < rankOf("fable"));
  assert.equal(rankOf("gpt-9"), null);
  for (const [tier, t] of Object.entries(MODEL_TIERS)) {
    assert.equal(typeof t.dispatchable, "boolean", `${tier}.dispatchable`);
    assert.ok(Number.isFinite(t.costUnits) && t.costUnits > 0, `${tier}.costUnits`);
    assert.ok(Number.isFinite(t.rank), `${tier}.rank`);
    assert.ok(t.note && t.note.length > 10, `${tier}.note`);
  }
  assert.ok(MODEL_TIERS[DEFAULT_TIER], "DEFAULT_TIER must name a real tier");
});
