import { generateTestFromPrompt } from "./storage.js";
import { normalizeModelName } from "./pricing.js";

/**
 * FeatureBoard test organization (FBMCPF-75).
 *
 * Ports organize-tests: group the recorded test runs (from the testing center,
 * FBMCPF-34 — test_runs.md) by suite so each suite's latest status and pass-rate
 * are visible, instead of one flat list. Pure over an array of run records
 * ({ suite, passed, failed, skipped, ticket, date, time, ... }); the tool feeds it
 * from meta.readTestRuns. Exported for tests.
 */

/** Group test-run records by suite with a per-suite rollup (newest-first runs). */
export function groupBySuite(runs = []) {
  const bySuite = {};
  for (const r of runs) {
    const s = (r.suite && String(r.suite).trim()) || "(unlabeled)";
    (bySuite[s] = bySuite[s] || []).push(r);
  }
  const suites = Object.keys(bySuite)
    .sort()
    .map((s) => {
      const rs = bySuite[s];
      const latest = rs[rs.length - 1]; // readTestRuns yields oldest→newest on disk
      const totalPassed = rs.reduce((a, r) => a + (r.passed || 0), 0);
      const totalFailed = rs.reduce((a, r) => a + (r.failed || 0), 0);
      const denom = totalPassed + totalFailed;
      return {
        suite: s,
        runs: rs.length,
        latest: latest ? { date: latest.date, time: latest.time || null, passed: latest.passed || 0, failed: latest.failed || 0 } : null,
        passing: latest ? (latest.failed || 0) === 0 : null,
        totalPassed,
        totalFailed,
        passRate: denom ? Math.round((totalPassed / denom) * 1000) / 10 : null,
      };
    });
  const failing = suites.filter((s) => s.passing === false).map((s) => s.suite);
  return { suites, count: suites.length, failing };
}

/**
 * Coverage-by-product rollup (FBMCPF-103): for each product, how many of its
 * tickets have at least one recorded test run (by ticket id) vs none. Pure over
 * tasks (features+bugs) + test-run records. Lists untested tickets per product.
 */
export function coverageByProduct(tasks = [], runs = []) {
  const tested = new Set(
    (Array.isArray(runs) ? runs : [])
      .map((r) => r && r.ticket)
      .filter(Boolean)
      .map((t) => String(t))
  );
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const byProduct = {};
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const p = (t.product && String(t.product).trim()) || "(unassigned)";
    (byProduct[p] = byProduct[p] || []).push(t);
  }
  const products = Object.keys(byProduct).sort().map((p) => {
    const list = byProduct[p];
    const untested = list.filter((t) => !tested.has(String(t.ticketNumber)));
    return {
      product: p,
      total: list.length,
      tested: list.length - untested.length,
      untested: untested.length,
      coveragePct: pct(list.length - untested.length, list.length),
      untestedTickets: untested.map((t) => t.ticketNumber),
    };
  });
  const total = Array.isArray(tasks) ? tasks.length : 0;
  const testedTotal = (Array.isArray(tasks) ? tasks : []).filter((t) => tested.has(String(t.ticketNumber))).length;
  return {
    products,
    overall: { total, tested: testedTotal, untested: total - testedTotal, coveragePct: pct(testedTotal, total) },
  };
}


// ---------------------------------------------------------------------------
// Multi-model test generation (FBMCPF-147) — one test per bug per model tier.
//
// The MCP server cannot call models itself; it returns generation packets that
// the calling agent runs against each tier, then submits back for dedupe +
// tagging. generateMultiModelTests() hands out the SAME prompt once per tier
// with a per-tier storage path (test/<ticket>.<model>.test.js). dedupeVariants()
// / saveGeneratedTests() ingest the per-tier content, tag each with its model,
// and drop identical assertions across variants so the suite stays lean. All
// pure/deterministic; the tool layer does any fs I/O.
// ---------------------------------------------------------------------------

/** Default model tiers to fan a bug's test generation across. */
export const DEFAULT_TIERS = ["fable", "opus", "sonnet"];

/** Normalize a requested tier list down to known tiers (deduped, order-kept). */
export function normalizeTiers(models) {
  const raw = Array.isArray(models) && models.length ? models : DEFAULT_TIERS;
  const out = [];
  for (const m of raw) {
    const tier = normalizeModelName(m) || (typeof m === "string" ? m.trim().toLowerCase() : null);
    if (tier && !out.includes(tier)) out.push(tier);
  }
  return out.length ? out : DEFAULT_TIERS.slice();
}

