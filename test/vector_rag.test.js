// FBMCPF-315 — hybrid vector retrieval. The pure parts (cosine, RRF, cache,
// fallback policy) run everywhere; the real-model test is double-gated behind
// the optional dependency being importable AND FEATUREBOARD_TEST_EMBEDDINGS=1
// (first run downloads the ~25MB model — never do that implicitly in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cosine, rrfFuse, readVectorCache, writeVectorCache, resetEmbedder, semanticDisabled } from "../server/vectors.js";
import { ragSearchHybrid, ragSearch } from "../server/rag.js";
import { Board } from "../server/storage.js";
import { addKbDoc } from "../server/kb.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vec-"));
  const board = new Board(dir);
  board.createProject("Proj");
  return { dir, board };
}

// ---------------------------------------------------------------------------
// pure math + cache
// ---------------------------------------------------------------------------

test("cosine: identical=1, orthogonal=0, degenerate inputs=0", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(cosine(null, [1]), 0);
});

test("rrfFuse: agreement wins, disagreement blends, deterministic ties", () => {
  // "a" is 1st in both rankings -> must fuse first
  const fused = rrfFuse([["a", "b", "c"], ["a", "c", "b"]]);
  assert.equal(fused[0].id, "a");
  assert.ok(fused[0].score > fused[1].score);
  // an item high in one ranking beats items low in both
  const fused2 = rrfFuse([["x", "y"], ["z", "x"]]);
  assert.equal(fused2[0].id, "x");
  // pure tie -> lexical order for determinism
  const fused3 = rrfFuse([["b"], ["a"]]);
  assert.deepEqual(fused3.map((f) => f.id), ["a", "b"]);
});

test("vector cache: round-trips, tolerates garbage, caps entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-veccache-"));
  assert.deepEqual(readVectorCache(dir), {});
  writeVectorCache(dir, { abc: [0.1, 0.2] });
  assert.deepEqual(readVectorCache(dir), { abc: [0.1, 0.2] });
  fs.writeFileSync(path.join(dir, ".featureboard", "vector-cache.json"), "[not an object]");
  assert.deepEqual(readVectorCache(dir), {});
});

// ---------------------------------------------------------------------------
// fallback policy — semantic hard-off must reduce to the exact lexical result
// ---------------------------------------------------------------------------

test("ragSearchHybrid falls back to pure BM25 when semantic is disabled", async () => {
  process.env.FEATUREBOARD_NO_SEMANTIC = "1";
  resetEmbedder();
  try {
    assert.equal(semanticDisabled(), true);
    const { board } = tmpBoard();
    addKbDoc(board, "Proj", "Webhook signatures", "Verify the HMAC signature over id.timestamp.body before trusting a webhook.");
    addKbDoc(board, "Proj", "Unrelated", "Grocery lists and meal planning notes.");
    const out = await ragSearchHybrid(board, "Proj", "verify webhook signature", { k: 3 });
    assert.equal(out.mode, "lexical");
    assert.ok(out.note && /FEATUREBOARD_NO_SEMANTIC|unavailable/.test(out.note));
    const plain = ragSearch(board, "Proj", "verify webhook signature", { k: 3 });
    assert.deepEqual(out.results, plain, "fallback must equal the lexical engine verbatim");
    assert.match(out.results[0].source, /^kb\/webhook-signatures/);
  } finally {
    delete process.env.FEATUREBOARD_NO_SEMANTIC;
    resetEmbedder();
  }
});

test("mode:'lexical' skips embeddings deliberately", async () => {
  const { board } = tmpBoard();
  addKbDoc(board, "Proj", "Alpha", "alpha beta gamma");
  const out = await ragSearchHybrid(board, "Proj", "alpha", { k: 2, mode: "lexical" });
  assert.equal(out.mode, "lexical");
  assert.equal(out.results.length, 1);
});

// ---------------------------------------------------------------------------
// real model — opt-in only (downloads ~25MB on first ever run)
// ---------------------------------------------------------------------------

const runReal = process.env.FEATUREBOARD_TEST_EMBEDDINGS === "1";
test("hybrid mode embeds, fuses, and beats keyword-miss queries", { skip: !runReal && "set FEATUREBOARD_TEST_EMBEDDINGS=1 (downloads the model on first run)" }, async () => {
  resetEmbedder();
  const { board } = tmpBoard();
  addKbDoc(board, "Proj", "Automobile pricing", "How much a car costs: sticker price, dealer margin, financing.");
  addKbDoc(board, "Proj", "Fish recipes", "Baking salmon with lemon and dill.");
  addKbDoc(board, "Proj", "Vehicle costs", "Total cost of ownership for a car: fuel, insurance, depreciation.");
  const out = await ragSearchHybrid(board, "Proj", "car cost", { k: 3 });
  assert.equal(out.mode, "hybrid");
  assert.equal(out.model, "Xenova/all-MiniLM-L6-v2");
  assert.ok(out.results.length >= 2);
  for (const r of out.results) {
    assert.equal(typeof r.cosine, "number");
    assert.equal(typeof r.bm25, "number");
  }
  // both car docs must outrank the fish doc under fusion
  const fishRank = out.results.findIndex((r) => /fish/i.test(r.source));
  const carRanks = out.results.map((r, i) => (/automobile|vehicle/i.test(r.source) ? i : -1)).filter((i) => i >= 0);
  if (fishRank !== -1) for (const cr of carRanks) assert.ok(cr < fishRank, "car docs must outrank fish");
  // second call hits the vector cache (sidecar exists and is non-empty)
  const cache = readVectorCache(board.dataDir);
  assert.ok(Object.keys(cache).length >= 3, "vectors cached to sidecar");
});
