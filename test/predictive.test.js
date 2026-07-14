import { test } from "node:test";
import assert from "node:assert/strict";
import { predictCompletion } from "../server/predictive.js";

// FBMCPF-32 — Predictive due-date suggestions
// Estimate completion from velocity (completed/active-day) vs open work.

const asOf = new Date("2026-07-13T12:00:00Z");

test("throughput = completed / active days, and queue is walked in order", () => {
  // 4 tickets closed across 2 active days -> 2 tickets/day
  const r = predictCompletion({
    open: [
      { ticketNumber: "F-1", title: "a", status: "Todo", priority: 1 },
      { ticketNumber: "F-2", title: "b", status: "Todo", priority: 2 },
      { ticketNumber: "F-3", title: "c", status: "Todo", priority: 3 },
      { ticketNumber: "F-4", title: "d", status: "Todo", priority: 4 },
    ],
    doneDates: ["2026-07-11", "2026-07-11", "2026-07-12", "2026-07-12"],
    asOf,
  });
  assert.equal(r.ratePerDay, 2);
  assert.equal(r.confidence, "medium");
  assert.equal(r.openCount, 4);
  assert.equal(r.basis.usedFallback, false);
  // position 1&2 -> day 1; position 3&4 -> day 2 at 2/day
  assert.equal(r.tickets[0].predictedCompletion, "2026-07-14");
  assert.equal(r.tickets[1].predictedCompletion, "2026-07-14");
  assert.equal(r.tickets[2].predictedCompletion, "2026-07-15");
  assert.equal(r.tickets[3].predictedCompletion, "2026-07-15");
  assert.equal(r.projectedCompletion, "2026-07-15");
});

test("tickets without a due date get a suggestion; dated ones are risk-checked", () => {
  const r = predictCompletion({
    open: [
      // predicted 2026-07-14 but due 2026-07-13 -> at risk (slip +1)
      { ticketNumber: "F-1", title: "a", status: "Todo", priority: 1, dueDate: "2026-07-13" },
      { ticketNumber: "F-2", title: "b", status: "Todo", priority: 2 },
    ],
    doneDates: ["2026-07-12"], // 1/day
    asOf,
  });
  assert.equal(r.tickets[0].suggestedDueDate, null);
  assert.equal(r.tickets[0].atRisk, true);
  assert.equal(r.tickets[0].slipDays, 1);
  assert.equal(r.tickets[1].suggestedDueDate, r.tickets[1].predictedCompletion);
  assert.equal(r.tickets[1].atRisk, false);
  assert.equal(r.atRiskCount, 1);
});

test("no completion history falls back to a low-confidence default rate", () => {
  const r = predictCompletion({
    open: [{ ticketNumber: "F-1", title: "a", status: "Todo" }],
    doneDates: [],
    asOf,
  });
  assert.equal(r.confidence, "low");
  assert.equal(r.basis.usedFallback, true);
  assert.equal(r.ratePerDay, 1);
  assert.equal(r.tickets[0].predictedCompletion, "2026-07-14");
});

test("empty board yields no projection", () => {
  const r = predictCompletion({ open: [], doneDates: ["2026-07-12"], asOf });
  assert.equal(r.openCount, 0);
  assert.equal(r.projectedCompletion, null);
  assert.equal(r.atRiskCount, 0);
});
