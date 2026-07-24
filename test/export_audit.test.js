import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { exportAudit } from "../server/audit.js";
import { setRequirements, checkAcceptance } from "../server/requirements.js";
import { logWork } from "../server/metadata.js";
import { addReviewComment, resolveReviewComment } from "../server/reviews.js";
import { addDecision } from "../server/decisions.js";
import { startDriftRun, recordDriftScore } from "../server/drift.js";

// FBMCPF-347 — compliance & traceability export.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbaudit-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

function seed(b) {
  const t = b.addTask("Proj", "feature", { title: "Ship the widget" });
  const tk = t.ticketNumber;
  setRequirements(b, "Proj", tk, {
    intent: "Widget ships.",
    acceptanceCriteria: ["Widget renders", "Widget persists"],
  });
  checkAcceptance(b, "Proj", tk, 1, true);
  b.setStatus("Proj", tk, "In Progress");
  logWork(b, "Proj", { ticket: tk, summary: "built the widget", tokens: 500, additions: 40, deletions: 3, model: "sonnet" });
  addReviewComment(b, "Proj", tk, { comment: "rename the prop", author: "lewis" });
  addDecision(b, "Proj", { title: "Widget storage", decision: "Use markdown", tickets: [tk] });
  b.setStatus("Proj", tk, "Done", "shipped", { approve: true });
  const run = startDriftRun(b, "Proj", { mode: "full" });
  recordDriftScore(b, "Proj", run.runId, { ticket: tk, score: 95 });
  return tk;
}

test("exportAudit json: per-ticket dossier + board summary", () => {
  const b = tmpBoard();
  const tk = seed(b);
  const rep = exportAudit(b, "Proj", { includeCommits: false });
  assert.equal(rep.format, "json");
  assert.equal(rep.summary.tickets, 1);
  assert.equal(rep.summary.byStatus.Done, 1);
  assert.equal(rep.summary.acceptance.criteriaTotal, 2);
  assert.equal(rep.summary.acceptance.criteriaDone, 1);
  assert.equal(rep.summary.reviews.unresolved, 1);
  assert.equal(rep.summary.work.tokens, 500);
  assert.equal(rep.summary.drift.scored, 1);
  assert.equal(rep.summary.drift.flagged, 0);
  assert.equal(rep.summary.doneWithoutCommits, undefined, "no commit section when includeCommits:false");

  const d = rep.tickets[0];
  assert.equal(d.ticket, tk);
  assert.equal(d.requirements.acceptance.done, 1);
  assert.ok(d.events.some((e) => e.field === "status" && e.to === "In Progress"), "status event recorded");
  assert.ok(d.events.some((e) => e.field === "status" && e.to === "Done"), "done event recorded");
  assert.equal(d.workSessions.length, 1);
  assert.equal(d.workSessions[0].model, "sonnet");
  assert.equal(d.reviews.unresolved, 1);
  assert.equal(d.decisions.length, 1);
  assert.equal(d.drift.length, 1);
  assert.equal(d.drift[0].score, 95);
  assert.equal(d.commits, null);
});

test("exportAudit single ticket + unknown ticket throws", () => {
  const b = tmpBoard();
  const tk = seed(b);
  const rep = exportAudit(b, "Proj", { ticket: tk, includeCommits: false });
  assert.equal(rep.tickets.length, 1);
  assert.throws(() => exportAudit(b, "Proj", { ticket: "PROJ-999" }), /not found/);
  assert.throws(() => exportAudit(b, "Nope", {}), /not found/);
});

test("exportAudit markdown dossier renders trail sections", () => {
  const b = tmpBoard();
  const tk = seed(b);
  const rep = exportAudit(b, "Proj", { format: "markdown", includeCommits: false });
  assert.equal(rep.format, "markdown");
  assert.ok(rep.content.includes(`## ${tk} — Ship the widget`));
  assert.ok(rep.content.includes("### Requirements (1/2 criteria met)"));
  assert.ok(rep.content.includes("- [x] Widget renders"));
  assert.ok(rep.content.includes("- [ ] Widget persists"));
  assert.ok(rep.content.includes("### Timeline"));
  assert.ok(rep.content.includes("### Work sessions"));
  assert.ok(rep.content.includes("### Review comments (1 unresolved)"));
  assert.ok(rep.content.includes("### Decisions"));
  assert.ok(rep.content.includes("### Drift scores"));
});

test("exportAudit csv: flat trail rows, quoting, resolved reviews", () => {
  const b = tmpBoard();
  const tk = seed(b);
  addReviewComment(b, "Proj", tk, { comment: 'has "quotes", commas', author: "qa" });
  const all = exportAudit(b, "Proj", { includeCommits: false });
  const id = all.tickets[0].reviews.comments.length; // sanity: 2 comments now
  assert.equal(id, 2);
  const rep = exportAudit(b, "Proj", { format: "csv", includeCommits: false });
  const lines = rep.content.trim().split("\n");
  assert.equal(lines[0], "ticket,ts,kind,detail,actor,model");
  assert.ok(lines.some((l) => l.includes("event:status")));
  assert.ok(lines.some((l) => l.includes(",work,")));
  assert.ok(lines.some((l) => l.includes("review:open")));
  assert.ok(lines.some((l) => l.includes("drift")));
  assert.ok(rep.content.includes('"has ""quotes"", commas"'), "csv quoting");
});

test("exportAudit flags Done tickets without commits when commits are included", () => {
  const b = tmpBoard();
  const tk = seed(b);
  // no codeLocation configured → commit lookup returns a warning + count 0
  const rep = exportAudit(b, "Proj", {});
  assert.deepEqual(rep.summary.doneWithoutCommits, [tk]);
  assert.equal(rep.tickets[0].commits.count, 0);
});
