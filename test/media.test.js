import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyAsset, isSidecar, sortMedia, listMedia, MEDIA_DIR,
  sanitizeAssetName, buildMetaSidecar, saveMedia,
  listVersions, getMedia, revertMedia, isTextAsset,
  tagMedia, annotateMedia, removeAnnotation, searchMedia,
  saveUpload, listUploads, UPLOADS_DIR, editMediaText,
} from "../server/media.js";

// FBMCPF-38 — Media gallery (list assets + metadata)

test("classifyAsset recognizes images, reports, and other", () => {
  assert.equal(classifyAsset("a.PNG").kind, "image");
  assert.equal(classifyAsset("b.jpeg").kind, "image");
  assert.equal(classifyAsset("c.svg").kind, "image");
  assert.equal(classifyAsset("report.html").kind, "report");
  assert.equal(classifyAsset("notes.txt").kind, "other");
  assert.equal(classifyAsset("a.PNG").ext, ".png");
});

test("isSidecar skips meta json and dotfiles", () => {
  assert.equal(isSidecar("x.png.meta.json"), true);
  assert.equal(isSidecar(".hidden"), true);
  assert.equal(isSidecar("x.png"), false);
});

test("sortMedia orders newest-first, name tiebreak", () => {
  const out = sortMedia([
    { name: "b", created: "2026-07-10" },
    { name: "a", created: "2026-07-12" },
    { name: "c", created: "2026-07-12" },
  ]);
  assert.deepEqual(out.map((e) => e.name), ["a", "c", "b"]);
});

// fs-backed integration against a temp board
function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmedia-"));
  return { dir, board: { projectDir: () => dir } };
}

test("listMedia returns empty gallery when media/ is absent", () => {
  const { board } = tmpBoard();
  const r = listMedia(board, "P");
  assert.equal(r.count, 0);
  assert.deepEqual(r.assets, []);
});

test("listMedia enumerates assets, merges sidecar metadata, ignores sidecars", () => {
  const { dir, board } = tmpBoard();
  const media = path.join(dir, MEDIA_DIR);
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, "chart.png"), "x");
  fs.writeFileSync(
    path.join(media, "chart.png.meta.json"),
    JSON.stringify({ title: "Q3 Chart", tags: ["revenue"], ticket: "FBMCPF-38" })
  );
  fs.writeFileSync(path.join(media, "launch.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(media, ".DS_Store"), "junk");

  const r = listMedia(board, "P");
  assert.equal(r.count, 2); // sidecar + dotfile excluded
  const byName = Object.fromEntries(r.assets.map((a) => [a.name, a]));
  assert.equal(byName["chart.png"].kind, "image");
  assert.equal(byName["chart.png"].title, "Q3 Chart");
  assert.deepEqual(byName["chart.png"].tags, ["revenue"]);
  assert.equal(byName["chart.png"].ticket, "FBMCPF-38");
  assert.equal(byName["chart.png"].hasMeta, true);
  assert.equal(byName["chart.png"].relPath, "media/chart.png");
  assert.equal(byName["launch.html"].kind, "report");
  assert.equal(byName["launch.html"].hasMeta, false);
  assert.equal(byName["launch.html"].title, "launch.html");
});

test("listMedia filters by kind", () => {
  const { dir, board } = tmpBoard();
  const media = path.join(dir, MEDIA_DIR);
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, "a.png"), "x");
  fs.writeFileSync(path.join(media, "b.html"), "x");
  const r = listMedia(board, "P", { kind: "report" });
  assert.equal(r.count, 1);
  assert.equal(r.assets[0].name, "b.html");
});

// --- FBMCPF-39: media generation (save_media) ---

test("sanitizeAssetName rejects traversal, dotfiles, sidecars, extensionless", () => {
  assert.equal(sanitizeAssetName("report.html"), "report.html");
  assert.throws(() => sanitizeAssetName(""), /required/);
  assert.throws(() => sanitizeAssetName("../evil.html"), /invalid media name/);
  assert.throws(() => sanitizeAssetName("sub/dir.html"), /invalid media name/);
  assert.throws(() => sanitizeAssetName(".hidden"), /invalid media name/);
  assert.throws(() => sanitizeAssetName("x.meta.json"), /sidecar/);
  assert.throws(() => sanitizeAssetName("noext"), /extension/);
});

test("buildMetaSidecar keeps provided fields and stamps generatedAt", () => {
  const now = new Date("2026-07-13T10:00:00Z");
  const m = buildMetaSidecar({ title: "T", prompt: "P", tags: ["a"], ticket: "FBMCPF-39" }, now);
  assert.equal(m.title, "T");
  assert.equal(m.prompt, "P");
  assert.deepEqual(m.tags, ["a"]);
  assert.equal(m.ticket, "FBMCPF-39");
  assert.equal(m.generatedAt, "2026-07-13T10:00:00.000Z");
  // empties dropped
  assert.deepEqual(Object.keys(buildMetaSidecar({}, now)), ["generatedAt"]);
});

