/**
 * FeatureBoard source ingestion (FBMCPF-336).
 *
 * Turns a URL or a local file into the raw TEXT that addSource stores in the
 * sources/ library (sources.js) — so "keep this paper" is one call instead of a
 * copy-paste. Design posture mirrors vectors.js:
 *
 *   - HTML / plain text / markdown extraction is ZERO-dependency: Node 18's
 *     global fetch + a small tag-stripper here. No hard dep added.
 *   - PDF text extraction rides an OPTIONAL dependency (pdfjs-dist), lazy-loaded
 *     exactly like @xenova/transformers. Absent, env-disabled, or a scanned PDF
 *     that yields no text → we return { needsText: true, reason } so the caller
 *     (the orchestrator, which can read PDFs itself) supplies text= directly.
 *   - All network / parsing entry points take an injectable `deps`
 *     ({ fetchImpl, extractPdf }) so the logic is unit-testable without egress or
 *     a real PDF.
 *
 * PRIVACY NOTE: ingestUrl performs arbitrary-URL egress from the server. That is
 * a deliberate, caller-initiated fetch (the user asked to ingest that URL), but
 * it is broader than vectors.js's single HF-CDN exception — gate with
 * FEATUREBOARD_NO_FETCH=1 to hard-off, and see docs/compliance/PRIVACY.md.
 */

import fs from "node:fs";
import path from "node:path";

const short = (e) => (e && e.message ? e.message.split("\n")[0] : String(e)).slice(0, 200);

export function fetchDisabled() {
  return /^(1|true|yes|on)$/.test(String(process.env.FEATUREBOARD_NO_FETCH || "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Zero-dependency HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", deg: "°",
};

function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, m) : m;
    }
    const key = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}
function safeFromCodePoint(code, fallback) {
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

/** Best-effort HTML → readable text. Drops script/style/noscript, turns block
 *  ends into newlines, strips remaining tags, decodes common entities, and
 *  collapses runaway whitespace. Not a full parser — deliberately dependency-free. */
export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|ul|ol|tr|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Pull <title> from an HTML document, or "" if none. */
export function htmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// PDF text — optional dependency, lazy-loaded (mirrors vectors.js)
// ---------------------------------------------------------------------------

let _pdfjs = null;
let _pdfUnavailable = null;

async function loadPdfjs() {
  if (_pdfUnavailable) return null;
  if (!_pdfjs) {
    try {
      _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    } catch (e) {
      _pdfUnavailable = `PDF extraction unavailable (${short(e)}) — install the optional dependency: npm install pdfjs-dist`;
      return null;
    }
  }
  return _pdfjs;
}

/** Test hook: reset the lazy pdfjs singleton. */
export function resetPdf() { _pdfjs = null; _pdfUnavailable = null; }

/**
 * Extract text from a PDF buffer using pdfjs-dist (optional dep). Returns
 * { ok, text, reason }; never throws. A missing dep, env-off, or a scanned PDF
 * with no text layer resolves to ok:false so callers degrade to needsText.
 * Tests may inject `deps.extractPdf(buffer) -> text` to avoid the dep.
 */
export async function extractPdfText(buffer, deps = {}) {
  if (typeof deps.extractPdf === "function") {
    try {
      const text = String((await deps.extractPdf(buffer)) || "").trim();
      return { ok: !!text, text, reason: text ? null : "injected extractor returned no text" };
    } catch (e) {
      return { ok: false, text: "", reason: `PDF parse failed (${short(e)})` };
    }
  }
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return { ok: false, text: "", reason: _pdfUnavailable || "pdfjs-dist unavailable" };
  try {
    const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const data = new Uint8Array(src);
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => (it && it.str) || "").join(" "));
    }
    try { await doc.destroy(); } catch { /* best effort */ }
    return { ok: true, text: pages.join("\n").replace(/[ \t]+/g, " ").trim(), reason: null };
  } catch (e) {
    return { ok: false, text: "", reason: `PDF parse failed (${short(e)})` };
  }
}

