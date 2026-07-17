import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMultiModelTests,
  normalizeTiers,
  variantTestPath,
  saveGeneratedTests,
  dedupeVariants,
  normalizeAssertion,
  listVariants,
  DEFAULT_TIERS,
} from "../server/testing.js";

// FBMCPF-147 — multi-model test generation: one test per bug per model tier.

test("generateMultiModelTests emits the SAME prompt once per tier with per-model paths", () => {
  const r = generateMultiModelTests({
    prompt: "adds a row\nremoves a row",
    ticket: "FBB-9",
    title: "rows",
    codeLocation: "/repo",
  });
  assert.deepEqual(r.models, ["fable", "opus", "sonnet"]);
  assert.equal(r.variants.length, 3);
  // same generation prompt handed to every tier
  assert.ok(r.variants.every((v) => v.prompt === r.prompt));
  // distinct per-tier storage paths using test/<ticket>.<model>.test.js
  assert.deepEqual(
    r.variants.map((v) => v.fileName),
    ["FBB-9.fable.test.js", "FBB-9.opus.test.js", "FBB-9.sonnet.test.js"]
  );
  assert.match(r.variants[0].path, /test[\\/]FBB-9\.fable\.test\.js$/);
  assert.match(r.variants[0].instruction, /save_generated_test/);
  // seed content is valid node:test boilerplate
  assert.match(r.variants[0].content, /import \{ test \} from "node:test"/);
});

test("generateMultiModelTests validates inputs and honours a custom tier list", () => {
  assert.throws(() => generateMultiModelTests({ ticket: "FBB-1" }), /prompt/);
  assert.throws(() => generateMultiModelTests({ prompt: "x" }), /ticket/);
  const r = generateMultiModelTests({ prompt: "x", ticket: "FBB-1", models: ["opus", "sonnet"] });
  assert.deepEqual(r.models, ["opus", "sonnet"]);
});

test("normalizeTiers loose-matches, dedupes and defaults", () => {
  assert.deepEqual(normalizeTiers(["Opus 4.8", "claude-sonnet-5", "opus"]), ["opus", "sonnet"]);
  assert.deepEqual(normalizeTiers(), DEFAULT_TIERS);
  assert.deepEqual(normalizeTiers([]), DEFAULT_TIERS);
});

test("variantTestPath builds test/<ticket>.<model>.test.js", () => {
  const v = variantTestPath({ codeLocation: "/repo/", ticket: "FBB-9", model: "opus" });
  assert.equal(v.fileName, "FBB-9.opus.test.js");
  assert.match(v.path, /^\/repo[\\/]test[\\/]FBB-9\.opus\.test\.js$/);
});

test("normalizeAssertion normalizes whitespace + variable names but keeps messages/literals distinct", () => {
  // whitespace + variable-name only differences collapse to equal
  assert.equal(
    normalizeAssertion("assert.equal(sum(2, 2), 4);"),
    normalizeAssertion("assert.equal(total(2,2),4);")
  );
  // different expected literal stays distinct
  assert.notEqual(normalizeAssertion("assert.equal(x, 4);"), normalizeAssertion("assert.equal(x, 5);"));
  // different message strings stay distinct (they distinguish generated behaviours)
  assert.notEqual(
    normalizeAssertion(`assert.ok(true, "log a bug");`),
    normalizeAssertion(`assert.ok(true, "link it");`)
  );
});

test("saveGeneratedTests tags by model, dedupes identical assertions, keeps distinct ones", () => {
  const opus = `import { test } from "node:test";
import assert from "node:assert/strict";

test("adds", () => {
  assert.equal(sum(2, 2), 4);
});`;
  const sonnet = `import { test } from "node:test";
import assert from "node:assert/strict";

test("adds again", () => {
  assert.equal(total(2, 2), 4);
});

test("negatives", () => {
  assert.equal(total(-1, -1), -2);
});`;
  const r = saveGeneratedTests({
    ticket: "FBB-9",
    project: "Demo",
    codeLocation: "/repo",
    variants: [
      { model: "opus", content: opus },
      { model: "sonnet", content: sonnet },
    ],
  });
  // both models produce a runnable file, each tagged with its model
  assert.deepEqual(r.files.map((f) => f.model), ["opus", "sonnet"]);
  assert.match(r.files[0].path, /FBB-9\.opus\.test\.js$/);
  // the duplicate "adds" block was dropped from sonnet; the distinct "negatives" kept
  assert.equal(r.keptTests, 2);
  assert.equal(r.droppedTests, 1);
  assert.equal(r.sharedNote.length, 1);
  assert.ok(!/adds again/.test(r.files[1].content), "duplicate block dropped from sonnet variant");
  assert.match(r.files[1].content, /negatives/);
  // manifest exposes queryable variant metadata (feeds FBMCPF-148)
  assert.equal(r.manifest.ticket, "FBB-9");
  assert.deepEqual(r.manifest.models, ["opus", "sonnet"]);
  assert.match(r.manifestPath, /FBB-9\.variants\.json$/);
});

test("dedupeVariants skips a variant whose blocks are all duplicates", () => {
  const a = `import { test } from "node:test";
import assert from "node:assert/strict";

test("t1", () => {
  assert.equal(fn(1), 2);
});`;
  const b = `import { test } from "node:test";
import assert from "node:assert/strict";

test("t1 copy", () => {
  assert.equal(other(1), 2);
});`;
  const r = dedupeVariants([
    { model: "opus", path: "/x/FBB-1.opus.test.js", content: a },
    { model: "sonnet", path: "/x/FBB-1.sonnet.test.js", content: b },
  ]);
  assert.equal(r.variants[0].skipped, false);
  assert.equal(r.variants[1].skipped, true);
  assert.equal(r.variants[1].content, null);
  assert.equal(r.keptTests, 1);
  assert.equal(r.droppedTests, 1);
});

test("saveGeneratedTests validates inputs", () => {
  assert.throws(() => saveGeneratedTests({ codeLocation: "/r", variants: [] }), /ticket/);
  assert.throws(() => saveGeneratedTests({ ticket: "FBB-1", variants: [] }), /at least one/);
});

test("listVariants reports models covering a ticket", () => {
  const files = [
    "FBB-9.opus.test.js",
    "FBB-9.sonnet.test.js",
    "FBB-9.fable.test.js",
    "FBB-9.variants.json",
    "FBB-10.opus.test.js",
    "other.test.js",
  ];
  const r = listVariants(files, "FBB-9");
  assert.equal(r.count, 3);
  assert.deepEqual(r.models.sort(), ["fable", "opus", "sonnet"]);
  // ticket boundary is respected — FBB-10 not matched for FBB-9
  assert.ok(r.variants.every((v) => v.file.startsWith("FBB-9.")));
  assert.deepEqual(listVariants(files, "FBB-10").models, ["opus"]);
});