test("saveMedia writes text asset + sidecar and list_media reads it back", () => {
  const { board } = tmpBoard();
  const now = new Date("2026-07-13T10:00:00Z");
  const r = saveMedia(board, "P", {
    name: "q3.html", content: "<h1>Q3</h1>", title: "Q3 Report", prompt: "make q3", tags: ["revenue"], ticket: "FBMCPF-39",
  }, { now });
  assert.equal(r.name, "q3.html");
  assert.equal(r.kind, "report");
  assert.equal(r.relPath, "media/q3.html");
  assert.equal(r.meta.title, "Q3 Report");

  const listed = listMedia(board, "P");
  assert.equal(listed.count, 1); // sidecar excluded
  assert.equal(listed.assets[0].name, "q3.html");
  assert.equal(listed.assets[0].title, "Q3 Report");
  assert.deepEqual(listed.assets[0].tags, ["revenue"]);
  assert.equal(listed.assets[0].ticket, "FBMCPF-39");
});

test("saveMedia decodes base64 image content", () => {
  const { dir, board } = tmpBoard();
  const b64 = Buffer.from("PNGBYTES").toString("base64");
  const r = saveMedia(board, "P", { name: "chart.png", content: b64, encoding: "base64" });
  assert.equal(r.kind, "image");
  assert.equal(r.sizeBytes, 8);
  assert.equal(fs.readFileSync(path.join(dir, MEDIA_DIR, "chart.png"), "utf8"), "PNGBYTES");
});

// --- FBMCPF-40: media viewer + version history ---

test("isTextAsset: html/svg text, png binary", () => {
  assert.equal(isTextAsset("a.html"), true);
  assert.equal(isTextAsset("a.svg"), true);
  assert.equal(isTextAsset("a.png"), false);
});

test("first save has no archived version and no history", () => {
  const { board } = tmpBoard();
  const r = saveMedia(board, "P", { name: "q.html", content: "v1", title: "Q" }, { now: new Date("2026-07-13T10:00:00Z") });
  assert.equal(r.archivedVersion, null);
  assert.deepEqual(listVersions(board, "P", "q.html"), []);
});

test("overwrite archives prior revision; current newest; history keeps prompts", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "q.html", content: "v1", title: "Q1", prompt: "make v1" }, { now: new Date("2026-07-13T10:00:00Z") });
  const r2 = saveMedia(board, "P", { name: "q.html", content: "v2", title: "Q2", prompt: "make v2" }, { now: new Date("2026-07-13T11:00:00Z") });
  assert.equal(r2.archivedVersion, "20260713T100000");

  const gallery = listMedia(board, "P");
  assert.equal(gallery.count, 1); // .versions excluded
  assert.equal(gallery.assets[0].title, "Q2");

  const versions = listVersions(board, "P", "q.html");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, "20260713T100000");
  assert.equal(versions[0].prompt, "make v1");

  assert.equal(getMedia(board, "P", "q.html").content, "v2");
  assert.equal(getMedia(board, "P", "q.html", { version: "20260713T100000" }).content, "v1");
});

test("getMedia returns base64 for images and throws on missing", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "c.png", content: Buffer.from("PNGDATA").toString("base64"), encoding: "base64" });
  const g = getMedia(board, "P", "c.png");
  assert.equal(g.kind, "image");
  assert.equal(g.encoding, "base64");
  assert.equal(Buffer.from(g.content, "base64").toString(), "PNGDATA");
  assert.throws(() => getMedia(board, "P", "nope.html"), /not found/);
  assert.throws(() => getMedia(board, "P", "c.png", { version: "19990101T000000" }), /not found/);
});

test("revert restores a prior version and archives the current one", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "q.html", content: "v1" }, { now: new Date("2026-07-13T10:00:00Z") });
  saveMedia(board, "P", { name: "q.html", content: "v2" }, { now: new Date("2026-07-13T11:00:00Z") });
  const rev = revertMedia(board, "P", "q.html", "20260713T100000", { now: new Date("2026-07-13T12:00:00Z") });
  assert.equal(rev.revertedFrom, "20260713T100000");
  assert.equal(rev.archivedVersion, "20260713T110000");

  const cur = getMedia(board, "P", "q.html");
  assert.equal(cur.content, "v1");
  assert.equal(cur.meta.revertedFrom, "20260713T100000");
  assert.deepEqual(listVersions(board, "P", "q.html").map((v) => v.version), ["20260713T110000", "20260713T100000"]);
});

// --- FBMCPF-41: tagging, search, annotations ---

