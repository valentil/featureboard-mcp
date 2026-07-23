import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { addKbDoc } from "../server/kb.js";
import { getProjectConfig, setProjectConfig, getWorkPacket } from "../server/metadata.js";
import { prepareResearch, resolveResearchOnIntake, researchSlug, appendResearch } from "../server/research.js";
import { ragSearch, clearIndexCache } from "../server/rag.js";

// FBMCPF-263 — research-on-intake: an optional (default ON) research phase that
// runs BEFORE implementation; prepare_research assembles the request packet and
// the saved brief round-trips into the work packet as researchBrief.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbresearch-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("resolveResearchOnIntake defaults ON when nothing is configured", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Add export" });
  const r = resolveResearchOnIntake(b, "Proj", t);
  assert.equal(r.enabled, true);
  assert.equal(r.source, "default");
});

test("research:off label skips the phase; research:on forces it even when config is off", () => {
  const b = tmpBoard();
  const off = b.addTask("Proj", "feature", { title: "Skip me", labels: ["research:off"] });
  const roff = resolveResearchOnIntake(b, "Proj", off);
  assert.equal(roff.enabled, false);
  assert.equal(roff.source, "label");
  assert.match(roff.reason, /research:off/);

  // Turn the whole project off, but a research:on label still forces it on.
  setProjectConfig(b, "Proj", { researchOnIntake: false });
  const plain = b.addTask("Proj", "feature", { title: "Plain, config off" });
  assert.equal(resolveResearchOnIntake(b, "Proj", plain).enabled, false);
  assert.equal(resolveResearchOnIntake(b, "Proj", plain).source, "config");

  const on = b.addTask("Proj", "feature", { title: "Force on", labels: ["research:on"] });
  const ron = resolveResearchOnIntake(b, "Proj", on);
  assert.equal(ron.enabled, true);
  assert.equal(ron.source, "label");
});

test("prepareResearch returns { skip:true, reason } when the phase resolves OFF", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { researchOnIntake: false });
  const t = b.addTask("Proj", "feature", { title: "No research wanted" });
  const req = prepareResearch(b, "Proj", t.ticketNumber);
  assert.equal(req.skip, true);
  assert.ok(req.reason);
  assert.equal(req.questions, undefined, "skipped requests carry no heavy fields");
});

test("prepareResearch packet shape: questions, sources, deliverable, saveInstruction, model", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Export Format Notes", "CSV columns for the export job and the ordering rules.");
  const t = b.addTask("Proj", "feature", {
    title: "Export ordering",
    description: "The CSV export job should honour the configured column ordering.",
    ref: "server/export.js",
    product: "Core",
  });
  const req = prepareResearch(b, "Proj", t.ticketNumber);
  assert.equal(req.skip, false);
  assert.equal(req.ticket, t.ticketNumber);
  assert.equal(req.questions.length, 4, "four research question categories");
  assert.ok(/how to execute/i.test(req.questions[0]));
  assert.ok(/prior art/i.test(req.questions[1]));

  assert.ok(req.sources, "sources present");
  assert.ok(Array.isArray(req.sources.kb));
  assert.ok(Array.isArray(req.sources.docs));
  assert.ok(Array.isArray(req.sources.priorArt), "priorArt seeded from rag_search");
  assert.equal(req.sources.code.ref, "server/export.js");
  assert.equal(req.sources.code.product, "Core");
  assert.equal(typeof req.sources.web, "boolean");

  assert.match(req.deliverable, /150 lines/);
  assert.match(req.saveInstruction, /add_kb_doc/);
  assert.match(req.saveInstruction, new RegExp(researchSlug(t.ticketNumber)));
});

test("suggestedModel: haiku for effort low/medium, sonnet otherwise", () => {
  const b = tmpBoard();
  const low = b.addTask("Proj", "feature", { title: "Low effort", labels: ["effort:low"] });
  const med = b.addTask("Proj", "feature", { title: "Medium effort", labels: ["effort:medium"] });
  const high = b.addTask("Proj", "feature", { title: "High effort", labels: ["effort:high"] });
  const none = b.addTask("Proj", "feature", { title: "No effort label" });
  assert.equal(prepareResearch(b, "Proj", low.ticketNumber).suggestedModel, "haiku");
  assert.equal(prepareResearch(b, "Proj", med.ticketNumber).suggestedModel, "haiku");
  assert.equal(prepareResearch(b, "Proj", high.ticketNumber).suggestedModel, "sonnet");
  assert.equal(prepareResearch(b, "Proj", none.ticketNumber).suggestedModel, "sonnet");
});

