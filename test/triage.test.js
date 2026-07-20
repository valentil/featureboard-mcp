import { test } from "node:test";
import assert from "node:assert/strict";
import { triageTokens, similarTickets, suggestTriage, applyTriage } from "../server/orchestration.js";

// FBMCPF-214 — triage intelligence at intake.

const HIST = [
  { ticketNumber: "FBF-1", title: "Analytics overlay theming for dark mode", description: "theme the analytics overlay", product: "Analytics", priority: 2, labels: ["ui", "model:sonnet", "cap:40000"], status: "Done" },
  { ticketNumber: "FBF-2", title: "Analytics overlay hover cards", description: "hover data cards on analytics overlay", product: "Analytics", priority: 3, labels: ["ui", "visualization"], status: "Done" },
  { ticketNumber: "FBF-3", title: "CRM lead import from csv", description: "import leads", product: "CRM", priority: 1, labels: ["crm"], status: "Done" },
];

test("triageTokens drops stopwords and short words", () => {
  const t = triageTokens("Add a new tool for the analytics overlay");
  assert.ok(t.has("analytics") && t.has("overlay"));
  assert.ok(!t.has("the") && !t.has("a") && !t.has("add") && !t.has("tool"));
});

test("similarTickets ranks the analytics neighbours first", () => {
  const near = similarTickets(HIST, { title: "Analytics overlay legend theming", description: "" });
  assert.ok(near.length >= 1);
  assert.equal(near[0].task.product, "Analytics");
  assert.ok(near.every((n) => n.task.ticketNumber !== "FBF-3"));
});

test("suggestTriage proposes product, median priority, and subject labels (never infra labels)", () => {
  const s = suggestTriage(HIST, { title: "Analytics overlay legend theming", description: "theme the overlay legend" });
  assert.equal(s.product, "Analytics");
  assert.ok([2, 3].includes(s.priority));
  assert.ok(!((s.labels || []).some((l) => /^(model|cap):/.test(l))));
  assert.ok(s.basis.length >= 1);
});

test("applyTriage fills only missing fields — explicit values win", () => {
  const filled = applyTriage(HIST, { title: "Analytics overlay legend theming", description: "" });
  assert.equal(filled.fields.product, "Analytics");
  assert.ok(filled.triage.applied.product);

  const explicit = applyTriage(HIST, { title: "Analytics overlay legend theming", description: "", product: "Board UX", priority: 9 });
  assert.equal(explicit.fields.product, "Board UX");
  assert.equal(explicit.fields.priority, 9);
  assert.equal(explicit.triage.applied, undefined);
});

test("no signal → triage null, fields untouched", () => {
  const r = applyTriage(HIST, { title: "zzqx unrelated frobnicator", description: "" });
  assert.equal(r.triage, null);
  assert.equal(r.fields.product, undefined);
});