// ---------------------------------------------------------------------------
// Fetch + dispatch
// ---------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}
function filenameTitle(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    const base = decodeURIComponent(p.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
    return base || hostOf(url) || url;
  } catch { return url; }
}

/** Fetch a URL → { status, contentType, buffer, finalUrl }. Injectable via deps.fetchImpl. */
export async function fetchUrl(url, deps = {}) {
  if (fetchDisabled()) throw new Error("URL fetch disabled (FEATUREBOARD_NO_FETCH=1) — pass text= directly");
  const f = deps.fetchImpl || globalThis.fetch;
  if (typeof f !== "function") throw new Error("global fetch unavailable — needs Node >=18, or pass deps.fetchImpl");
  const res = await f(url, { redirect: "follow", headers: { "user-agent": "FeatureBoard-source-ingest/1.0" } });
  const contentType = String((res.headers && res.headers.get && res.headers.get("content-type")) || "").toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType, buffer, finalUrl: res.url || url };
}

const MIN_TEXT = 20; // below this we assume extraction failed (scanned PDF / JS-only page)

/**
 * Ingest a URL into { title, text, source, url, contentType }, or
 * { needsText: true, reason, url } when text couldn't be extracted server-side.
 */
export async function ingestUrl(url, deps = {}) {
  const r = await fetchUrl(url, deps);
  if (r.status >= 400) throw new Error(`fetch ${url} failed: HTTP ${r.status}`);
  const ct = r.contentType;
  const isPdf = ct.includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(url);

  if (isPdf) {
    const p = await extractPdfText(r.buffer, deps);
    if (!p.ok || p.text.length < MIN_TEXT) {
      return { needsText: true, reason: p.reason || "PDF yielded no extractable text (scanned?) — read it and pass text= directly", url: r.finalUrl, contentType: ct };
    }
    return { title: filenameTitle(url), text: p.text, source: hostOf(url), url: r.finalUrl, contentType: ct };
  }

  const body = r.buffer.toString("utf8");
  const looksHtml = ct.includes("html") || /^\s*<(?:!doctype|html|head|body)/i.test(body);
  if (looksHtml) {
    const text = htmlToText(body);
    if (text.length < MIN_TEXT) {
      return { needsText: true, reason: "no extractable text from the HTML (JS-rendered?) — read it and pass text= directly", url: r.finalUrl, contentType: ct };
    }
    return { title: htmlTitle(body) || filenameTitle(url), text, source: hostOf(url), url: r.finalUrl, contentType: ct };
  }

  // text/plain, markdown, csv, anything utf8-ish.
  const text = body.trim();
  if (text.length < MIN_TEXT) {
    return { needsText: true, reason: `unrecognized/empty content (${ct || "no content-type"}) — pass text= directly`, url: r.finalUrl, contentType: ct };
  }
  return { title: filenameTitle(url), text, source: hostOf(url), url: r.finalUrl, contentType: ct };
}

/**
 * Ingest a local file into { title, text, source }, or { needsText, reason }
 * for a PDF that couldn't be parsed. .html/.htm → stripped; .pdf → pdf-parse;
 * everything else read as utf8 text.
 */
export async function ingestFile(filePath, deps = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext);

  if (ext === ".pdf") {
    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) { throw new Error(`cannot read ${filePath}: ${short(e)}`); }
    const p = await extractPdfText(buf, deps);
    if (!p.ok || p.text.length < MIN_TEXT) {
      return { needsText: true, reason: p.reason || "PDF yielded no extractable text (scanned?) — pass text= directly", path: filePath };
    }
    return { title: base, text: p.text, source: filePath };
  }

  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { throw new Error(`cannot read ${filePath}: ${short(e)}`); }
  if (ext === ".html" || ext === ".htm") {
    return { title: htmlTitle(raw) || base, text: htmlToText(raw), source: filePath };
  }
  return { title: base, text: raw.trim(), source: filePath };
}