test("research:local label turns web egress off in the request", () => {
  const b = tmpBoard();
  const online = b.addTask("Proj", "feature", { title: "Online research" });
  const offline = b.addTask("Proj", "feature", { title: "Offline research", labels: ["research:local"] });
  assert.equal(prepareResearch(b, "Proj", online.ticketNumber).sources.web, true);
  assert.equal(prepareResearch(b, "Proj", offline.ticketNumber).sources.web, false);
});

test("brief round-trip: add_kb_doc research/<ticket> → getWorkPacket.researchBrief attached", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Widget alignment", description: "Center the widget." });
  // Orchestrator saves the brief under the research/<ticket> convention.
  addKbDoc(b, "Proj", `research/${t.ticketNumber}`, "## Approach\n\nUse flexbox centering. Prior art: FBF-1.\n");
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.ok(packet.researchBrief, "researchBrief attached");
  assert.equal(packet.researchBrief.slug, researchSlug(t.ticketNumber));
  assert.match(packet.researchBrief.content, /flexbox centering/);
  assert.equal(packet.researchBrief.truncated, false);
});

test("researchBrief is capped at ~6KB with a truncation note", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Big brief ticket" });
  const huge = "line of research detail ".repeat(600); // ~14KB
  addKbDoc(b, "Proj", `research/${t.ticketNumber}`, huge);
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.ok(packet.researchBrief);
  assert.equal(packet.researchBrief.truncated, true);
  assert.match(packet.researchBrief.content, /truncated at ~6KB/);
  // Body (minus the note) stays within ~6KB.
  assert.ok(Buffer.byteLength(packet.researchBrief.content, "utf8") <= 6144 + 200);
});

test("no researchBrief attached when no brief doc exists (back-compat)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Plain ticket" });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.equal(packet.researchBrief, undefined);
});

test("FBMCPF-333: appendResearch writes the research-<ticket> kb doc and is RAG-retrievable", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Export metrics", description: "csv export" });

  const r1 = appendResearch(b, "Proj", t.ticketNumber, "Approach: stream rows to avoid buffering the whole export.");
  assert.equal(r1.created, true);
  assert.equal(r1.slug, researchSlug(t.ticketNumber), "lands on the slug the packet auto-attaches");

  const r2 = appendResearch(b, "Proj", t.ticketNumber, "Risk: the pandas dependency bloats cold start.");
  assert.equal(r2.appended, true);

  // Both findings retrievable from the RAG (they now live in the indexed kb/).
  clearIndexCache();
  const hitA = ragSearch(b, "Proj", "stream rows buffering export", { k: 5 });
  const hitB = ragSearch(b, "Proj", "pandas dependency cold start", { k: 5 });
  const brief = `kb/${researchSlug(t.ticketNumber)}`;
  assert.ok(hitA.some((h) => h.source === brief), "first finding indexed");
  assert.ok(hitB.some((h) => h.source === brief), "second finding indexed");
});

test("FBMCPF-333: appendResearch validates ticket + finding", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "X" });
  assert.throws(() => appendResearch(b, "Proj", "NOPE-1", "x"), /not found/);
  assert.throws(() => appendResearch(b, "Proj", t.ticketNumber, "   "), /finding is required/);
});

test("FBMCPF-334: prepare_research nudges incremental capture via append_research", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Add export", description: "csv" });
  const packet = prepareResearch(b, "Proj", t.ticketNumber);
  assert.equal(packet.skip, false);
  assert.match(packet.deliverable, /append_research/, "deliverable points at append_research");
  assert.match(packet.deliverable, /AS YOU GO/i, "deliverable stresses incremental capture");
  assert.match(packet.saveInstruction, /append_research/, "saveInstruction points at append_research");
  assert.match(packet.deliverable, /add_source/, "deliverable tells you to capture sources");
  assert.match(packet.saveInstruction, /add_source/, "saveInstruction points at add_source for raw sources");
  assert.match(packet.saveInstruction, new RegExp(researchSlug(t.ticketNumber)), "still names the research slug");
});
