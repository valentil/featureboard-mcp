// FBMCPF-159 — intake orchestration guard: model/cap assignment on every
// ticket intake path, plus a lint for open tickets still missing a label.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import {
  suggestModelAndCap,
  withOrchestrationLabels,
  findUnlabeledTickets,
  CAP_BY_EFFORT,
} from "../server/orchestration.js";
import { createFeedbackTickets } from "../server/feedback.js";
import { addCompany, reportCompanyBug } from "../server/crm.js";
import { scanBoardCleanup } from "../server/cleanup.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-orch-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// ---------------------------------------------------------------------------
// suggestModelAndCap heuristics
// ---------------------------------------------------------------------------

test("suggestModelAndCap: bug defaults to sonnet", () => {
  const s = suggestModelAndCap({ type: "bug", title: "Save button throws" });
  assert.equal(s.model, "sonnet");
  assert.equal(s.cap, CAP_BY_EFFORT.medium);
  assert.match(s.reason, /bug/);
});

test("suggestModelAndCap: docs/copy/rename keywords -> haiku or sonnet, low cap", () => {
  const s = suggestModelAndCap({ type: "feature", title: "Update README copy and listing docs" });
  assert.equal(s.model, "haiku");
  assert.equal(s.cap, CAP_BY_EFFORT.low);

  const rename = suggestModelAndCap({ type: "feature", title: "Rename the widget field" });
  assert.ok(["haiku", "sonnet"].includes(rename.model));
  assert.equal(rename.cap, CAP_BY_EFFORT.low);
});

test("suggestModelAndCap: architecture/schema/migration keywords -> opus, high cap", () => {
  const s = suggestModelAndCap({ type: "feature", title: "New storage schema migration" });
  assert.equal(s.model, "opus");
  assert.equal(s.cap, CAP_BY_EFFORT.high);
});

test("suggestModelAndCap: UI-heavy / multi-file / parity keywords -> opus (intake-specific bump)", () => {
  for (const title of ["Rebuild the UI-heavy settings screen", "Multi-file refactor of the export pipeline", "Match iOS parity for the timeline"]) {
    const s = suggestModelAndCap({ type: "feature", title });
    assert.equal(s.model, "opus", `expected opus for "${title}"`);
    assert.equal(s.cap, CAP_BY_EFFORT.high);
  }
});

test("suggestModelAndCap: default (no signal) -> conservative sonnet, cap 80k", () => {
  const s = suggestModelAndCap({ type: "feature", title: "Add a settings toggle" });
  assert.equal(s.model, "sonnet");
  assert.equal(s.cap, 80000);
  assert.equal(s.cap, CAP_BY_EFFORT.medium);
});

test("suggestModelAndCap: respects an explicit effort: label over keyword heuristics", () => {
  const s = suggestModelAndCap({ type: "feature", title: "New storage schema migration", labels: ["effort:low"] });
  assert.equal(s.cap, CAP_BY_EFFORT.low);
});

test("suggestModelAndCap: respects an explicit model: label over keyword heuristics", () => {
  const s = suggestModelAndCap({ type: "feature", title: "New storage schema migration", labels: ["model:haiku"] });
  assert.equal(s.model, "haiku");
  assert.match(s.reason, /model label/);
});

// ---------------------------------------------------------------------------
// withOrchestrationLabels: fills only what's missing, never overrides
// ---------------------------------------------------------------------------

test("withOrchestrationLabels: fills model:/cap: when both absent", () => {
  const out = withOrchestrationLabels("feature", { title: "Add a settings toggle" });
  assert.ok(out.labels.some((l) => /^model:/.test(l)));
  assert.ok(out.labels.some((l) => /^cap:/.test(l)));
});

test("withOrchestrationLabels: never overrides labels the creator already set", () => {
  const out = withOrchestrationLabels("feature", {
    title: "New storage schema migration", // would otherwise suggest opus/high
    labels: ["model:haiku", "cap:15000", "custom"],
  });
  assert.deepEqual(out.labels, ["model:haiku", "cap:15000", "custom"]);
});

test("withOrchestrationLabels: fills only the missing one of model:/cap:", () => {
  const onlyModel = withOrchestrationLabels("feature", { title: "x", labels: ["model:opus"] });
  assert.deepEqual(onlyModel.labels.filter((l) => /^model:/.test(l)), ["model:opus"]);
  assert.equal(onlyModel.labels.filter((l) => /^cap:/.test(l)).length, 1);

  const onlyCap = withOrchestrationLabels("feature", { title: "x", labels: ["cap:9000"] });
  assert.deepEqual(onlyCap.labels.filter((l) => /^cap:/.test(l)), ["cap:9000"]);
  assert.equal(onlyCap.labels.filter((l) => /^model:/.test(l)).length, 1);
});

test("withOrchestrationLabels: leaves other fields untouched", () => {
  const out = withOrchestrationLabels("bug", { title: "x", description: "d", product: "Core", priority: 2 });
  assert.equal(out.title, "x");
  assert.equal(out.description, "d");
  assert.equal(out.product, "Core");
  assert.equal(out.priority, 2);
});

// ---------------------------------------------------------------------------
// Every intake path yields a labeled ticket — mirrors exactly how each tool
// in server/index.js (and feedback.js/crm.js) calls withOrchestrationLabels
// right before board.addTask.
// ---------------------------------------------------------------------------

