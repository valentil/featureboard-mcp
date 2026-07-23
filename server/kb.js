/**
 * FeatureBoard v0.3 project knowledge base (FBMCPF-141).
 *
 * Beyond the scratchpad: a per-project kb/ folder of markdown docs the agent
 * (or a human) can add to over time — architecture notes, glossary entries,
 * gotchas, whatever is worth remembering across tickets. Docs are plain
 * markdown files with a tiny frontmatter header, one file per doc:
 *
 *   <projectDir>/kb/<slug>.md
 *
 *   ---
 *   title: <original title>
 *   updatedAt: <ISO timestamp>
 *   ---
 *   <markdown body>
 *
 * `search_kb` does simple keyword ranking (title hits weighted above content
 * hits) and get_work_packet uses the same matcher to inject the top few docs
 * relevant to a ticket's title/description/labels/product, so the "living
 * knowledge" surfaces automatically without a graph database.
 *
 * IMPORTANT (no import cycle): this module imports ONLY node builtins,
 * mirroring requirements.js/decisions.js/handoffs.js — the Board and its
 * projectDir are passed in through arguments, so metadata.js may safely
 * import THIS module for work-packet injection without creating a
 * require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Directory that holds a project's kb doc files. */
function kbDir(board, project) {
  return path.join(board.projectDir(project), "kb");
}

/** Slugify a title into a filesystem-safe, URL-safe doc id. */
export function slugify(title) {
  const s = String(title || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "doc";
}

function listSlugFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

/** Split "---\nfrontmatter\n---\nbody" into { title, updatedAt, content }; tolerant of hand-edits. */
function parseDoc(raw, fallbackSlug) {
  if (raw == null) return null;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: fallbackSlug, updatedAt: null, content: raw };
  const fm = m[1];
  const titleM = fm.match(/^title:\s*(.*)$/m);
  const updatedM = fm.match(/^updatedAt:\s*(.*)$/m);
  return {
    title: titleM ? titleM[1].trim() : fallbackSlug,
    updatedAt: updatedM ? updatedM[1].trim() : null,
    content: m[2],
  };
}

function renderDoc({ title, updatedAt, content }) {
  return `---\ntitle: ${title}\nupdatedAt: ${updatedAt}\n---\n${content}`;
}

