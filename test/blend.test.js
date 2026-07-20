import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { Board } from "../server/storage.js";
import * as meta from "../server/metadata.js";
import { blendStatus, blendPlan } from "../server/blend.js";
import { buildDispatchDirective } from "../server/metadata.js";
import { getGlobalConfig, setGlobalConfig, reconcileChurn } from "../server/git.js";
import { getLatestUpdate } from "../server/updates.js";
import { planBudget } from "../server/budget.js";
import { registerAnalyticsTools } from "../server/register/analytics.js";
import { registerWorkflowTools } from "../server/register/workflow.js";

// FBMCPF-278/279 — plan-meter "blend" tracking. The account-wide planLimits
// (two weekly Claude-Max meters that reset together) drive a convergence
// verdict + directive, surfaced on get_health/get_metrics and plan_budget.
//
// Same in-memory harness trick as test/eta_hints.test.js: a fake
// server.registerTool captures handlers; registration-time code only touches
// ctx.z, so any other destructured-but-unused ctx field is safely undefined.
// We only CALL get_health (analytics) and plan_budget (workflow), so only those
// handlers' real dependencies need to be present in ctx.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-blend-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function ok(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function tryTool(fn) {
  return async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e.message); } };
}
const writeTool = tryTool;
function makeFakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, _m, h) { tools.set(name, h); }, registerPrompt() {} };
}
async function call(handler, args) {
  const res = await handler(args);
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** ctx with the real deps get_health + plan_budget actually reach at call time. */
function buildTools(board) {
  const ctx = {
    getBoard: () => board,
    meta, blendStatus, blendPlan, getGlobalConfig,
    reconcileChurn, getLatestUpdate, planBudget,
    tryTool, writeTool, z,
  };
  const server = makeFakeServer();
  registerAnalyticsTools(server, ctx);
  registerWorkflowTools(server, ctx);
  return server.tools;
}

/** Set the account-wide planLimits so that `now` is ~daysToReset before reset. */
function setLimits(board, { fablePct, allModelsPct, daysToReset = 2.6, targetRatio } = {}) {
  const now = Date.now();
  const resetAt = new Date(now + daysToReset * 24 * 3600 * 1000).toISOString();
  const capturedAt = new Date(now - 3600 * 1000).toISOString(); // captured 1h ago
  setGlobalConfig(board, { planLimits: { fablePct, allModelsPct, capturedAt, resetAt, ...(targetRatio != null ? { targetRatio } : {}) } });
  return { resetAt, capturedAt };
}

// Fixed-clock planLimits config for the pure-math tests.
function fixedCfg({ fablePct, allModelsPct, capturedAt, resetAt, targetRatio } = {}) {
  return { planLimits: { fablePct, allModelsPct, capturedAt, resetAt, ...(targetRatio != null ? { targetRatio } : {}) } };
}

const RESET = "2026-07-23T03:00:00.000Z";
const NOW_2_6D = "2026-07-20T12:36:00.000Z"; // 62.4h => 2.6 days before RESET
const CAP_FRESH = "2026-07-19T20:00:00.000Z";

// ---------------------------------------------------------------------------
// (a) blendStatus math: hot / cold / balanced / unset / stale
// ---------------------------------------------------------------------------

test("blendStatus: 56/38 fixture -> fable-hot with the documented per-day math", () => {
  const s = blendStatus(fixedCfg({ fablePct: 56, allModelsPct: 38, capturedAt: CAP_FRESH, resetAt: RESET }), new Date(NOW_2_6D));
  assert.ok(s, "expected a status");
  assert.equal(s.verdict, "fable-hot");
  assert.equal(s.fablePct, 56);
  assert.equal(s.allModelsPct, 38);
  assert.equal(s.delta, 18);
  assert.equal(s.daysToReset, 2.6);
  assert.equal(s.hoursToReset, 62.4);
  assert.equal(s.fableDailyAllowancePct, 16.9); // (100-56)/2.6
  assert.equal(s.nonFableDailyNeededPct, 23.8); // (100-38)/2.6
  assert.equal(typeof s.recommendation, "string");
  assert.match(s.recommendation, /sonnet\/opus/i);
});

test("blendStatus: fable trailing -> fable-cold (delta below -5)", () => {
  const s = blendStatus(fixedCfg({ fablePct: 30, allModelsPct: 60, capturedAt: CAP_FRESH, resetAt: RESET }), new Date(NOW_2_6D));
  assert.equal(s.verdict, "fable-cold");
  assert.equal(s.delta, -30);
  assert.match(s.recommendation, /fable/i);
});

test("blendStatus: within +/-5 -> balanced", () => {
  const s = blendStatus(fixedCfg({ fablePct: 50, allModelsPct: 48, capturedAt: CAP_FRESH, resetAt: RESET }), new Date(NOW_2_6D));
  assert.equal(s.verdict, "balanced");
  assert.equal(s.delta, 2);
});

test("blendStatus: exactly +5 delta is still balanced (threshold is strict >)", () => {
  const s = blendStatus(fixedCfg({ fablePct: 45, allModelsPct: 40, capturedAt: CAP_FRESH, resetAt: RESET }), new Date(NOW_2_6D));
  assert.equal(s.delta, 5);
  assert.equal(s.verdict, "balanced");
});

test("blendStatus: unset -> null (no planLimits at all)", () => {
  assert.equal(blendStatus({ gitMode: "commit-only" }, new Date(NOW_2_6D)), null);
  assert.equal(blendStatus({}, new Date(NOW_2_6D)), null);
  assert.equal(blendStatus(null, new Date(NOW_2_6D)), null);
});

test("blendStatus: stale capture (older than one 7-day cycle before reset) -> null", () => {
  const stale = "2026-07-15T00:00:00.000Z"; // RESET - 7d is 2026-07-16T03:00Z, so this predates the window
  assert.equal(blendStatus(fixedCfg({ fablePct: 56, allModelsPct: 38, capturedAt: stale, resetAt: RESET }), new Date(NOW_2_6D)), null);
});

test("blendStatus: cycle already over (now >= resetAt) -> null", () => {
  const after = "2026-07-24T00:00:00.000Z";
  assert.equal(blendStatus(fixedCfg({ fablePct: 56, allModelsPct: 38, capturedAt: CAP_FRESH, resetAt: RESET }), new Date(after)), null);
});

test("blendStatus: targetRatio scales the delta comparison", () => {
  // fable 56 vs all-models 38: at ratio 1.0 delta=18 (hot). At ratio 1.8 the
  // scaled target (38*1.8=68.4) clears fable by >5, flipping the verdict cold.
  const cold = blendStatus(fixedCfg({ fablePct: 56, allModelsPct: 38, capturedAt: CAP_FRESH, resetAt: RESET, targetRatio: 1.8 }), new Date(NOW_2_6D));
  assert.ok(cold.delta < 0);
  assert.equal(cold.verdict, "fable-cold");
});

// ---------------------------------------------------------------------------
// (b) directive text presence per verdict (buildDispatchDirective)
// ---------------------------------------------------------------------------

const HOT = { verdict: "fable-hot", fablePct: 56, allModelsPct: 38 };
const COLD = { verdict: "fable-cold", fablePct: 30, allModelsPct: 60 };
const BAL = { verdict: "balanced", fablePct: 50, allModelsPct: 48 };
const task = { title: "Do the thing", labels: [] };

test("buildDispatchDirective: fable-hot appends the exact hot sentence", () => {
  const d = buildDispatchDirective(task, { etaHints: false, blend: HOT });
  assert.ok(
    d.instruction.includes("Fable meter is running hot (56% vs 38%): dispatch this ticket to a sonnet/opus sub-agent, keep orchestrator turns terse, and batch board ops."),
    d.instruction
  );
});

test("buildDispatchDirective: fable-cold appends the inverse (inline acceptable)", () => {
  const d = buildDispatchDirective(task, { etaHints: false, blend: COLD });
  assert.match(d.instruction, /Fable meter is running cold \(30% vs 60%\)/);
  assert.match(d.instruction, /inline in the orchestrator/i);
});

test("buildDispatchDirective: balanced/unset append nothing", () => {
  assert.doesNotMatch(buildDispatchDirective(task, { etaHints: false, blend: BAL }).instruction, /Fable meter is running/);
  assert.doesNotMatch(buildDispatchDirective(task, { etaHints: false }).instruction, /Fable meter is running/);
});

// ---------------------------------------------------------------------------
// (c) get_health carries blend when planLimits is set; absent otherwise
// ---------------------------------------------------------------------------

test("get_health: carries blend when planLimits is captured", async () => {
  const board = tmpBoard();
  setLimits(board, { fablePct: 56, allModelsPct: 38, daysToReset: 2.6 });
  const tools = buildTools(board);
  const out = await call(tools.get("get_health"), { project: "Proj" });
  assert.ok(out.blend, "expected a blend block on get_health");
  assert.equal(out.blend.verdict, "fable-hot");
  assert.equal(out.blend.fablePct, 56);
  assert.equal(out.blend.allModelsPct, 38);
});

test("get_health: no blend key when planLimits is unset", async () => {
  const board = tmpBoard();
  const tools = buildTools(board);
  const out = await call(tools.get("get_health"), { project: "Proj" });
  assert.equal("blend" in out, false);
});

// ---------------------------------------------------------------------------
// (d) plan_budget carries blendPlan with plausible numbers (56/38, 2.6 days)
// ---------------------------------------------------------------------------

test("plan_budget: carries an additive blendPlan with plausible convergence numbers", async () => {
  const board = tmpBoard();
  // a few open tickets so the wave sizing exercises estimateTicketMinutes
  board.addTask("Proj", "feature", { title: "A", labels: ["effort:medium"] });
  board.addTask("Proj", "feature", { title: "B", labels: ["effort:low"] });
  board.addTask("Proj", "bug", { title: "C", labels: ["effort:high"] });
  setLimits(board, { fablePct: 56, allModelsPct: 38, daysToReset: 2.6 });
  const tools = buildTools(board);

  const out = await call(tools.get("plan_budget"), { project: "Proj" });

  // existing token budgeting is untouched / still present
  assert.ok(out.totals, "existing budget totals must remain");
  assert.ok("plan" in out);

  const bp = out.blendPlan;
  assert.ok(bp, "expected a blendPlan block");
  assert.ok(bp.daysToReset >= 2.5 && bp.daysToReset <= 2.7, `daysToReset=${bp.daysToReset}`);
  assert.ok(bp.fablePerDayPct >= 16 && bp.fablePerDayPct <= 18, `fablePerDayPct=${bp.fablePerDayPct}`);
  assert.ok(bp.nonFablePerDayPct >= 22 && bp.nonFablePerDayPct <= 25, `nonFablePerDayPct=${bp.nonFablePerDayPct}`);
  assert.equal(bp.verdict, "fable-hot");
  assert.equal(typeof bp.convergeBy, "string");
  assert.ok(Array.isArray(bp.waves) && bp.waves.length >= 1, "waves must be a non-empty array");
  assert.ok(bp.waves.some((w) => /sonnet\/opus/i.test(w)), "a wave should name the sonnet/opus volume");
  assert.ok(bp.waves.some((w) => /tokens/i.test(w)), "a wave should carry a token figure");
});

test("plan_budget: no blendPlan when planLimits is unset", async () => {
  const board = tmpBoard();
  board.addTask("Proj", "feature", { title: "A", labels: ["effort:medium"] });
  const tools = buildTools(board);
  const out = await call(tools.get("plan_budget"), { project: "Proj" });
  assert.equal("blendPlan" in out, false);
});
