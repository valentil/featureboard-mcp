import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";
import { buildHistoryMap, getHistoryMap, suggestHistoricalFiles } from "../server/git.js";

// FBMCPF-192 — history-driven filesToRead hints: which files did Done tickets of
// a given product/label historically touch? Built from recorded commit events
// (FBMCPF-188) or a git grep fallback, cached by HEAD, ranked per product/label.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-history-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}
function tmpRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-history-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  return repo;
}
function doneWithCommit(b, product, hash, files, labels = []) {
  const t = b.addTask("Proj", "feature", { title: "T " + hash, product, labels });
  b.setStatus("Proj", t.ticketNumber, "Done", "done");
  appendEvent(b, "Proj", {
    ticket: t.ticketNumber, field: "commit", to: hash.slice(0, 7),
    hash, shortHash: hash.slice(0, 7), additions: 1, deletions: 0, source: "commit_feature",
  });
  return { ticket: t.ticketNumber, hash, files };
}
// exec serving rev-parse HEAD + `git show --name-only` from a hash->files table
function makeExec(files, counters = {}) {
  return (args) => {
    counters[args[0]] = (counters[args[0]] || 0) + 1;
    if (args[0] === "rev-parse") return { status: 0, stdout: "HEADHASH123\n", stderr: "" };
    if (args[0] === "show") {
      const hash = args[args.length - 1];
      return { status: 0, stdout: (files[hash] || []).join("\n") + "\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
}

test("buildHistoryMap aggregates product -> file frequency from recorded commits", () => {
  const b = tmpBoard(); const repo = tmpRepo();
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const c1 = doneWithCommit(b, "Analytics", "aaaaaaa1111", ["server/analytics.js", "server/index.js"]);
  const c2 = doneWithCommit(b, "Analytics", "bbbbbbb2222", ["server/analytics.js"]);
  const map = buildHistoryMap(b, "Proj", { exec: makeExec({ [c1.hash]: c1.files, [c2.hash]: c2.files }) });
  assert.equal(map.products.Analytics["server/analytics.js"], 2);
  assert.equal(map.products.Analytics["server/index.js"], 1);
});

test("suggestHistoricalFiles ranks by frequency for the matching product, marked historical", () => {
  const b = tmpBoard(); const repo = tmpRepo();
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const c1 = doneWithCommit(b, "Analytics", "aaaaaaa1111", ["server/analytics.js", "server/index.js"]);
  const c2 = doneWithCommit(b, "Analytics", "bbbbbbb2222", ["server/analytics.js"]);
  const map = buildHistoryMap(b, "Proj", { exec: makeExec({ [c1.hash]: c1.files, [c2.hash]: c2.files }) });
  const hints = suggestHistoricalFiles(map, { product: "Analytics", labels: [] }, { limit: 5 });
  assert.equal(hints[0].path, "server/analytics.js");
  assert.equal(hints[0].score, 2);
  assert.equal(hints[0].source, "historical");
  assert.deepEqual(hints.map((h) => h.path), ["server/analytics.js", "server/index.js"]);
});

test("suggestHistoricalFiles returns [] for a null map (git disabled) or a non-matching product", () => {
  assert.deepEqual(suggestHistoricalFiles(null, { product: "Analytics" }), []);
  const map = { products: { Analytics: { "a.js": 1 } }, labels: {} };
  assert.deepEqual(suggestHistoricalFiles(map, { product: "Website", labels: [] }), []);
});

test("control labels (model:/cap:/effort:) are not used as correlation keys", () => {
  const b = tmpBoard(); const repo = tmpRepo();
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const c1 = doneWithCommit(b, "Analytics", "ddddddd4444", ["server/x.js"], ["model:sonnet", "cap:60000", "correlation"]);
  const map = buildHistoryMap(b, "Proj", { exec: makeExec({ [c1.hash]: c1.files }) });
  assert.ok(map.labels["correlation"], "semantic label is a key");
  assert.ok(!map.labels["model:sonnet"], "control label is excluded");
  assert.ok(!map.labels["cap:60000"], "control label is excluded");
});

test("getHistoryMap returns null when the project has no usable git repo", () => {
  const b = tmpBoard(); // no codeLocation
  assert.equal(getHistoryMap(b, "Proj", { exec: makeExec({}) }), null);
});

test("getHistoryMap caches by HEAD: a second call does not rescan commits", () => {
  const b = tmpBoard(); const repo = tmpRepo();
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const c1 = doneWithCommit(b, "Analytics", "ccccccc3333", ["server/analytics.js"]);
  const counters = {};
  const exec = makeExec({ [c1.hash]: c1.files }, counters);
  getHistoryMap(b, "Proj", { exec });
  const showsAfterFirst = counters.show || 0;
  assert.ok(showsAfterFirst >= 1, "first call scans commits");
  const m2 = getHistoryMap(b, "Proj", { exec });
  assert.equal(counters.show, showsAfterFirst, "second call served from cache — no extra git show");
  assert.equal(m2.products.Analytics["server/analytics.js"], 1);
});

test("grep fallback: a Done ticket with no recorded commit events uses git log --grep --name-only", () => {
  const b = tmpBoard(); const repo = tmpRepo();
  setProjectConfig(b, "Proj", { codeLocation: repo });
  const t = b.addTask("Proj", "feature", { title: "Grep", product: "Core" });
  b.setStatus("Proj", t.ticketNumber, "Done", "done");
  const exec = (args) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: "HEADX\n", stderr: "" };
    if (args[0] === "log") return { status: 0, stdout: "server/storage.js\nserver/storage.js\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  const map = buildHistoryMap(b, "Proj", { exec });
  assert.equal(map.products.Core["server/storage.js"], 1, "deduped once per ticket");
});
