import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import {
  DEFAULT_PRICING,
  normalizeModelName,
  costOfEvent,
  getPricing,
  rollupCost,
} from "../server/pricing.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pricing-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// ---------------------------------------------------------------------------
// normalizeModelName
// ---------------------------------------------------------------------------

test("normalizeModelName loose-matches tiers case-insensitively", () => {
  assert.equal(normalizeModelName("sonnet"), "sonnet");
  assert.equal(normalizeModelName("Sonnet 4.5"), "sonnet");
  assert.equal(normalizeModelName("claude-sonnet-4-5-20260101"), "sonnet");
  assert.equal(normalizeModelName("OPUS"), "opus");
  assert.equal(normalizeModelName("claude-opus-4-5"), "opus");
  assert.equal(normalizeModelName("haiku"), "haiku");
  assert.equal(normalizeModelName("Haiku 4.5"), "haiku");
  assert.equal(normalizeModelName("fable"), "fable");
  assert.equal(normalizeModelName("Claude Fable 5"), "fable");
  assert.equal(normalizeModelName("mythos"), "fable");
});

test("normalizeModelName returns null for blank/unrecognized input", () => {
  assert.equal(normalizeModelName(null), null);
  assert.equal(normalizeModelName(undefined), null);
  assert.equal(normalizeModelName(""), null);
  assert.equal(normalizeModelName("gpt-4"), null);
});

// ---------------------------------------------------------------------------
// costOfEvent
// ---------------------------------------------------------------------------

test("costOfEvent uses the precise input/output split when present", () => {
  // sonnet default: $2/MTok in, $10/MTok out
  const entry = { model: "sonnet", inputTokens: 100_000, outputTokens: 10_000 };
  const cost = costOfEvent(entry, DEFAULT_PRICING);
  // 100,000 * 2/1e6 + 10,000 * 10/1e6 = 0.2 + 0.1 = 0.3
  assert.equal(Math.round(cost * 1000) / 1000, 0.3);
});

test("costOfEvent treats a missing side of the split as 0, not falling back to blended", () => {
  const entry = { model: "haiku", inputTokens: 200_000 }; // no outputTokens at all
  const cost = costOfEvent(entry, DEFAULT_PRICING);
  // 200,000 * 1/1e6 = 0.2, outputTokens treated as 0
  assert.equal(Math.round(cost * 1000) / 1000, 0.2);
});

test("costOfEvent falls back to the blended rate on total tokens when no split is recorded", () => {
  // opus blended: $15/MTok
  const entry = { model: "opus", tokens: 50_000 };
  const cost = costOfEvent(entry, DEFAULT_PRICING);
  assert.equal(Math.round(cost * 1000) / 1000, 0.75); // 50,000 * 15 / 1e6
});

test("costOfEvent falls back to the 'default' pricing tier for an unrecognized/missing model", () => {
  const entry = { model: "some-other-vendor-model", tokens: 100_000 };
  const cost = costOfEvent(entry, DEFAULT_PRICING);
  assert.equal(Math.round(cost * 1000) / 1000, 0.6); // default blended $6/MTok * 100k

  const noModel = { tokens: 100_000 };
  assert.equal(costOfEvent(noModel, DEFAULT_PRICING), costOfEvent(entry, DEFAULT_PRICING));
});

test("costOfEvent returns 0 for a null/undefined entry", () => {
  assert.equal(costOfEvent(null, DEFAULT_PRICING), 0);
  assert.equal(costOfEvent(undefined, DEFAULT_PRICING), 0);
});

// ---------------------------------------------------------------------------
// getPricing — project config overrides
// ---------------------------------------------------------------------------

test("getPricing returns DEFAULT_PRICING untouched when no project config override exists", () => {
  const b = tmpBoard();
  const pricing = getPricing(b, "Proj");
  assert.deepEqual(pricing, DEFAULT_PRICING);
});

test("getPricing merges a partial per-tier override over the defaults", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { pricing: { sonnet: { inputPerMTok: 3, outputPerMTok: 15 } } });
  const pricing = getPricing(b, "Proj");
  // overridden fields change...
  assert.equal(pricing.sonnet.inputPerMTok, 3);
  assert.equal(pricing.sonnet.outputPerMTok, 15);
  // ...but blendedPerMTok, not overridden, keeps its default
  assert.equal(pricing.sonnet.blendedPerMTok, DEFAULT_PRICING.sonnet.blendedPerMTok);
  // other tiers are untouched
  assert.deepEqual(pricing.opus, DEFAULT_PRICING.opus);
  assert.deepEqual(pricing.haiku, DEFAULT_PRICING.haiku);
});

test("getPricing allows configuring a brand-new tier name not in DEFAULT_PRICING", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { pricing: { customtier: { inputPerMTok: 1, outputPerMTok: 2, blendedPerMTok: 1.5 } } });
  const pricing = getPricing(b, "Proj");
  assert.equal(pricing.customtier.inputPerMTok, 1);
  assert.equal(pricing.customtier.blendedPerMTok, 1.5);
});

