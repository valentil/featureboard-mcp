/**
 * FeatureBoard v0.6 local lexical RAG (FBMCPF-264).
 *
 * A zero-dependency, zero-token, zero-network retrieval index that grounds the
 * research → implementation handoff. The corpus is everything a work packet
 * might want to draw on WITHOUT paying to re-read it every time:
 *
 *   (a) every kb/ doc of the project (architecture notes, gotchas, and the
 *       research briefs FBMCPF-263 writes as research-<ticket> docs),
 *   (b) *.md under the code repo's docs/ plus the root README, and
 *   (c) Done tickets' title + completionSummary from the board.
 *
 * Retrieval is Okapi BM25 (k1=1.5, b=0.75) over heading/paragraph chunks — a
 * classic, well-understood lexical ranker. Be honest about what this is: it is
 * KEYWORD retrieval, not semantic search. It cannot match "car" to "automobile"
 * unless both words appear. That is a deliberate trade — it is deterministic,
 * costs no model tokens and no network round-trips, and is plenty to surface
 * prior art / relevant docs by shared vocabulary.
 *
 * UPGRADE PATH (embeddings): to add semantic recall, keep this chunker +
 * corpus builder as-is and swap the ranker — embed each chunk's `text` with a
 * local model (or a cached embedding API), store the vectors alongside the
 * chunks, and replace `scoreBM25` with cosine similarity (or blend the two:
 * BM25 for exact terms, vectors for paraphrase). The chunk/source/heading shape
 * returned here is already what a vector store would key on, so callers
 * (rag_search, getWorkPacket.ragChunks) would not change.
 *
 * IMPORTANT (no import cycle): like kb.js, this module imports ONLY node
 * builtins. The Board + project are passed in as arguments and the code
 * location is read from the project's config files directly (a tiny local
 * reader, not an import of metadata.js) so that metadata.js may safely import
 * THIS module for work-packet injection without creating a require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// A tiny stopword list — just the highest-frequency English glue words that
// carry no retrieval signal. Kept deliberately small so domain terms survive.
const STOPWORDS = new Set(
  ("a an the and or but of to in on at for with by from as is are be was were " +
   "this that these those it its it's you your we our they their he she " +
   "not no do does did so if then than into over under out up down " +
   "will would can could should may might must have has had").split(/\s+/)
);

/** Lowercase, split on non-alphanumerics, drop 1-char tokens + stopwords. */
export function tokenize(s) {
  return (String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// ---------------------------------------------------------------------------
// Corpus builders — pure(ish) helpers, each returns { source, heading, text }[]
// ---------------------------------------------------------------------------

const CHUNK_MIN = 400;
const CHUNK_MAX = 800;
const MAX_FILE_BYTES = 100 * 1024; // skip files larger than ~100KB
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".featureboard", "coverage"]);

/**
 * Split a markdown document into ~400-800 char chunks. We break on headings
 * (lines starting with #) and on blank-line paragraph groups, then greedily
 * pack paragraphs up to CHUNK_MAX, carrying the nearest preceding heading onto
 * each chunk so a hit can be traced back to its section.
 */
export function chunkMarkdown(text, source) {
  const chunks = [];
  const lines = String(text || "").split(/\r?\n/);
  let heading = "";
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    // If a single paragraph group is huge, hard-split it on char length.
    if (body.length <= CHUNK_MAX) {
      chunks.push({ source, heading, text: body });
      return;
    }
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + CHUNK_MAX, body.length);
      if (end < body.length) {
        const nextSpace = body.lastIndexOf(" ", end);
        if (nextSpace > start + CHUNK_MIN) end = nextSpace;
      }
      chunks.push({ source, heading, text: body.slice(start, end).trim() });
      start = end;
    }
  };

  let acc = "";
  for (const raw of lines) {
    const line = raw;
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      // A heading closes the current chunk and starts a new section.
      if (acc.trim()) { buf.push(acc.trim()); acc = ""; }
      flush();
      heading = headingMatch[2].trim();
      continue;
    }
    if (line.trim() === "") {
      // Paragraph boundary: append the paragraph, flush once we're big enough.
      if (acc.trim()) buf.push(acc.trim());
      acc = "";
      const packed = buf.join("\n");
      if (packed.length >= CHUNK_MIN) flush();
      continue;
    }
    acc += (acc ? "\n" : "") + line;
  }
  if (acc.trim()) buf.push(acc.trim());
  flush();
  return chunks;
}

