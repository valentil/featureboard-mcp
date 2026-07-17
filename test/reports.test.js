import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { addDecision } from "../server/decisions.js";
import {
  AUDIENCES,
  slugify,
  buildReportPacket,
  renderReport,
  buildReportPrompt,
  buildAllPrompts,
  formatSprintSummary,
  writeReports,
  listReports,
  getSprintReport,
  closeSprint,
} from "../server/reports.js";

// FBMCPF-156 — audience-specific sprint close-out reports.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbreports-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

/**
 * Seed sprint "Alpha": two Done features, one Done bug, one ADR touched by the
 * first feature, and (optionally) one still-open ticket for carryover/gating.
 */
function seedSprint(b, { withOpen = false } = {}) {
  const f1 = b.addTask("Proj", "feature", { title: "Export to CSV", product: "Core", labels: ["sprint:Alpha", "cap:50k"], priority: 1 });
  b.setStatus("Proj", f1.ticketNumber, "Done", "Users can export any table to CSV.");
  logWork(b, "Proj", { ticket: f1.ticketNumber, summary: "shipped export commit a1b2c3d4e5", additions: 120, deletions: 10, tokens: 40000, model: "sonnet" });

  const f2 = b.addTask("Proj", "feature", { title: "Dark mode", product: "UI", labels: ["sprint:Alpha"], priority: 2 });
  b.setStatus("Proj", f2.ticketNumber, "Done", "Board now supports a dark theme.");
  logWork(b, "Proj", { ticket: f2.ticketNumber, summary: "themed everything", additions: 200, deletions: 30, tokens: 60000, model: "opus" });

  const bug = b.addTask("Proj", "bug", { title: "Fix crash on empty board", product: "Core", labels: ["sprint:Alpha"], priority: 1 });
  b.setStatus("Proj", bug.ticketNumber, "Done", "Guarded the empty case.");
  logWork(b, "Proj", { ticket: bug.ticketNumber, summary: "null guard", additions: 5, deletions: 2, tokens: 8000, model: "sonnet" });

  addDecision(b, "Proj", { title: "Stream CSV exports", decision: "Stream rather than buffer.", tickets: [f1.ticketNumber] });

  let open = null;
  if (withOpen) {
    open = b.addTask("Proj", "feature", { title: "Import from CSV", product: "Core", labels: ["sprint:Alpha"], priority: 3 });
    b.setStatus("Proj", open.ticketNumber, "In Progress");
  }
  return { f1, f2, bug, open };
}

test("buildReportPacket aggregates tickets, metrics, ADRs and commits", () => {
  const b = tmpBoard();
  seedSprint(b);
  const packet = buildReportPacket(b, "Proj", "Alpha");

  assert.equal(packet.sprint.name, "Alpha");
  assert.equal(packet.sprint.slug, "alpha");
  assert.equal(packet.closed, true);
  assert.equal(packet.metrics.total, 3);
  assert.equal(packet.metrics.done, 3);
  assert.equal(packet.metrics.carryover, 0);
  assert.equal(packet.metrics.completionPct, 100);
  // velocity rolls up the three logged work sessions
  assert.equal(packet.metrics.velocity.additions, 325);
  assert.equal(packet.metrics.velocity.deletions, 42);
  assert.equal(packet.metrics.velocity.tokens, 108000);
  // ADR linked to the CSV feature is surfaced
  assert.equal(packet.adrs.length, 1);
  assert.equal(packet.adrs[0].title, "Stream CSV exports");
  // best-effort commit extraction from the work log
  assert.ok(packet.commits.includes("a1b2c3d4e5"));
  // per-ticket cap read from the cap:50k label
  const csv = packet.tickets.find((t) => t.title === "Export to CSV");
  assert.equal(csv.cap, 50000);
  assert.equal(csv.done, true);
});

test("buildReportPacket carryover + closed flag with an open ticket", () => {
  const b = tmpBoard();
  seedSprint(b, { withOpen: true });
  const packet = buildReportPacket(b, "Proj", "Alpha");
  assert.equal(packet.closed, false);
  assert.equal(packet.metrics.total, 4);
  assert.equal(packet.metrics.done, 3);
  assert.equal(packet.metrics.carryover, 1);
  assert.equal(packet.carryoverTickets.length, 1);
  assert.equal(packet.carryoverTickets[0].title, "Import from CSV");
});

test("buildReportPacket throws when the sprint has no tickets", () => {
  const b = tmpBoard();
  seedSprint(b);
  assert.throws(() => buildReportPacket(b, "Proj", "Ghost"), /no tickets/i);
  assert.throws(() => buildReportPacket(b, "Proj", ""), /required/i);
});

