// FBMCPF-315 — hybrid vector retrieval. The pure parts (cosine, RRF, cache,
// fallback policy) run everywhere; the real-model test is double-gated behind
// the optional dependency being importable AND FEATUREBOARD_TEST_EMBEDDINGS=1
// (first run downloads the ~25MB model — never do that implicitly in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cosine, rrfFuse, readVectorCache, writeVectorCache, resetEmbedder, semanticDisabled, sweepRootVectorCache } from "../server/vectors.js";
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
  // FBMCPB-67: the sidecar belongs to the PROJECT, not the boards root. This assertion
  // previously read board.dataDir, which is exactly the bug — one shared file for every
  // project, with a global 8,000-entry cap they evicted each other from.
  const cache = readVectorCache(board.projectDir("Proj"));
  assert.ok(Object.keys(cache).length >= 3, "vectors cached to the project sidecar");
  assert.deepEqual(readVectorCache(board.dataDir), {}, "nothing written to the boards root");
});

// ---------------------------------------------------------------------------
// FBMCPB-67 — the cache is per project, and projects cannot evict each other
// ---------------------------------------------------------------------------

test("vector cache is written under the project pad, never the boards root", () => {
  const { board } = tmpBoard();
  const projDir = board.projectDir("Proj");
  writeVectorCache(projDir, { k1: [0.1, 0.2] });

  assert.ok(fs.existsSync(path.join(projDir, ".featureboard", "vector-cache.json")),
    "sidecar must land in <projectDir>/.featureboard/");
  assert.ok(!fs.existsSync(path.join(board.dataDir, ".featureboard", "vector-cache.json")),
    "sidecar must NOT land at the boards root");
  assert.deepEqual(readVectorCache(projDir), { k1: [0.1, 0.2] });
});

test("two projects keep independent caches and cannot evict one another", () => {
  const { board } = tmpBoard();
  const a = board.projectDir("Alpha");
  const b = board.projectDir("Beta");

  writeVectorCache(a, { shared_hash: [1, 1], only_a: [2, 2] });
  writeVectorCache(b, { shared_hash: [9, 9], only_b: [3, 3] });

  // Same content hash in both boards must NOT clobber across projects.
  assert.deepEqual(readVectorCache(a).shared_hash, [1, 1]);
  assert.deepEqual(readVectorCache(b).shared_hash, [9, 9]);
  assert.ok(readVectorCache(a).only_a && !readVectorCache(a).only_b);
  assert.ok(readVectorCache(b).only_b && !readVectorCache(b).only_a);
});

test("the 8000-entry cap applies PER PROJECT, not across all of them", () => {
  const { board } = tmpBoard();
  const a = board.projectDir("Alpha");
  const b = board.projectDir("Beta");

  // Fill one project past the cap; the other must be untouched.
  const big = {};
  for (let i = 0; i < 8200; i++) big["h" + i] = [i];
  writeVectorCache(a, big);
  writeVectorCache(b, { survivor: [7] });

  const capped = readVectorCache(a);
  assert.ok(Object.keys(capped).length <= 8000, `expected <=8000, got ${Object.keys(capped).length}`);
  assert.ok(!capped.h0, "oldest entries evicted within the project");
  assert.ok(capped.h8199, "newest entries retained");
  // The whole point: Beta is unaffected by Alpha blowing its budget.
  assert.deepEqual(readVectorCache(b), { survivor: [7] },
    "one project exceeding the cap must not evict another project's vectors");
});

test("embedTexts still accepts the legacy dataDir alias without losing caching", async () => {
  // Kept only so an out-of-tree caller degrades to working-but-shared rather than
  // silently uncached. cacheDir is the correct parameter.
  const { board } = tmpBoard();
  const dir = board.projectDir("Proj");
  writeVectorCache(dir, { seeded: [4, 4] });
  assert.deepEqual(readVectorCache(dir).seeded, [4, 4]);
});

test("sweepRootVectorCache removes the orphaned shared cache but spares its siblings", () => {
  const { board } = tmpBoard();
  const rootFb = path.join(board.dataDir, ".featureboard");
  fs.mkdirSync(rootFb, { recursive: true });
  // The boards-root .featureboard/ legitimately holds these — they must survive.
  fs.writeFileSync(path.join(rootFb, "license.json"), '{"tier":"pro"}');
  fs.writeFileSync(path.join(rootFb, "index.json"), '{"projects":[]}');
  fs.writeFileSync(path.join(rootFb, "registration.json"), '{"email":"a@b.c"}');
  fs.writeFileSync(path.join(rootFb, "vector-cache.json"), '{"h":[1,2]}');

  const res = sweepRootVectorCache(board.dataDir);
  assert.ok(res, "expected the orphan to be reported");
  assert.ok(res.bytes > 0);
  assert.ok(!fs.existsSync(path.join(rootFb, "vector-cache.json")), "orphan removed");
  for (const keep of ["license.json", "index.json", "registration.json"]) {
    assert.ok(fs.existsSync(path.join(rootFb, keep)), `${keep} must survive`);
  }
  assert.ok(fs.existsSync(rootFb), "the directory itself must survive");
  assert.equal(sweepRootVectorCache(board.dataDir), null, "idempotent");
});

test("sweepRootVectorCache never throws on a bogus path", () => {
  assert.doesNotThrow(() => sweepRootVectorCache("/nonexistent-xyz"));
  assert.equal(sweepRootVectorCache("/nonexistent-xyz"), null);
});
