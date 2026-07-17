import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseTap,
  builtinMutations,
  applyMutationToSource,
  discoverVariantFiles,
  runVariantMatrix,
  formatEvidenceSection,
  appendEvidence,
} from "../server/modeleval.js";
import { DEFAULT_PRICING } from "../server/pricing.js";

// FBMCPF-148 — model up/downgrade effectiveness at test time, built on the
// multi-model test generation variants from FBMCPF-147 (server/testing.js).

// --- TAP parsing -----------------------------------------------------------

test("parseTap reads ok/not ok lines and tallies pass/fail", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: a",
    "ok 1 - a",
    "  ---",
    "  duration_ms: 0.1",
    "  ...",
    "# Subtest: b",
    "not ok 2 - b",
    "  ---",
    "  error: boom",
    "  ...",
    "1..2",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const r = parseTap(tap);
  assert.deepEqual(r.tests, [{ name: "a", ok: true }, { name: "b", ok: false }]);
  assert.equal(r.pass, 1);
  assert.equal(r.fail, 1);
});

// --- builtin mutations -------------------------------------------------

test("builtinMutations mutate deterministically and report null when their pattern is absent", () => {
  const specs = builtinMutations();
  const cmp = specs.find((s) => s.id === "flip-comparison");
  const r1 = applyMutationToSource("export function isPositive(n) { return n > 0; }", cmp);
  assert.equal(r1.applied, true);
  assert.match(r1.content, /n < 0/);

  const bool = specs.find((s) => s.id === "negate-boolean-literal");
  const r2 = applyMutationToSource("function f() { return true; }", bool);
  assert.equal(r2.applied, true);
  assert.match(r2.content, /return false/);

  // pattern absent -> not applied, content unchanged
  const r3 = applyMutationToSource("const x = 1;", specs.find((s) => s.id === "flip-strict-eq"));
  assert.equal(r3.applied, false);
  assert.equal(r3.content, "const x = 1;");

  // same mutation is deterministic across repeated calls
  const r4 = applyMutationToSource("export function isPositive(n) { return n > 0; }", cmp);
  assert.equal(r4.content, r1.content);
});

// --- fixture: one target module + three model variants ---------------------
//
// isPositive (uses `>`) is covered only by the "opus" variant, alwaysTrue
// (uses `return true`) only by "haiku", and sum (uses `+`) only by "sonnet"
// — a deliberately weak variant whose assertion doesn't exercise the
// mutated comparison/boolean at all, so it never catches anything. This
// gives a fixture with a known unique-catch/overlap answer to check the
// matrix math against, plus a mutation (off-by-one) nobody catches and
// mutations with no matching pattern (skipped) for realism.

function buildFixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcp-modeleval-fixture-"));
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "server", "target.js"),
    [
      "export function isPositive(n) {",
      "  return n > 0;",
      "}",
      "",
      "export function alwaysTrue() {",
      "  return true;",
      "}",
      "",
      "export function sum(a, b) {",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "test", "FBX-1.opus.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { isPositive } from "../server/target.js";',
      "",
      'test("isPositive true for 5", () => {',
      "  assert.equal(isPositive(5), true);",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "test", "FBX-1.haiku.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { alwaysTrue } from "../server/target.js";',
      "",
      'test("alwaysTrue is true", () => {',
      "  assert.equal(alwaysTrue(), true);",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "test", "FBX-1.sonnet.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { sum } from "../server/target.js";',
      "",
      'test("sum adds", () => {',
      "  assert.equal(sum(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
    "utf8"
  );
  return dir;
}

