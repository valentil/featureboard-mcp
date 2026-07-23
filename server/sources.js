/**
 * FeatureBoard research sources library (FBMCPF-335).
 *
 * A per-project store of the RAW research material — papers, articles,
 * references — kept as small, organized markdown files ON OUR SIDE, distinct
 * from the SYNTHESIZED findings that live in kb/ (kb.js) and the per-ticket
 * research briefs (research.js). Each source is one file:
 *
 *   <projectDir>/sources/<slug>.md
 *
 *   ---
 *   title: <human title>
 *   source: <author / publication / origin>
 *   url: <where it came from>
 *   ticket: <linked ticket id, optional>
 *   tags: a, b, c
 *   addedAt: <ISO>
 *   updatedAt: <ISO>
 *   ---
 *   <the raw text of the paper / article, organized>
 *
 * The body is indexed into the local RAG (rag.js → sourceChunks, label
 * "source/<slug>") so the raw material is searchable and grounds work packets
 * alongside kb docs. Keeping sources separate from kb/ means retrieval can tell
 * "our note about X" apart from "the paper X came from".
 *
 * IMPORTANT (no import cycle): like kb.js this module imports ONLY node builtins
 * plus kb.js's pure slugify helper. The Board + projectDir come in through
 * arguments, so metadata.js/rag.js may read the sources/ folder directly without
 * importing this module.
 */

import fs from "node:fs";
import path from "node:path";
import { slugify } from "./kb.js";
import { ingestUrl, ingestFile } from "./ingest.js";

function readFileSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Directory that holds a project's raw source files. */
function sourcesDir(board, project) {
  return path.join(board.projectDir(project), "sources");
}

function listSlugFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

/** Normalize a tags value (array or comma string) into a clean string[]. */
function normalizeTags(tags) {
  const arr = Array.isArray(tags)
    ? tags
    : String(tags || "").split(",");
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

/** Split "---\nfrontmatter\n---\nbody" into { fields, content }; tolerant of hand-edits. */
function parseSource(raw, fallbackSlug) {
  if (raw == null) return null;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: fallbackSlug, source: "", url: "", ticket: "", tags: [], addedAt: null, updatedAt: null, content: raw };
  const fm = m[1];
  const field = (name) => {
    const mm = fm.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
    return mm ? mm[1].trim() : "";
  };
  return {
    title: field("title") || fallbackSlug,
    source: field("source"),
    url: field("url"),
    ticket: field("ticket"),
    tags: normalizeTags(field("tags")),
    addedAt: field("addedAt") || null,
    updatedAt: field("updatedAt") || null,
    content: m[2],
  };
}

function renderSource({ title, source, url, ticket, tags, addedAt, updatedAt, content }) {
  return (
    `---\n` +
    `title: ${title}\n` +
    `source: ${source || ""}\n` +
    `url: ${url || ""}\n` +
    `ticket: ${ticket || ""}\n` +
    `tags: ${(tags || []).join(", ")}\n` +
    `addedAt: ${addedAt}\n` +
    `updatedAt: ${updatedAt}\n` +
    `---\n${content}`
  );
}

