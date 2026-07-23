import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  htmlToText, htmlTitle, ingestUrl, ingestFile, fetchDisabled,
} from "../server/ingest.js";

// FBMCPF-336 — source ingestion: URL/file → raw text, deps injectable so no
// network egress or real PDF is needed to test the logic.

/** Build a minimal fetch Response-like for a given body + content-type. */
function fakeFetch(body, { contentType = "text/html", status = 200, url = "https://ex.com/x" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  return async () => ({
    status,
    url,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

test("htmlToText strips scripts/styles/tags and decodes entities", () => {
  const html = "<html><head><style>b{}</style><title>T</title></head><body><h1>Hi</h1>" +
    "<p>Alpha &amp; Beta &mdash; done</p><script>evil()</script></body></html>";
  const text = htmlToText(html);
  assert.match(text, /Hi/);
  assert.match(text, /Alpha & Beta — done/);
  assert.ok(!/evil/.test(text), "script contents dropped");
  assert.ok(!/</.test(text), "no tags remain");
});

test("htmlTitle extracts and decodes the <title>", () => {
  assert.equal(htmlTitle("<title>My &mdash; Paper</title>"), "My — Paper");
  assert.equal(htmlTitle("<html><body>no title</body></html>"), "");
});

test("ingestUrl: HTML page → title + stripped text, host as source", async () => {
  const html = "<title>Collatz Notes</title><body><p>The 2-adic shift map conjugacy is a solenoid conjugacy indeed.</p></body>";
  const r = await ingestUrl("https://arxiv.org/abs/1234", { fetchImpl: fakeFetch(html, { contentType: "text/html; charset=utf-8", url: "https://arxiv.org/abs/1234" }) });
  assert.equal(r.needsText, undefined);
  assert.equal(r.title, "Collatz Notes");
  assert.equal(r.source, "arxiv.org");
  assert.match(r.text, /solenoid conjugacy/);
});

test("ingestUrl: plain text passes through verbatim", async () => {
  const r = await ingestUrl("https://ex.com/notes.txt", { fetchImpl: fakeFetch("Terras density argument for stopping times over the integers.", { contentType: "text/plain" }) });
  assert.match(r.text, /Terras density argument/);
});

test("ingestUrl: PDF uses the injected extractor", async () => {
  const r = await ingestUrl("https://ex.com/paper.pdf", {
    fetchImpl: fakeFetch(Buffer.from("%PDF-1.4 fake bytes"), { contentType: "application/pdf" }),
    extractPdf: async () => "Extracted PDF body about almost bounded values.",
  });
  assert.equal(r.needsText, undefined);
  assert.match(r.text, /almost bounded values/);
});

test("ingestUrl: scanned/empty PDF → needsText fallback (no throw)", async () => {
  const r = await ingestUrl("https://ex.com/scan.pdf", {
    fetchImpl: fakeFetch(Buffer.from("%PDF-1.4"), { contentType: "application/pdf" }),
    extractPdf: async () => "   ",
  });
  assert.equal(r.needsText, true);
  assert.match(r.reason, /extract|text/i);
});

test("ingestUrl: HTTP error throws", async () => {
  await assert.rejects(
    () => ingestUrl("https://ex.com/missing", { fetchImpl: fakeFetch("nope", { status: 404 }) }),
    /HTTP 404/,
  );
});

test("ingestFile: reads .md/.html/.txt and strips html", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbing-"));
  const md = path.join(dir, "note.md");
  fs.writeFileSync(md, "# Heading\n\nRaw markdown body about cycles.");
  const rMd = await ingestFile(md);
  assert.equal(rMd.title, "note");
  assert.match(rMd.text, /Raw markdown body about cycles/);

  const htmlPath = path.join(dir, "page.html");
  fs.writeFileSync(htmlPath, "<title>Doc</title><body><p>Hello <b>world</b> of automata.</p></body>");
  const rHtml = await ingestFile(htmlPath);
  assert.equal(rHtml.title, "Doc");
  assert.match(rHtml.text, /Hello world of automata/);
});

test("ingestFile: PDF via injected extractor, and needsText when empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbing-"));
  const pdf = path.join(dir, "paper.pdf");
  fs.writeFileSync(pdf, Buffer.from("%PDF-1.4 bytes"));
  const good = await ingestFile(pdf, { extractPdf: async () => "Full paper text about transcendence and cycles." });
  assert.equal(good.title, "paper");
  assert.match(good.text, /transcendence and cycles/);

  const empty = await ingestFile(pdf, { extractPdf: async () => "" });
  assert.equal(empty.needsText, true);
});

test("fetchDisabled honors FEATUREBOARD_NO_FETCH", async () => {
  const prev = process.env.FEATUREBOARD_NO_FETCH;
  process.env.FEATUREBOARD_NO_FETCH = "1";
  try {
    assert.equal(fetchDisabled(), true);
    await assert.rejects(() => ingestUrl("https://ex.com/x", { fetchImpl: fakeFetch("x") }), /disabled/);
  } finally {
    if (prev === undefined) delete process.env.FEATUREBOARD_NO_FETCH;
    else process.env.FEATUREBOARD_NO_FETCH = prev;
  }
});

test("FBMCPF-336: real pdfjs-dist extraction (skips if optional dep absent)", async (t) => {
  let available = true;
  try { await import("pdfjs-dist/legacy/build/pdf.mjs"); } catch { available = false; }
  if (!available) return t.skip("pdfjs-dist not installed (optional dependency)");
  const { extractPdfText, resetPdf } = await import("../server/ingest.js");
  resetPdf();
  const buf = fs.readFileSync(new URL("./fixtures/sample.pdf", import.meta.url));
  const r = await extractPdfText(buf);
  assert.equal(r.ok, true, r.reason || "");
  assert.match(r.text, /Collatz/);
  assert.match(r.text, /solenoid conjugacy/);
});