test("all four renderers produce non-empty, structured markdown", () => {
  const b = tmpBoard();
  seedSprint(b);
  const packet = buildReportPacket(b, "Proj", "Alpha");

  for (const audience of AUDIENCES) {
    const md = renderReport(packet, audience);
    assert.ok(md.length > 100, `${audience} report should be substantial`);
    assert.match(md, /^# /m, `${audience} has a top-level heading`);
    assert.match(md, /^## /m, `${audience} has section headings`);
    assert.match(md, /Alpha/, `${audience} names the sprint`);
    assert.ok(md.endsWith("\n"), `${audience} ends with a newline`);
  }

  // audience-distinct content
  assert.match(renderReport(packet, "marketing"), /Features shipped/);
  assert.match(renderReport(packet, "marketing"), /Export to CSV/);
  assert.match(renderReport(packet, "sales"), /customer-facing capabilities/i);
  assert.match(renderReport(packet, "technical"), /Per-ticket changes/);
  assert.match(renderReport(packet, "technical"), /Stream CSV exports/); // ADR
  assert.match(renderReport(packet, "executive"), /Velocity/);
  assert.match(renderReport(packet, "executive"), /Spend vs budget/);

  assert.throws(() => renderReport(packet, "nobody"), /Unknown audience/);
});

test("buildReportPrompt / buildAllPrompts carry the packet and an audience brief", () => {
  const b = tmpBoard();
  seedSprint(b);
  const packet = buildReportPacket(b, "Proj", "Alpha");

  const one = buildReportPrompt(packet, "sales");
  assert.match(one, /sales close-out/);
  assert.match(one, /REPORT PACKET/);
  assert.match(one, /Export to CSV/); // packet JSON embedded

  const all = buildAllPrompts(packet);
  assert.deepEqual(Object.keys(all).sort(), [...AUDIENCES].sort());
  for (const a of AUDIENCES) assert.ok(all[a].length > 200);

  assert.throws(() => buildReportPrompt(packet, "nobody"), /Unknown audience/);
});

test("formatSprintSummary is a compact Slack block", () => {
  const b = tmpBoard();
  seedSprint(b);
  const packet = buildReportPacket(b, "Proj", "Alpha");
  const summary = formatSprintSummary(packet);
  assert.match(summary, /Sprint closed: Alpha/);
  assert.match(summary, /3\/3 tickets done/);
  assert.match(summary, /Shipped:/);
});

test("writeReports writes the four pads + a manifest, listReports finds them", () => {
  const b = tmpBoard();
  seedSprint(b);
  const packet = buildReportPacket(b, "Proj", "Alpha");
  const { dir, paths } = writeReports(b, "Proj", packet);

  for (const a of AUDIENCES) {
    assert.ok(fs.existsSync(paths[a]), `${a}.md exists`);
    assert.equal(path.basename(paths[a]), `${a}.md`);
    assert.ok(fs.readFileSync(paths[a], "utf8").length > 0);
  }
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  assert.ok(dir.includes(path.join("reports", "alpha")));

  const listed = listReports(b, "Proj");
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].sprint, "Alpha");
  assert.deepEqual(listed.reports[0].audiences.sort(), [...AUDIENCES].sort());
  assert.equal(listed.reports[0].metrics.done, 3);
});

test("getSprintReport: list → manifest → single markdown", () => {
  const b = tmpBoard();
  seedSprint(b);
  writeReports(b, "Proj", buildReportPacket(b, "Proj", "Alpha"));

  // no sprint → list
  const list = getSprintReport(b, "Proj", {});
  assert.equal(list.reports.length, 1);

  // sprint, no audience → manifest + audiences
  const manifest = getSprintReport(b, "Proj", { sprint: "Alpha" });
  assert.equal(manifest.sprint, "Alpha");
  assert.equal(manifest.slug, "alpha");
  assert.deepEqual(manifest.audiences.sort(), [...AUDIENCES].sort());

  // sprint + audience → markdown
  const tech = getSprintReport(b, "Proj", { sprint: "Alpha", audience: "technical" });
  assert.equal(tech.audience, "technical");
  assert.match(tech.markdown, /Per-ticket changes/);

  assert.throws(() => getSprintReport(b, "Proj", { sprint: "Nope" }), /No reports found/i);
  assert.throws(() => getSprintReport(b, "Proj", { sprint: "Alpha", audience: "nobody" }), /Unknown audience/);
});

test("closeSprint gates on open tickets unless force:true", async () => {
  const b = tmpBoard();
  seedSprint(b, { withOpen: true });
  await assert.rejects(closeSprint(b, "Proj", "Alpha", {}), /open ticket/i);

  const res = await closeSprint(b, "Proj", "Alpha", { force: true });
  assert.equal(res.closed, false);
  assert.equal(res.forced, true);
  assert.equal(res.summary.carryover, 1);
  for (const a of AUDIENCES) assert.ok(fs.existsSync(res.paths[a]));
  assert.deepEqual(Object.keys(res.prompts).sort(), [...AUDIENCES].sort());
});

test("closeSprint writes reports and returns prompts for a clean sprint", async () => {
  const b = tmpBoard();
  seedSprint(b);
  const res = await closeSprint(b, "Proj", "Alpha", {});
  assert.equal(res.closed, true);
  assert.equal(res.forced, false);
  assert.equal(res.summary.total, 3);
  assert.equal(res.summary.done, 3);
  assert.equal(res.summary.adrs, 1);
  assert.equal(res.slack.sent, false); // no notify hook supplied
  for (const a of AUDIENCES) assert.ok(fs.existsSync(res.paths[a]));
});

test("closeSprint posts a Slack summary when a notify hook is given", async () => {
  const b = tmpBoard();
  seedSprint(b);
  let posted = null;
  const notify = (text) => { posted = text; return { sent: true }; };
  const res = await closeSprint(b, "Proj", "Alpha", { notify });
  assert.equal(res.slack.sent, true);
  assert.match(posted, /Sprint closed: Alpha/);
});

test("closeSprint never fails the close when Slack throws", async () => {
  const b = tmpBoard();
  seedSprint(b);
  const notify = () => { throw new Error("slack webhook 500"); };
  const res = await closeSprint(b, "Proj", "Alpha", { notify });
  // close still succeeded, reports still written, failure captured not thrown
  assert.equal(res.closed, true);
  assert.equal(res.slack.sent, false);
  assert.match(res.slack.warning, /slack webhook 500/i);
  for (const a of AUDIENCES) assert.ok(fs.existsSync(res.paths[a]));
});

test("slugify normalizes sprint names for the reports dir", () => {
  assert.equal(slugify("Sprint 24-Q3"), "sprint-24-q3");
  assert.equal(slugify("  Alpha!!  "), "alpha");
  assert.equal(slugify(""), "sprint");
});
