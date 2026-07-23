import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { addKbDoc } from "../server/kb.js";
import { setProjectConfig, getWorkPacket, setScratchpad } from "../server/metadata.js";
import { tokenize, chunkMarkdown, buildIndex, search, ragSearch, clearIndexCache } from "../server/rag.js";
import { researchSlug } from "../server/research.js";

// FBMCPF-264 — local lexical RAG (BM25) over KB docs + docs/*.md + Done ticket
// summaries. Zero deps, zero tokens, zero network.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbrag-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("tokenizer lowercases, splits on non-alnum, drops stopwords and 1-char tokens", () => {
  const toks = tokenize("The Quick, brown-FOX jumps over X");
  assert.ok(toks.includes("quick"));
  assert.ok(toks.includes("brown"));
  assert.ok(toks.includes("fox"));
  assert.ok(toks.includes("jumps"));
  assert.ok(!toks.includes("the"), "stopword dropped");
  assert.ok(!toks.includes("over"), "stopword dropped");
  assert.ok(!toks.includes("x"), "1-char token dropped");
});

test("chunkMarkdown preserves headings as the chunk's source heading", () => {
  const md = "# Title\n\nIntro paragraph about widgets.\n\n## Details\n\nThe details section talks about gizmos and gadgets.\n";
  const chunks = chunkMarkdown(md, "kb/some-doc");
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.equal(c.source, "kb/some-doc");
  const detail = chunks.find((c) => /gizmos/.test(c.text));
  assert.ok(detail, "a chunk carries the details text");
  assert.equal(detail.heading, "Details", "the chunk is tagged with its section heading");
});

test("BM25: a doc mentioning the query terms outranks an unrelated one; term frequency matters", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Payments High", "payment payment payment payment retries and gateway handling");
  addKbDoc(b, "Proj", "Payments Low", "one payment mention only here");
  addKbDoc(b, "Proj", "Weather", "sunshine forecast clouds and rain unrelated entirely");

  const results = ragSearch(b, "Proj", "payment", { k: 10 });
  const sources = results.map((r) => r.source);
  assert.ok(sources.includes("kb/payments-high"));
  assert.ok(sources.includes("kb/payments-low"));
  assert.ok(!sources.includes("kb/weather"), "unrelated doc scores 0 and is excluded");
  // Higher term frequency ranks first.
  assert.equal(results[0].source, "kb/payments-high");
  assert.ok(results[0].score > results[1].score);
});

test("corpus spans KB docs, code repo docs/*.md + README, and Done ticket summaries", () => {
  const b = tmpBoard();
  // (a) a KB doc
  addKbDoc(b, "Proj", "Arch Notes", "The storage layer parses markdown into tasks.");
  // (b) a code repo with docs/ + README
  const code = fs.mkdtempSync(path.join(os.tmpdir(), "fbcode-"));
  fs.mkdirSync(path.join(code, "docs"));
  fs.writeFileSync(path.join(code, "docs", "guide.md"), "# Guide\n\nHow the retrieval indexer chunks documents.\n");
  fs.writeFileSync(path.join(code, "README.md"), "# Project\n\nTop level readme describing the widget engine.\n");
  setProjectConfig(b, "Proj", { codeLocation: code });
  // (c) a Done ticket with a completion summary
  const done = b.addTask("Proj", "feature", { title: "Cache the parser", description: "speed" });
  b.setStatus("Proj", done.ticketNumber, "Done", "Added an mtime-keyed parse cache to storage.");

  clearIndexCache();
  const idx = buildIndex(b, "Proj");
  const sources = new Set(idx.docs.map((d) => d.source));
  assert.ok([...sources].some((s) => s.startsWith("kb/")), "KB docs in corpus");
  assert.ok(sources.has("docs/guide.md"), "docs/*.md in corpus");
  assert.ok([...sources].some((s) => /readme\.md$/i.test(s)), "root README in corpus");
  assert.ok(sources.has(done.ticketNumber), "Done ticket summary in corpus");

  // The Done-ticket summary is retrievable by its own vocabulary.
  const hit = ragSearch(b, "Proj", "mtime parse cache", { k: 5 });
  assert.ok(hit.some((r) => r.source === done.ticketNumber));
});

