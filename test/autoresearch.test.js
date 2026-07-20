import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG, mergeConfig, validateConfig, parseMetric, median,
  shouldAccept, buildExperimentPrompt, appendResults,
} from "../scripts/autoresearch.mjs";

// FBMCPF-246 — pure decision logic of the auto-research outer loop.

test("mergeConfig: user values override defaults, nested objects merge", () => {
  const cfg = mergeConfig({ objective: { minDelta: 5 }, budget: { maxExperiments: 3 } });
  assert.equal(cfg.objective.minDelta, 5);
  assert.equal(cfg.objective.direction, "min"); // default survives the merge
  assert.equal(cfg.budget.maxExperiments, 3);
  assert.equal(cfg.integrationBranch, DEFAULT_CONFIG.integrationBranch);
});

test("validateConfig: catches the important mistakes", () => {
  assert.deepEqual(validateConfig(mergeConfig({})), []); // defaults are valid
  assert.ok(validateConfig(mergeConfig({ objective: { direction: "sideways" } })).some((e) => /direction/.test(e)));
  assert.ok(validateConfig(mergeConfig({ integrationBranch: "has space" })).some((e) => /integrationBranch/.test(e)));
  assert.ok(validateConfig(mergeConfig({ experiments: [{ id: "a", hypothesis: "h" }, { id: "a", hypothesis: "h2" }] })).some((e) => /unique/.test(e)));
  assert.ok(validateConfig(mergeConfig({ experiments: [{ hypothesis: "no id" }] })).some((e) => /needs an id/.test(e)));
});

test("parseMetric + median", () => {
  assert.equal(parseMetric("noise\nMETRIC 12.5\nmore", "METRIC ([0-9.]+)"), 12.5);
  assert.equal(parseMetric("no match here", "METRIC ([0-9.]+)"), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("shouldAccept: direction and minDelta noise guard", () => {
  // min: 100 -> 97 is a 3% improvement
  assert.equal(shouldAccept({ baseline: 100, value: 97, direction: "min", minDelta: 2 }), true);
  assert.equal(shouldAccept({ baseline: 100, value: 99, direction: "min", minDelta: 2 }), false); // only 1%
  assert.equal(shouldAccept({ baseline: 100, value: 103, direction: "min", minDelta: 0 }), false); // regression
  // max: higher is better
  assert.equal(shouldAccept({ baseline: 50, value: 52, direction: "max", minDelta: 2 }), true); // 4%
  assert.equal(shouldAccept({ baseline: 50, value: 49, direction: "max", minDelta: 0 }), false);
  // garbage in -> never accept
  assert.equal(shouldAccept({ baseline: NaN, value: 90, direction: "min", minDelta: 0 }), false);
  assert.equal(shouldAccept({ baseline: 100, value: null, direction: "min", minDelta: 0 }), false);
});

test("buildExperimentPrompt: carries hypothesis, contract, and suite command", () => {
  const cfg = mergeConfig({});
  const p = buildExperimentPrompt({ id: "x1", hypothesis: "caching helps", hint: "server/storage.js" }, cfg);
  assert.match(p, /HYPOTHESIS: caching helps/);
  assert.match(p, /server\/storage\.js/);
  assert.match(p, /full test suite/);
  assert.match(p, /Never weaken or delete an assertion/);
  assert.match(p, /autoresearch\(x1\)/);
  assert.match(p, /commit NOTHING/i);
});

test("appendResults: appends, tolerates corrupt file with .bak rotation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-arres-"));
  appendResults(dir, [{ id: "a", accepted: true }]);
  appendResults(dir, [{ id: "b", accepted: false }]);
  const file = path.join(dir, "autoresearch_results.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((e) => e.id), ["a", "b"]);
  fs.writeFileSync(file, "{corrupt");
  appendResults(dir, [{ id: "c" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((e) => e.id), ["c"]); // fresh array
  assert.ok(fs.existsSync(`${file}.bak`)); // history preserved
});

// FBMCPF-248 — token-safety rails

import { parseAgentUsage, budgetExceeded } from "../scripts/autoresearch.mjs";

test("parseAgentUsage: reads cost + token counts from claude -p json output", () => {
  const out = 'noise\n{"type":"result","subtype":"success","total_cost_usd":0.42,"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":2000}}';
  assert.deepEqual(parseAgentUsage(out), { costUsd: 0.42, tokens: 3500 });
  assert.deepEqual(parseAgentUsage("plain text, no json"), { costUsd: null, tokens: null });
  assert.deepEqual(parseAgentUsage(""), { costUsd: null, tokens: null });
  // usage without cost still yields tokens
  const t = parseAgentUsage('{"usage":{"input_tokens":10,"output_tokens":5}}');
  assert.equal(t.tokens, 15);
  assert.equal(t.costUsd, null);
});

test("budgetExceeded: usd and token run caps halt the loop; null caps never do", () => {
  assert.equal(budgetExceeded({ usd: 14.99, tokens: 0 }, { maxUsdPerRun: 15 }).stop, false);
  assert.equal(budgetExceeded({ usd: 15, tokens: 0 }, { maxUsdPerRun: 15 }).stop, true);
  assert.equal(budgetExceeded({ usd: 0, tokens: 2_000_000 }, { maxTokensPerRun: 1_000_000 }).stop, true);
  assert.equal(budgetExceeded({ usd: 999, tokens: 999999999 }, {}).stop, false);
  assert.match(budgetExceeded({ usd: 15, tokens: 0 }, { maxUsdPerRun: 15 }).reason, /USD budget/);
});

test("agent defaults carry the budget rails", () => {
  const cfg = mergeConfig({});
  assert.ok(cfg.agent.args.includes("--output-format"));
  assert.equal(cfg.agent.maxTurns, 25);
  assert.ok(cfg.budget.maxUsdPerRun != null);
  assert.ok(cfg.budget.maxUsdPerExperiment != null);
});