/** Build the per-tier variant path: test/<ticket>.<model>.test.js under codeLocation. */
export function variantTestPath({ codeLocation, ticket, model } = {}) {
  const base = codeLocation ? String(codeLocation).replace(/[\\/]+$/, "") : ".";
  const sep = base.includes("\\") ? "\\" : "/";
  const fileName = `${ticket}.${model}.test.js`;
  return { path: base + sep + "test" + sep + fileName, fileName, base, sep };
}

/**
 * Fan out a single generation prompt across model tiers. Returns one packet per
 * tier — the SAME prompt each time (each model surfaces different failure
 * concepts) plus a distinct storage path and instruction. Seed content is the
 * deterministic stub from generateTestFromPrompt; the agent replaces its
 * assertions with what the tier produces, then calls save_generated_test.
 */
export function generateMultiModelTests({ prompt, ticket, title, module, codeLocation, models } = {}) {
  const desc = String(prompt || title || "").trim();
  if (!desc) throw new Error("a prompt (or title) is required to generate tests");
  if (!ticket) throw new Error("a ticket id is required for multi-model variant naming");
  const tiers = normalizeTiers(models);
  const seed = generateTestFromPrompt({ prompt: desc, ticket, title, module, codeLocation });
  const variants = tiers.map((model) => {
    const { path, fileName } = variantTestPath({ codeLocation, ticket, model });
    return {
      model,
      path,
      fileName,
      framework: "node:test",
      prompt: desc,
      instruction:
        `Generate a node:test file for ${ticket} from the shared prompt using the ${model} model, ` +
        `then submit it via save_generated_test (ticket="${ticket}", model="${model}"). ` +
        `Target path: ${path}.`,
      content: seed.content,
    };
  });
  return { ticket, title: title || null, prompt: desc, models: tiers, behaviors: seed.behaviors, variants };
}

// --- dedupe -----------------------------------------------------------------

const ASSERT_KEEP = new Set([
  "assert", "ok", "equal", "deepEqual", "deepStrictEqual", "strictEqual",
  "notEqual", "notStrictEqual", "notDeepEqual", "throws", "doesNotThrow",
  "rejects", "doesNotReject", "match", "doesNotMatch", "fail", "ifError",
  "true", "false", "null", "undefined", "NaN", "t", "test",
]);

/** Does this line carry a node:test assertion (assert.* or a t.* sub-runner call)? */
export function isAssertionLine(line) {
  const s = String(line);
  return /\bassert\b\s*[.(]/.test(s) || /^\s*t\.[A-Za-z]+\s*\(/.test(s);
}

/**
 * Light normalization for comparing assertions across variants: collapse
 * whitespace, mask string literals (so message text is preserved verbatim, not
 * mangled), rename local identifiers to a placeholder (so `result` vs `res`
 * compare equal) while keeping the assert API surface and literals intact.
 */
export function normalizeAssertion(line) {
  let s = String(line).replace(/\s+/g, " ").trim();
  const strings = [];
  s = s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (lit) => {
    strings.push(lit);
    return "\u0000" + (strings.length - 1) + "\u0000";
  });
  // strip spaces around structural punctuation (string literals already masked)
  s = s.replace(/\s*([(),;{}\[\]:.])\s*/g, "$1");
  s = s.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (id) => (ASSERT_KEEP.has(id) ? id : "V"));
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => strings[Number(i)]);
  return s;
}

/** Split a generated test file into { header, blocks } (one entry per test() call). */
export function splitTestFile(content) {
  const s = String(content || "");
  const re = /(^|\n)(test\([\s\S]*?\n\}\);)/g;
  const blocks = [];
  let firstStart = -1, m;
  while ((m = re.exec(s))) {
    const start = m.index + m[1].length;
    if (firstStart < 0) firstStart = start;
    blocks.push(m[2]);
  }
  const header = firstStart >= 0 ? s.slice(0, firstStart) : s;
  return { header, blocks };
}

function blockAssertions(block) {
  return String(block).split(/\r?\n/).filter(isAssertionLine).map(normalizeAssertion);
}

function blockName(block) {
  const m = /test\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(String(block));
  return m ? m[2] : "(test)";
}