test("incremental cache: reuse when unchanged, rebuild when a source file changes", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Doc One", "alpha beta gamma");
  clearIndexCache();
  const first = buildIndex(b, "Proj");
  const second = buildIndex(b, "Proj");
  assert.equal(first, second, "same object reused when nothing changed");

  // Change the KB doc's size → fingerprint changes → rebuild.
  addKbDoc(b, "Proj", "Doc One", "alpha beta gamma delta epsilon zeta eta theta");
  const third = buildIndex(b, "Proj");
  assert.notEqual(third, first, "index rebuilt after a source file changed");
  assert.notEqual(third.fingerprint, first.fingerprint);
});

test("search / rag_search respect the k cap", () => {
  const b = tmpBoard();
  for (let i = 0; i < 8; i++) addKbDoc(b, "Proj", `Widget ${i}`, "widget widget widget gadget");
  const idx = buildIndex(b, "Proj");
  assert.ok(search(idx, "widget", 3).length <= 3);
  assert.equal(ragSearch(b, "Proj", "widget", { k: 2 }).length, 2);
});

test("empty / no-match queries return []", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Something", "content here");
  assert.deepEqual(ragSearch(b, "Proj", ""), []);
  assert.deepEqual(ragSearch(b, "Proj", "zznonexistentterm"), []);
});

test("getWorkPacket attaches ragChunks, excludes the ticket's own research brief, caps ~4KB", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", {
    title: "Payment retries",
    description: "Retry failed payment charges with backoff.",
  });
  // A matching KB doc that SHOULD surface.
  addKbDoc(b, "Proj", "Retry Strategy", "payment retries use exponential backoff on failed charges.");
  // The ticket's own research brief — matches the query too, but must be excluded
  // from ragChunks because it's attached separately as researchBrief.
  addKbDoc(b, "Proj", `research/${t.ticketNumber}`, "payment retries research brief: backoff and jitter for charges.");

  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.ok(packet.ragChunks && packet.ragChunks.length >= 1, "ragChunks attached");
  const briefSource = `kb/${researchSlug(t.ticketNumber)}`;
  assert.ok(!packet.ragChunks.some((c) => c.source === briefSource), "own research brief excluded from ragChunks");
  assert.ok(packet.researchBrief, "brief still attached separately");

  // 4KB total cap on attached rag text.
  setProjectConfig(b, "Proj", { ragK: 20 });
  const big = "payment retries backoff charges failure retry ".repeat(400); // ~19KB of matching text
  addKbDoc(b, "Proj", "Big Retry Doc", big);
  const packet2 = getWorkPacket(b, "Proj", t.ticketNumber);
  const totalBytes = packet2.ragChunks.reduce((s, c) => s + Buffer.byteLength(c.text, "utf8"), 0);
  assert.ok(totalBytes <= 4096, `total rag text within ~4KB (was ${totalBytes})`);
});

test("ragInPackets:false disables ragChunks on the packet", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { ragInPackets: false });
  addKbDoc(b, "Proj", "Retry Strategy", "payment retries use exponential backoff.");
  const t = b.addTask("Proj", "feature", { title: "Payment retries", description: "backoff" });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.equal(packet.ragChunks, undefined);
});

test("FBMCPB-54: the project scratchpad is part of the corpus and is retrievable", () => {
  const b = tmpBoard();
  // Research condensation that lives in the scratchpad, NOT in kb/.
  setScratchpad(
    b,
    "Proj",
    "# Known walls\n\nThe 2-adic conjugacy of the Collatz map to the shift is a solenoid conjugacy; the binary viewpoint has not yielded a cycle bound.",
  );
  clearIndexCache();

  const idx = buildIndex(b, "Proj");
  const sources = new Set(idx.docs.map((d) => d.source));
  assert.ok(sources.has("scratchpad"), "scratchpad is in the corpus");

  // Retrievable by its own vocabulary (would have returned [] before the fix).
  const hit = ragSearch(b, "Proj", "solenoid conjugacy cycle bound", { k: 5 });
  assert.ok(hit.some((r) => r.source === "scratchpad"), "scratchpad content is retrievable");
});

test("FBMCPB-54: an empty scratchpad contributes nothing to the corpus", () => {
  const b = tmpBoard();
  setScratchpad(b, "Proj", "   \n  ");
  addKbDoc(b, "Proj", "Doc", "alpha beta gamma");
  clearIndexCache();
  const idx = buildIndex(b, "Proj");
  assert.ok(!idx.docs.some((d) => d.source === "scratchpad"), "empty scratchpad excluded");
});
