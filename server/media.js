/**
 * FeatureBoard media gallery (FBMCPF-38/39/40).
 *
 * The original OpenClaw app kept a per-project media area (generated images and
 * shareable HTML reports) with metadata and revision history. Ported AI-natively,
 * the store is just a `media/` folder inside each board:
 *
 *   <project>/media/
 *     revenue-q3.png
 *     revenue-q3.png.meta.json     # sidecar: { title, prompt, tags, ticket, generatedAt }
 *     launch-report.html
 *     .versions/                   # prior revisions, archived on overwrite
 *       launch-report.html/
 *         20260713T190000.html
 *         20260713T190000.meta.json
 *
 * `listMedia` enumerates current assets; `saveMedia` writes an asset + sidecar and
 * archives any prior copy into .versions/; `getMedia` views an asset (or a specific
 * version) with content + its revision list; `revertMedia` restores a prior version
 * (archiving the current one first, so revert is itself undoable). The sidecar +
 * versions layout keeps everything on disk with no database. Pure helpers are
 * exported for unit testing.
 */

import fs from "node:fs";
import path from "node:path";

export const MEDIA_DIR = "media";
export const META_SUFFIX = ".meta.json";
export const VERSIONS_DIR = ".versions";
export const UPLOADS_DIR = "uploads";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);
const REPORT_EXTS = new Set([".html", ".htm"]);
const TEXT_EXTS = new Set([".html", ".htm", ".svg", ".txt", ".json", ".md", ".csv", ".xml"]);

/** Classify an asset filename into a media kind + normalized extension. */
export function classifyAsset(filename) {
  const ext = path.extname(filename).toLowerCase();
  let kind = "other";
  if (IMAGE_EXTS.has(ext)) kind = "image";
  else if (REPORT_EXTS.has(ext)) kind = "report";
  return { ext, kind };
}

/** True for assets whose bytes are UTF-8 text (safe to return inline). */
export function isTextAsset(filename) {
  return TEXT_EXTS.has(path.extname(filename).toLowerCase());
}

/** True for files that are sidecars/hidden rather than gallery assets. */
export function isSidecar(filename) {
  return filename.startsWith(".") || filename.endsWith(META_SUFFIX);
}