/** Split "---\nfrontmatter\n---\nbody" -> { title, content }; tolerant of hand-edits. */
function parseKbDoc(raw, fallback) {
  if (raw == null) return null;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: fallback, content: raw };
  const titleM = m[1].match(/^title:\s*(.*)$/m);
  return { title: titleM ? titleM[1].trim() : fallback, content: m[2] };
}

/** Read the project's codeLocation from its config files WITHOUT importing metadata.js. */
function readCodeLocation(board, project) {
  const dir = board.projectDir(project);
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const managed = read(path.join(dir, ".featureboard.config.json"));
  if (managed && managed.codeLocation) return managed.codeLocation;
  const legacy = read(path.join(dir, "project_config.json"));
  if (legacy && legacy.codeLocation) return legacy.codeLocation;
  return null;
}

/** Collect kb/ docs of a project as chunk records (source = kb/<slug>). */
function kbChunks(board, project, fingerprintParts) {
  const dir = path.join(board.projectDir(project), "kb");
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const p = path.join(dir, f);
    let stat, raw;
    try {
      stat = fs.statSync(p);
      if (stat.size > MAX_FILE_BYTES) continue;
      raw = fs.readFileSync(p, "utf8");
    } catch { continue; }
    fingerprintParts.push(`kb/${f}:${stat.mtimeMs}:${stat.size}`);
    const slug = f.replace(/\.md$/, "");
    const doc = parseKbDoc(raw, slug);
    const source = `kb/${slug}`;
    // Prepend the title so a title-only match still ranks.
    for (const c of chunkMarkdown(`# ${doc.title}\n\n${doc.content}`, source)) out.push(c);
  }
  return out;
}

/** Recursively collect *.md under docs/ (+ root README) of the code repo. */
function docsChunks(codeLocation, fingerprintParts) {
  const out = [];
  if (!codeLocation) return out;
  const roots = [];
  const docsDir = path.join(codeLocation, "docs");
  if (safeIsDir(docsDir)) roots.push(docsDir);

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        addFile(full);
      }
    }
  };
  const addFile = (full) => {
    let stat, raw;
    try {
      stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) return;
      raw = fs.readFileSync(full, "utf8");
    } catch { return; }
    const source = path.relative(codeLocation, full).replace(/\\/g, "/");
    fingerprintParts.push(`${source}:${stat.mtimeMs}:${stat.size}`);
    for (const c of chunkMarkdown(raw, source)) out.push(c);
  };

  for (const r of roots) walk(r);
  // Root README (README.md / Readme.md, case-insensitive), not under docs/.
  try {
    for (const name of fs.readdirSync(codeLocation)) {
      if (/^readme\.md$/i.test(name)) { addFile(path.join(codeLocation, name)); break; }
    }
  } catch {}
  return out;
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Done tickets' title + completionSummary as chunk records (source = ticket id). */
function doneTicketChunks(board, project, fingerprintParts) {
  const out = [];
  let tasks;
  try { tasks = board.listTasks(project, {}); } catch { return out; }
  let doneCount = 0;
  for (const t of tasks) {
    if (t.status !== "Done") continue;
    const summary = (t.completionSummary || "").trim();
    if (!summary && !(t.title || "").trim()) continue;
    doneCount++;
    const text = `${t.title || ""}${summary ? `. ${summary}` : ""}`.trim();
    out.push({ source: t.ticketNumber || "ticket", heading: t.title || "", text });
  }
  fingerprintParts.push(`done:${doneCount}`);
  return out;
}