function hasModelAndCap(t) {
  return t.labels.some((l) => /^model:/.test(l)) && t.labels.some((l) => /^cap:/.test(l));
}

test("intake path: add_feature / log_bug (single addTask call)", () => {
  const b = tmpBoard();
  const feature = b.addTask("Proj", "feature", withOrchestrationLabels("feature", { title: "Add export button" }));
  const bug = b.addTask("Proj", "bug", withOrchestrationLabels("bug", { title: "Export crashes" }));
  assert.ok(hasModelAndCap(feature));
  assert.ok(hasModelAndCap(bug));
});

test("intake path: add_features_bulk / plan_work (mapped addTask calls)", () => {
  const b = tmpBoard();
  const features = [{ title: "A" }, { title: "B: multi-file refactor" }];
  const created = features.map((f) => b.addTask("Proj", "feature", withOrchestrationLabels("feature", f)));
  created.forEach((t) => assert.ok(hasModelAndCap(t)));
  const opusOne = created.find((t) => t.title === "B: multi-file refactor");
  assert.ok(opusOne.labels.includes("model:opus"));
});

test("intake path: import_tasks (type resolved per row, then labeled)", () => {
  const b = tmpBoard();
  const rows = [
    { title: "Imported feature" }, // defaultType feature
    { title: "Imported bug", type: "bug" },
  ];
  const defaultType = "feature";
  const created = rows.map((row) => {
    const { type, ...fields } = row;
    const resolvedType = type === "bug" ? "bug" : defaultType;
    return b.addTask("Proj", resolvedType, withOrchestrationLabels(resolvedType, fields));
  });
  created.forEach((t) => assert.ok(hasModelAndCap(t)));
});

test("intake path: validate_feedback apply (createFeedbackTickets)", () => {
  const b = tmpBoard();
  const candidates = [
    { title: "Crash when saving", type: "bug" },
    { title: "Please add dark mode", type: "feature" },
  ];
  const created = createFeedbackTickets(b, "Proj", candidates);
  created.forEach((t) => assert.ok(hasModelAndCap(t)));
});

test("intake path: validate_feedback apply respects a creator-supplied model: label", () => {
  const b = tmpBoard();
  const created = createFeedbackTickets(b, "Proj", [
    { title: "New storage schema migration", type: "feature", labels: ["model:haiku"] },
  ]);
  assert.ok(created[0].labels.includes("model:haiku"));
  assert.ok(created[0].labels.some((l) => /^cap:/.test(l)));
});

test("intake path: CRM convert (report_company_bug)", () => {
  const b = tmpBoard();
  const company = addCompany(b, "Proj", { name: "Acme" });
  const result = reportCompanyBug(
    b,
    "Proj",
    company.id,
    { title: "Customer-reported crash" },
    { logBug: (f) => b.addTask("Proj", "bug", withOrchestrationLabels("bug", f)) }
  );
  const bugTicket = b.getTask("Proj", result.ticket);
  assert.ok(hasModelAndCap(bugTicket));
});

// ---------------------------------------------------------------------------
// findUnlabeledTickets / scan_board_cleanup lint
// ---------------------------------------------------------------------------

test("findUnlabeledTickets: flags open tickets missing model: and/or cap:, ignores Done", () => {
  const tasks = [
    { ticketNumber: "PF-1", title: "unlabeled", status: "Todo", labels: [] },
    { ticketNumber: "PF-2", title: "fully labeled", status: "Todo", labels: ["model:sonnet", "cap:80000"] },
    { ticketNumber: "PF-3", title: "model only", status: "In Progress", labels: ["model:opus"] },
    { ticketNumber: "PF-4", title: "done but unlabeled", status: "Done", labels: [] },
  ];
  const out = findUnlabeledTickets(tasks);
  const byTicket = Object.fromEntries(out.map((r) => [r.ticket, r]));
  assert.deepEqual(byTicket["PF-1"].missing, ["model", "cap"]);
  assert.ok(!byTicket["PF-2"]);
  assert.deepEqual(byTicket["PF-3"].missing, ["cap"]);
  assert.ok(!byTicket["PF-4"]); // Done tickets are never flagged
});

test("scan_board_cleanup surfaces unlabeled tickets from a real board", () => {
  const b = tmpBoard();
  // created via the intake guard -> labeled
  b.addTask("Proj", "feature", withOrchestrationLabels("feature", { title: "Guarded ticket" }));
  // created directly (bypassing intake, e.g. a raw markdown edit) -> unlabeled
  const raw = b.addTask("Proj", "feature", { title: "Raw ticket" });
  const scan = scanBoardCleanup(b, "Proj");
  assert.equal(scan.unlabeledCount, 1);
  assert.equal(scan.unlabeled[0].ticket, raw.ticketNumber);
  assert.deepEqual(scan.unlabeled[0].missing, ["model", "cap"]);
});

test("scan_board_cleanup: labeling the ticket clears the lint finding", () => {
  const b = tmpBoard();
  const raw = b.addTask("Proj", "feature", { title: "Raw ticket" });
  assert.equal(scanBoardCleanup(b, "Proj").unlabeledCount, 1);
  b.updateTask("Proj", raw.ticketNumber, { labels: ["model:sonnet", "cap:80000"] });
  assert.equal(scanBoardCleanup(b, "Proj").unlabeledCount, 0);
});