/** Newest-first by created date, tie-broken by name for stable ordering. */
export function sortMedia(entries) {
  return entries.slice().sort((a, b) => {
    if (a.created !== b.created) return a.created < b.created ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** ISO date (YYYY-MM-DD) from a Date or epoch ms. */
function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

/** Compact UTC version id (YYYYMMDDTHHMMSS) from a Date or ISO/ms. */
function stampId(d) {
  const p = (n) => String(n).padStart(2, "0");
  const dt = d instanceof Date ? d : new Date(d);
  return (
    `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}`
  );
}

function readMetaSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic write (temp + rename); accepts a string or Buffer. */
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * Validate a media asset filename: a plain basename with an extension, no path
 * separators, not hidden, not a .meta.json sidecar. Returns the safe name.
 */
export function sanitizeAssetName(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("media name is required");
  const n = name.trim();
  if (n !== path.basename(n) || n.includes("/") || n.includes("\\") || n.startsWith(".")) {
    throw new Error(`invalid media name (use a plain filename with an extension): ${name}`);
  }
  if (n.endsWith(META_SUFFIX)) throw new Error("media name must not end with .meta.json (that's the sidecar)");
  if (!path.extname(n)) throw new Error("media name needs a file extension, e.g. report.html or chart.png");
  return n;
}

/** Build the sidecar metadata object for a generated asset. */
export function buildMetaSidecar(fields = {}, now = new Date()) {
  const meta = {};
  if (fields.title) meta.title = String(fields.title);
  if (fields.prompt) meta.prompt = String(fields.prompt);
  if (Array.isArray(fields.tags) && fields.tags.length) meta.tags = fields.tags.map(String);
  if (fields.ticket) meta.ticket = String(fields.ticket);
  meta.generatedAt = now.toISOString();
  return meta;
}

/**
 * Archive an existing asset (+ its sidecar) into media/.versions/<name>/ keyed by
 * the copy's own generatedAt (or mtime). Returns the version id, or null if there
 * was nothing to archive.
 */
function archiveExisting(mediaDir, name, now = new Date()) {
  const assetPath = path.join(mediaDir, name);
  if (!fs.existsSync(assetPath)) return null;
  const metaPath = assetPath + META_SUFFIX;
  const curMeta = readMetaSafe(metaPath);
  const when = curMeta && curMeta.generatedAt ? new Date(curMeta.generatedAt) : fs.statSync(assetPath).mtime;
  const vdir = path.join(mediaDir, VERSIONS_DIR, name);
  fs.mkdirSync(vdir, { recursive: true });
  const ext = path.extname(name);
  let id = stampId(when);
  let n = 1;
  while (fs.existsSync(path.join(vdir, `${id}${ext}`))) {
    n += 1;
    id = `${stampId(when)}-${n}`;
  }
  fs.renameSync(assetPath, path.join(vdir, `${id}${ext}`));
  if (fs.existsSync(metaPath)) fs.renameSync(metaPath, path.join(vdir, `${id}.meta.json`));
  return id;
}

/**
 * Persist a generated asset (Claude is the generator) into <project>/media/,
 * archiving any prior copy into .versions/ first, then writing the bytes plus a
 * <name>.meta.json sidecar. `content` is UTF-8 text by default, or base64 when
 * encoding:"base64" (for images). Returns the new entry.
 */
export function saveMedia(board, project, args = {}, { now = new Date() } = {}) {
  const { name, content, encoding = "utf8", title, prompt, tags, ticket } = args;
  const safe = sanitizeAssetName(name);
  if (typeof content !== "string") throw new Error("content must be a string (text, or base64 for images)");
  if (encoding !== "utf8" && encoding !== "base64") throw new Error("encoding must be 'utf8' or 'base64'");

  const dir = path.join(board.projectDir(project), MEDIA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const archivedVersion = archiveExisting(dir, safe, now);

  const assetPath = path.join(dir, safe);
  const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  atomicWrite(assetPath, buf);

  const meta = buildMetaSidecar({ title, prompt, tags, ticket }, now);
  atomicWrite(assetPath + META_SUFFIX, JSON.stringify(meta, null, 2) + "\n");

  const cls = classifyAsset(safe);
  return {
    project,
    name: safe,
    kind: cls.kind,
    ext: cls.ext,
    sizeBytes: buf.length,
    relPath: `${MEDIA_DIR}/${safe}`,
    savedAt: meta.generatedAt,
    archivedVersion,
    meta,
  };
}

/**
 * List prior revisions of an asset (newest-first): version id, savedAt, title,
 * prompt, size. Empty array if the asset has no history.
 */
export function listVersions(board, project, name) {
  const safe = sanitizeAssetName(name);
  const vdir = path.join(board.projectDir(project), MEDIA_DIR, VERSIONS_DIR, safe);
  let entries;
  try {
    entries = fs.readdirSync(vdir);
  } catch {
    return [];
  }
  const ext = path.extname(safe);
  const out = [];
  for (const f of entries) {
    if (f.endsWith(META_SUFFIX) || !f.endsWith(ext)) continue;
    const id = f.slice(0, -ext.length);
    const meta = readMetaSafe(path.join(vdir, `${id}.meta.json`));
    let size = null;
    try {
      size = fs.statSync(path.join(vdir, f)).size;
    } catch {
      /* ignore */
    }
    out.push({
      version: id,
      savedAt: (meta && meta.generatedAt) || null,
      title: (meta && meta.title) || null,
      prompt: (meta && meta.prompt) || null,
      sizeBytes: size,
    });
  }
  return out.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
}

/**
 * View an asset (or a specific archived version): metadata, size, its revision
 * list, and — when withContent — the bytes (UTF-8 for text assets, base64 for
 * images). Throws if the asset (or version) is missing.
 */
export function getMedia(board, project, name, { version, withContent = true } = {}) {
  const safe = sanitizeAssetName(name);
  const mediaDir = path.join(board.projectDir(project), MEDIA_DIR);
  const ext = path.extname(safe);
  let assetPath;
  let metaPath;
  if (version) {
    const vdir = path.join(mediaDir, VERSIONS_DIR, safe);
    assetPath = path.join(vdir, `${version}${ext}`);
    metaPath = path.join(vdir, `${version}.meta.json`);
  } else {
    assetPath = path.join(mediaDir, safe);
    metaPath = assetPath + META_SUFFIX;
  }
  if (!fs.existsSync(assetPath)) {
    throw new Error(version ? `version ${version} of ${safe} not found` : `media asset not found: ${safe}`);
  }
  const stat = fs.statSync(assetPath);
  const meta = readMetaSafe(metaPath);
  const cls = classifyAsset(safe);
  const res = {
    project,
    name: safe,
    version: version || null,
    kind: cls.kind,
    ext: cls.ext,
    sizeBytes: stat.size,
    modified: isoDate(stat.mtimeMs),
    title: (meta && meta.title) || safe,
    tags: (meta && Array.isArray(meta.tags) && meta.tags) || [],
    annotations: (meta && Array.isArray(meta.annotations) && meta.annotations) || [],
    meta: meta || null,
    versions: listVersions(board, project, safe),
  };
  if (withContent) {
    const buf = fs.readFileSync(assetPath);
    if (isTextAsset(safe)) {
      res.encoding = "utf8";
      res.content = buf.toString("utf8");
    } else {
      res.encoding = "base64";
      res.content = buf.toString("base64");
    }
  }
  return res;
}

/**
 * Restore a prior version as the current asset. The current copy is archived first
 * (so the revert can itself be undone); the restored sidecar records revertedFrom.
 */
export function revertMedia(board, project, name, version, { now = new Date() } = {}) {
  const safe = sanitizeAssetName(name);
  if (!version) throw new Error("version is required to revert");
  const mediaDir = path.join(board.projectDir(project), MEDIA_DIR);
  const ext = path.extname(safe);
  const vdir = path.join(mediaDir, VERSIONS_DIR, safe);
  const vAsset = path.join(vdir, `${version}${ext}`);
  if (!fs.existsSync(vAsset)) throw new Error(`version ${version} of ${safe} not found`);

  const archivedVersion = archiveExisting(mediaDir, safe, now);
  const buf = fs.readFileSync(vAsset);
  const assetPath = path.join(mediaDir, safe);
  atomicWrite(assetPath, buf);
  const vMeta = readMetaSafe(path.join(vdir, `${version}.meta.json`)) || {};
  const newMeta = { ...vMeta, generatedAt: now.toISOString(), revertedFrom: version };
  atomicWrite(assetPath + META_SUFFIX, JSON.stringify(newMeta, null, 2) + "\n");

  return {
    project,
    name: safe,
    revertedFrom: version,
    archivedVersion,
    relPath: `${MEDIA_DIR}/${safe}`,
    meta: newMeta,
  };
}

/** Resolve a current asset's sidecar path, erroring if the asset is missing. */
function metaPathFor(board, project, name) {
  const safe = sanitizeAssetName(name);
  const assetPath = path.join(board.projectDir(project), MEDIA_DIR, safe);
  if (!fs.existsSync(assetPath)) throw new Error(`media asset not found: ${safe}`);
  return { safe, metaPath: assetPath + META_SUFFIX };
}

/**
 * Add and/or remove custom tags on an asset (sidecar only — the asset bytes and
 * its version history are untouched). Tags are de-duplicated, insertion-ordered.
 */
export function tagMedia(board, project, name, { add = [], remove = [] } = {}) {
  const { safe, metaPath } = metaPathFor(board, project, name);
  const meta = readMetaSafe(metaPath) || {};
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
  const set = new Set(tags);
  for (const t of add) if (t != null && String(t).trim()) set.add(String(t).trim());
  for (const t of remove) set.delete(String(t));
  meta.tags = [...set];
  atomicWrite(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { name: safe, tags: meta.tags };
}

/**
 * Add a pin-based annotation/comment to an asset. Optional x/y locate the pin
 * (e.g. 0-1 relative coords on an image/report). Ids are monotonic per asset so
 * they stay unique even after removals.
 */
export function annotateMedia(board, project, name, { x, y, text, author } = {}, { now = new Date() } = {}) {
  if (!text || !String(text).trim()) throw new Error("annotation text is required");
  const { safe, metaPath } = metaPathFor(board, project, name);
  const meta = readMetaSafe(metaPath) || {};
  const anns = Array.isArray(meta.annotations) ? meta.annotations : [];
  const seq = (meta.annotationSeq || 0) + 1;
  const ann = { id: `a${seq}`, text: String(text), createdAt: now.toISOString() };
  if (typeof x === "number") ann.x = x;
  if (typeof y === "number") ann.y = y;
  if (author) ann.author = String(author);
  anns.push(ann);
  meta.annotations = anns;
  meta.annotationSeq = seq;
  atomicWrite(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { name: safe, annotation: ann, count: anns.length };
}

/** Remove an annotation by id. Throws if the id isn't present. */
export function removeAnnotation(board, project, name, id) {
  const { safe, metaPath } = metaPathFor(board, project, name);
  const meta = readMetaSafe(metaPath) || {};
  const anns = Array.isArray(meta.annotations) ? meta.annotations : [];
  const next = anns.filter((a) => a.id !== id);
  if (next.length === anns.length) throw new Error(`annotation ${id} not found on ${safe}`);
  meta.annotations = next;
  atomicWrite(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { name: safe, removed: id, count: next.length };
}

/**
 * Search/filter a project's gallery: by kind, by exact tag, and/or a free-text
 * query matched across name, title, tags, and the generation prompt.
 */
export function searchMedia(board, project, { query, tag, kind } = {}) {
  const { assets } = listMedia(board, project, kind ? { kind } : {});
  const q = query ? String(query).toLowerCase() : null;
  const out = assets.filter((a) => {
    if (tag && !(Array.isArray(a.tags) && a.tags.includes(tag))) return false;
    if (q) {
      const hay = [a.name, a.title, (a.tags || []).join(" "), (a.meta && a.meta.prompt) || ""]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { project, count: out.length, query: query || null, tag: tag || null, kind: kind || null, assets: out };
}

/**
 * Save a reference/source image under media/uploads/ (base64 by default). These
 * are inputs for generation (FBMCPF-86), kept separate from generated assets so
 * they don't clutter the gallery. Returns the saved path.
 */
export function saveUpload(board, project, { name, content, encoding = "base64" } = {}) {
  const safe = sanitizeAssetName(name);
  if (typeof content !== "string") throw new Error("content must be a string (base64, or utf8)");
  if (encoding !== "base64" && encoding !== "utf8") throw new Error("encoding must be 'base64' or 'utf8'");
  const dir = path.join(board.projectDir(project), MEDIA_DIR, UPLOADS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  atomicWrite(path.join(dir, safe), buf);
  return { project, name: safe, relPath: `${MEDIA_DIR}/${UPLOADS_DIR}/${safe}`, sizeBytes: buf.length };
}

/** List reference/source uploads under media/uploads/. */
export function listUploads(board, project) {
  const dir = path.join(board.projectDir(project), MEDIA_DIR, UPLOADS_DIR);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { project, count: 0, uploads: [] };
  }
  const uploads = files
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      let size = null;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
      return { name: f, relPath: `${MEDIA_DIR}/${UPLOADS_DIR}/${f}`, sizeBytes: size };
    });
  return { project, count: uploads.length, uploads };
}

/**
 * Edit an existing text/report asset in place (find/replace, append, prepend) and
 * save the result as a new version (the prior copy is archived — FBMCPF-40). For
 * images use refine_media or image generation. Ports edit-media as a direct,
 * deterministic transform of a specific file.
 */
export function editMediaText(board, project, name, { find, replace, append, prepend } = {}, { now = new Date() } = {}) {
  const safe = sanitizeAssetName(name);
  if (!isTextAsset(safe)) {
    throw new Error(`edit_media edits text assets (html/svg/txt/md/…); use refine_media or image generation for ${safe}`);
  }
  if (find == null && !append && !prepend) throw new Error("provide find (with replace), append, or prepend");
  const cur = getMedia(board, project, safe, { withContent: true });
  let content = String(cur.content || "");
  if (find != null) {
    const f = String(find);
    if (!content.includes(f)) throw new Error(`text to replace not found in ${safe}`);
    content = content.split(f).join(replace != null ? String(replace) : "");
  }
  if (prepend) content = String(prepend) + content;
  if (append) content = content + String(append);
  const meta = cur.meta || {};
  const editDesc = find != null ? `replace "${find}"` : append && prepend ? "prepend+append" : append ? "append" : "prepend";
  return saveMedia(
    board,
    project,
    { name: safe, content, encoding: "utf8", title: meta.title, prompt: `edit: ${editDesc}`, tags: meta.tags, ticket: meta.ticket },
    { now }
  );
}

/**
 * List a project's media assets with metadata. Returns { project, count, assets }.
 * Missing media/ folder yields an empty gallery rather than an error.
 */
export function listMedia(board, project, { kind } = {}) {
  const dir = path.join(board.projectDir(project), MEDIA_DIR);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { project, count: 0, mediaDir: dir, assets: [] };
  }

  const assets = [];
  for (const ent of names) {
    if (!ent.isFile() || isSidecar(ent.name)) continue;
    const cls = classifyAsset(ent.name);
    const full = path.join(dir, ent.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const meta = readMetaSafe(full + META_SUFFIX);
    const createdMs = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    assets.push({
      name: ent.name,
      kind: cls.kind,
      ext: cls.ext,
      sizeBytes: stat.size,
      created: isoDate(createdMs),
      modified: isoDate(stat.mtimeMs),
      title: (meta && meta.title) || ent.name,
      tags: (meta && Array.isArray(meta.tags) && meta.tags) || [],
      ticket: (meta && meta.ticket) || null,
      hasMeta: !!meta,
      meta: meta || null,
      relPath: `${MEDIA_DIR}/${ent.name}`,
    });
  }

  const filtered = kind ? assets.filter((a) => a.kind === kind) : assets;
  return { project, count: filtered.length, mediaDir: dir, assets: sortMedia(filtered) };
}