test("discoverVariantFiles finds the ticket's per-model test files", () => {
  const dir = buildFixtureProject();
  try {
    const found = discoverVariantFiles(path.join(dir, "test"), "FBX-1");
    assert.deepEqual(found.map((v) => v.model).sort(), ["haiku", "opus", "sonnet"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix requires an explicit mode label", () => {
  const dir = buildFixtureProject();
  try {
    assert.throws(() => runVariantMatrix(dir, "FBX-1", {}), /mode must be/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix errors when no variant files exist for the ticket", () => {
  const dir = buildFixtureProject();
  try {
    assert.throws(() => runVariantMatrix(dir, "NOPE-9", { mode: "harness-validation" }), /no variant test files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix: baseline passes for all three variants (fixture sanity)", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", { mode: "harness-validation" });
    assert.deepEqual(r.models.sort(), ["haiku", "opus", "sonnet"]);
    for (const m of r.models) {
      assert.equal(r.baseline[m].fail, 0, `${m} baseline should be clean`);
      assert.equal(r.baseline[m].pass, 1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix: seeded mutations, unique-catch rate, and overlap matrix match the fixture design", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", { targetFile: "server/target.js", mode: "harness-validation" });

    // 3 of the 6 builtin mutations have no matching pattern in this fixture
    // (no ===, ==, &&/||) and are reported as skipped, not applied.
    const skipped = r.mutations.filter((m) => !m.applied).map((m) => m.id).sort();
    assert.deepEqual(skipped, ["flip-logical-and-or", "flip-loose-eq", "flip-strict-eq"]);
    const applied = r.mutations.filter((m) => m.applied).map((m) => m.id).sort();
    assert.deepEqual(applied, ["flip-comparison", "negate-boolean-literal", "off-by-one-const"]);
    assert.equal(applied.length, 3);

    // opus (isPositive) uniquely catches the comparison flip
    const flipComparison = r.mutations.find((m) => m.id === "flip-comparison");
    assert.deepEqual(flipComparison.caughtBy, ["opus"]);

    // haiku (alwaysTrue) uniquely catches the boolean negation
    const negateBool = r.mutations.find((m) => m.id === "negate-boolean-literal");
    assert.deepEqual(negateBool.caughtBy, ["haiku"]);

    // the off-by-one mutation (n > 0 -> n > 1) doesn't change isPositive(5)'s
    // result and doesn't touch sum/alwaysTrue at all — nobody catches it
    const offByOne = r.mutations.find((m) => m.id === "off-by-one-const");
    assert.deepEqual(offByOne.caughtBy, []);

    const totalMutations = 3;
    const byModel = Object.fromEntries(r.perModel.map((p) => [p.model, p]));
    assert.equal(byModel.opus.defectsCaught, 1);
    assert.equal(byModel.opus.uniqueDefectsCaught, 1);
    assert.equal(byModel.opus.totalMutations, totalMutations);
    assert.equal(byModel.opus.catchRate, Math.round((1 / 3) * 1e4) / 1e4);
    assert.equal(byModel.opus.uniqueCatchRate, Math.round((1 / 3) * 1e4) / 1e4);

    assert.equal(byModel.haiku.defectsCaught, 1);
    assert.equal(byModel.haiku.uniqueDefectsCaught, 1);

    // sonnet's variant only tests sum(), which none of the seeded mutations
    // touch — it catches nothing, demonstrating a genuinely weak tier here
    assert.equal(byModel.sonnet.defectsCaught, 0);
    assert.equal(byModel.sonnet.uniqueDefectsCaught, 0);
    assert.equal(byModel.sonnet.catchRate, 0);

    // overlap matrix: opus and haiku never caught the SAME mutation, and
    // each model's diagonal equals its own total catch count
    assert.equal(r.overlap.opus.opus, 1);
    assert.equal(r.overlap.haiku.haiku, 1);
    assert.equal(r.overlap.sonnet.sonnet, 0);
    assert.equal(r.overlap.opus.haiku, 0);
    assert.equal(r.overlap.opus.sonnet, 0);
    assert.equal(r.overlap.haiku.sonnet, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix never mutates the real target file on disk", () => {
  const dir = buildFixtureProject();
  try {
    const before = fs.readFileSync(path.join(dir, "server", "target.js"), "utf8");
    runVariantMatrix(dir, "FBX-1", { targetFile: "server/target.js", mode: "harness-validation" });
    const after = fs.readFileSync(path.join(dir, "server", "target.js"), "utf8");
    assert.equal(after, before, "target.js on disk must be untouched by seeded mutations");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix: cost per caught defect uses pricing.js rates from tokensByModel", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", {
      targetFile: "server/target.js",
      mode: "harness-validation",
      tokensByModel: { opus: 40000, sonnet: 12000, haiku: 6000 },
      pricing: DEFAULT_PRICING,
    });
    const byModel = Object.fromEntries(r.perModel.map((p) => [p.model, p]));
    // opus: 40000 tokens * 15 blended $/MTok / 1e6 = 0.6, 1 defect caught -> 0.6/defect
    assert.equal(byModel.opus.cost, 0.6);
    assert.equal(byModel.opus.costPerCaughtDefect, 0.6);
    // haiku: 6000 * 3 / 1e6 = 0.018, 1 defect caught -> 0.018/defect
    assert.equal(byModel.haiku.cost, 0.018);
    assert.equal(byModel.haiku.costPerCaughtDefect, 0.018);
    // sonnet caught 0 defects -> cost/caught-defect is null even though cost > 0
    assert.equal(byModel.sonnet.cost, 0.072);
    assert.equal(byModel.sonnet.costPerCaughtDefect, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix without targetFile runs baseline only (no seeded mutations)", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", { mode: "harness-validation" });
    assert.ok(r.mutations.every((m) => m.applied === false));
    assert.ok(r.mutations.every((m) => m.reason === "no targetFile provided"));
    assert.ok(r.perModel.every((p) => p.defectsCaught === 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVariantMatrix accepts custom find/replace mutation specs", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", {
      targetFile: "server/target.js",
      mode: "harness-validation",
      mutations: [{ id: "kill-isPositive", description: "always return false", find: "return n > 0;", replace: "return false;" }],
    });
    assert.equal(r.mutations.length, 1);
    assert.equal(r.mutations[0].applied, true);
    assert.deepEqual(r.mutations[0].caughtBy, ["opus"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- EVIDENCE.md formatting + append gating ---------------------------

test("formatEvidenceSection labels a harness-validation run distinctly from a real run", () => {
  const dir = buildFixtureProject();
  try {
    const r = runVariantMatrix(dir, "FBX-1", { targetFile: "server/target.js", mode: "harness-validation" });
    const md = formatEvidenceSection(r);
    assert.match(md, /harness validation — no real defect data/);
    assert.match(md, /Harness-validation run — not real defect data/);
    assert.match(md, /\| Model \| Defects caught \|/);
    assert.match(md, /Overlap matrix/);

    const r2 = { ...r, mode: "real" };
    const md2 = formatEvidenceSection(r2);
    assert.match(md2, /\(real run\)/);
    assert.ok(!/Harness-validation run/.test(md2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvidence only writes when explicitly called, and appends (doesn't clobber) existing content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcp-modeleval-evidence-"));
  try {
    const evPath = path.join(dir, "EVIDENCE.md");
    fs.writeFileSync(evPath, "# Existing evidence\n\nSome prior readout.\n", "utf8");
    appendEvidence(evPath, "## New section\n\nBody text.\n");
    const out = fs.readFileSync(evPath, "utf8");
    assert.match(out, /# Existing evidence/);
    assert.match(out, /Some prior readout\./);
    assert.match(out, /## New section/);
    assert.match(out, /Body text\./);
    // order preserved: existing content first, new section appended after
    assert.ok(out.indexOf("Existing evidence") < out.indexOf("New section"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvidence creates the file when it doesn't exist yet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcp-modeleval-evidence2-"));
  try {
    const evPath = path.join(dir, "EVIDENCE.md");
    assert.equal(fs.existsSync(evPath), false);
    appendEvidence(evPath, "## First section\n\nBody.\n");
    assert.equal(fs.existsSync(evPath), true);
    assert.match(fs.readFileSync(evPath, "utf8"), /## First section/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
