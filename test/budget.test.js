import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { estimateWork, planBudget, suggestModel, capOfTask } from "../server/budget.js";
import { logWork } from "../server/metadata.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("capOfTask and suggestModel read labels", () => {
  assert.equal(capOfTask({ labels: ["cap:50k"] }), 50000);
  assert.equal(capOfTask({ labels: ["cap:1.5m"] }), 1500000);
  assert.equal(capOfTask({ labels: [] }), null);
  assert.equal(suggestModel({ labels: ["model:sonnet"], title: "x" }).model, "sonnet");
  assert.equal(suggestModel({ type: "bug", labels: [], title: "small fix" }).model, "sonnet");
  assert.equal(suggestModel({ type: "feature", labels: [], title: "New storage schema migration" }).model, "opus");
});

test("estimateWork: cap label wins, then history medians, then default", () => {
  const b = tmpBoard();
  // history: three Done tickets in product "Core" with logged spend
  for (const [title, tokens] of [["a", 10000], ["b", 20000], ["c", 30000]]) {
    const t = b.addTask("Proj", "feature", { title, product: "Core" });
    b.setStatus("Proj", t.ticketNumber, "Done");
    logWork(b, "Proj", { ticket: t.ticketNumber, summary: "done", tokens });
  }
  const capped = b.addTask("Proj", "feature", { title: "capped", labels: ["cap:99k"], product: "Core" });
  const coreOpen = b.addTask("Proj", "feature", { title: "core open", product: "Core" });
  const other = b.addTask("Proj", "feature", { title: "no product history" });
  const { estimates, history } = estimateWork(b, "Proj");
  const byT = Object.fromEntries(estimates.map((e) => [e.ticket, e]));
  assert.equal(history.doneWithSpend, 3);
  assert.equal(byT[capped.ticketNumber].estimate, 99000);
  assert.equal(byT[capped.ticketNumber].basis, "cap label");
  assert.equal(byT[coreOpen.ticketNumber].estimate, 20000); // product median
  assert.equal(byT[other.ticketNumber].estimate, 20000); // board median fallback
});

test("planBudget: cutline, day spread, model split, sprint filter", () => {
  const b = tmpBoard();
  const t1 = b.addTask("Proj", "feature", { title: "one", labels: ["cap:100k", "model:opus", "sprint:W1"], priority: 1 });
  const t2 = b.addTask("Proj", "feature", { title: "two", labels: ["cap:100k", "model:sonnet", "sprint:W1"], priority: 2 });
  const t3 = b.addTask("Proj", "feature", { title: "three", labels: ["cap:100k", "model:sonnet", "sprint:W1"], priority: 3 });
  const plan = planBudget(b, "Proj", { budgetTokens: 250000, days: 2, sprint: "W1" });
  assert.equal(plan.totals.plannedTickets, 2);
  assert.equal(plan.totals.plannedTokens, 200000);
  assert.equal(plan.cutline.unplannedTickets, 1);
  assert.equal(plan.unplanned[0].ticket, t3.ticketNumber);
  assert.equal(plan.totals.byModel.opus, 100000);
  assert.equal(plan.totals.byModel.sonnet, 100000);
  assert.equal(plan.totals.costUnits, 100000 * 5 + 100000 * 1);
  const days = plan.plan.map((x) => x.day).sort();
  assert.deepEqual(days, [1, 2]); // spread across both days
  // spent tokens reduce remaining
  logWork(b, "Proj", { ticket: t1.ticketNumber, summary: "partial", tokens: 40000 });
  const plan2 = planBudget(b, "Proj", { budgetTokens: 250000, days: 2, sprint: "W1" });
  const p1 = plan2.plan.find((x) => x.ticket === t1.ticketNumber);
  assert.equal(p1.remaining, 60000);
});