function excerptOf(content, len = 200) {
  const flat = String(content || "").replace(/\s+/g, " ").trim();
  return flat.length > len ? flat.slice(0, len).trim() + "…" : flat;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Add or update a raw source. The filename is slugify(title) + ".md". Calling
 * again with the SAME title (case-insensitive) updates that source in place,
 * preserving its original addedAt; a different title that slugifies to the same
 * base gets a numeric suffix instead of clobbering the original.
 */
export function addSource(board, project, opts = {}) {
  const title = String(opts.title || "").trim();
  if (!title) throw new Error("A source title is required.");
  const text = opts.text == null ? "" : String(opts.text);

  const dir = sourcesDir(board, project);
  ensureDir(dir);
  const baseSlug = slugify(title);

  let slug = baseSlug;
  const basePath = path.join(dir, `${baseSlug}.md`);
  const baseExisting = parseSource(readFileSafe(basePath), baseSlug);
  if (baseExisting && baseExisting.title.toLowerCase() !== title.toLowerCase()) {
    // Slug collision with a different source: reuse a prior suffix for this
    // exact title if one exists, else mint the next free suffix.
    let reused = null;
    for (const f of listSlugFiles(dir)) {
      const s = f.replace(/\.md$/, "");
      if (s === baseSlug) continue;
      const doc = parseSource(readFileSafe(path.join(dir, f)), s);
      if (doc && doc.title.toLowerCase() === title.toLowerCase()) { reused = s; break; }
    }
    if (reused) {
      slug = reused;
    } else {
      let n = 2;
      while (fs.existsSync(path.join(dir, `${baseSlug}-${n}.md`))) n++;
      slug = `${baseSlug}-${n}`;
    }
  }

  const p = path.join(dir, `${slug}.md`);
  const prior = parseSource(readFileSafe(p), slug);
  const created = !fs.existsSync(p);
  const now = new Date().toISOString();
  const rendered = renderSource({
    title,
    source: opts.source != null ? String(opts.source).trim() : (prior ? prior.source : ""),
    url: opts.url != null ? String(opts.url).trim() : (prior ? prior.url : ""),
    ticket: opts.ticket != null ? String(opts.ticket).trim() : (prior ? prior.ticket : ""),
    tags: opts.tags != null ? normalizeTags(opts.tags) : (prior ? prior.tags : []),
    addedAt: created ? now : (prior && prior.addedAt) || now,
    updatedAt: now,
    content: text,
  });
  atomicWrite(p, rendered);

  return { slug, title, path: p, bytes: Buffer.byteLength(rendered, "utf8"), created, updated: !created };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** List every source's metadata + a short excerpt (not the full raw text). */
export function listSources(board, project) {
  const dir = sourcesDir(board, project);
  return listSlugFiles(dir).map((f) => {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSafe(path.join(dir, f)) || "";
    const doc = parseSource(raw, slug) || { title: slug, content: "" };
    return {
      slug,
      title: doc.title,
      source: doc.source,
      url: doc.url,
      ticket: doc.ticket,
      tags: doc.tags,
      addedAt: doc.addedAt,
      updatedAt: doc.updatedAt,
      bytes: Buffer.byteLength(raw, "utf8"),
      excerpt: excerptOf(doc.content),
    };
  });
}

/** Full raw text + citation fields of one source, or null when it doesn't exist. */
export function getSource(board, project, slug) {
  const s = slugify(slug);
  const p = path.join(sourcesDir(board, project), `${s}.md`);
  const raw = readFileSafe(p);
  if (raw == null) return null;
  const doc = parseSource(raw, s);
  return {
    slug: s,
    title: doc.title,
    source: doc.source,
    url: doc.url,
    ticket: doc.ticket,
    tags: doc.tags,
    addedAt: doc.addedAt,
    updatedAt: doc.updatedAt,
    content: doc.content,
    path: p,
  };
}


// ---------------------------------------------------------------------------
// Auto-ingest (FBMCPF-336): pull the raw text from a URL or a local file, then
// store it as a source. Returns { needsText, reason } (no throw) when the text
// can't be extracted server-side, so the caller supplies text= directly.
// ---------------------------------------------------------------------------

/** Merge caller-supplied metadata over what ingestion auto-detected. */
function mergeSourceOpts(ing, opts, fallbackUrl) {
  return {
    title: opts.title || ing.title || fallbackUrl,
    text: ing.text,
    source: opts.source || ing.source,
    url: opts.url || ing.url || fallbackUrl,
    ticket: opts.ticket,
    tags: opts.tags,
  };
}

/** Fetch a URL, extract text, and store it as a source. */
export async function addSourceFromUrl(board, project, url, opts = {}, deps = {}) {
  if (!url) throw new Error("A url is required.");
  const ing = await ingestUrl(url, deps);
  if (ing.needsText) return { needsText: true, reason: ing.reason, url: ing.url || url };
  return addSource(board, project, mergeSourceOpts(ing, opts, url));
}

/** Read a local file, extract text, and store it as a source. */
export async function addSourceFromFile(board, project, filePath, opts = {}, deps = {}) {
  if (!filePath) throw new Error("A path is required.");
  const ing = await ingestFile(filePath, deps);
  if (ing.needsText) return { needsText: true, reason: ing.reason, path: filePath };
  return addSource(board, project, mergeSourceOpts(ing, { ...opts, url: opts.url }, ""));
}
