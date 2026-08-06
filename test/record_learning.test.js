// FBMCPF-384 — canonical learnings (kb.js recordLearning, FBMCPF-381) and the
// embed-on-write warm path (rag.js warmEmbeddings, FBMCPF-383).
//
// The contract under guard: one topic = one file = one CURRENT truth. A repeat
// call REPLACES the body (no appended contradictions — that's the spaghetti
// this exists to prevent); only frontmatter provenance accumulates. And the
// vector warm-up is a silent no-op without the optional semantic runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLearning, addKbDoc, listKbDocs, getKbDoc, searchKb } from "../server/kb.js";
import { warmEmbeddings } from "../server/rag.js";

function tmpBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-learn-"));
  fs.mkdirSync(path.join(root, "Proj"), { recursive: true });
  return {
    dataDir: root,
    projectDir: (p) => path.join(root, p),
  };
}

test("recordLearning creates kb/learning-<slug>.md with kind + provenance frontmatter", () => {
  const board = tmpBoard();
  const r = recordLearning(board, "Proj", "OCC fillet edge-id stability", "Edge ids must be re-resolved after every boolean.", { ticket: "CADS-12" });
  assert.equal(r.created, true);
  assert.equal(r.slug, "learning-occ-fillet-edge-id-stability");
  const raw = fs.readFileSync(r.path, "utf8");
  assert.match(raw, /kind: learning/);
  assert.match(raw, /provenance: CADS-12 \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(raw, /re-resolved after every boolean/);
});

test("same topic REPLACES the body wholesale and accumulates provenance", () => {
  const board = tmpBoard();
  recordLearning(board, "Proj", "Sweep profiles", "v1: sweeps require closed profiles.", { ticket: "CADS-1" });
  const r2 = recordLearning(board, "Proj", "Sweep profiles", "v2: sweeps accept open profiles since kernel 0.3; closed only for shelling.", { ticket: "CADS-9" });
  assert.equal(r2.replaced, true);
  const raw = fs.readFileSync(r2.path, "utf8");
  assert.ok(!raw.includes("v1:"), "old body must be GONE — replace, never append");
  assert.match(raw, /v2: sweeps accept open profiles/);
  assert.deepEqual(r2.provenance.map((p) => p.split(" ")[0]), ["CADS-1", "CADS-9"], "provenance accumulates across upserts");
});

test("learnings are ordinary kb docs: listed, fetched, and keyword-searchable", () => {
  const board = tmpBoard();
  recordLearning(board, "Proj", "Chamfer distance limits", "Chamfer distance must be < half the adjacent edge length.");
  const docs = listKbDocs(board, "Proj");
  assert.equal(docs.length, 1);
  const doc = getKbDoc(board, "Proj", "learning-chamfer-distance-limits");
  assert.match(doc.content, /half the adjacent edge length/);
  const hits = searchKb(board, "Proj", "chamfer distance");
  assert.ok(hits.length >= 1, "learning should surface in search_kb");
});

test("learning slugs are prefix-separated from regular kb docs — no clobbering", () => {
  const board = tmpBoard();
  addKbDoc(board, "Proj", "Mesh export", "Regular doc about mesh export options.");
  recordLearning(board, "Proj", "Mesh export", "Learning: binary STL is 5x smaller, always default to it.");
  const docs = listKbDocs(board, "Proj").map((d) => d.slug).sort();
  assert.deepEqual(docs, ["learning-mesh-export", "mesh-export"]);
  assert.match(getKbDoc(board, "Proj", "mesh-export").content, /Regular doc/);
});

test("empty topic or content is refused — no placeholder learnings", () => {
  const board = tmpBoard();
  assert.throws(() => recordLearning(board, "Proj", "  ", "body"), /topic is required/);
  assert.throws(() => recordLearning(board, "Proj", "Topic", "   "), /content is required/i);
});

test("warmEmbeddings is a silent no-op without the semantic runtime (and never throws)", async () => {
  const board = tmpBoard();
  process.env.FEATUREBOARD_NO_SEMANTIC = "1"; // hard-off, so this test never downloads a model
  try {
    const r = await warmEmbeddings(board, "Proj", [{ source: "kb/x.md", content: "# H\n\nsome text" }]);
    assert.equal(r.warmed, 0);
    const junk = await warmEmbeddings(board, "Proj", null);
    assert.equal(junk.warmed, 0, "malformed input tolerated");
  } finally {
    delete process.env.FEATUREBOARD_NO_SEMANTIC;
  }
});
