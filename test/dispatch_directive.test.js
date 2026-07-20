import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDispatchDirective } from "../server/metadata.js";

// FBMCPF-236 — dispatch directive: make sub-agent fan-out the default
// reading of a work packet (next_task / get_work_packet).

test("sonnet + cap label → subAgent, parallelizable, sub-agent instruction", () => {
  const t = { labels: ["model:sonnet", "cap:40000", "effort:medium"] };
  const d = buildDispatchDirective(t);
  assert.equal(d.model, "sonnet");
  assert.equal(d.cap, 40000);
  assert.equal(d.effort, "medium");
  assert.equal(d.subAgent, true);
  assert.equal(d.parallelizable, true);
  assert.match(d.instruction, /sub-agent/i);
  assert.match(d.instruction, /NEVER writes the board or commits/i);
});

test("haiku → subAgent true", () => {
  const t = { labels: ["model:haiku"] };
  const d = buildDispatchDirective(t);
  assert.equal(d.model, "haiku");
  assert.equal(d.subAgent, true);
  assert.equal(d.parallelizable, true);
});

test("opus → subAgent false, orchestrator instruction", () => {
  const t = { labels: ["model:opus", "cap:120000"] };
  const d = buildDispatchDirective(t);
  assert.equal(d.model, "opus");
  assert.equal(d.subAgent, false);
  assert.equal(d.parallelizable, false);
  assert.match(d.instruction, /orchestrator context/i);
});

test("fable → subAgent false", () => {
  const t = { labels: ["model:fable"] };
  const d = buildDispatchDirective(t);
  assert.equal(d.subAgent, false);
  assert.equal(d.parallelizable, false);
});

test("blocked:true forces parallelizable false even for a sub-agent model", () => {
  const t = { labels: ["model:sonnet"] };
  const d = buildDispatchDirective(t, { blocked: true });
  assert.equal(d.subAgent, true);
  assert.equal(d.parallelizable, false);
});

test("missing labels → model falls back to sonnet, cap/effort null", () => {
  const t = { labels: [] };
  const d = buildDispatchDirective(t);
  assert.equal(d.model, "sonnet");
  assert.equal(d.cap, null);
  assert.equal(d.effort, null);
  assert.equal(d.subAgent, true);
  assert.equal(d.parallelizable, true);
});

test("no labels array at all is tolerated", () => {
  const d = buildDispatchDirective({});
  assert.equal(d.model, "sonnet");
  assert.equal(d.subAgent, true);
});
