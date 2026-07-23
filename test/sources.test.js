import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { addSource, listSources, getSource } from "../server/sources.js";
import { ragSearch, clearIndexCache } from "../server/rag.js";

// FBMCPF-335 — research sources library: per-project sources/ folder holding the
// RAW text of papers/articles under a citation header, indexed into the RAG.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsrc-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("addSource writes sources/<slug>.md with a citation header and round-trips", () => {
  const b = tmpBoard();
  const r = addSource(b, "Proj", {
    title: "Terras 1976 stopping time",
    text: "Almost all Collatz orbits have finite stopping time; density argument.",
    source: "Terras, Acta Arithmetica",
    url: "https://example.org/terras",
    ticket: "TXPOF-4",
    tags: ["collatz", "stopping-time"],
  });
  assert.equal(r.slug, "terras-1976-stopping-time");
  assert.equal(r.created, true);
  assert.ok(r.path.endsWith(path.join("sources", "terras-1976-stopping-time.md")));

  const raw = fs.readFileSync(r.path, "utf8");
  assert.match(raw, /^---\n/);
  assert.match(raw, /source: Terras, Acta Arithmetica/);
  assert.match(raw, /ticket: TXPOF-4/);

  const doc = getSource(b, "Proj", "terras-1976-stopping-time");
  assert.equal(doc.title, "Terras 1976 stopping time");
  assert.equal(doc.url, "https://example.org/terras");
  assert.deepEqual(doc.tags, ["collatz", "stopping-time"]);
  assert.match(doc.content, /finite stopping time/);
});

test("addSource with the same title updates in place and preserves addedAt", () => {
  const b = tmpBoard();
  const first = addSource(b, "Proj", { title: "Paper A", text: "v1 text" });
  const before = getSource(b, "Proj", first.slug).addedAt;
  const second = addSource(b, "Proj", { title: "Paper A", text: "v2 text expanded" });
  assert.equal(second.created, false);
  assert.equal(second.slug, first.slug);
  const after = getSource(b, "Proj", first.slug);
  assert.equal(after.addedAt, before, "addedAt preserved across updates");
  assert.match(after.content, /v2 text expanded/);
  assert.ok(after.updatedAt >= before);
});

test("listSources returns metadata + excerpt, not the full body", () => {
  const b = tmpBoard();
  addSource(b, "Proj", { title: "Long Paper", text: "x".repeat(5000), source: "Journal" });
  const list = listSources(b, "Proj");
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Long Paper");
  assert.equal(list[0].source, "Journal");
  assert.ok(list[0].excerpt.length < 5000, "excerpt truncated");
  assert.ok(list[0].bytes > 5000);
});

test("addSource requires a title; getSource is null for missing", () => {
  const b = tmpBoard();
  assert.throws(() => addSource(b, "Proj", { title: "", text: "x" }), /title is required/);
  assert.equal(getSource(b, "Proj", "nope"), null);
});

test("FBMCPF-335: sources are indexed into the RAG and retrievable by raw-text vocabulary", () => {
  const b = tmpBoard();
  addSource(b, "Proj", {
    title: "Tao 2019",
    text: "Almost all Collatz orbits attain almost bounded values via a probabilistic pointwise argument.",
    source: "Terence Tao",
  });
  clearIndexCache();
  const hits = ragSearch(b, "Proj", "probabilistic pointwise bounded values", { k: 5 });
  assert.ok(hits.some((h) => h.source === "source/tao-2019"), "raw source text is retrievable");
});
