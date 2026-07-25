/**
 * FeatureBoard local vector embeddings (FBMCPF-315).
 *
 * Turns the lexical RAG (rag.js) into two-stage HYBRID retrieval: BM25
 * preselects candidates, a local sentence-embedding model re-ranks them by
 * cosine similarity, and reciprocal-rank fusion blends the two rankings.
 *
 * Privacy / dependency posture (deliberate):
 *   - The embedding runtime (@xenova/transformers + onnxruntime) is an
 *     OPTIONAL dependency — ~90MB of platform-specific native code that must
 *     never ride in the cross-platform plugin bundle. Absent → everything in
 *     here reports unavailable and callers fall back to pure BM25.
 *   - The model (Xenova/all-MiniLM-L6-v2, ~25MB) downloads ONCE from the
 *     Hugging Face CDN on the first semantic query, then lives in the local
 *     cache dir forever. That single fetch is a disclosed exception in
 *     docs/compliance/PRIVACY.md. Set FEATUREBOARD_NO_SEMANTIC=1 to hard-off.
 *   - Embedded vectors are cached by content hash in
 *     <dataDir>/.featureboard/vector-cache.json, so only new/changed chunks
 *     ever get embedded — steady-state queries embed just the query string.
 *
 * Exposed shape is deliberately tiny: semanticAvailable(), embedTexts(),
 * cosine(), rrfFuse(), plus the cache helpers. rag.js owns retrieval policy.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const CACHE_FILE = "vector-cache.json";
const CACHE_MAX_ENTRIES = 8000; // ~8k chunks × 384 floats ≈ 25MB JSON worst case

let _pipelinePromise = null; // lazy singleton; null until first use
let _unavailableReason = null; // sticky failure so we probe at most once per process

function disabledByEnv() {
  return /^(1|true|yes|on)$/.test(String(process.env.FEATUREBOARD_NO_SEMANTIC || "").toLowerCase());
}

/** Cheap sync availability hint (no import triggered). */
export function semanticDisabled() {
  return disabledByEnv();
}

/**
 * Lazy-load the feature-extraction pipeline. Resolves to null (never throws)
 * when the optional dependency is missing, env-disabled, or init fails —
 * callers treat null as "stay lexical".
 */
export async function getEmbedder() {
  if (disabledByEnv() || _unavailableReason) return null;
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      try {
        const { pipeline, env } = await import("@xenova/transformers");
        // keep the model cache next to the package (default) — one download, reused forever
        env.allowLocalModels = true;
        return await pipeline("feature-extraction", MODEL_ID);
      } catch (e) {
        _unavailableReason =
          `semantic embeddings unavailable (${(e && e.message ? e.message.split("\n")[0] : String(e)).slice(0, 200)}) — ` +
          `install the optional dependency with: npm install @xenova/transformers`;
        return null;
      }
    })();
  }
  return _pipelinePromise;
}

/** Why semantic mode is off, or null if it isn't (or hasn't been probed yet). */
export function unavailableReason() {
  if (disabledByEnv()) return "FEATUREBOARD_NO_SEMANTIC=1";
  return _unavailableReason;
}

/** Test hook: reset the lazy singleton so availability can be re-probed. */
export function resetEmbedder() {
  _pipelinePromise = null;
  _unavailableReason = null;
}

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Vector cache — content-hash keyed, JSON sidecar under .featureboard/
//
// FBMCPB-67: the argument here is the directory the cache lives IN, and it must be the
// PROJECT's pad, not the boards root. It was previously called with board.dataDir, so all
// projects shared one file: 2.4MB at projectpads/.featureboard/vector-cache.json with zero
// per-project caches. That was not merely untidy — CACHE_MAX_ENTRIES applied to the single
// shared object, so 27 projects competed for one 8,000-chunk budget and evicted each other.
// A rag_search on a big board wiped a smaller board's vectors, which were then re-embedded
// from scratch on the next switch. The per-project intent already existed in rag.js, whose
// indexCache is keyed by dataDir + project.
// ---------------------------------------------------------------------------

function cachePath(cacheDir) {
  return path.join(cacheDir, ".featureboard", CACHE_FILE);
}

/**
 * FBMCPB-67: remove the orphaned boards-root vector cache.
 *
 * Before this fix the cache was written to <boardsRoot>/.featureboard/vector-cache.json, one
 * shared file for every project (2.4MB on the reporter's machine). Now that each project owns
 * its own sidecar, that file is unreachable and pure dead weight — and it CANNOT be migrated:
 * entries are content-hash keyed with no project attribution, so there is no way to work out
 * which project any vector belonged to. Abandon and re-embed is the only correct move.
 *
 * Targets the single FILE, never the directory: the boards-root .featureboard/ legitimately
 * holds license.json, index.json and registration.json. Never throws.
 */
export function sweepRootVectorCache(dataDir) {
  try {
    const orphan = path.join(dataDir, ".featureboard", CACHE_FILE);
    if (!fs.existsSync(orphan)) return null;
    const bytes = fs.statSync(orphan).size;
    fs.rmSync(orphan, { force: true });
    return { removed: orphan, bytes };
  } catch {
    return null;
  }
}

export function readVectorCache(cacheDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(cacheDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeVectorCache(cacheDir, cache) {
  const keys = Object.keys(cache);
  // crude size guard: drop oldest-inserted entries beyond the cap (object key
  // order is insertion order for string keys — good enough for a cache)
  if (keys.length > CACHE_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete cache[k];
  }
  const dir = path.dirname(cachePath(cacheDir));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = cachePath(cacheDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, cachePath(cacheDir));
}

/**
 * Embed texts, consulting/updating the on-disk cache when dataDir is given.
 * Returns Array<Float lists> aligned with input, or null when semantic mode
 * is unavailable. Never throws.
 */
export async function embedTexts(texts, { cacheDir = null, dataDir = null } = {}) {
  // FBMCPB-67: cacheDir is the project pad. dataDir is accepted as a legacy alias only so an
  // out-of-tree caller does not silently lose caching — but passing the boards root is what
  // caused the shared-cache thrash, so prefer cacheDir.
  const dir = cacheDir || dataDir;
  const embedder = await getEmbedder();
  if (!embedder) return null;
  const cache = dir ? readVectorCache(dir) : {};
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    const key = sha1(t);
    if (cache[key]) out[i] = cache[key];
    else missing.push({ i, t, key });
  });
  try {
    for (const m of missing) {
      const res = await embedder(m.t, { pooling: "mean", normalize: true });
      const vec = Array.from(res.data, (v) => Math.round(v * 1e6) / 1e6); // 6dp keeps the sidecar sane
      out[m.i] = vec;
      cache[m.key] = vec;
    }
  } catch {
    return null; // mid-flight failure → caller stays lexical this query
  }
  if (dir && missing.length) {
    try { writeVectorCache(dir, cache); } catch { /* cache write is best-effort */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure math — unit-testable without the model
// ---------------------------------------------------------------------------

/** Cosine similarity. Vectors from embedTexts are already L2-normalized, but
 *  compute the full quotient so unnormalized test vectors behave too. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal-rank fusion over N rankings. Each ranking is an array of item
 * ids, best first. Classic RRF: score(id) = Σ 1/(K + rank). Returns ids
 * sorted by fused score (desc), ties broken lexically for determinism.
 */
export function rrfFuse(rankings, { k = 60 } = {}) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, idx) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([id, score]) => ({ id, score: Math.round(score * 1e6) / 1e6 }));
}