test("a stale/overridden price is harmless — costOfEvent picks up the override automatically", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { pricing: { sonnet: { inputPerMTok: 100, outputPerMTok: 200 } } });
  const pricing = getPricing(b, "Proj");
  const cost = costOfEvent({ model: "sonnet", inputTokens: 10_000, outputTokens: 1_000 }, pricing);
  // 10,000 * 100/1e6 + 1,000 * 200/1e6 = 1 + 0.2 = 1.2
  assert.equal(Math.round(cost * 1000) / 1000, 1.2);
});

// ---------------------------------------------------------------------------
// rollupCost — byModel rollup (feeds get_metrics)
// ---------------------------------------------------------------------------

test("rollupCost groups tokens/cost by normalized model tier and sums totalCost", () => {
  const entries = [
    { model: "sonnet", tokens: 10_000 },
    { model: "Sonnet 4.5", inputTokens: 5_000, outputTokens: 1_000 },
    { model: "opus", tokens: 20_000 },
    { model: "unknown-thing", tokens: 1_000 },
    { tokens: 500 }, // no model at all
  ];
  const { byModel, totalCost } = rollupCost(entries, DEFAULT_PRICING);

  assert.equal(byModel.sonnet.events, 2);
  assert.equal(byModel.sonnet.tokens, 16_000); // 10,000 + 5,000 + 1,000
  assert.equal(byModel.sonnet.inputTokens, 5_000);
  assert.equal(byModel.sonnet.outputTokens, 1_000);
  // 10,000 * 6/1e6 (blended) + (5,000*2 + 1,000*10)/1e6 = 0.06 + 0.02 = 0.08
  assert.equal(Math.round(byModel.sonnet.cost * 1000) / 1000, 0.08);

  assert.equal(byModel.opus.events, 1);
  assert.equal(byModel.opus.tokens, 20_000);
  assert.equal(Math.round(byModel.opus.cost * 1000) / 1000, 0.3); // 20,000 * 15/1e6

  assert.equal(byModel.unknown.events, 2); // "unknown-thing" and no-model entry
  assert.equal(byModel.unknown.tokens, 1_500);

  const expectedTotal = byModel.sonnet.cost + byModel.opus.cost + byModel.unknown.cost;
  assert.equal(Math.round(totalCost * 1000) / 1000, Math.round(expectedTotal * 1000) / 1000);
});

test("rollupCost handles an empty entry list without throwing", () => {
  const { byModel, totalCost } = rollupCost([], DEFAULT_PRICING);
  assert.deepEqual(byModel, {});
  assert.equal(totalCost, 0);
});

// ---------------------------------------------------------------------------
// integration: get_metrics byModel rollup, agentMonitorV2 costSoFar
// ---------------------------------------------------------------------------

test("integration: get_metrics-style velocity byModel rollup reflects logged work with mixed models", async () => {
  const { velocity, readWorkLog } = await import("../server/metadata.js");
  const b = tmpBoard();
  const { logWork } = await import("../server/metadata.js");
  logWork(b, "Proj", { ticket: "FBF-1", summary: "work", tokens: 10_000, model: "sonnet" });
  logWork(b, "Proj", { ticket: "FBF-1", summary: "more work", inputTokens: 8_000, outputTokens: 2_000, model: "opus" });
  const entries = readWorkLog(b, "Proj");
  const pricing = getPricing(b, "Proj");
  const { byModel, totalCost } = rollupCost(entries, pricing);
  assert.equal(byModel.sonnet.tokens, 10_000);
  assert.equal(byModel.opus.inputTokens, 8_000);
  assert.equal(byModel.opus.outputTokens, 2_000);
  assert.ok(totalCost > 0);
});

test("integration: agentMonitorV2 reports costSoFar per ticket and capCost when a model is known", async () => {
  const { agentMonitorV2 } = await import("../server/events.js");
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Priced ticket", labels: ["cap:100k", "model:sonnet"] });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  const p = path.join(b.projectDir("Proj"), "agent_work_log.md");
  fs.writeFileSync(
    p,
    `## [2030-01-01]\n2030-01-01 10:00:00, work, Task: ${t.ticketNumber}, tokens: 40000, model: sonnet\n`,
    "utf8"
  );
  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:10:00" });
  const ticket = r.tickets[0];
  assert.equal(ticket.ticket, t.ticketNumber);
  assert.ok(ticket.costSoFar > 0);
  // 40,000 tokens, sonnet blended $6/MTok -> 0.24
  assert.equal(Math.round(ticket.costSoFar * 1000) / 1000, 0.24);
  // cap 100k tokens at sonnet blended rate -> 0.6
  assert.ok(ticket.capCost != null);
  assert.equal(Math.round(ticket.capCost * 1000) / 1000, 0.6);
});

test("integration: agentMonitorV2 capCost is null when no model can be determined for the ticket", async () => {
  const { agentMonitorV2 } = await import("../server/events.js");
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "No model hint", labels: ["cap:50k"] });
  b.setStatus("Proj", t.ticketNumber, "In Progress");
  const r = agentMonitorV2(b, "Proj", { asOf: "2030-01-01T10:10:00" });
  const ticket = r.tickets[0];
  assert.equal(ticket.cap, 50000);
  assert.equal(ticket.capCost, null);
  assert.equal(ticket.costSoFar, 0);
});