/**
 * Dedupe test blocks across model variants for one ticket. Variants are
 * processed in order; a block whose assertions are ALL already seen in an
 * earlier variant is skipped (its assertions go to a shared note). Blocks with
 * at least one novel assertion are kept. A variant left with no unique blocks is
 * marked skipped (content null) so nothing empty gets written.
 */
export function dedupeVariants(variants = []) {
  const seen = new Set();
  const sharedNote = [];
  const out = [];
  let keptTests = 0, droppedTests = 0;
  for (const v of variants) {
    const { header, blocks } = splitTestFile(v.content);
    const keptBlocks = [];
    const dropped = [];
    for (const block of blocks) {
      const asserts = blockAssertions(block);
      const novel = asserts.filter((a) => !seen.has(a));
      if (asserts.length && novel.length === 0) {
        const name = blockName(block);
        dropped.push(name);
        droppedTests++;
        for (const a of asserts) sharedNote.push({ model: v.model, test: name, assertion: a });
        continue;
      }
      for (const a of asserts) seen.add(a);
      keptBlocks.push(block);
      keptTests++;
    }
    const content = keptBlocks.length ? header + keptBlocks.join("\n\n") + "\n" : null;
    out.push({
      model: v.model,
      path: v.path || null,
      content,
      skipped: keptBlocks.length === 0,
      keptTests: keptBlocks.map(blockName),
      droppedTests: dropped,
    });
  }
  return { variants: out, sharedNote, keptTests, droppedTests };
}

/** Manifest path for a ticket's variant metadata: test/<ticket>.variants.json. */
export function variantManifestPath({ codeLocation, ticket } = {}) {
  const base = codeLocation ? String(codeLocation).replace(/[\\/]+$/, "") : ".";
  const sep = base.includes("\\") ? "\\" : "/";
  return base + sep + "test" + sep + `${ticket}.variants.json`;
}

/**
 * Ingest generated variants for a ticket: dedupe across tiers, tag each with its
 * model, and produce the files to write plus a queryable manifest (feeds the
 * FBMCPF-148 eval). Pure — returns content; the tool writes the files.
 */
export function saveGeneratedTests({ ticket, project, codeLocation, variants } = {}) {
  if (!ticket) throw new Error("a ticket id is required");
  const list = (Array.isArray(variants) ? variants : []).filter((v) => v && v.content != null);
  if (!list.length) throw new Error("provide at least one variant { model, content }");
  const staged = list.map((v) => {
    const model = normalizeModelName(v.model) || (v.model ? String(v.model).trim().toLowerCase() : "default");
    const path = v.path || variantTestPath({ codeLocation, ticket, model }).path;
    return { model, path, content: String(v.content) };
  });
  const dedup = dedupeVariants(staged);
  const files = dedup.variants
    .filter((v) => !v.skipped && v.content)
    .map((v) => ({ path: v.path, model: v.model, content: v.content, framework: "node:test" }));
  const manifest = {
    ticket,
    project: project || null,
    generatedAt: new Date().toISOString(),
    models: staged.map((v) => v.model),
    variants: dedup.variants.map((v) => ({
      model: v.model,
      path: v.path,
      skipped: v.skipped,
      keptTests: v.keptTests,
      droppedTests: v.droppedTests,
    })),
    dedupe: {
      keptTests: dedup.keptTests,
      droppedTests: dedup.droppedTests,
      sharedAssertions: dedup.sharedNote,
    },
  };
  return {
    ticket,
    manifestPath: variantManifestPath({ codeLocation, ticket }),
    manifest,
    files,
    sharedNote: dedup.sharedNote,
    keptTests: dedup.keptTests,
    droppedTests: dedup.droppedTests,
  };
}

/**
 * List the model variants present for a ticket from a set of filenames (feeds
 * suite integration + the FBMCPF-148 eval: which models cover this ticket).
 */
export function listVariants(files = [], ticket) {
  const esc = String(ticket || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + esc + "\\.([A-Za-z0-9]+)\\.test\\.js$", "i");
  const variants = [];
  for (const f of Array.isArray(files) ? files : []) {
    const name = String(f).split(/[\\/]/).pop();
    const m = re.exec(name);
    if (m) variants.push({ model: m[1].toLowerCase(), file: name });
  }
  const models = [...new Set(variants.map((v) => v.model))];
  return { ticket, models, count: variants.length, variants };
}