// ---------------------------------------------------------------------------
// BM25 index
// ---------------------------------------------------------------------------

const indexCache = new Map(); // "<dataDir>\0<project>" -> built index

// Key by the board's absolute data dir AND the project so two boards that share
// a project name (e.g. temp fixtures both called "Proj") never collide.
function cacheKeyFor(board, project) {
  return `${board.dataDir} ${project}`;
}

/**
 * Build (or return a cached) BM25 index for a project. The corpus is KB docs +
 * docs/*.md + Done ticket summaries. The built index is cached in memory keyed
 * by board+project and only rebuilt when a cheap mtime/count fingerprint changes.
 */
export function buildIndex(board, project, opts = {}) {
  const codeLocation = opts.codeLocation !== undefined ? opts.codeLocation : readCodeLocation(board, project);
  const fingerprintParts = [];
  const chunks = [
    ...kbChunks(board, project, fingerprintParts),
    ...docsChunks(codeLocation, fingerprintParts),
    ...doneTicketChunks(board, project, fingerprintParts),
  ];
  const fingerprint = fingerprintParts.sort().join("|");

  const cacheKey = cacheKeyFor(board, project);
  const cached = indexCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached;

  // Tokenize each chunk; accumulate document frequencies for IDF.
  const docs = chunks.map((c) => {
    const terms = tokenize(`${c.heading} ${c.text}`);
    const tf = new Map();
    for (const w of terms) tf.set(w, (tf.get(w) || 0) + 1);
    return { ...c, tf, length: terms.length };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  const avgdl = N ? docs.reduce((s, d) => s + d.length, 0) / N : 0;

  const index = { project, fingerprint, docs, df, N, avgdl, k1: 1.5, b: 0.75, builtAt: Date.now() };
  indexCache.set(cacheKey, index);
  return index;
}

function scoreBM25(index, queryTerms, doc) {
  const { df, N, avgdl, k1, b } = index;
  let score = 0;
  for (const q of queryTerms) {
    const f = doc.tf.get(q);
    if (!f) continue;
    const n = df.get(q) || 0;
    // Okapi BM25 IDF (with +1 inside the log so it stays non-negative).
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const denom = f + k1 * (1 - b + (b * doc.length) / (avgdl || 1));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return score;
}

/**
 * Rank the index's chunks against a query, returning the top-k
 * [{ score, source, heading, text }]. `opts.exclude` is a set/array of source
 * ids to drop from the results (used to exclude a ticket's own research brief
 * when it's already attached to the packet as researchBrief).
 */
export function search(index, query, k = 5, opts = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index || !index.docs.length) return [];
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
  const scored = [];
  for (const doc of index.docs) {
    if (exclude.has(doc.source)) continue;
    const score = scoreBM25(index, terms, doc);
    if (score > 0) scored.push({ score, source: doc.source, heading: doc.heading, text: doc.text });
  }
  scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
  return scored.slice(0, Math.max(0, k));
}

/**
 * Convenience: build (cached) the project's index and search it in one call.
 * Rounds scores to 4dp for stable, compact output.
 */
export function ragSearch(board, project, query, opts = {}) {
  const k = opts.k != null ? opts.k : 5;
  const index = buildIndex(board, project, { codeLocation: opts.codeLocation });
  return search(index, query, k, { exclude: opts.exclude }).map((r) => ({
    score: Math.round(r.score * 10000) / 10000,
    source: r.source,
    heading: r.heading,
    text: r.text,
  }));
}

/** Test/maintenance hook: drop the in-memory index cache (all projects, or one by name). */
export function clearIndexCache(project) {
  if (!project) { indexCache.clear(); return; }
  for (const key of [...indexCache.keys()]) {
    if (key.endsWith(`\u0000${project}`)) indexCache.delete(key);
  }
}