function excerptOf(content, len = 160) {
  const flat = String(content || "").replace(/\s+/g, " ").trim();
  return flat.length > len ? flat.slice(0, len).trim() + "…" : flat;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Add or update a kb doc. The filename is `slugify(title)` + ".md". Calling
 * again with the SAME title (case-insensitive) updates that doc in place
 * (overwrite). Calling with a DIFFERENT title that happens to slugify to the
 * same base (e.g. "Hello, World!" and "Hello World?") does not clobber the
 * existing doc — it gets a numeric suffix (-2, -3, ...), and re-adding that
 * second title later reuses its own already-assigned slug rather than
 * drifting to a new suffix each time.
 */
export function addKbDoc(board, project, title, content, opts = {}) {
  const t = String(title || "").trim();
  if (!t) throw new Error("A kb doc title is required.");
  const body = content == null ? "" : String(content);

  const dir = kbDir(board, project);
  ensureDir(dir);
  const baseSlug = slugify(t);

  let slug = baseSlug;
  const basePath = path.join(dir, `${baseSlug}.md`);
  const baseExisting = parseDoc(readFileSafe(basePath), baseSlug);
  if (baseExisting && baseExisting.title.toLowerCase() !== t.toLowerCase()) {
    // Slug collision with a different doc. Reuse a prior suffix assigned to
    // this same title if one exists; otherwise mint the next free suffix.
    let reused = null;
    for (const f of listSlugFiles(dir)) {
      const s = f.replace(/\.md$/, "");
      if (s === baseSlug) continue;
      const doc = parseDoc(readFileSafe(path.join(dir, f)), s);
      if (doc && doc.title.toLowerCase() === t.toLowerCase()) {
        reused = s;
        break;
      }
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
  const created = !fs.existsSync(p);
  const updatedAt = new Date().toISOString();
  const rendered = renderDoc({ title: t, updatedAt, content: body });
  atomicWrite(p, rendered);

  return { slug, title: t, path: p, bytes: Buffer.byteLength(rendered, "utf8"), created, updated: !created };
}

/**
 * Append to a kb doc's body, creating it if absent. Unlike addKbDoc (which
 * overwrites), this preserves the existing body and adds `content` after it
 * (separated by a blank line), then bumps updatedAt. This is the durable,
 * always-indexed "capture as you go" primitive behind append_research
 * (FBMCPF-333) — so findings accrue in kb/ instead of the ephemeral scratchpad.
 * Matching is by title (case-insensitive); a same-slug doc with a DIFFERENT
 * title is treated as absent so we never append into the wrong doc.
 */
export function appendKbDoc(board, project, title, content, opts = {}) {
  const t = String(title || "").trim();
  if (!t) throw new Error("A kb doc title is required.");
  const addition = content == null ? "" : String(content);

  const existing = getKbDoc(board, project, t);
  const match = existing && String(existing.title || "").toLowerCase() === t.toLowerCase();
  let body = addition;
  if (match) {
    const sep = opts.separator != null ? opts.separator : "\n\n";
    const prev = String(existing.content || "").replace(/\s+$/, "");
    body = prev ? `${prev}${sep}${addition}` : addition;
  }
  const res = addKbDoc(board, project, t, body);
  return { ...res, created: !match, appended: !!match };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** List every kb doc's metadata + a short excerpt (not the full body). */
export function listKbDocs(board, project) {
  const dir = kbDir(board, project);
  return listSlugFiles(dir).map((f) => {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSafe(path.join(dir, f)) || "";
    const doc = parseDoc(raw, slug) || { title: slug, updatedAt: null, content: "" };
    return {
      slug,
      title: doc.title,
      updatedAt: doc.updatedAt,
      bytes: Buffer.byteLength(raw, "utf8"),
      excerpt: excerptOf(doc.content),
    };
  });
}

/** Full content of one kb doc, or null when it doesn't exist. */
export function getKbDoc(board, project, slug) {
  const s = slugify(slug);
  const dir = kbDir(board, project);
  const p = path.join(dir, `${s}.md`);
  const raw = readFileSafe(p);
  if (raw == null) return null;
  const doc = parseDoc(raw, s);
  return { slug: s, title: doc.title, updatedAt: doc.updatedAt, content: doc.content, path: p };
}

// ---------------------------------------------------------------------------
// Search — simple keyword ranking, title hits weighted above content hits
// ---------------------------------------------------------------------------

function tokenize(s) {
  return (String(s || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
}

function countOccurrences(haystackLower, term) {
  const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "g");
  const m = haystackLower.match(re);
  return m ? m.length : 0;
}

function excerptAround(content, terms, radius = 100) {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`);
    const m = lower.match(re);
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  if (idx === -1) return excerptOf(content, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + radius);
  let excerpt = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) excerpt = "…" + excerpt;
  if (end < content.length) excerpt += "…";
  return excerpt;
}

/**
 * Keyword search across kb doc titles + content, ranked by weighted hit
 * count (title hits count 5x a content hit). Returns [] for an empty/blank
 * query or when nothing matches. Each result carries a short excerpt around
 * the first matched term (or the doc's start, if only the title matched) and
 * the doc's on-disk path.
 */
export function searchKb(board, project, query, opts = {}) {
  const limit = opts.limit != null ? opts.limit : 10;
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const dir = kbDir(board, project);
  const scored = [];
  for (const f of listSlugFiles(dir)) {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSafe(path.join(dir, f)) || "";
    const doc = parseDoc(raw, slug);
    if (!doc) continue;
    const titleLower = doc.title.toLowerCase();
    const contentLower = doc.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += countOccurrences(titleLower, term) * 5;
      score += countOccurrences(contentLower, term);
    }
    if (score > 0) {
      scored.push({
        slug,
        title: doc.title,
        score,
        excerpt: excerptAround(doc.content, terms),
        path: path.join(dir, f),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, limit);
}

/**
 * Convenience matcher used by get_work_packet: build a query from a ticket's
 * title/description/labels/product and return the top few kb docs, with
 * excerpts truncated further so packets stay lean. Returns [] when the
 * project has no kb docs or nothing matches.
 */
export function matchKbForTicket(board, project, task, opts = {}) {
  const limit = opts.limit != null ? opts.limit : 3;
  const excerptLen = opts.excerptLen != null ? opts.excerptLen : 160;
  const query = [task.title, task.description, (task.labels || []).join(" "), task.product]
    .filter(Boolean)
    .join(" ");
  if (!query.trim()) return [];
  const hits = searchKb(board, project, query, { limit });
  return hits.map((h) => ({
    slug: h.slug,
    title: h.title,
    excerpt: h.excerpt.length > excerptLen ? h.excerpt.slice(0, excerptLen).trim() + "…" : h.excerpt,
    path: h.path,
  }));
}