test("tagMedia adds/removes/dedups without touching asset bytes", () => {
  const { dir, board } = tmpBoard();
  saveMedia(board, "P", { name: "a.png", content: Buffer.from("IMG").toString("base64"), encoding: "base64", title: "A" });
  let r = tagMedia(board, "P", "a.png", { add: ["x", "y", "x"] });
  assert.deepEqual(r.tags, ["x", "y"]);
  r = tagMedia(board, "P", "a.png", { add: ["z"], remove: ["x"] });
  assert.deepEqual(r.tags, ["y", "z"]);
  assert.equal(fs.readFileSync(path.join(dir, MEDIA_DIR, "a.png"), "utf8"), "IMG");
  assert.throws(() => tagMedia(board, "P", "missing.png", { add: ["x"] }), /not found/);
});

test("annotateMedia: monotonic ids survive removal; text required", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "a.png", content: Buffer.from("IMG").toString("base64"), encoding: "base64" });
  const a1 = annotateMedia(board, "P", "a.png", { x: 0.1, y: 0.2, text: "hi" });
  assert.equal(a1.annotation.id, "a1");
  assert.equal(a1.annotation.x, 0.1);
  const a2 = annotateMedia(board, "P", "a.png", { text: "again" });
  assert.equal(a2.annotation.id, "a2");
  assert.equal(removeAnnotation(board, "P", "a.png", "a1").count, 1);
  assert.equal(annotateMedia(board, "P", "a.png", { text: "third" }).annotation.id, "a3");
  assert.throws(() => removeAnnotation(board, "P", "a.png", "aX"), /not found/);
  assert.throws(() => annotateMedia(board, "P", "a.png", { text: " " }), /text is required/);
  // annotations surface in get_media
  assert.equal(getMedia(board, "P", "a.png").annotations.length, 2);
});

// --- FBMCPF-90: edit_media (text) ---
test("editMediaText find/replace saves a new version; images rejected", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "r.html", content: "<h1>Old</h1><p>Old</p>", title: "T" });
  const r = editMediaText(board, "P", "r.html", { find: "Old", replace: "New" });
  assert.equal(r.name, "r.html");
  assert.equal(getMedia(board, "P", "r.html").content, "<h1>New</h1><p>New</p>");
  assert.equal(listVersions(board, "P", "r.html").length, 1); // prior archived
  assert.match(r.meta.prompt, /edit: replace "Old"/);
  // append/prepend
  editMediaText(board, "P", "r.html", { prepend: "<!--top-->", append: "<!--end-->" });
  const c = getMedia(board, "P", "r.html").content;
  assert.ok(c.startsWith("<!--top-->") && c.endsWith("<!--end-->"));
  // guards
  assert.throws(() => editMediaText(board, "P", "r.html", {}), /provide find/);
  assert.throws(() => editMediaText(board, "P", "r.html", { find: "zzz", replace: "x" }), /not found/);
  saveMedia(board, "P", { name: "pic.png", content: Buffer.from("IMG").toString("base64"), encoding: "base64" });
  assert.throws(() => editMediaText(board, "P", "pic.png", { append: "x" }), /edits text assets/);
});

// --- FBMCPF-86: reference uploads ---
test("saveUpload writes to media/uploads and listUploads lists them", () => {
  const { dir, board } = tmpBoard();
  const r = saveUpload(board, "P", { name: "mood.png", content: Buffer.from("IMG").toString("base64") });
  assert.equal(r.relPath, "media/uploads/mood.png");
  assert.equal(fs.readFileSync(path.join(dir, MEDIA_DIR, UPLOADS_DIR, "mood.png"), "utf8"), "IMG");
  assert.throws(() => saveUpload(board, "P", { name: "../x.png", content: "a" }), /invalid media name/);
  assert.equal(listUploads(board, "P").count, 1);
  // uploads/ is a subfolder — must NOT show up in the gallery
  assert.equal(listMedia(board, "P").count, 0);
});

test("searchMedia filters by tag, kind, and free text across name/title/tags/prompt", () => {
  const { board } = tmpBoard();
  saveMedia(board, "P", { name: "revenue.png", content: Buffer.from("I").toString("base64"), encoding: "base64", title: "Revenue", tags: ["finance"], prompt: "quarterly earnings" });
  saveMedia(board, "P", { name: "launch.html", content: "<h1>x</h1>", title: "Launch", tags: ["marketing"] });
  assert.equal(searchMedia(board, "P", { tag: "finance" }).count, 1);
  assert.equal(searchMedia(board, "P", { kind: "report" }).assets[0].name, "launch.html");
  assert.equal(searchMedia(board, "P", { query: "earnings" }).assets[0].name, "revenue.png");
  assert.equal(searchMedia(board, "P", { query: "launch" }).assets[0].name, "launch.html");
  assert.equal(searchMedia(board, "P", { query: "nomatch" }).count, 0);
});
