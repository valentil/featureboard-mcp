import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTestFiles, isStubOnly } from "../server/cleanup.js";

// FBMCPF-104 — deep-clean stale/duplicate tests

const stub = `import { test } from "node:test";
import assert from "node:assert/strict";
test("x", () => { assert.ok(true, "TODO: implement"); });`;
const real = `import { test } from "node:test";
test("y", () => { assert.equal(1 + 1, 2); });`;

test("isStubOnly flags TODO-only files, not real ones", () => {
  assert.equal(isStubOnly(stub), true);
  assert.equal(isStubOnly(real), false);
});

test("scanTestFiles finds duplicates, stale-by-ticket, and stubs", () => {
  const files = [
    { name: "a.test.js", content: real },
    { name: "b.test.js", content: real },               // dup of a
    { name: "FBF-999-old.test.js", content: real + "\n// 999" }, // stale ticket, distinct content
    { name: "FBF-1-live.test.js", content: real + "\n// 1" },    // known ticket, distinct content
    { name: "stub.test.js", content: stub },             // empty stub
  ];
  const r = scanTestFiles(files, { knownTickets: ["FBF-1"] });
  assert.equal(r.duplicateGroups, 1);
  assert.deepEqual(r.duplicates[0].removeCandidates, ["b.test.js"]); // keeps first alphabetically... a<b
  assert.deepEqual(r.stale.map((s) => s.file), ["FBF-999-old.test.js"]);
  assert.deepEqual(r.emptyStubs.map((s) => s.file), ["stub.test.js"]);
  assert.ok(r.suggestedRemovals.includes("FBF-999-old.test.js"));
});

test("scanTestFiles clean suite -> no suggestions", () => {
  const r = scanTestFiles([{ name: "a.test.js", content: real }], { knownTickets: [] });
  assert.equal(r.suggestedRemovals.length, 0);
});
